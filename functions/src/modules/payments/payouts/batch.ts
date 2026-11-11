import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Operator, PayoutBatch, Shift, User } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../../lib/deps.js';
import { P } from '../../../lib/paths.js';
import { audit } from '../../../lib/audit.js';
import { sumDeliveredTips } from '../../scheduling/tipPool.js';
import type { PaymentGateway } from '../port.js';
import { defineSecret } from 'firebase-functions/params';
import { getGateway } from '../registry.js';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

/** The operator-local hour the daily sweep acts at (plan: "acts when operator-local hour == 5"). */
const SWEEP_HOUR = 5;

/** Operator-local hour and calendar date for an instant — pure, testable. */
export function localClock(nowIso: string, timeZone: string): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(nowIso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { hour: Number(get('hour')) % 24, date: `${get('year')}-${get('month')}-${get('day')}` };
}

/** The allocation doc shape the sweep reads — published schema + the Admin-side fields the writers add. */
interface AllocationDoc {
  id: string;
  ticketId?: string;
  shiftId?: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed';
  createdAt: string;
  fundingRef?: string;
  fundingRefunded?: boolean;
}

/**
 * The daily payout sweep for ONE operator (Plan 8 Task 1; closes carries #1/#2). Groups pending
 * allocations by uid for `payoutStatus === 'active'` users (inactive users ACCRUE — their
 * allocations stay pending untouched, per the global constraint), one `gateway.transfer` per
 * uid, allocations → 'paid' + transferRef, batch doc `completed | partial | failed`.
 *
 * CARRY #1, THE MONEY INVARIANT (verbatim acceptance criterion from tipPool.ts's own M2(a)
 * comment): before paying, the sweep RE-READS each allocation's funding's CURRENT status —
 * guard-reads-now — and any allocation whose funding has since refunded is marked
 * `fundingRefunded: true`, STAYS 'pending', is EXCLUDED from the transfer, and is surfaced on
 * the batch doc. Never silently paid, never clawed back (M2(a): the claw-back decision is a
 * human's, not the sweep's). Two funding shapes:
 *  - ticket allocations carry `fundingRef` (the funding transaction row's id): refunded ⇔ that
 *    row's status is 'refunded' (applyEvent only sets 'refunded' on a FULL refund — a partial
 *    refund keeps 'succeeded', and the tip decision stands per M2(a)).
 *  - shift-pool allocations carry `shiftId`: the pool was funded by many transactions, so the
 *    check re-runs tipPool's own `sumDeliveredTips` over the shift window — if the CURRENT sum
 *    is below the pool total frozen at close, some funding refunded since, and every still-pending
 *    allocation of that shift is flagged rather than guessing which uid's share was funded by
 *    the refunded tip.
 *
 * IDEMPOTENCY: batch id = `{operatorId}_{localDate}`; transfer idempotencyKey =
 * `{batchId}_{uid}` (Stripe dedupes server-side, so a crash between transfer and the allocation
 * flip re-runs into the SAME transfer, not a second one); a rerun finds the allocations already
 * 'paid' and transfers nothing. The batch doc is `.create`d up front (code-6 swallow) and
 * finalized by update — polarity: the batch doc is LEDGER (it records what was transferred at
 * sweep time); every gate in here reads live state.
 */
export async function sweepOperatorPayouts(deps: Deps, gateway: PaymentGateway, op: Operator, nowLocalDate: string): Promise<{ transfers: number; flagged: number }> {
  const batchId = `${op.id}_${nowLocalDate}`;
  const batchRef = deps.db.doc(P.payoutBatch(op.id, batchId));
  await batchRef
    .create({ id: batchId, operatorId: op.id, period: nowLocalDate, totalTips: 0, currency: op.currency, allocations: [], createdAt: deps.now(), status: 'pending' } satisfies PayoutBatch)
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e; // crash-resume of today's batch
    });

  const users = await deps.db.collection(`operators/${op.id}/users`).where('payoutStatus', '==', 'active').get();
  const shiftFundingOk = new Map<string, boolean>(); // shiftId → funding intact (computed once per shift)

  let transfers = 0;
  let flagged = 0;
  const batchAllocations: PayoutBatch['allocations'] = [];
  for (const userDoc of users.docs) {
    const user = userDoc.data() as User;
    const uid = userDoc.id;
    const pendingSnap = await deps.db.collection(`operators/${op.id}/users/${uid}/payouts`).where('status', '==', 'pending').get();
    const payable: { ref: FirebaseFirestore.DocumentReference; doc: AllocationDoc }[] = [];

    for (const d of pendingSnap.docs) {
      const alloc = d.data() as AllocationDoc;
      if (alloc.fundingRefunded) continue; // already flagged on an earlier sweep — a human's call now
      // ---- carry #1: the funding cross-check, live ----
      let fundingIntact = true;
      if (alloc.fundingRef) {
        const tx = (await deps.db.doc(P.tx(op.id, alloc.fundingRef)).get()).data() as { status?: string } | undefined;
        fundingIntact = tx?.status !== 'refunded';
      } else if (alloc.shiftId) {
        let ok = shiftFundingOk.get(alloc.shiftId);
        if (ok === undefined) {
          const shift = (await deps.db.doc(P.shift(op.id, alloc.shiftId)).get()).data() as Shift | undefined;
          ok =
            !shift?.tipPool ||
            (await sumDeliveredTips(deps, op.id, shift.venueId, shift.startsAt, shift.endsAt)) >= shift.tipPool.total;
          shiftFundingOk.set(alloc.shiftId, ok);
        }
        fundingIntact = ok;
      }
      if (!fundingIntact) {
        await d.ref.update({ fundingRefunded: true });
        batchAllocations.push({ uid, amount: alloc.amount, status: 'pending', lastError: 'funding_refunded' });
        flagged++;
        continue;
      }
      payable.push({ ref: d.ref, doc: alloc });
    }

    if (payable.length === 0) continue;
    const amount = payable.reduce((s, a) => s + a.doc.amount, 0);
    const destinationAccountId = user.stripeConnectAccountId;
    if (!destinationAccountId) {
      // payoutStatus 'active' with no account is a data inconsistency, not a payable state.
      batchAllocations.push({ uid, amount, status: 'failed', lastError: 'no_connect_account' });
      continue;
    }
    try {
      const { transferRef } = await gateway.transfer({
        amount,
        currency: op.currency,
        destinationAccountId,
        idempotencyKey: `${batchId}_${uid}`,
        metadata: { operatorId: op.id, batchId, uid },
      });
      await Promise.all(payable.map((a) => a.ref.update({ status: 'paid', transferRef, batchId, paidAt: deps.now() })));
      batchAllocations.push({ uid, amount, transferRef, status: 'paid' });
      transfers++;
    } catch {
      // Failure keeps every allocation 'pending' (retried tomorrow under a new batch id) and is
      // surfaced on the batch doc — sanitized, no raw provider text.
      batchAllocations.push({ uid, amount, status: 'failed', lastError: 'transfer_failed' });
    }
  }

  const paidTotal = batchAllocations.filter((a) => a.status === 'paid').reduce((s, a) => s + a.amount, 0);
  const anyFailed = batchAllocations.some((a) => a.status !== 'paid');
  const status: PayoutBatch['status'] = batchAllocations.length === 0 || !anyFailed ? 'completed' : paidTotal > 0 ? 'partial' : 'failed';
  await batchRef.update({ totalTips: paidTotal, allocations: batchAllocations, status });
  await audit(deps, { operatorId: op.id, actorUid: 'system', action: 'payouts.batch', target: batchId, after: { transfers, flagged, status } });
  return { transfers, flagged };
}

/** Hourly schedule; acts only for operators whose LOCAL hour is SWEEP_HOUR (5am local). */
export async function payoutBatchDailyHandler(deps: Deps, gatewayFor: (op: Operator) => PaymentGateway = (op) => getGateway(deps, op)): Promise<{ swept: number }> {
  let swept = 0;
  const ops = await deps.db.collection('operators').where('status', '==', 'active').get();
  for (const opDoc of ops.docs) {
    const op = opDoc.data() as Operator;
    const { hour, date } = localClock(deps.now(), op.timezone);
    if (hour !== SWEEP_HOUR) continue;
    await sweepOperatorPayouts(deps, gatewayFor(op), op, date);
    swept++;
  }
  return { swept };
}

export const payoutBatchDaily = onSchedule({ schedule: 'every 1 hours', secrets: [STRIPE_SECRET_KEY] }, async () => {
  await payoutBatchDailyHandler(makeDeps());
});
