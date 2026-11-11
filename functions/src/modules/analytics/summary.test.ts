import { beforeEach, describe, expect, it } from 'vitest';
import { callables, type MetricsDaily, type VenueMetrics } from '@goldstar/platform';
import { analyticsSummaryHandler } from './summary.js';
import type { Caller } from '../../lib/callable.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function vm(over: Partial<VenueMetrics>): VenueMetrics {
  return {
    tickets: 0, retrievalP50: null, retrievalP90: null, throughputPerAttendantHour: null,
    tips: 0, avgTip: null, tipRate: null, revenue: 0, damageReports: 0, claims: 0, laborCostPerVehicle: null, laborCostTotal: 0, platformFees: 0, refundedTotal: 0,
    hourly: Array.from({ length: 24 }, () => 0),
    driveHome: { jobs: 0, completionSec: null, chaseUtilization: null }, rides: { jobs: 0 },
    credentialCompliance: null, offlineSyncSuccess: null,
    ...over,
  };
}

async function seedDay(deps: ReturnType<typeof testDeps>, day: string, venues: Record<string, VenueMetrics>): Promise<void> {
  const operator = Object.values(venues)[0] ?? vm({}); // single-venue test fixtures: operator mirrors the one venue
  const doc: MetricsDaily = { venues, operator, day, updatedAt: deps.now() };
  await deps.db.doc(P.metricsDay(OP, day)).set(doc);
}

describe('analyticsSummaryHandler — access control', () => {
  it('denies a non-manager role', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-02' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('denies a manager on a suspended operator', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      analyticsSummaryHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-02' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('platform_admin (auditQuery-class exemption) can still inspect a suspended operator', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', { v1: vm({ tickets: 3 }) });
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await analyticsSummaryHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-01' });
    expect(out.operator.tickets).toBe(3);
  });

  it('rejects an inverted range', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: '2026-08-10', to: '2026-08-01' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects a range longer than the max', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: '2025-01-01', to: '2026-08-01' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('analyticsSummaryHandler — aggregation math', () => {
  it('sums exact fields and weight-averages rate fields across a 2-day range; a missing day in the previous period contributes nothing and a null rate is skipped, not zeroed', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', {
      v1: vm({ tickets: 10, retrievalP50: 200, retrievalP90: 400, throughputPerAttendantHour: 2, tips: 1000, avgTip: 100, tipRate: 50, revenue: 5000, damageReports: 1, claims: 0, laborCostPerVehicle: 300, laborCostTotal: 3000, platformFees: 100, driveHome: { jobs: 2, completionSec: 600, chaseUtilization: 40 }, rides: { jobs: 1 }, credentialCompliance: 80, offlineSyncSuccess: 90 }),
    });
    await seedDay(deps, '2026-08-02', {
      v1: vm({ tickets: 20, retrievalP50: 300, retrievalP90: 500, throughputPerAttendantHour: 4, tips: 2000, avgTip: 200, tipRate: 60, revenue: 8000, damageReports: 2, claims: 1, laborCostPerVehicle: 350, laborCostTotal: 5000, platformFees: 200, driveHome: { jobs: 4, completionSec: 700, chaseUtilization: 50 }, rides: { jobs: 3 }, credentialCompliance: 100, offlineSyncSuccess: 70 }),
    });
    // Previous period = ['2026-07-30','2026-07-31'] (same 2-day length, immediately preceding).
    // '2026-07-30' is deliberately left UNSEEDED — proves a missing day contributes nothing.
    await seedDay(deps, '2026-07-31', { v1: vm({ tickets: 5, tips: 100, revenue: 500 }) }); // every rate field stays null

    const out = await analyticsSummaryHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-02' });

    expect(out.from).toBe('2026-08-01');
    expect(out.to).toBe('2026-08-02');
    expect(out.operator.tickets).toBe(30);
    expect(out.operator.tips).toBe(3000);
    expect(out.operator.revenue).toBe(13000);
    expect(out.operator.damageReports).toBe(3);
    expect(out.operator.claims).toBe(1);
    expect(out.operator.driveHome.jobs).toBe(6);
    expect(out.operator.rides.jobs).toBe(4);
    expect(out.operator.laborCostTotal).toBe(8000); // sum, exact — not weight-averaged
    expect(out.operator.platformFees).toBe(300);
    // Weighted by that day's own `tickets`: (200*10 + 300*20) / 30, etc.
    expect(out.operator.retrievalP50).toBeCloseTo(266.6667, 3);
    expect(out.operator.retrievalP90).toBeCloseTo(466.6667, 3);
    expect(out.operator.throughputPerAttendantHour).toBeCloseTo(3.3333, 3);
    // Fix round 1 (Critical #1): `avgTip` is `moneySchema` (int-typed) — the weighted-average
    // result (166.6667) is now `Math.round`ed before being returned, not left as a raw float that
    // would throw at the real callable's `.output.parse()` boundary.
    expect(out.operator.avgTip).toBe(167); // round(5000/30) = round(166.6667)
    expect(out.operator.tipRate).toBeCloseTo(56.6667, 3);
    // Fix round 1 (Major #2): `laborCostPerVehicle` is no longer a weighted average of daily-rounded
    // values (which drifts from double-rounding) — it's derived directly from this SAME function's
    // own exact `laborCostTotal`/`tickets` sums: round(8000/30), not the old weighted-avg ~333.
    expect(out.operator.laborCostPerVehicle).toBe(267); // round(8000/30) = round(266.6667)
    // Weighted by that day's own `driveHome.jobs`: (600*2 + 700*4) / 6, etc.
    expect(out.operator.driveHome.completionSec).toBeCloseTo(666.6667, 3);
    expect(out.operator.driveHome.chaseUtilization).toBeCloseTo(46.6667, 3);
    // Weighted 1-per-day (no better denominator persisted): (80 + 100) / 2, (90 + 70) / 2.
    expect(out.operator.credentialCompliance).toBe(90);
    expect(out.operator.offlineSyncSuccess).toBe(80);
    expect(out.venues.v1).toEqual(out.operator); // single venue, no filter -> identical

    expect(out.previousPeriod.from).toBe('2026-07-30');
    expect(out.previousPeriod.to).toBe('2026-07-31');
    expect(out.previousPeriod.operator.tickets).toBe(5); // only 07-31 contributed; 07-30 (missing) added nothing
    expect(out.previousPeriod.operator.tips).toBe(100);
    expect(out.previousPeriod.operator.revenue).toBe(500);
    expect(out.previousPeriod.operator.retrievalP50).toBeNull(); // the one contributing day's own value was null -> skipped, not treated as 0
    // Per-venue previous-period breakdown (for the dashboard's growth-signals comparison) — same
    // single-venue-mirrors-operator identity as the current period.
    expect(out.previousPeriod.venues.v1).toEqual(out.previousPeriod.operator);
  });

  /**
   * Fix round 1 (Critical #1, MANDATORY per task-7-review.md): the handler's return value alone is
   * NOT sufficient evidence this callable works — `defineCallable` (`lib/callable.ts:181`) runs
   * `callables[name].output.parse(out)` on every real invocation, and NOTHING in this file exercised
   * that schema-validated boundary before this fix, which is exactly how the `avgTip`/
   * `laborCostPerVehicle` float-vs-`moneySchema.int()` bug shipped invisibly through 1,278 passing
   * tests. This test re-parses the handler's output through the REAL installed output schema — the
   * same call `defineCallable` makes — using a fixture engineered to produce a non-integer weighted
   * average for every rate/percentage field (2 days, uneven ticket counts), so a regression of this
   * exact class throws here instead of only inside a live Cloud Function invocation.
   */
  it('the real output schema (not just the handler return value) accepts a multi-day range with fractional weighted-average intermediates', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', {
      v1: vm({ tickets: 7, retrievalP50: 111, retrievalP90: 222, throughputPerAttendantHour: 1.5, tips: 777, avgTip: 111, tipRate: 33, revenue: 3333, laborCostPerVehicle: 99, laborCostTotal: 777, platformFees: 17, driveHome: { jobs: 3, completionSec: 333, chaseUtilization: 17 }, rides: { jobs: 2 }, credentialCompliance: 71, offlineSyncSuccess: 83 }),
    });
    await seedDay(deps, '2026-08-02', {
      v1: vm({ tickets: 13, retrievalP50: 222, retrievalP90: 333, throughputPerAttendantHour: 2.5, tips: 1313, avgTip: 101, tipRate: 61, revenue: 5555, laborCostPerVehicle: 88, laborCostTotal: 1234, platformFees: 29, driveHome: { jobs: 5, completionSec: 444, chaseUtilization: 29 }, rides: { jobs: 4 }, credentialCompliance: 89, offlineSyncSuccess: 79 }),
    });
    const out = await analyticsSummaryHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-02' });
    // Sanity: this fixture genuinely produces non-integer weighted-average intermediates for the
    // fields that stay `WeightedAvg`-derived — proving the schema parse below is a real exercise of
    // the bug class, not a fixture that happens to divide evenly.
    expect(Number.isInteger(out.operator.retrievalP50)).toBe(false);
    expect(() => callables.analyticsSummary.output.parse(out)).not.toThrow();
    const parsed = callables.analyticsSummary.output.parse(out);
    expect(Number.isInteger(parsed.operator.avgTip)).toBe(true);
    expect(Number.isInteger(parsed.operator.laborCostPerVehicle)).toBe(true);
  });

  it('a venueId filter restricts `venues` to that one venue and makes `operator` mirror it (not the operator-wide total)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, 'v2')).set({ id: 'v2', operatorId: OP, name: 'Second Venue', type: 'hotel', status: 'active', address: { line1: 'x', city: 'Indianapolis', region: 'IN', postalCode: '46225', country: 'US' }, geo: { lat: 0, lng: 0 }, zones: [], rates: { valet: { model: 'flat', items: [{ id: 's', label: 's', amount: 100 }], taxRateBps: 0, fees: [] }, driveHome: { base: 0, perMile: 0, perMinute: 0, minimum: 0 }, passengerRide: { base: 0, perMile: 0, perMinute: 0, minimum: 0 }, validations: { allowPartial: false, maxAmount: 0 } }, sms: {}, qr: { staticCheckoutEnabled: false }, contract: { model: 'per_ticket', terms: '', billingEmail: 'a@b.example.com', invoiceDay: 1 }, createdAt: deps.now(), updatedAt: deps.now() });
    const day = '2026-08-01';
    const v1m = vm({ tickets: 10 });
    const v2m = vm({ tickets: 99 });
    await deps.db.doc(P.metricsDay(OP, day)).set({ venues: { v1: v1m, v2: v2m }, operator: vm({ tickets: 109 }), day, updatedAt: deps.now() } satisfies MetricsDaily);

    const out = await analyticsSummaryHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: day, to: day, venueId: 'v1' });
    expect(Object.keys(out.venues)).toEqual(['v1']);
    expect(out.venues.v1?.tickets).toBe(10);
    expect(out.operator.tickets).toBe(10); // mirrors v1, NOT the operator-wide 109
  });
});

describe('analyticsSummaryHandler — carry #44: venue-scoped access and the per-day series', () => {
  // Typed as `Caller` rather than asserted: the previous `roles: [...] as string[]` widened away
  // the `Role[]` that `Caller` requires, so every use of this fixture failed TS2345. Annotating the
  // const contextually types the literal instead of casting it, which also means a future typo in a
  // role name fails here rather than being laundered through an assertion.
  const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: ['v1'] };

  it('lets a venue_user read their OWN venue, scoped', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', { v1: vm({ tickets: 4 }), v2: vm({ tickets: 99 }) });

    const out = await analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-01', venueId: 'v1' });
    expect(out.operator.tickets).toBe(4);
    expect(Object.keys(out.venues)).toEqual(['v1']);
  });

  it("SECURITY: a venue_user's scoped read never carries another venue's numbers", async () => {
    // The whole point of carry #44 — the page used to read the rollup DOCUMENT, which contains
    // every venue's bucket plus the operator aggregate, and filter in the browser.
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', { v1: vm({ tickets: 4 }), v2: vm({ tickets: 99 }) });

    const out = await analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-01', venueId: 'v1' });
    expect(JSON.stringify(out)).not.toContain('99');
    expect(out.days.every((d) => d.metrics.tickets !== 99)).toBe(true);
  });

  it('SECURITY: a venue_user with NO venueId is refused — an unscoped call is the operator-wide view', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-01' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it("SECURITY: a venue_user asking for a venue they do NOT hold is refused", async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-01', venueId: 'v2' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('SECURITY: the gate is not widened — an attendant holding the venue is still refused', async () => {
    // `requireVenueUserOrStaff`'s staff branch would admit an attendant with this venueId; the
    // role check in front of it is what keeps this callable's audience exactly as it was, plus
    // venue_user. Without that check this test passes an attendant straight through.
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      analyticsSummaryHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { from: '2026-08-01', to: '2026-08-01', venueId: 'v1' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('returns the per-day series with hourly intact, in range order', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const h = Array.from({ length: 24 }, (_, i) => (i === 19 ? 7 : 0));
    await seedDay(deps, '2026-08-01', { v1: vm({ tickets: 2, hourly: h }) });
    await seedDay(deps, '2026-08-02', { v1: vm({ tickets: 5, hourly: h }) });

    const out = await analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-02', venueId: 'v1' });
    expect(out.days.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02']);
    expect(out.days.map((d) => d.metrics.tickets)).toEqual([2, 5]);
    // `hourly` is what `venueMetricsSummary` omits and the heatmap needs — it must survive here.
    expect(out.days[0]!.metrics.hourly[19]).toBe(7);
  });

  it('unscoped, the series carries the operator bucket rather than any single venue', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const doc: MetricsDaily = { venues: { v1: vm({ tickets: 1 }) }, operator: vm({ tickets: 12 }), day: '2026-08-01', updatedAt: deps.now() };
    await deps.db.doc(P.metricsDay(OP, '2026-08-01')).set(doc);

    const out = await analyticsSummaryHandler(deps, { uid: 'o1', operatorId: OP, roles: ['owner'], venueIds: [] }, { from: '2026-08-01', to: '2026-08-01' });
    expect(out.days.map((d) => d.metrics.tickets)).toEqual([12]);
  });

  it('a day with no bucket for this venue is SKIPPED, not emitted as a zero day', async () => {
    // A venue that did not exist yet did not have a zero-vehicle day; drawing one asserts
    // something the rollup does not say.
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', { v2: vm({ tickets: 3 }) });
    await seedDay(deps, '2026-08-02', { v1: vm({ tickets: 5 }), v2: vm({ tickets: 3 }) });

    const out = await analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-02', venueId: 'v1' });
    expect(out.days.map((d) => d.day)).toEqual(['2026-08-02']);
  });

  it('the output parses against the installed contract', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedDay(deps, '2026-08-01', { v1: vm({ tickets: 2 }) });
    const out = await analyticsSummaryHandler(deps, HOST, { from: '2026-08-01', to: '2026-08-01', venueId: 'v1' });
    expect(() => callables.analyticsSummary.output.parse(out)).not.toThrow();
  });
});
