import { secondsBetween, type Operator, type Ticket, type Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { buildProjection, deriveDriverInfo, deriveLinkedJobs } from './projection.js';
import { allocateDelivererTip } from '../payments/payouts/allocate.js';

export interface TicketWrittenEvent {
  operatorId: string;
  ticketId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

const sec = (a?: string, b?: string) => (a && b ? secondsBetween(new Date(a), new Date(b)) : undefined);

async function guestHasPush(deps: Deps, t: Ticket): Promise<boolean> {
  if (!t.guest.uid) return false;
  const g = (await deps.db.doc(P.guest(t.guest.uid)).get()).data() as { fcmTokens?: string[]; consent?: { push?: boolean } } | undefined;
  return !!g && (g.fcmTokens?.length ?? 0) > 0 && g.consent?.push !== false;
}

// Templates exempt from the "push preferred, SMS is the fallback" gate below: 'welcome' has no push
// event to prefer (it fires on ticket create, before any push channel is relevant), and 'receipt'
// (Ruling AT, 1d final review finding 13) is a financial record that must always go out over SMS
// regardless of the guest's push setup — never silently skipped in favor of a push notification.
const ALWAYS_SMS_TEMPLATES = ['welcome', 'receipt'];

export async function enqueueSms(deps: Deps, op: string, t: Ticket, template: string, vars: Record<string, unknown>): Promise<void> {
  // Capture the phone into a local before the `await` below — narrowing on a parameter's nested
  // property (`t.guest.phoneE164`) is not guaranteed to survive an intervening async call, but a
  // `const` local is.
  const phone = t.guest.phoneE164;
  if (!t.guest.consentSms || !phone) return;
  if (!ALWAYS_SMS_TEMPLATES.includes(template) && (await guestHasPush(deps, t))) return; // push preferred when the guest app is installed; Plan 1d push handler falls back to SMS on delivery failure
  const id = `${t.id}_${template}`; // deterministic → retries never duplicate
  await deps.db
    .doc(P.outbound(id))
    // .create() (not .set) so a redelivered trigger invocation for the same ticket+template hits the
    // `{ exists: false }` precondition and rejects with ALREADY_EXISTS (code 6) instead of silently
    // overwriting an in-flight/already-sent message back to status:'queued', attempts:0 — which would
    // cause the SMS worker to actually re-send it.
    .create({ id, channel: 'sms', operatorId: op, venueId: t.venueId, ticketId: t.id, to: phone, template, vars, status: 'queued', attempts: 0, createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

/**
 * Queues the guest's `ticket.status` push — GUEST uid only, deliberately (mobile fix round).
 *
 * This used to ALSO target the `venue_{op}_{venueId}` topic, which every on-shift attendant's
 * device subscribes to (mobile's `venueTopic()` is byte-identical to that string) — so attendants
 * received the GUEST-worded copy `copyFor('ticket.status', …)` renders: "Your car is ready — Head
 * to the valet stand", "Enjoy your drive — Thanks for choosing us". Ruling: guest-facing copy goes
 * to the guest only. If staff ever genuinely need a ready-signal, that is a SEPARATE kind with
 * staff-worded copy and its own decision — not the guest's message forwarded to people it wasn't
 * written for. (Staff-facing pushes on the venue topic already exist where they were designed:
 * `venue.request` and `venue.pre_arrival` in venue/hostRequest.ts, both staff-worded; the live
 * board and mobile queue render status changes from their own Firestore listeners.)
 *
 * A guest who never linked (no uid) gets no push event at all — the SMS path (`enqueueSms` +
 * `guestHasPush`) already owns that case.
 */
async function enqueuePush(deps: Deps, op: string, t: Ticket, kind: string, data: Record<string, string>): Promise<void> {
  if (!t.guest.uid) return;
  // Doc id keeps the target-key suffix (the uid) from the two-target era: the stored `id` field is
  // the FULL doc id, so field-keyed consumers and any pre-existing queued docs keep their contract.
  const docId = `${t.id}_${t.status}_${kind}_${t.guest.uid}`;
  // .create() (not .set) — same redelivery-safety reasoning as enqueueSms: a redelivered trigger
  // invocation for the same ticket+status+kind+target must not reset an in-flight/already-delivered
  // push event back to status:'queued'. ALREADY_EXISTS (code 6) on retry is swallowed as a no-op.
  await deps.db
    .doc(`pushEvents/${docId}`)
    .create({ id: docId, operatorId: op, ticketId: t.id, kind, data, status: 'queued' as const, createdAt: deps.now(), toUid: t.guest.uid })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

/**
 * Plan 5 T2 (4b-F3 carry, WITH TEETH): writes the ticket's own projection with FRESHLY-DERIVED
 * `linkedJobs`/`driver` (see projection.ts), then — when this ticket IS a job (`parentTicketId` set)
 * — also refreshes the PARENT ticket's projection, so a status change on the job (quoted → confirmed
 * → assigned → …) shows up on the guest's PARENT ticket page's linked-job card without the guest
 * needing to separately visit the job's own token page. The parent refresh re-derives its OWN
 * `linkedJobs` from scratch (not a merge of this one job's new status onto old data) — this is what
 * makes a parent-ticket rebuild triggered by an unrelated valet-status change equally correct: every
 * rebuild, from either direction, re-queries the current children rather than trusting stale state.
 * The parent write is a plain doc write (`guestTickets/{token}`, not `tickets/{id}`) — it does not
 * re-trigger `onTicketWritten`, so there is no recursion to guard against here.
 */
async function writeAndPropagateProjection(deps: Deps, op: Operator, venue: Venue, t: Ticket, now: string): Promise<void> {
  // N1 (fix round 1, review Minor): an operator that has never enabled either job feature could
  // structurally never have a linked job — skip deriveLinkedJobs' query entirely for it rather than
  // paying an extra read on every valet-ticket write (the large majority of platform write volume).
  const canHaveJobs = op.features.driveHome || op.features.passengerRides;
  const [linkedJobs, driver] = await Promise.all([
    t.parentTicketId || !canHaveJobs ? Promise.resolve([]) : deriveLinkedJobs(deps, op.id, t.id),
    deriveDriverInfo(deps, op.id, t),
  ]);
  await deps.db.doc(P.guestTicket(t.guestToken)).set(buildProjection(op, venue, t, now, { linkedJobs, driver }));
  if (!t.parentTicketId) return;
  const parentSnap = await deps.db.doc(P.ticket(op.id, t.parentTicketId)).get();
  if (!parentSnap.exists) return;
  const parent = parentSnap.data() as Ticket;
  const [parentLinkedJobs, parentDriver] = await Promise.all([canHaveJobs ? deriveLinkedJobs(deps, op.id, parent.id) : Promise.resolve([]), deriveDriverInfo(deps, op.id, parent)]);
  // Job tickets share their parent's venueId by construction (dispatch/requestDriveHome.ts,
  // dispatch/requestRide.ts both set `venueId: parent.venueId` at creation) — the already-fetched
  // `venue` is reused rather than re-read.
  await deps.db.doc(P.guestTicket(parent.guestToken)).set(buildProjection(op, venue, parent, now, { linkedJobs: parentLinkedJobs, driver: parentDriver }));
}

export async function ticketWrittenHandler(deps: Deps, e: TicketWrittenEvent): Promise<void> {
  const after = e.after as unknown as Ticket;
  const before = e.before as unknown as Ticket | null;
  const [opSnap, venueSnap] = await Promise.all([deps.db.doc(P.operator(e.operatorId)).get(), deps.db.doc(P.venue(e.operatorId, after.venueId)).get()]);
  // Carry #18 (poison-event guard): this trigger runs with `retry: true`, so an unguarded
  // `.data() as Operator` on a MISSING doc doesn't fail once — it throws on first property access
  // and redelivers forever, for every write to a ticket whose operator or venue doc was deleted.
  // A missing doc is a permanent condition retry can never fix; log-and-skip is the only exit.
  // (A transient read failure still rejects out of the Promise.all above and retries — that is
  // the case `retry: true` exists for, and this guard deliberately does not catch it.)
  if (!opSnap.exists || !venueSnap.exists) {
    console.error('ticketWrittenHandler: skipping ticket with missing parent doc', {
      operatorId: e.operatorId, ticketId: e.ticketId, missing: !opSnap.exists ? 'operator' : 'venue', venueId: after.venueId,
    });
    return;
  }
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue;
  const ref = deps.db.doc(P.ticket(e.operatorId, e.ticketId));
  const patch: Record<string, unknown> = {};
  const statusChanged = !before || before.status !== after.status;
  if (statusChanged) {
    if (after.status === 'ready' && after.metrics?.retrievalSec === undefined) {
      const v = sec(after.times.requestedAt, after.times.readyAt);
      if (v !== undefined) patch['metrics.retrievalSec'] = v;
    }
    if (after.status === 'delivered' && after.metrics?.readyToDeliverSec === undefined) {
      const v = sec(after.times.readyAt, after.times.deliveredAt);
      if (v !== undefined) patch['metrics.readyToDeliverSec'] = v;
    }
    if (after.status === 'completed' && after.metrics?.tripSec === undefined) {
      const v = sec(after.times.inTransitAt, after.times.arrivedAt);
      if (v !== undefined) patch['metrics.tripSec'] = v;
    }
  }
  if (Object.keys(patch).length > 0) await ref.update(patch);
  const merged: Ticket = {
    ...after,
    metrics: {
      ...(after.metrics ?? {}),
      ...(patch['metrics.retrievalSec'] !== undefined ? { retrievalSec: patch['metrics.retrievalSec'] as number } : {}),
      ...(patch['metrics.readyToDeliverSec'] !== undefined ? { readyToDeliverSec: patch['metrics.readyToDeliverSec'] as number } : {}),
      ...(patch['metrics.tripSec'] !== undefined ? { tripSec: patch['metrics.tripSec'] as number } : {}),
    },
  };
  const link = `https://${process.env.GUEST_HOST ?? 'app.goldstar.example.com'}/t/${after.guestToken}`;
  await writeAndPropagateProjection(deps, op, venue, merged, deps.now());
  if (!before) await enqueueSms(deps, e.operatorId, after, 'welcome', { venue: venue.name, link });
  if (statusChanged && after.status === 'cancelled' && after.payment && ['paid', 'authorized'].includes(after.payment.status) && !after.payment.refundRequested) {
    // Ruling AH (1d final review, finding 1): refundRequestId minted in the SAME write as
    // refundRequested:true — full refund at the default reason (no amount/reason set), server-side so
    // offline/client cancels refund too (Plan 1d refund trigger).
    await ref.update({ 'payment.refundRequested': true, 'payment.refundRequestId': deps.newId() });
  }
  if (statusChanged) {
    if (after.status === 'ready') await enqueueSms(deps, e.operatorId, after, 'ready', { venue: venue.name, link });
    if (after.status === 'closed') {
      await enqueueSms(deps, e.operatorId, after, 'survey', { venue: venue.name, link });
      // Plan 8 T1: deliverer-policy tip allocation happens exactly once, at the closed transition
      // (allocate-at-closed rule; shift_pool stays tipPool.ts's trigger). Internal guards make it
      // a no-op for unpaid/untipped tickets and non-deliverer operators.
      await allocateDelivererTip(deps, { operatorId: e.operatorId, before: e.before as Ticket | null, after });
    }
    if (after.status === 'assigned') {
      // {{eta}} carry: the quote's trip duration (route venue → destination, already computed at
      // request/re-quote time) is the best "how long until my ride/driver arrives" figure available
      // at assignment — pass it whenever the quote exists (it always does by the time a job reaches
      // 'assigned', since assignment only follows confirmed, which only follows quoted) so an operator
      // who customizes their driveHomeAssigned/rideAssigned template with a literal `{{eta}}` token
      // gets a real value; the built-in default templates don't reference it, so this is a no-op for
      // anyone who hasn't opted in. Genuinely missing (malformed data) drops the var rather than
      // sending a fabricated number — renderTemplate already renders an unknown/missing var as empty.
      const quote = after.jobType === 'drive_home' ? after.driveHome?.quote : after.jobType === 'passenger_ride' ? after.ride?.quote : undefined;
      const eta = quote ? `${Math.round(quote.durationSec / 60)} min` : undefined;
      await enqueueSms(deps, e.operatorId, after, after.jobType === 'drive_home' ? 'driveHomeAssigned' : 'rideAssigned', { venue: venue.name, link, ...(eta !== undefined ? { eta } : {}) });
    }
    await enqueuePush(deps, e.operatorId, after, 'ticket.status', { ticketId: after.id, status: after.status });
  }
}
