import { beforeEach, expect, it, vi } from 'vitest';
import type { Operator, PayoutBatch } from '@goldstar/platform';
import { NOW, OP, seedOperator, testDeps, wipe } from '../../../../test/helpers.js';
import { P } from '../../../lib/paths.js';
import type { PaymentGateway } from '../port.js';
import { localClock, payoutBatchDailyHandler, sweepOperatorPayouts } from './batch.js';
import { applyPaymentEvent } from '../applyEvent.js';

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

const LOCAL_DATE = '2026-08-23';

function fakeGateway() {
  const transfers: { amount: number; destinationAccountId: string; idempotencyKey: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- gateway signature
  const transferSpy = vi.fn(async (i: { amount: number; destinationAccountId: string; idempotencyKey: string }) => {
    transfers.push(i);
    return { transferRef: `tr_${transfers.length}` };
  });
  const gateway = { transfer: transferSpy } as unknown as PaymentGateway;
  return { gateway, transfers, transferSpy };
}

async function seedUser(deps: ReturnType<typeof testDeps>, uid: string, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.user(OP, uid)).set({
    uid,
    operatorId: OP,
    displayName: uid,
    roles: ['attendant'],
    venueIds: [],
    status: 'active',
    payoutStatus: 'active',
    stripeConnectAccountId: `acct_${uid}`,
    createdAt: NOW,
    ...over,
  });
}

async function seedAllocation(deps: ReturnType<typeof testDeps>, uid: string, id: string, amount: number, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.payout(OP, uid, id)).set({ id, ticketId: id, amount, currency: 'USD', status: 'pending', createdAt: NOW, ...over });
}

async function operator(deps: ReturnType<typeof testDeps>): Promise<Operator> {
  return (await deps.db.doc(P.operator(OP)).get()).data() as Operator;
}

it('MONEY: batch math — 3 allocations across 2 users → exactly 2 transfers with exact per-uid sums, allocations paid with transferRef, batch completed', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1');
  await seedUser(deps, 'att2');
  await seedAllocation(deps, 'att1', 'a1', 700);
  await seedAllocation(deps, 'att1', 'a2', 300);
  await seedAllocation(deps, 'att2', 'a3', 500);
  const { gateway, transfers } = fakeGateway();

  const out = await sweepOperatorPayouts(deps, gateway, await operator(deps), LOCAL_DATE);
  expect(out).toEqual({ transfers: 2, flagged: 0 });
  expect(transfers).toEqual([
    { amount: 1000, currency: 'USD', destinationAccountId: 'acct_att1', idempotencyKey: `${OP}_${LOCAL_DATE}_att1`, metadata: { operatorId: OP, batchId: `${OP}_${LOCAL_DATE}`, uid: 'att1' } },
    { amount: 500, currency: 'USD', destinationAccountId: 'acct_att2', idempotencyKey: `${OP}_${LOCAL_DATE}_att2`, metadata: { operatorId: OP, batchId: `${OP}_${LOCAL_DATE}`, uid: 'att2' } },
  ]);

  const a1 = (await deps.db.doc(P.payout(OP, 'att1', 'a1')).get()).data()!;
  expect(a1).toMatchObject({ status: 'paid', transferRef: 'tr_1', batchId: `${OP}_${LOCAL_DATE}`, paidAt: NOW });

  const batch = (await deps.db.doc(P.payoutBatch(OP, `${OP}_${LOCAL_DATE}`)).get()).data() as PayoutBatch;
  expect(batch.status).toBe('completed');
  expect(batch.totalTips).toBe(1500);
  expect(batch.allocations).toEqual([
    { uid: 'att1', amount: 1000, transferRef: 'tr_1', status: 'paid' },
    { uid: 'att2', amount: 500, transferRef: 'tr_2', status: 'paid' },
  ]);
});

it('IDEMPOTENT: a rerun of the same batch id transfers NOTHING — the allocations are already paid', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1');
  await seedAllocation(deps, 'att1', 'a1', 700);
  const { gateway, transferSpy } = fakeGateway();
  const op = await operator(deps);
  await sweepOperatorPayouts(deps, gateway, op, LOCAL_DATE);
  await sweepOperatorPayouts(deps, gateway, op, LOCAL_DATE);
  expect(transferSpy).toHaveBeenCalledTimes(1);
});

it('ACCRUAL: an inactive (onboarding/restricted) user is never swept — allocations stay pending, untouched', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1', { payoutStatus: 'onboarding' });
  await seedAllocation(deps, 'att1', 'a1', 700);
  const { gateway, transferSpy } = fakeGateway();
  const out = await sweepOperatorPayouts(deps, gateway, await operator(deps), LOCAL_DATE);
  expect(out.transfers).toBe(0);
  expect(transferSpy).not.toHaveBeenCalled();
  expect((await deps.db.doc(P.payout(OP, 'att1', 'a1')).get()).data()!.status).toBe('pending');
});

it("CARRY #1, THE MONEY INVARIANT: an allocation whose funding transaction has since REFUNDED is flagged fundingRefunded, stays pending, is excluded from the transfer, and surfaces on the batch — never silently paid", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1');
  // Two allocations: one intact funding, one refunded funding.
  await deps.db.doc(P.tx(OP, 'pi_ok')).set({ id: 'pi_ok', operatorId: OP, venueId: 'v1', ticketId: '01912345-7abc-7def-8123-4567890000a1', provider: 'stripe', providerRef: 'pi_ok', kind: 'charge', status: 'succeeded', base: 1500, tip: 700, tax: 0, fees: 0, total: 2200, currency: 'USD', method: 'web', at: NOW, refunds: [] });
  await deps.db.doc(P.tx(OP, 'pi_bad')).set({ id: 'pi_bad', operatorId: OP, venueId: 'v1', ticketId: '01912345-7abc-7def-8123-4567890000a2', provider: 'stripe', providerRef: 'pi_bad', kind: 'charge', status: 'refunded', base: 1500, tip: 300, tax: 0, fees: 0, total: 1800, currency: 'USD', method: 'web', at: NOW, refunds: [{ refundRef: 'r1', amount: 1800, at: NOW, reason: 'guest' }] });
  await seedAllocation(deps, 'att1', 'a_ok', 700, { fundingRef: 'pi_ok' });
  await seedAllocation(deps, 'att1', 'a_bad', 300, { fundingRef: 'pi_bad' });
  const { gateway, transfers, transferSpy } = fakeGateway();

  const out = await sweepOperatorPayouts(deps, gateway, await operator(deps), LOCAL_DATE);
  expect(out).toEqual({ transfers: 1, flagged: 1 });
  // The transfer carries ONLY the intact allocation's amount.
  expect(transfers[0]).toMatchObject({ amount: 700 });

  const bad = (await deps.db.doc(P.payout(OP, 'att1', 'a_bad')).get()).data()!;
  expect(bad).toMatchObject({ status: 'pending', fundingRefunded: true }); // flagged, NOT paid, NOT clawed
  const batch = (await deps.db.doc(P.payoutBatch(OP, `${OP}_${LOCAL_DATE}`)).get()).data() as PayoutBatch;
  expect(batch.allocations).toContainEqual({ uid: 'att1', amount: 300, status: 'pending', lastError: 'funding_refunded' });
  expect(batch.status).toBe('partial'); // surfaced — a human decides

  // The NEXT sweep skips the flagged doc without re-checking or paying it.
  const rerun = await sweepOperatorPayouts(deps, gateway, await operator(deps), '2026-08-24');
  expect(rerun).toEqual({ transfers: 0, flagged: 0 });
  expect(transferSpy).toHaveBeenCalledTimes(1);
});

it('FAILURE: a transfer rejection keeps every allocation pending with the failure surfaced sanitized on the batch', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1');
  await seedAllocation(deps, 'att1', 'a1', 700);
  const { gateway, transferSpy } = fakeGateway();
  transferSpy.mockRejectedValueOnce(new Error('stripe: raw provider text with acct details'));

  await sweepOperatorPayouts(deps, gateway, await operator(deps), LOCAL_DATE);
  expect((await deps.db.doc(P.payout(OP, 'att1', 'a1')).get()).data()!.status).toBe('pending');
  const batch = (await deps.db.doc(P.payoutBatch(OP, `${OP}_${LOCAL_DATE}`)).get()).data() as PayoutBatch;
  expect(batch.allocations).toEqual([{ uid: 'att1', amount: 700, status: 'failed', lastError: 'transfer_failed' }]);
  expect(JSON.stringify(batch)).not.toContain('raw provider'); // sanitized
  expect(batch.status).toBe('failed');
});

it('HOUR GATE: the hourly handler sweeps only operators whose LOCAL hour is 5', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { gateway } = fakeGateway();
  // NOW (21:00Z) is 17:00 in Indianapolis — not sweep hour.
  expect(await payoutBatchDailyHandler(deps, () => gateway)).toEqual({ swept: 0 });
  // 09:00Z = 05:00 EDT — sweep hour.
  const at5 = testDeps({ now: () => '2026-08-23T09:00:00.000Z' });
  expect(await payoutBatchDailyHandler(at5, () => gateway)).toEqual({ swept: 1 });
  expect(localClock('2026-08-23T09:00:00.000Z', 'America/Indiana/Indianapolis')).toEqual({ hour: 5, date: LOCAL_DATE });
});

// ---------- account.updated → payoutStatus ----------

it("ACCOUNT.UPDATED: payouts_enabled flips the matched user to 'active'; requirements-due to 'restricted'; deduped by eventId; unknown account ignored", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedUser(deps, 'att1', { payoutStatus: 'onboarding' });

  const ev = (over: { eventId: string } & Record<string, unknown>) => ({
    kind: 'account_updated' as const,
    providerRef: 'acct_att1',
    accountId: 'acct_att1',
    payoutsEnabled: true,
    chargesEnabled: true,
    requirementsDue: [] as string[],
    amount: 0, tip: 0, base: 0, tax: 0, fees: 0, currency: 'USD',
    ...over,
  });

  expect(await applyPaymentEvent(deps, ev({ eventId: 'e1' }))).toBe('applied');
  expect((await deps.db.doc(P.user(OP, 'att1')).get()).data()!.payoutStatus).toBe('active');

  expect(await applyPaymentEvent(deps, ev({ eventId: 'e1' }))).toBe('duplicate'); // deduped

  expect(await applyPaymentEvent(deps, ev({ eventId: 'e2', payoutsEnabled: false, requirementsDue: ['individual.id_number'] }))).toBe('applied');
  expect((await deps.db.doc(P.user(OP, 'att1')).get()).data()!.payoutStatus).toBe('restricted');

  expect(await applyPaymentEvent(deps, ev({ eventId: 'e3', accountId: 'acct_nobody' }))).toBe('ignored');
});
