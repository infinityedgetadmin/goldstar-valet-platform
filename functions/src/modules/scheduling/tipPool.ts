import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { ClockEvent, Operator, Shift, Ticket, Transaction } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

/**
 * Task 2 (task-2-brief.md): allocates a shift's pooled tips across its assignees by clocked hours
 * when the shift transitions to `status: 'closed'` and the operator's `payments.tipPolicy` is
 * `'shift_pool'` (the alternative, `'deliverer'`, pays the tip straight to whoever delivered the
 * ticket — no pooling, nothing for this trigger to do).
 *
 * ## Tip source: `transactions` (status `'succeeded'`), not `ticket.payment.tip` — disclosed decision
 *
 * Both fields exist and, for every payment path actually implemented in this codebase today (Stripe
 * checkout via `guestCreateCheckout`/`staffCreateCheckout` -> `applyPaymentEvent`, in
 * `payments/checkout.ts` + `payments/applyEvent.ts`), they end up numerically equal for a
 * successfully-paid ticket. They are NOT the same field, though, and only one of them is safe to
 * trust without cross-checking a second field first:
 *
 * - `ticket.payment.tip` is written ONCE, at checkout-request time (`checkout.ts`'s `runCheckout`:
 *   `payment: { status: 'pending', tip: priced.tip, ... }`) — BEFORE the guest/staff member has
 *   actually confirmed the card. `applyPaymentEvent` never revises it afterward (only
 *   `payment.status`/`payment.lastIntentId`/`payment.paidAt` are touched). So a ticket whose checkout
 *   was abandoned or declined still carries a real `payment.tip` value with `payment.status:
 *   'failed'` or `'pending'` — using this field means EVERY read site must remember to also gate on
 *   `payment.status === 'paid'`, and even that isn't quite right for a fully-refunded ticket (whose
 *   status moves to `'refunded'`, not `'paid'`, but which never had its `tip` field cleared either).
 *
 * - `transactions/{providerRef}` (`applyEvent.ts`'s `applyPaymentEvent`, `tx.set(txRef, {..., tip:
 *   ev.tip, status: txStatus, ...}, {merge:true})`) is the actual confirmed-by-Stripe-webhook ledger
 *   row for that payment intent, keyed by `ticket.payment.lastIntentId`. Its `status` field already
 *   encodes exactly the distinction this task needs: `'succeeded'` only when the webhook confirmed
 *   the charge, and a FULL refund flips it to `'refunded'` (excluding it automatically), while a
 *   PARTIAL refund keeps it `'succeeded'` (Ruling AK in `applyEvent.ts` — the ticket's own tip wasn't
 *   necessarily what got refunded, so it correctly keeps counting for the pool). No second field to
 *   remember to check.
 *
 * `transactions.status === 'succeeded'` is therefore the authoritative source: for each ticket
 * delivered inside the shift's window at the shift's venue, this reads `ticket.payment.lastIntentId`
 * and fetches that one transaction doc directly (`P.tx`) rather than running a second Firestore query
 * — the transaction doc ID IS the provider ref, so this is a plain `.get()`, not a `.where()`.
 *
 * Caveat, disclosed rather than silently assumed: `pmsPostRoomCharge`/`posAddValetCharge`/
 * `posApplyValidation` (room-charge and POS payment methods) are declared in `callables.ts` but have
 * NO handler implementation anywhere under `functions/src/modules/` yet (verified — grepped the whole
 * tree). Today, every paid ticket goes through Stripe, so `transactions` and a status-gated
 * `ticket.payment.tip` would agree either way; if/when those non-Stripe methods are implemented, this
 * trigger should be revisited to make sure they also produce a `transactions` row (or this trigger
 * gains a second read path) — otherwise a room-charged/POS tip would silently never reach the pool.
 *
 * ## Ticket window: `times.deliveredAt`, not `shiftId`
 *
 * `ticketBaseSchema` has an (unused) optional `shiftId` field, but nothing under `functions/src`
 * ever writes it (verified by grep) — it isn't wired into the check-in/claim flow, so relying on it
 * here would silently match zero tickets. The brief's own wording ("tickets DELIVERED during the
 * shift window at the venue") points at a venue + time-window join instead: every ticket at
 * `after.venueId` whose `times.deliveredAt` falls within `[after.startsAt, after.endsAt]`
 * (`isoDateSchema` strings are UTC 'Z' timestamps, so plain lexicographic `>=`/`<=` range comparison
 * is correct — no parsing needed for the query itself). This needs a `(venueId, times.deliveredAt)`
 * composite index; added directly to `firestore.indexes.json` (NOT to the contracts package's
 * `QUERIES` registry — that registry's own doc comment scopes it to CLIENT SDK queries feeding
 * `scripts/generate-indexes.ts`, and this is an Admin-SDK-only query a client never issues; the same
 * precedent already exists in this file — the `users` collectionGroup indexes `identity/eligibility.ts`
 * needs are hand-added the same way, not registered in `QUERIES` either).
 */

export function computeClockedHours(events: Pick<ClockEvent, 'uid' | 'type' | 'at'>[], shiftEndsAt: string): Record<string, number> {
  const byUid = new Map<string, Pick<ClockEvent, 'uid' | 'type' | 'at'>[]>();
  for (const e of events) {
    if (e.type !== 'in' && e.type !== 'out') continue; // break_start/break_end don't bound a worked interval on their own
    const arr = byUid.get(e.uid) ?? [];
    arr.push(e);
    byUid.set(e.uid, arr);
  }
  const hours: Record<string, number> = {};
  for (const [uid, evs] of byUid) {
    const sorted = [...evs].sort((a, b) => a.at.localeCompare(b.at));
    let openAt: string | null = null;
    let ms = 0;
    for (const e of sorted) {
      if (e.type === 'in') {
        // A second 'in' before a matching 'out' abandons the earlier open interval rather than
        // stacking/nesting it — an anomaly (double clock-in with no clock-out between), not a valid
        // worked span; the LATER 'in' is what the attendant most recently asserted.
        openAt = e.at;
      } else if (e.type === 'out' && openAt) {
        ms += Math.max(0, Date.parse(e.at) - Date.parse(openAt));
        openAt = null;
      }
      // an 'out' with no open 'in' (openAt === null) is the mirror anomaly — ignored, adds no time.
    }
    if (openAt) {
      // Missing-out anomaly (brief: "exclude or cap, disclose"). Chosen: CAP the open interval at
      // the shift's own `endsAt` rather than excluding it entirely. Reasoning: `shiftsCorrectClock`
      // exists specifically so a lead/admin can fix a missing punch BEFORE closing the shift — by the
      // time this trigger runs (the shift IS being closed), any still-open punch is an uncorrected
      // mistake, and denying that attendant their entire tip share for a punch-clock slip is a
      // harsher default than crediting them up to the shift's scheduled end. Judgment call — the
      // alternative (exclude: drop this uid's open interval instead of capping it) is a one-line
      // swap if the product decision goes the other way.
      ms += Math.max(0, Date.parse(shiftEndsAt) - Date.parse(openAt));
    }
    hours[uid] = ms / 3_600_000;
  }
  return hours;
}

/**
 * Splits `totalCents` across `hoursByUid` proportional to hours, using the largest-remainder method
 * so the allocations always sum to EXACTLY `totalCents` (never a cent over/under from independent
 * per-uid rounding) — deterministic given the same inputs (ties broken by uid, ascending), which
 * matters for the trigger's own idempotency: a redelivered event must recompute the identical
 * allocation array, not a different valid-but-different rounding.
 */
export function computeTipPoolAllocations(totalCents: number, hoursByUid: Record<string, number>): { uid: string; amount: number }[] {
  const uids = Object.keys(hoursByUid).sort();
  const totalHours = uids.reduce((s, u) => s + hoursByUid[u]!, 0);
  if (totalCents <= 0 || totalHours <= 0 || uids.length === 0) return uids.map((uid) => ({ uid, amount: 0 }));

  const raw = uids.map((uid) => {
    const exact = (totalCents * hoursByUid[uid]!) / totalHours;
    const floor = Math.floor(exact);
    return { uid, floor, remainder: exact - floor };
  });
  const allocated = raw.reduce((s, r) => s + r.floor, 0);
  const remaining = totalCents - allocated; // always >= 0 and < uids.length by construction of floor/remainder

  const byRemainder = [...raw].sort((a, b) => b.remainder - a.remainder || a.uid.localeCompare(b.uid));
  const bumped = new Set(byRemainder.slice(0, remaining).map((r) => r.uid));

  return raw.map((r) => ({ uid: r.uid, amount: r.floor + (bumped.has(r.uid) ? 1 : 0) }));
}

export async function sumDeliveredTips(deps: Deps, operatorId: string, venueId: string, startsAt: string, endsAt: string): Promise<number> {
  // m2 (final whole-branch review): [start, end) — matches rollup.ts's own window convention
  // (dayWindow uses `<` at the end, not `<=`). Inclusive-inclusive let a ticket delivered at the
  // EXACT instant one shift ends and the next begins (`shiftA.endsAt === shiftB.startsAt`) count
  // toward BOTH pools — the same tip funding two payouts. Millisecond-exact so rare in practice, but
  // free to close.
  const ticketsSnap = await deps.db
    .collection(`operators/${operatorId}/tickets`)
    .where('venueId', '==', venueId)
    .where('times.deliveredAt', '>=', startsAt)
    .where('times.deliveredAt', '<', endsAt)
    .get();

  const amounts = await Promise.all(
    ticketsSnap.docs.map(async (d) => {
      const t = d.data() as Ticket;
      const intentId = t.payment?.lastIntentId;
      if (!intentId) return 0;
      const txSnap = await deps.db.doc(P.tx(operatorId, intentId)).get();
      if (!txSnap.exists) return 0;
      const tx = txSnap.data() as Transaction;
      return tx.status === 'succeeded' ? tx.tip : 0;
    }),
  );
  return amounts.reduce((s, a) => s + a, 0);
}

export interface ShiftWriteEvent {
  operatorId: string;
  shiftId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | undefined;
}

export async function tipPoolHandler(deps: Deps, e: ShiftWriteEvent): Promise<void> {
  if (!e.after) return; // delete
  const before = e.before as (Pick<Shift, 'tipPool'> & { status?: string }) | null;
  const beforeStatus = before?.status;
  const after = e.after as unknown as Shift;
  // Only on the transition INTO 'closed' — this is also the trigger's own recursion guard: the
  // `tipPool`-carrying update this handler makes below re-fires onDocumentWritten, but that event's
  // `before.status` is ALREADY 'closed' by then, so this check skips it instead of looping.
  if (after.status !== 'closed' || beforeStatus === 'closed') return;

  const opSnap = await deps.db.doc(P.operator(e.operatorId)).get();
  const op = opSnap.data() as Operator | undefined;
  if (!op || op.modules.payments.tipPolicy !== 'shift_pool') return;

  // Ruling M2(a) (final whole-branch review, recorded in the ledger): tips are evaluated ONCE, here,
  // at shift close — a refund on the FUNDING transaction that lands afterward (whether the shift
  // reopens/recloses, per the reconciliation below, or not) does NOT claw back an already-allocated
  // tip. Deliberate product decision: the staff member worked the shift and is owed the tip
  // regardless of what the guest does with their payment afterward. The direct consequence: a
  // `users/{uid}/payouts/{shiftId}` entry can be funded by a transaction that later shows
  // `status !== 'succeeded'` in `transactions/{id}` — nothing here (or anywhere in this plan) flags
  // that divergence. Plan 8's payout-paying sweep MUST cross-check the funding transaction's CURRENT
  // status before paying out and flag (a `fundingRefunded` marker or equivalent — never silently pay)
  // any pending allocation whose source transaction has since refunded; it must NOT claw the tip back
  // on its own authority. See `analytics/rollup.ts`'s own Ruling M2(b)/M2(c) comments for the two
  // related-but-different consequences on the METRICS side of the same refund model.
  const [totalTips, clockSnap] = await Promise.all([
    sumDeliveredTips(deps, e.operatorId, after.venueId, after.startsAt, after.endsAt),
    deps.db.collection(`operators/${e.operatorId}/shifts/${e.shiftId}/clockEvents`).get(),
  ]);
  const events = clockSnap.docs.map((d) => d.data() as ClockEvent);
  const hoursByUid = computeClockedHours(events, after.endsAt);
  const allocations = computeTipPoolAllocations(totalTips, hoursByUid);

  // Deterministic doc id (the shift's own id) at BOTH write sites below — a redelivered/retried
  // trigger invocation `.set()`s the exact same content at the exact same path instead of creating a
  // second payout entry (brief: "re-fired trigger must not double-write payout entries").
  await deps.db.doc(P.shift(e.operatorId, e.shiftId)).update({ tipPool: { total: totalTips, hoursByUid, allocations } });

  /**
   * Fix round 1, C1 (task-2-review.md): `tipPool` is rules-pinned across an update
   * (`firestore.rules`'s `shifts` update rule keeps it in `unchanged([...])`), so a manager reopening
   * a closed shift, changing assignments/clock events, and closing it again reaches this handler a
   * SECOND time with `before.tipPool` still holding the FIRST close's allocations. Without
   * reconciling against it, a uid paid something on the prior close who computes to zero (or drops
   * out of `hoursByUid` entirely) on this close keeps its stale `users/{uid}/payouts/{shiftId}` doc
   * forever — nothing else in the system can clean it up (`payouts` writes are Functions-only,
   * `firestore.rules`'s `allow write: if false`), so a downstream payout sweep would still pay it.
   *
   * `newByUid`/`staleUids` diff the two allocation sets by uid; `payoutAllocationSchema.status` has
   * no "voided"/"cancelled" value (`z.enum(['pending','paid','failed'])`), so deleting the doc is the
   * only schema-compatible cleanup for an entry that's still `'pending'`. Guarded to only ever act on
   * THIS shift's own payout doc for that uid (the path is built from `e.shiftId`, never a different
   * one) and, defensively, to skip a doc a downstream sweep already moved to `'paid'`/`'failed'` —
   * silently deleting a payout record for money that may already be in flight/sent is a worse outcome
   * than leaving a flagged stale record for a human to look at (logged via `console.warn`, matching
   * this codebase's existing "log and skip" convention for an out-of-band race — see
   * `identity/eligibility.ts`/`incidents/onIncidentCreated.ts`).
   */
  const newByUid = new Map(allocations.map((a) => [a.uid, a.amount]));
  const previousAllocations = before?.tipPool?.allocations ?? [];
  const staleUids = previousAllocations.filter((a) => a.amount > 0 && (newByUid.get(a.uid) ?? 0) <= 0).map((a) => a.uid);

  await Promise.all([
    ...allocations
      .filter((a) => a.amount > 0)
      .map((a) =>
        // Carry #3 (Plan 8 T1, done FIRST while nothing orders by createdAt): this was a bare
        // `.set()`, so a reopen-reclose RESET createdAt — harmless right up until the daily payout
        // sweep starts ageing allocations by it — and, worse (carry #2's edge), would have
        // reverted a doc the sweep already marked 'paid' back to 'pending': a double pay. Now a
        // TRANSACTION (guard-reads-now): absent → create with a fresh createdAt; still 'pending' →
        // update the recomputed amount only, PRESERVING the original createdAt; 'paid'/'failed' →
        // never touched (same log-and-skip convention as the stale-uid branch below — money may
        // already be in flight, and a reclose has no authority over a settled payout).
        deps.db.runTransaction(async (tx) => {
          const ref = deps.db.doc(P.payout(e.operatorId, a.uid, e.shiftId));
          const snap = await tx.get(ref);
          const existing = snap.data() as { status?: string } | undefined;
          if (!snap.exists) {
            tx.create(ref, { id: e.shiftId, shiftId: e.shiftId, amount: a.amount, currency: op.currency, status: 'pending', createdAt: deps.now() });
          } else if (existing?.status === 'pending') {
            tx.update(ref, { amount: a.amount });
          } else {
            console.warn(`tipPool: reclose skipped payout ${e.shiftId}/${a.uid} — status '${existing?.status ?? 'unknown'}' is settled`);
          }
        }),
      ),
    ...staleUids.map(async (uid) => {
      const ref = deps.db.doc(P.payout(e.operatorId, uid, e.shiftId));
      const snap = await ref.get();
      const status = (snap.data() as { status?: string } | undefined)?.status;
      if (!snap.exists || status === 'pending') {
        await ref.delete();
      } else {
        console.warn('tipPool reconcile: stale payout doc already left "pending" — not deleting', { operatorId: e.operatorId, shiftId: e.shiftId, uid, status });
      }
    }),
  ]);

  // `auditLogEntrySchema`'s own doc comment: "actorUid may be the literal 'system' for
  // platform-initiated actions with no human actor" — this trigger fires off a status write, not a
  // callable, so there is no caller uid to attribute it to.
  await audit(deps, {
    operatorId: e.operatorId,
    actorUid: 'system',
    action: 'scheduling.tipPool',
    target: e.shiftId,
    after: { total: totalTips, allocations, ...(staleUids.length > 0 ? { reconciledStaleUids: staleUids } : {}) },
  });
}

// retry: true — every write above is idempotent for the same shift/ticket/clockEvents state (see
// tipPoolHandler's own doc comment): the `tipPool` update recomputes the same deterministic value,
// and the payout docs are `.set()` at deterministic ids, so a crash-then-redelivery converges to the
// same end state rather than risking a half-applied pool.
export const onShiftWritten = onDocumentWritten({ document: 'operators/{op}/shifts/{shiftId}', retry: true }, async (event) => {
  const afterData = event.data?.after.data() as Record<string, unknown> | undefined;
  const beforeData = (event.data?.before.data() as Record<string, unknown> | undefined) ?? null;
  await tipPoolHandler(makeDeps(), { operatorId: event.params.op, shiftId: event.params.shiftId, before: beforeData, after: afterData });
});
