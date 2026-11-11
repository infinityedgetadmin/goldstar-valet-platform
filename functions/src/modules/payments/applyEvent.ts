import type { Ticket } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { enqueueSms, ticketWrittenHandler } from '../tickets/ticket.handler.js';
import type { PaymentEvent } from './port.js';

interface TxRefundEntry {
  refundRef: string;
  amount: number;
  at: string;
  reason: string;
}

export async function applyPaymentEvent(deps: Deps, ev: PaymentEvent): Promise<'applied' | 'duplicate' | 'ignored'> {
  const key = deps.db.doc(P.processed('stripe', ev.eventId));
  // Plan 8 T1: account.updated is operator/ticket-less by nature — routed before the guard below
  // that treats that absence as ignorable.
  if (ev.kind === 'account_updated') return applyAccountUpdated(deps, ev, key);
  if (!ev.operatorId || !ev.ticketId) {
    await key.set({ at: deps.now(), kind: ev.kind, ignored: true });
    return 'ignored';
  }
  // Capture into locals before the transaction closure below — narrowing on ev's optional fields
  // doesn't survive a nested-function/await boundary (same reasoning as ticket.handler.ts's enqueueSms).
  const operatorId = ev.operatorId;
  const ticketId = ev.ticketId;
  const ref = deps.db.doc(P.ticket(operatorId, ticketId));
  const txRef = deps.db.doc(P.tx(operatorId, ev.providerRef));
  // ONE transaction: dedupe key + transaction row + ticket payment state — a crash anywhere leaves
  // nothing half-applied. `ticketPaid` tells the post-transaction code below (outside the txn) whether
  // a receipt is owed for this event — it can't be recomputed from the returned outcome alone.
  const result = await deps.db.runTransaction(async (tx) => {
    if ((await tx.get(key)).exists) return { outcome: 'duplicate' as const, ticketPaid: false };
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(key, { at: deps.now(), kind: ev.kind, ignored: true });
      return { outcome: 'ignored' as const, ticketPaid: false };
    }
    // Ruling AK (finding 4): read the tx row in-txn so a 'refunded' event appends to its `refunds`
    // array instead of the prior write's `{merge:true}` silently replacing it (Firestore does not
    // merge array fields element-wise) — a second partial refund on the same charge would otherwise
    // erase the first entry. Read unconditionally (harmless for non-refund kinds) so every read in
    // this transaction precedes every write, per Firestore's transaction ordering requirement.
    const txSnap = await tx.get(txRef);
    const t = snap.data() as Ticket;
    const cur = t.payment?.status;
    const method = t.payment?.method ?? 'web';
    const status = ev.kind === 'payment_succeeded' ? 'paid' : ev.kind === 'payment_authorized' ? 'authorized' : ev.kind === 'payment_failed' ? 'failed' : 'refunded';
    // Ruling AK: a partial refund (Stripe's ch.amount_refunded, cumulative across all refunds on this
    // charge, still less than the charge total) must NOT flip the ticket to 'refunded' — that's a
    // one-shot state per the current schema and would permanently block refunding the remainder
    // (staffRefund's ['paid','authorized'] gate). Stay 'paid'; only a full refund settles 'refunded'.
    const isPartialRefund = ev.kind === 'refunded' && ev.refundAmount !== undefined && ev.refundAmount < ev.amount;
    const ticketStatus = isPartialRefund ? 'paid' : status;
    // Ruling AL (finding 5a): extend the regress guard to cover paid/refunded never regressing to
    // failed (a late/out-of-order payment_failed for an intent that later succeeded) — the prior guard
    // only caught paid→authorized, missing paid→failed and refunded→failed/authorized entirely (those
    // are also covered by the `cur === 'refunded'` clause below).
    const regress = (cur === 'refunded' && status !== 'refunded') || (cur === 'paid' && ['authorized', 'failed'].includes(status)) || (['closed', 'cancelled'].includes(t.status) && status === 'authorized');
    // Ruling AL (finding 5b): an event about a DIFFERENT (older/abandoned) intent than the one
    // currently on the ticket must never touch ticket payment state or repoint lastIntentId at a dead
    // intent — by construction (checkout.ts writes lastIntentId before the client can ever confirm) an
    // event about the ticket's CURRENT intent always matches. Tx row + dedupe key still land below
    // (analytics/audit trail); only the ticket-state write is skipped.
    const staleIntent = t.payment?.lastIntentId !== ev.providerRef;
    const skipTicketUpdate = regress || staleIntent;
    const txStatus =
      ev.kind === 'payment_succeeded' ? 'succeeded' : ev.kind === 'payment_authorized' ? 'authorized' : ev.kind === 'payment_failed' ? 'failed' : isPartialRefund ? 'succeeded' : 'refunded';
    const priorRefunds: TxRefundEntry[] = (txSnap.exists ? (txSnap.data() as { refunds?: TxRefundEntry[] }).refunds : undefined) ?? [];
    // Ruling AY (finding N2): ev.refundAmount (from Stripe's ch.amount_refunded) is CUMULATIVE across
    // every refund on this charge, not this event's own delta — storing it verbatim would make each
    // array entry report the running total instead of what THAT refund actually moved. Subtract the
    // sum of prior entries to recover the delta; clamp at 0 defensively (a redelivered/reordered event
    // must never produce a negative entry).
    const priorRefundedSum = priorRefunds.reduce((sum, r) => sum + r.amount, 0);
    const refundDelta = Math.max(0, (ev.refundAmount ?? ev.amount) - priorRefundedSum);
    // Plan 8 #6 (ledger reads THEN): a REGRESSED event — Stripe re-firing amount_capturable_updated
    // after a partial capture (new event.id, `amount` = the REMAINING capturable), or any late
    // authorized/failed on a paid or refunded intent — must not rewrite a settled row. The ticket
    // was already guarded by `regress`; this write was unconditional, so a captured charge's row
    // flipped to status 'authorized' with the remainder as its total. Per-event dedupe cannot catch
    // a re-fire (it IS a new event), so the row itself has to refuse the downgrade. A stale-intent
    // event still writes ITS OWN row (a different providerRef) — that is the audit trail of an
    // abandoned intent, not a regression of this one.
    if (!(regress && txSnap.exists)) tx.set(
      txRef,
      {
        id: ev.providerRef,
        operatorId,
        venueId: t.venueId, // transactionSchema v0.3.1 requires venueId; ticket is already fetched in this txn
        ticketId,
        provider: 'stripe',
        providerRef: ev.providerRef,
        kind: 'charge',
        status: txStatus,
        base: ev.base,
        tip: ev.tip,
        tax: ev.tax,
        fees: ev.fees,
        total: ev.amount,
        currency: ev.currency,
        method,
        // Ruling (final-wave C1): `at` is the transaction's ORIGINAL charge date, set once. A later
        // event on the same row (refund, or any other merge) must never rewrite it — analytics/
        // rollup.ts buckets revenue/tips by `at`'s day window, so re-dating a row on refund would
        // silently double-count it (the charge day's already-closed rollup keeps the original amounts,
        // then the refund day's rollup counts the same row again) or migrate it across a day boundary.
        // Each refund's own timestamp is already recorded per-entry in `refunds[].at` (Ruling AY) —
        // that's the place a "when did this move" question belongs, not the row's `at`. paymentsSearch
        // (search.ts) and the dashboard's payments explorer/CSV export key on this same field; keeping
        // it fixed makes them show the charge date, not "whenever this row was last touched" — correct
        // and intended, not a side effect.
        ...(txSnap.exists ? {} : { at: deps.now() }),
        ...(ev.chargeRef ? { chargeRef: ev.chargeRef } : {}),
        ...(ev.failureMessage ? { failureMessage: ev.failureMessage } : {}),
        // Ruling AW (finding 17): platform's cut + destination account, when this was a connected
        // charge — omitted (not written as 0/undefined) for non-connected charges.
        ...(ev.applicationFee !== undefined ? { platformFee: ev.applicationFee } : {}),
        ...(ev.destinationAccountId !== undefined ? { destinationAccountId: ev.destinationAccountId } : {}),
        // Ruling AK: append, not replace — carries every prior entry (read in-txn above) forward.
        // Ruling AY: `amount` here is THIS refund's delta (refundDelta), not the cumulative total.
        ...(ev.kind === 'refunded' ? { refunds: [...priorRefunds, { refundRef: ev.refundRef ?? 'unknown', amount: refundDelta, at: deps.now(), reason: 'webhook' }] } : {}),
      },
      { merge: true },
    );
    if (!skipTicketUpdate) tx.update(ref, { 'payment.status': ticketStatus, 'payment.lastIntentId': ev.providerRef, ...(ev.kind === 'payment_succeeded' ? { 'payment.paidAt': deps.now() } : {}) });
    // Plan 8 Task 5 (carry #4): a refund — partial or full — changes what the CHARGE day's metrics
    // should say, and that day may already be closed (the sweep only revisits today/yesterday). Name
    // the row here, in the same transaction as the refund, so the sweep revisits its charge day.
    // Keyed by the transaction id: one marker per row however many refunds it takes.
    if (ev.kind === 'refunded' && txSnap.exists) {
      const rowAt = (txSnap.data() as { at?: string }).at ?? deps.now();
      tx.set(deps.db.doc(P.metricsRecompute(operatorId, ev.providerRef)), { at: rowAt, txId: ev.providerRef, markedAt: deps.now() });
    }
    tx.set(key, { at: deps.now(), kind: ev.kind, regress, staleIntent });
    // A receipt is owed only when this event ACTUALLY transitioned the ticket to paid (not a
    // regressed/stale-intent event that was skipped above).
    return { outcome: 'applied' as const, ticketPaid: ev.kind === 'payment_succeeded' && !skipTicketUpdate };
  });
  if (result.outcome !== 'applied') return result.outcome;
  const before = null;
  const after = (await ref.get()).data() as Ticket;
  // Ruling AT (finding 13): receipts are owned here — the transition-to-paid enqueues the receipt SMS.
  // Its own try/catch (separate from the projection-refresh swallow below, and sequenced before it):
  // idempotent via enqueueSms's `.create()` dedupe (id `${ticketId}_receipt`), but must not propagate
  // — an uncaught throw here would make webhook.ts respond non-200, Stripe would redeliver, and the
  // redelivery would hit the processedEvents dedupe key above and return 'duplicate' before ever
  // reaching this code again, permanently losing the one receipt to a transient error.
  if (result.ticketPaid) {
    try {
      const link = `https://${process.env.GUEST_HOST ?? 'app.goldstar.example.com'}/t/${after.guestToken}`;
      await enqueueSms(deps, operatorId, after, 'receipt', { link });
    } catch (e) {
      console.error('applyPaymentEvent receipt enqueue failed', { name: e instanceof Error ? e.name : typeof e });
    }
  }
  // The financial transaction (above) is already durable and deduped by this point — the projection
  // refresh is best-effort. A failure here (e.g. a transient read error) must not make the webhook
  // retry, because a retry would hit the processedEvents dedupe key and return 'duplicate' without
  // ever getting another chance to refresh the projection — so swallow and log name-only rather than
  // let it propagate.
  try {
    await ticketWrittenHandler(deps, { operatorId, ticketId, before, after });
  } catch (e) {
    console.error('applyPaymentEvent projection refresh failed', { name: e instanceof Error ? e.name : typeof e });
  }
  return 'applied';
}

/**
 * Consumes `account.updated` (Plan 8 T1): resolves the Connect account to its user doc
 * (collectionGroup on `stripeConnectAccountId` — COLLECTION_GROUP index in
 * firestore.indexes.json, the emailReceipt precedent) and derives `payoutStatus`:
 * `payouts_enabled` → 'active'; else outstanding requirements → 'restricted'; else 'onboarding'
 * (a stated mapping decision — Stripe has no single status field to mirror). Dedupe via the
 * same processedEvents key discipline as every other webhook kind; an accountId matching no
 * user (or, defensively, more than one) is recorded and skipped, never guessed at.
 */
async function applyAccountUpdated(deps: Deps, ev: PaymentEvent, key: FirebaseFirestore.DocumentReference): Promise<'applied' | 'duplicate' | 'ignored'> {
  if ((await key.get()).exists) return 'duplicate';
  const accountId = ev.accountId;
  if (!accountId) {
    await key.set({ at: deps.now(), kind: ev.kind, ignored: true });
    return 'ignored';
  }
  const match = await deps.db.collectionGroup('users').where('stripeConnectAccountId', '==', accountId).limit(2).get();
  if (match.size !== 1) {
    console.warn(`applyAccountUpdated: account ${accountId} matched ${match.size} users — skipped`);
    await key.set({ at: deps.now(), kind: ev.kind, ignored: true });
    return 'ignored';
  }
  const payoutStatus = ev.payoutsEnabled ? 'active' : (ev.requirementsDue?.length ?? 0) > 0 ? 'restricted' : 'onboarding';
  await match.docs[0]!.ref.update({ payoutStatus });
  await key.set({ at: deps.now(), kind: ev.kind, accountId, payoutStatus });
  return 'applied';
}
