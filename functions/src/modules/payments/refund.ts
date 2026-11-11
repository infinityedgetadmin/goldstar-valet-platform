import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue } from 'firebase-admin/firestore';
import type { Operator, Ticket } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import type { PaymentGateway } from './port.js';
import { getGateway } from './registry.js';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

// Ruling AQ (1d final review, finding 10): the caller must be able to distinguish "actually refunded/
// voided" from every non-success outcome without inferring it from a possibly-stale `lastRefundRef`
// left over from a PRIOR refund on the same ticket. 'noop' covers every claim-transaction bail-out
// (already in progress, no lastIntentId, wrong status, or — Ruling AJ — a backoff window still open).
export type RefundOutcome = 'refunded' | 'voided' | 'retry_scheduled' | 'gave_up' | 'noop';

export async function refundRequestedHandler(deps: Deps, e: { operatorId: string; ticketId: string }, gateway?: PaymentGateway): Promise<RefundOutcome> {
  const ref = deps.db.doc(P.ticket(e.operatorId, e.ticketId));
  const claimed = await deps.db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const p = (s.data() as Ticket).payment;
    if (!p?.refundRequested || p.refundInProgress || !p.lastIntentId || !['paid', 'authorized'].includes(p.status)) return null;
    // Ruling AJ (finding 3): the catch branch below sets refundRequested:false→true to schedule a
    // backoff retry, which immediately re-fires onPaymentRefundRequested below — without this check
    // that re-fire re-claims instantly and burns through all 5 attempts in seconds instead of waiting
    // out the backoff window. Only retryRefunds' scheduled sweep (which queries refundRetryAt <= now)
    // may claim before the window elapses.
    if (p.refundRetryAt && p.refundRetryAt > deps.now()) return null;
    // refundClaimedAt marks when this attempt took the claim — reclaimStuckRefunds below uses it to
    // detect a claim that crashed before either branch below could clear refundInProgress.
    tx.update(ref, { 'payment.refundRequested': false, 'payment.refundInProgress': true, 'payment.refundClaimedAt': deps.now() });
    return p;
  });
  if (!claimed) return 'noop';
  const op = (await deps.db.doc(P.operator(e.operatorId)).get()).data() as Operator;
  const gw = gateway ?? getGateway(deps, op);
  // Ruling AH (finding 1): amount/reason travel on the ticket doc, persisted atomically with
  // refundRequested:true by every producer (staffRefund, the ticket-cancel trigger, staffCancel) —
  // read from the SAME claimed snapshot every re-entry path (trigger race, post-failure retry,
  // reclaim sweep) sees, instead of being passed as call-site arguments that a concurrent/later
  // invocation of this handler would never have.
  const amount = claimed.refundAmount;
  const reason = claimed.refundReason ?? 'ticket cancelled';
  try {
    if (claimed.status === 'authorized') {
      // Plan 5 T2 fix (pre-flight CRITICAL CONFLICT flag): this branch was previously dead for every
      // ticket EXCEPT jobs — valet payments never reach 'authorized' (always capture:'automatic'), so
      // it was untested against a real requires_capture intent until drive_home/passenger_ride jobs
      // started reaching this state. `cancelIntent`'s F2 guard treats requires_capture as
      // "already paid" and throws `payment_already_paid`, which would have made every legitimate
      // authorized-job cancellation fail here, get caught by the try/catch below, and burn through 5
      // retry attempts before giving up — never actually voiding the authorization. `cancelAuthorization`
      // (stripe.adapter.ts) is the correct, deliberately distinct port method for voiding an intent
      // that IS at requires_capture; see its own comment for the full contrast with cancelIntent.
      await gw.cancelAuthorization({ providerRef: claimed.lastIntentId!, reason: 'requested_by_customer' });
      // Clear the backoff bookkeeping for THIS attempt-cycle — otherwise a stale future refundRetryAt
      // left over from an earlier failed attempt of the SAME request could block a later, entirely
      // NEW refund request on this ticket (AK makes repeat partial refunds a real product flow).
      // Ruling AX (finding N1): also clear refundAmount/refundReason/refundRequestId — otherwise a
      // NEXT refund request whose producer doesn't happen to overwrite every field (e.g. the
      // cancel-trigger/staffCancel paths never set refundAmount/refundReason at all; staffRefund only
      // conditionally sets refundAmount) would read THIS resolved request's stale amount/reason instead
      // of its own.
      // Fix round 1 (review N3): `'refunded'` here is a REUSE, not a distinct "voided" status — no
      // money ever moved for a cancelAuthorization void (the card was never captured), unlike every
      // other producer of `'refunded'`, which always means a real charge was reversed.
      // `paymentStateSchema`'s status enum is fixed and has no `'voided'`/`'cancelled'` value; adding
      // one is real, if additive, contract churn (a new enum member every switch/comparison over
      // `payment.status` across this repo AND every consumer — mobile, dashboard, web — would need to
      // at least be aware of) that this fix round chose not to take on for a display-only nit.
      // `lastRefundRef: 'void'` (below) is the documented way to tell the two apart — no
      // `transactions/{id}` ledger row is created for this path either (that only happens via the
      // webhook-driven `applyPaymentEvent`), so there is no double-counted-revenue risk from the
      // reuse; only a staff/finance view that reads `payment.status` without also checking
      // `lastRefundRef === 'void'` would mislabel a never-charged card as "refunded".
      await ref.update({
        'payment.refundInProgress': false,
        'payment.status': 'refunded',
        'payment.lastRefundRef': 'void',
        'payment.refundRetryAt': FieldValue.delete(),
        'payment.refundAttempts': FieldValue.delete(),
        'payment.refundAmount': FieldValue.delete(),
        'payment.refundReason': FieldValue.delete(),
        'payment.refundRequestId': FieldValue.delete(),
      });
      await audit(deps, { operatorId: e.operatorId, actorUid: 'system', action: 'payment.refund', target: e.ticketId, after: { amount: amount ?? 'full', reason } });
      return 'voided';
    }
    // Deterministic per-logical-refund key: stable across reclaim/retry of the SAME refund request
    // (refundRequestId is a nonce minted once by the producer and never touched by this handler), so
    // a slow-but-eventually-successful first attempt and a reclaim-driven retry of that same request
    // dedupe at Stripe rather than double-refunding. A DIFFERENT refund request (new staffRefund call)
    // always gets a fresh nonce, so two same-amount partial refunds never collide.
    const idempotencyKey = `refund_${e.ticketId}_${claimed.refundRequestId ?? 'legacy'}`;
    // Ruling AI (finding 2): reverse the Connect transfer only when this WAS a destination charge —
    // Stripe 400s if reverse_transfer is passed on a non-transfer charge.
    const reverseTransfer = !!op.modules.payments.connectedAccountId;
    const { refundRef } = await gw.refund({ providerRef: claimed.lastIntentId!, ...(amount !== undefined ? { amount } : {}), reason, idempotencyKey, ...(reverseTransfer ? { reverseTransfer } : {}) });
    // Same reasoning as the authorized/void branch above: clear this cycle's backoff bookkeeping AND
    // the request fields themselves (Ruling AX) — a subsequent, unrelated refund request must never
    // read this resolved request's amount/reason/nonce.
    await ref.update({
      'payment.refundInProgress': false,
      'payment.lastRefundRef': refundRef,
      'payment.refundRetryAt': FieldValue.delete(),
      'payment.refundAttempts': FieldValue.delete(),
      'payment.refundAmount': FieldValue.delete(),
      'payment.refundReason': FieldValue.delete(),
      'payment.refundRequestId': FieldValue.delete(),
    });
    await audit(deps, { operatorId: e.operatorId, actorUid: 'system', action: 'payment.refund', target: e.ticketId, after: { amount: amount ?? 'full', reason } });
    return 'refunded';
  } catch (err) {
    const attempts = (claimed.refundAttempts ?? 0) + 1;
    const give = attempts >= 5;
    await ref.update({
      'payment.refundInProgress': false,
      'payment.refundRequested': !give,
      'payment.refundAttempts': attempts,
      'payment.refundRetryAt': new Date(Date.parse(deps.now()) + Math.min(3600, 60 * 2 ** attempts) * 1000).toISOString(),
      'payment.refundLastError': (err as Error).message.slice(0, 200),
    });
    if (give) {
      // Clear the now-permanent-give-up's backoff bookkeeping — refundRequested is already false, but
      // a stale future refundRetryAt must not silently block a later manual retry (a fresh
      // refundRequested:true + new refundRequestId written by staffRefund/staffCancel/the cancel
      // trigger) until that old window happens to elapse. Ruling AX: also clear amount/reason/nonce —
      // same staleness risk as the two success branches above.
      await ref.update({
        'payment.refundRetryAt': FieldValue.delete(),
        'payment.refundAttempts': FieldValue.delete(),
        'payment.refundAmount': FieldValue.delete(),
        'payment.refundReason': FieldValue.delete(),
        'payment.refundRequestId': FieldValue.delete(),
      });
      await audit(deps, { operatorId: e.operatorId, actorUid: 'system', action: 'payment.refund.failed', target: e.ticketId, after: { error: (err as Error).message.slice(0, 200) } });
      return 'gave_up';
    }
    return 'retry_scheduled';
  }
}

// A claim that crashed between the claim transaction (refundRequested: false, refundInProgress:
// true) and either completion branch clearing refundInProgress leaves the ticket permanently stuck
// — refundRequested is false, so the normal retry query above never finds it again. Sweep for claims
// stuck in progress past a 10-minute window and reset them back to refundRequested: true (only if
// still in progress — a claim that finished normally between the query and this transaction must not
// be reopened). The reset write flips payment.refundRequested false→true, which re-fires
// onPaymentRefundRequested below — that trigger is what actually re-attempts the refund, not this
// sweep directly.
export async function reclaimStuckRefunds(deps: Deps): Promise<void> {
  const cutoff = new Date(Date.parse(deps.now()) - 10 * 60_000).toISOString();
  const q = await deps.db
    .collectionGroup('tickets')
    .where('payment.refundInProgress', '==', true)
    .where('payment.refundClaimedAt', '<=', cutoff)
    .limit(50)
    .get();
  for (const d of q.docs) {
    await deps.db.runTransaction(async (tx) => {
      const s = await tx.get(d.ref);
      const p = (s.data() as Ticket).payment;
      if (!p?.refundInProgress) return; // resolved (or reclaimed already) since the query ran
      tx.update(d.ref, { 'payment.refundRequested': true, 'payment.refundInProgress': false });
    });
  }
}

export const retryRefunds = onSchedule({ schedule: 'every 10 minutes', secrets: [STRIPE_SECRET_KEY] }, async () => {
  const deps = makeDeps();
  await reclaimStuckRefunds(deps);
  const q = await deps.db.collectionGroup('tickets').where('payment.refundRequested', '==', true).where('payment.refundRetryAt', '<=', deps.now()).limit(50).get();
  for (const d of q.docs) await refundRequestedHandler(deps, { operatorId: d.data().operatorId as string, ticketId: d.id });
});

export const onPaymentRefundRequested = onDocumentUpdated({ document: 'operators/{op}/tickets/{ticketId}', secrets: [STRIPE_SECRET_KEY] }, async (event) => {
  const before = event.data?.before.data() as { payment?: { refundRequested?: boolean } } | undefined;
  const after = event.data?.after.data() as { payment?: { refundRequested?: boolean } } | undefined;
  if (!after || before?.payment?.refundRequested === true || after.payment?.refundRequested !== true) return;
  await refundRequestedHandler(makeDeps(), { operatorId: event.params.op, ticketId: event.params.ticketId });
});
