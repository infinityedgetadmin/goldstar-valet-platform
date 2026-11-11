import { beforeEach, describe, expect, it } from 'vitest';
import type { MetricsDaily, Operator } from '@goldstar/platform';
import { addDays, dayStringInTz, emptyVenueDayRaw, hourInTz, rollupMetricsHandler, rollupOperatorDay, startOfDayUtcMs, toVenueMetrics, type VenueDayRaw } from './rollup.js';
import { applyPaymentEvent } from '../payments/applyEvent.js';
import { OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Deps } from '../../lib/deps.js';

const TZ = 'America/Indiana/Indianapolis'; // EDT (UTC-4) in August — matches `seedOperator`'s operator timezone.
const DAY = '2026-08-23';

beforeEach(async () => {
  await wipe(testDeps());
});

describe('timezone/day helpers', () => {
  it('startOfDayUtcMs finds Indianapolis EDT local midnight (UTC-4 in August)', () => {
    expect(new Date(startOfDayUtcMs(DAY, TZ)).toISOString()).toBe('2026-08-23T04:00:00.000Z');
  });

  it('dayStringInTz buckets an instant just after UTC midnight into the PREVIOUS local day', () => {
    // 2026-08-24T02:00:00Z minus 4h = 2026-08-23T22:00 local — still the 23rd in Indianapolis.
    expect(dayStringInTz(Date.parse('2026-08-24T02:00:00.000Z'), TZ)).toBe('2026-08-23');
    expect(dayStringInTz(Date.parse('2026-08-24T05:00:00.000Z'), TZ)).toBe('2026-08-24');
  });

  it('hourInTz converts a UTC instant to the venue-local hour', () => {
    expect(hourInTz('2026-08-23T21:00:00.000Z', TZ)).toBe(17); // 9pm UTC - 4h = 5pm local
    expect(hourInTz('2026-08-23T04:00:00.000Z', TZ)).toBe(0); // exactly local midnight
  });

  it('addDays does pure calendar arithmetic, including month/year rollover', () => {
    expect(addDays('2026-08-23', 1)).toBe('2026-08-24');
    expect(addDays('2026-08-23', -23)).toBe('2026-07-31');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('toVenueMetrics', () => {
  it('derives every rate/percentile field exactly from a raw accumulator', () => {
    const raw: VenueDayRaw = {
      ticketsCount: 2, retrievalSecs: [300, 900], deliveredCount: 1,
      tipsTotal: 300, revenueTotal: 3210, txnCount: 2, tippedTxnCount: 1, platformFeesTotal: 96, refundedTotal: 25,
      laborCostTotal: 30400, clockedHoursTotal: 16, driverClockedHoursTotal: 8, chaseHoursTotal: 0.5,
      driveHomeJobs: 1, driveHomeTripSecs: [1800], ridesJobs: 1,
      damageReportsCount: 1, claimsCount: 1,
      hourly: Array.from({ length: 24 }, () => 0),
      credentialCompliance: 50, offlineSyncSuccess: 80,
    };
    expect(toVenueMetrics(raw)).toEqual({
      tickets: 2, retrievalP50: 300, retrievalP90: 900, throughputPerAttendantHour: 1 / 16,
      tips: 300, avgTip: 300, tipRate: 50, revenue: 3210,
      damageReports: 1, claims: 1, laborCostPerVehicle: 15200, laborCostTotal: 30400, platformFees: 96, refundedTotal: 25,
      hourly: raw.hourly,
      driveHome: { jobs: 1, completionSec: 1800, chaseUtilization: 6.25 },
      rides: { jobs: 1 },
      credentialCompliance: 50, offlineSyncSuccess: 80,
    });
  });

  it('nullable-rate fields fall back to null (never 0) when their denominator is zero', () => {
    const raw = emptyVenueDayRaw();
    const vm = toVenueMetrics(raw);
    expect(vm.retrievalP50).toBeNull();
    expect(vm.retrievalP90).toBeNull();
    expect(vm.throughputPerAttendantHour).toBeNull();
    expect(vm.avgTip).toBeNull();
    expect(vm.tipRate).toBeNull();
    expect(vm.laborCostPerVehicle).toBeNull();
    expect(vm.driveHome.completionSec).toBeNull();
    expect(vm.driveHome.chaseUtilization).toBeNull();
    expect(vm.tickets).toBe(0);
    expect(vm.tips).toBe(0);
  });
});

async function seedTicket(deps: Deps, id: string, over: Record<string, unknown>): Promise<void> {
  await deps.db.doc(P.ticket(OP, id)).set({
    id, operatorId: OP, venueId: V1, jobType: 'valet', status: 'checked_in', source: 'staff',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, vehicle: {},
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: {}, times: {}, damageReportIds: [], incidentIds: [], guestToken: `token_${id}`,
    ...over,
  });
}

async function seedFullVenueDayFixture(deps: Deps): Promise<void> {
  await seedOperator(deps);

  // Two valet tickets: T1 checked in 10am local (hour 10) w/ a fast retrieval + a delivery + a
  // damage report + a claim; T2 checked in 4pm local (hour 16) w/ a slower retrieval, still open.
  await seedTicket(deps, 't1', {
    times: { checkedInAt: '2026-08-23T14:00:00.000Z', readyAt: '2026-08-23T14:10:00.000Z', deliveredAt: '2026-08-23T14:20:00.000Z' },
    metrics: { retrievalSec: 300 },
  });
  await seedTicket(deps, 't2', {
    times: { checkedInAt: '2026-08-23T20:00:00.000Z', readyAt: '2026-08-23T20:15:00.000Z' },
    metrics: { retrievalSec: 900 },
  });
  // Drive-home + passenger-ride jobs, both completed within the day window.
  await seedTicket(deps, 't3', {
    jobType: 'drive_home', status: 'completed', times: { checkedInAt: '2026-08-23T17:00:00.000Z', completedAt: '2026-08-23T18:00:00.000Z' },
    metrics: { tripSec: 1800 }, attendants: { chaseDriverUid: 'driver1' },
  });
  await seedTicket(deps, 't4', {
    jobType: 'passenger_ride', status: 'completed', times: { checkedInAt: '2026-08-23T18:30:00.000Z', completedAt: '2026-08-23T19:00:00.000Z' },
  });

  await deps.db.doc(P.damage(OP, 'dr1')).set({
    id: 'dr1', operatorId: OP, ticketId: 't1', vehicleSnapshot: {}, phase: 'check_in', diagramMarks: [], notes: '', createdBy: 'att1', createdAt: '2026-08-23T21:00:00.000Z',
  });
  await deps.db.doc(P.claim(OP, 'cl1')).set({
    id: 'cl1', operatorId: OP, ticketId: 't1', status: 'intake', reportedAt: '2026-08-23T21:00:00.000Z', description: 'scratch', allegedDamage: [], guestContact: {}, createdBy: 'att1', createdAt: '2026-08-23T21:00:00.000Z',
  });

  await deps.db.doc(P.tx(OP, 'tx1')).set({ id: 'tx1', operatorId: OP, venueId: V1, ticketId: 't1', provider: 'stripe', providerRef: 'tx1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', method: 'web', at: '2026-08-23T15:00:00.000Z', platformFee: 45 });
  await deps.db.doc(P.tx(OP, 'tx2')).set({ id: 'tx2', operatorId: OP, venueId: V1, ticketId: 't2', provider: 'stripe', providerRef: 'tx2', kind: 'charge', status: 'succeeded', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', method: 'web', at: '2026-08-23T20:30:00.000Z', platformFee: 45 });
  // A FAILED transaction in the same window must not count anywhere — proves the `succeeded`-only filter.
  await deps.db.doc(P.tx(OP, 'tx3')).set({ id: 'tx3', operatorId: OP, venueId: V1, ticketId: 't2', provider: 'stripe', providerRef: 'tx3', kind: 'charge', status: 'failed', base: 1500, tip: 500, tax: 105, fees: 0, total: 2105, currency: 'USD', method: 'web', at: '2026-08-23T20:31:00.000Z' });

  await deps.db.doc(P.shift(OP, 'shift1')).set({
    id: 'shift1', operatorId: OP, venueId: V1, date: DAY, startsAt: '2026-08-23T13:00:00.000Z', endsAt: '2026-08-23T21:00:00.000Z', status: 'closed',
    assignments: [
      { uid: 'att1', role: 'attendant', startsAt: '2026-08-23T13:00:00.000Z', endsAt: '2026-08-23T21:00:00.000Z', confirmed: true },
      { uid: 'driver1', role: 'driver', startsAt: '2026-08-23T13:00:00.000Z', endsAt: '2026-08-23T21:00:00.000Z', confirmed: true },
    ],
    notes: '', assignedUids: ['att1', 'driver1'], source: { provider: 'internal' },
  });
  await deps.db.doc(P.clockEvent(OP, 'shift1', 'c1')).set({ id: 'c1', uid: 'att1', type: 'in', at: '2026-08-23T13:00:00.000Z', deviceId: 'd1' });
  await deps.db.doc(P.clockEvent(OP, 'shift1', 'c2')).set({ id: 'c2', uid: 'att1', type: 'out', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
  await deps.db.doc(P.clockEvent(OP, 'shift1', 'c3')).set({ id: 'c3', uid: 'driver1', type: 'in', at: '2026-08-23T13:00:00.000Z', deviceId: 'd2' });
  await deps.db.doc(P.clockEvent(OP, 'shift1', 'c4')).set({ id: 'c4', uid: 'driver1', type: 'out', at: '2026-08-23T21:00:00.000Z', deviceId: 'd2' });

  // att1 has NO hourlyRate — must fall back to platform/config.laborRateDefault (1800, the schema
  // default; `platform/config` is deliberately left unseeded to prove the fallback, not just the
  // happy path where the doc exists).
  await deps.db.doc(P.user(OP, 'att1')).set({ uid: 'att1', operatorId: OP, displayName: 'Att One', email: 'att1@x.example.com', roles: ['attendant'], venueIds: ['v1'], status: 'active', invitedAt: DAY, fcmTokens: [] });
  await deps.db.doc(P.user(OP, 'driver1')).set({ uid: 'driver1', operatorId: OP, displayName: 'Driver One', email: 'driver1@x.example.com', roles: ['driver'], venueIds: ['v1'], status: 'active', invitedAt: DAY, fcmTokens: [], hourlyRate: 2000, eligibility: { driveHome: true, passengerRide: false, reasons: [] } });
  await deps.db.doc(P.user(OP, 'driver2')).set({ uid: 'driver2', operatorId: OP, displayName: 'Driver Two', email: 'driver2@x.example.com', roles: ['driver'], venueIds: ['v1'], status: 'active', invitedAt: DAY, fcmTokens: [], eligibility: { driveHome: false, passengerRide: false, reasons: ['license_missing'] } });

  await deps.db.doc('telemetry/driver1').set({ operatorId: OP, day: DAY, photosUploaded: 10, photosNeedsAttention: 2, writesPending: 0, appVersion: '1.0.0', platform: 'ios', updatedAt: '2026-08-23T21:00:00.000Z' });
}

describe('rollupOperatorDay — exact numbers from a seeded fixture', () => {
  it('computes every metric exactly, for the single venue AND the operator aggregate', async () => {
    const deps = testDeps();
    await seedFullVenueDayFixture(deps);
    const op = (await deps.db.doc(P.operator(OP)).get()).data() as Operator;

    const result = await rollupOperatorDay(deps, op, DAY);

    const expectedHourly = Array.from({ length: 24 }, () => 0);
    expectedHourly[10] = 1; // t1 checked in 10am local
    expectedHourly[16] = 1; // t2 checked in 4pm local

    const expected = {
      tickets: 2, retrievalP50: 300, retrievalP90: 900, throughputPerAttendantHour: 1 / 16,
      tips: 300, avgTip: 300, tipRate: 50, revenue: 3210,
      damageReports: 1, claims: 1, laborCostPerVehicle: 15200, laborCostTotal: 30400, platformFees: 90, refundedTotal: 0, // tx1 (45) + tx2 (45); tx3 excluded (status: 'failed')
      hourly: expectedHourly,
      driveHome: { jobs: 1, completionSec: 1800, chaseUtilization: 6.25 },
      rides: { jobs: 1 },
      credentialCompliance: 50, offlineSyncSuccess: 80,
    };
    expect(result.venues[V1]).toEqual(expected);
    // Single-venue operator: the operator aggregate exactly mirrors the one venue's own numbers.
    expect(result.operator).toEqual(expected);
    expect(result.day).toBe(DAY);

    const stored = (await deps.db.doc(P.metricsDay(OP, DAY)).get()).data() as MetricsDaily | undefined;
    expect(stored?.venues[V1]).toEqual(expected);
  });

  it('is idempotent — recomputing the same day twice overwrites to the identical result', async () => {
    const deps = testDeps();
    await seedFullVenueDayFixture(deps);
    const op = (await deps.db.doc(P.operator(OP)).get()).data() as Operator;

    const first = await rollupOperatorDay(deps, op, DAY);
    const second = await rollupOperatorDay(deps, op, DAY);
    expect(second).toEqual(first);
  });

  it('an inactive venue is excluded from the rollup entirely', async () => {
    const deps = testDeps();
    await seedFullVenueDayFixture(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ status: 'inactive' });
    const op = (await deps.db.doc(P.operator(OP)).get()).data() as Operator;

    const result = await rollupOperatorDay(deps, op, DAY);
    expect(result.venues).toEqual({});
    expect(result.operator.tickets).toBe(0);
  });

  // C1 (final whole-branch review, blocking): applyEvent.ts used to rewrite a transaction row's `at`
  // on EVERY event, including 'refunded'. Because this rollup buckets revenue/tips by `at`'s day
  // window, a refund posted days after the charge would re-date the row into the refund day's
  // window — the charge day's already-closed rollup keeps the full original amounts, and the refund
  // day's rollup would ALSO count the same row, double-counting revenue/tips/platformFees/txnCount
  // permanently (neither day gets recomputed after its window closes). The fix (applyEvent.ts) keeps
  // `at` fixed at the original charge time once the row exists. This test proves it through the
  // actual rollup, not just at the transaction-row level (webhook.test.ts covers that unit).
  it("C1 regression: a partial refund posted days after the charge does not rewrite the transaction's `at` — the charge day's rollup is unchanged and the refund day's rollup counts nothing for it", async () => {
    const CHARGE_AT = '2026-08-23T15:00:00.000Z'; // DAY, 11am local (Indianapolis, EDT)
    const REFUND_DAY = '2026-08-25';
    const REFUND_AT = '2026-08-25T15:00:00.000Z'; // DAY + 2

    const chargeDeps = testDeps({ now: () => CHARGE_AT });
    await seedOperator(chargeDeps);
    await chargeDeps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_c1' } }));
    await applyPaymentEvent(chargeDeps, {
      kind: 'payment_succeeded', eventId: 'evt_c1', providerRef: 'pi_c1', amount: 1905, base: 1500, tip: 300, tax: 105, fees: 0, currency: 'USD', operatorId: OP, ticketId: TID,
    });

    const op = (await chargeDeps.db.doc(P.operator(OP)).get()).data() as Operator;
    const beforeRefund = await rollupOperatorDay(chargeDeps, op, DAY);
    expect(beforeRefund.venues[V1]).toMatchObject({ revenue: 1605, tips: 300, platformFees: 0 }); // base+tax, tip excluded from `revenue`

    // A goodwill partial refund lands two days later — a completely normal staffRefund flow, not an
    // edge case. Must NOT rewrite `at` (which would migrate this row into REFUND_DAY's window).
    const refundDeps = testDeps({ now: () => REFUND_AT });
    await applyPaymentEvent(refundDeps, {
      kind: 'refunded', eventId: 'evt_r1', providerRef: 'pi_c1', amount: 1905, base: 1500, tip: 300, tax: 105, fees: 0, currency: 'USD', operatorId: OP, ticketId: TID,
      refundAmount: 400, refundRef: 're_1',
    });
    const tx = (await chargeDeps.db.doc(P.tx(OP, 'pi_c1')).get()).data() as { at: string };
    expect(tx.at).toBe(CHARGE_AT); // the refund event did not rewrite it

    // The charge day's rollup, recomputed after the refund, is identical in every gross figure — no
    // double count, no migration — with exactly ONE difference: Plan 8 Task 5's `refundedTotal` now
    // shows the 400 on the CHARGE day (the day the money was taken), which is M2(b)/M2(c)'s closure.
    const afterRefundChargeDay = await rollupOperatorDay(chargeDeps, op, DAY);
    expect(afterRefundChargeDay.venues[V1]).toEqual({ ...beforeRefund.venues[V1], refundedTotal: 400 });

    // The refund day's rollup contains nothing for this transaction — no phantom second count.
    const refundDayRollup = await rollupOperatorDay(chargeDeps, op, REFUND_DAY);
    expect(refundDayRollup.venues[V1]).toMatchObject({ revenue: 0, tips: 0, platformFees: 0 });
  });

  it('#5: a partial refund nets into refundedTotal on the CHARGE day without touching gross; a second partial accumulates; a full refund drops the row from both', async () => {
    const CHARGE_AT = '2026-08-23T15:00:00.000Z';
    const chargeDeps = testDeps({ now: () => CHARGE_AT });
    await seedOperator(chargeDeps);
    await chargeDeps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_p1' } }));
    const base = { providerRef: 'pi_p1', amount: 1905, base: 1500, tip: 300, tax: 105, fees: 0, currency: 'USD', operatorId: OP, ticketId: TID };
    await applyPaymentEvent(chargeDeps, { kind: 'payment_succeeded', eventId: 'evt_p1', ...base });
    const op = (await chargeDeps.db.doc(P.operator(OP)).get()).data() as Operator;
    expect((await rollupOperatorDay(chargeDeps, op, DAY)).venues[V1]).toMatchObject({ revenue: 1605, tips: 300, refundedTotal: 0 });

    const later = testDeps({ now: () => '2026-08-25T15:00:00.000Z' });
    await applyPaymentEvent(later, { kind: 'refunded', eventId: 'evt_p1_r1', refundRef: 're_1', refundAmount: 400, ...base });
    expect((await rollupOperatorDay(chargeDeps, op, DAY)).venues[V1]).toMatchObject({ revenue: 1605, tips: 300, refundedTotal: 400 }); // gross untouched, refund visible
    await applyPaymentEvent(later, { kind: 'refunded', eventId: 'evt_p1_r2', refundRef: 're_2', refundAmount: 700, ...base }); // Stripe's cumulative amount_refunded
    expect((await rollupOperatorDay(chargeDeps, op, DAY)).venues[V1]).toMatchObject({ revenue: 1605, refundedTotal: 700 });
    // The rest comes back: the row flips to 'refunded' and leaves revenue AND refundedTotal.
    await applyPaymentEvent(later, { kind: 'refunded', eventId: 'evt_p1_r3', refundRef: 're_3', refundAmount: 1905, ...base });
    expect((await rollupOperatorDay(chargeDeps, op, DAY)).venues[V1]).toMatchObject({ revenue: 0, tips: 0, refundedTotal: 0 });
    // Refund events on a different day's window never see this row.
    expect((await rollupOperatorDay(chargeDeps, op, '2026-08-25')).venues[V1]).toMatchObject({ revenue: 0, refundedTotal: 0 });
  });

  it('#4: a full refund on a CLOSED day makes the hourly sweep revisit that day (not just today/yesterday) and consume the marker', async () => {
    const CHARGE_AT = '2026-08-23T15:00:00.000Z';
    const chargeDeps = testDeps({ now: () => CHARGE_AT });
    await seedOperator(chargeDeps);
    await chargeDeps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_f1' } }));
    const base = { providerRef: 'pi_f1', amount: 1905, base: 1500, tip: 300, tax: 105, fees: 0, currency: 'USD', operatorId: OP, ticketId: TID };
    await applyPaymentEvent(chargeDeps, { kind: 'payment_succeeded', eventId: 'evt_f1', ...base });
    const op = (await chargeDeps.db.doc(P.operator(OP)).get()).data() as Operator;
    await rollupOperatorDay(chargeDeps, op, DAY); // the day closes with the charge counted
    expect(((await chargeDeps.db.doc(P.metricsDay(OP, DAY)).get()).data() as MetricsDaily).venues[V1]).toMatchObject({ revenue: 1605 });

    // A week later the charge is fully refunded. DAY is neither today nor yesterday any more.
    const later = testDeps({ now: () => '2026-08-30T15:00:00.000Z' });
    await applyPaymentEvent(later, { kind: 'refunded', eventId: 'evt_f1_r', refundRef: 're_f', refundAmount: 1905, ...base });
    expect((await later.db.doc(P.metricsRecompute(OP, 'pi_f1')).get()).data()).toMatchObject({ at: CHARGE_AT, txId: 'pi_f1' }); // marker written IN the refund transaction
    expect(((await later.db.doc(P.metricsDay(OP, DAY)).get()).data() as MetricsDaily).venues[V1]).toMatchObject({ revenue: 1605 }); // still stale — nothing has swept yet

    await rollupMetricsHandler(later);
    expect(((await later.db.doc(P.metricsDay(OP, DAY)).get()).data() as MetricsDaily).venues[V1]).toMatchObject({ revenue: 0, tips: 0, refundedTotal: 0 }); // the closed day was revisited
    expect((await later.db.doc(P.metricsRecompute(OP, 'pi_f1')).get()).exists).toBe(false); // and the marker consumed
    // Today/yesterday were still written as before.
    expect((await later.db.doc(P.metricsDay(OP, '2026-08-30')).get()).exists).toBe(true);
    expect((await later.db.doc(P.metricsDay(OP, '2026-08-29')).get()).exists).toBe(true);
  });
});

describe('rollupMetricsHandler', () => {
  it('writes both TODAY and YESTERDAY docs for every active operator, and skips a suspended one', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps, 't1', { times: { checkedInAt: '2026-08-23T15:00:00.000Z' } });

    const result = await rollupMetricsHandler(deps);
    expect(result.operators).toBe(1);

    const today = (await deps.db.doc(P.metricsDay(OP, '2026-08-23')).get()).data() as MetricsDaily | undefined;
    const yesterday = (await deps.db.doc(P.metricsDay(OP, '2026-08-22')).get()).data() as MetricsDaily | undefined;
    expect(today?.venues[V1]?.tickets).toBe(1); // t1's checkedInAt falls in "today"
    expect(yesterday?.venues[V1]?.tickets).toBe(0); // nothing seeded for yesterday
    expect(today?.day).toBe('2026-08-23');
    expect(yesterday?.day).toBe('2026-08-22');
  });

  it('a suspended operator is skipped (the active-operator query excludes it)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });

    const result = await rollupMetricsHandler(deps);
    expect(result.operators).toBe(0);
    expect((await deps.db.doc(P.metricsDay(OP, '2026-08-23')).get()).exists).toBe(false);
  });
});
