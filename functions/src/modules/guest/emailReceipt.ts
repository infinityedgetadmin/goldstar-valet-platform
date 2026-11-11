import { createHash } from 'node:crypto';
import type { CallableParsedInput, CallableOutput, Ticket, Venue } from '@goldstar/platform';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { rateLimit, capDistinctValues } from './rateLimit.js';

/**
 * Task 7 legitimate-use check (documented per the controller's explicit ask, not a guess):
 * a guest resending ONE receipt after a typo'd address is 1-2 calls; deliberately re-sending an
 * old receipt to a couple of different people (self, a partner, a work expense inbox) in one
 * sitting is a handful more; reviewing several past tickets from their guest account in one
 * session multiplies that by a small factor. 10 calls in 10 minutes covers all of that with
 * headroom while still bounding a scripted loop to a few sends a minute, not hundreds.
 */
const EMAIL_RECEIPT_MAX_PER_WINDOW = 10;
const EMAIL_RECEIPT_WINDOW_SEC = 600;

/**
 * Task 7 legitimate-use check: realistically a guest emails ONE receipt to themselves, maybe a
 * partner, maybe a work expense inbox — 1 to 3 addresses. 5 distinct recipients per ticket, ever,
 * is generous headroom above that while still bounding how many strangers one ticket can ever be
 * used to fan a receipt link out to — see the capability-handoff note on the link itself below.
 */
const MAX_DISTINCT_RECIPIENTS_PER_TICKET = 5;

// Payment statuses that actually represent money having moved and are therefore receiptable.
// 'authorized' is deliberately excluded — nothing has been captured yet, so there's no completed
// transaction to email a receipt for.
const RECEIPTABLE_STATUSES = ['paid', 'refunded', 'room_charged', 'venue_billed'];

// Plan 6 (guest account, guestEmailReceipt). CARRY (2c): this outbox id must be DISTINCT from the
// automatic SMS receipt's deterministic id (`${ticketId}_receipt`, ticket.handler.ts's enqueueSms /
// applyEvent.ts) — colliding would make a guest-requested email receipt dedupe against (and silently
// never send behind) the automatic SMS, which is a different channel/template/recipient entirely.
// Still deterministic (not deps.newId()) so a client retry of the SAME request (same ticket + same
// email) naturally dedupes via the .create() ALREADY_EXISTS pattern below, exactly like enqueueSms —
// a different email address, or a second explicit request to the same address, is allowed to send
// again is NOT the goal here (each request is a fresh explicit "email me this" click); the id is
// scoped to ticket+email specifically so retries of ONE request dedupe without blocking a guest who
// asks for the receipt at two different addresses. Email hashed (not embedded raw) to keep the doc id
// short and free of characters Firestore doc ids can't reliably round-trip.
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}
function outboxId(ticketId: string, email: string): string {
  return `${ticketId}_receiptEmail_${hashEmail(email)}`;
}

export async function guestEmailReceiptHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestEmailReceipt'>): Promise<CallableOutput<'guestEmailReceipt'>> {
  const c = requireRole(caller, ['guest']);
  // Task 7 (M1): per-uid, before any Firestore reads — matches the established `guest:${token}`
  // rateLimit-right-after-identity-resolution convention this repo already uses everywhere else
  // (survey.ts, cancel.ts, checkout.ts, etc.), just keyed by the authenticated guest's uid instead
  // of an anonymous token, since this is a Plan 6 guest-ACCOUNT callable, not a token flow.
  await rateLimit(deps, `guestEmailReceipt:${c.uid}`, EMAIL_RECEIPT_MAX_PER_WINDOW, EMAIL_RECEIPT_WINDOW_SEC);
  // Single equality-filter collectionGroup query (ticket ids are uuidv7, globally unique — see
  // deps.newId) — ownership is verified AFTER the fetch, in code, never folded into the query itself.
  // A ticket that doesn't exist and a ticket that exists but isn't this guest's both return the same
  // permission_denied below — no oracle on either axis (the 4b cross-tenant-oracle lesson).
  // Fix round 2 (task-platform-review.md, C1): `id` needs the `COLLECTION_GROUP`-scope index added
  // to `firestore.indexes.json` alongside this change — see ticketsByGuest.ts's own comment (same
  // reasoning: Firestore doesn't auto-index a field for collection-group scope even for one bare
  // equality filter) and identity/eligibility.ts's `users.status` for the established precedent.
  const q = await deps.db.collectionGroup('tickets').where('id', '==', input.ticketId).limit(1).get();
  if (q.empty) throw err('permission_denied');
  const doc = q.docs[0]!;
  const ticket = doc.data() as Ticket;
  if (ticket.guest.uid !== c.uid) throw err('permission_denied');
  if (!ticket.payment || !RECEIPTABLE_STATUSES.includes(ticket.payment.status)) throw err('failed_precondition', 'no payment to receipt');
  // Task 7 (M1, second finding): the `(ticketId,email)` dedupe above lets a fresh address bypass
  // the per-uid rateLimit entirely — nothing stopped one ticket being used to fan a receipt out to
  // an unbounded number of DIFFERENT addresses. Capped at DISTINCT recipients, permanently, not
  // windowed — see capDistinctValues's own doc comment for why. Email hashed before being passed in
  // (PII minimization, same discipline outboxId already applies).
  await capDistinctValues(deps, `guestEmailReceiptRecipients:${ticket.id}`, hashEmail(input.email), MAX_DISTINCT_RECIPIENTS_PER_TICKET);
  // Only venue is needed here — sendOutboundHandler (sender.ts) already fetches the Operator itself
  // and injects operatorName into every template's vars at send time (buildEmailVars, email.ts), so
  // this handler doesn't duplicate that read.
  const venue = (await deps.db.doc(P.venue(ticket.operatorId, ticket.venueId)).get()).data() as Venue;
  // Task 7 (M1's OTHER half — "a receipt link that is not a full capability handoff"), investigated
  // and DEFERRED, recorded here rather than silently: this link carries the SAME `guestToken` the
  // ticket's own guest account uses for full access (view, and whatever else that token enables) —
  // it is not a receipt-only, read-limited credential. Every one of the (now-capped) distinct
  // recipients above receives full ticket capability, not just a receipt view. A real fix needs a
  // NARROWER-scoped token/capability distinct from `guestToken` — a new token shape and its own
  // resolution path, a contracts change, not a rate-limit-task-sized change. The cap above bounds
  // the BLAST RADIUS (how many strangers could ever receive full access via one ticket) without
  // closing the underlying design gap; that gap is unresolved after this task, on purpose.
  const link = `https://${process.env.GUEST_HOST ?? 'app.goldstar.example.com'}/t/${ticket.guestToken}#receipt`;
  const vars = {
    venueName: venue.name,
    jobType: ticket.jobType,
    ticketRef: ticket.id.slice(0, 8),
    paidAt: ticket.payment.paidAt ?? deps.now(),
    base: ticket.payment.base,
    tip: ticket.payment.tip,
    tax: ticket.payment.tax,
    fees: ticket.payment.fees,
    total: ticket.payment.total,
    currency: ticket.payment.currency,
    receiptUrl: link,
  };
  const id = outboxId(ticket.id, input.email);
  await deps.db
    .doc(P.outbound(id))
    // .create() (not .set) — same redelivery-safety reasoning as enqueueSms/enqueuePush
    // (ticket.handler.ts): a retried call for the SAME ticket+email hits ALREADY_EXISTS (code 6) and
    // is swallowed as a no-op instead of resetting an in-flight/already-sent message back to queued.
    .create({ id, channel: 'email', operatorId: ticket.operatorId, venueId: ticket.venueId, ticketId: ticket.id, to: input.email, template: 'receipt', vars, status: 'queued', attempts: 0, createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
  // PII minimization: the destination email is not written into the audit `after` payload (only the
  // ticket id, already the audit target) — the outboundMessages doc above is the durable record of
  // who it was actually sent to, access-controlled the same way every other outbound message is.
  await audit(deps, { operatorId: ticket.operatorId, actorUid: c.uid, action: 'guest.emailReceipt', target: ticket.id });
  return { ok: true };
}

export const guestEmailReceipt = defineCallable('guestEmailReceipt', {}, guestEmailReceiptHandler);
