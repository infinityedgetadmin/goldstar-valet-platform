import { beforeEach, describe, expect, it } from 'vitest';
import type { MetricsDaily, MetricsForecast, VenueMetrics } from '@goldstar/platform';
import { buildForecastHandler, buildVenueForecast, isoWeekString } from './forecast.js';
import { emptyVenueDayRaw, toVenueMetrics } from './rollup.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

describe('isoWeekString', () => {
  // Ground truth computed independently (node -e, ISO-8601 "nearest Thursday" definition) before
  // writing this test, not derived from `isoWeekString` itself — see task-7-report.md.
  it('matches known reference dates, including both year-boundary directions', () => {
    expect(isoWeekString('2026-08-23')).toBe('2026-W34'); // a plain Sunday mid-week-34
    expect(isoWeekString('2026-01-01')).toBe('2026-W01'); // Jan 1 is a Thursday — belongs to ITS OWN year's week 1
    expect(isoWeekString('2025-12-29')).toBe('2026-W01'); // a December Monday that belongs to the NEXT year's week 1
    expect(isoWeekString('2026-12-31')).toBe('2026-W53'); // 2026 has 53 ISO weeks
  });
});

function metricsWithHourly(hourly: number[]): VenueMetrics {
  return toVenueMetrics({ ...emptyVenueDayRaw(), hourly });
}

describe('buildVenueForecast', () => {
  it('averages same-weekday/same-hour samples across weeks, keeps weekdays separate, ceils suggestedAttendants, and skips a day missing the venue entirely', () => {
    const hourly = (h10: number, h11: number) => { const h = Array.from({ length: 24 }, () => 0); h[10] = h10; h[11] = h11; return h; };
    const docs: Pick<MetricsDaily, 'day' | 'venues'>[] = [
      { day: '2026-08-02', venues: { v1: metricsWithHourly(hourly(4, 1)) } }, // Sunday: hour10=4, hour11=1
      { day: '2026-08-09', venues: { v1: metricsWithHourly(hourly(6, 2)) } }, // Sunday: hour10=6, hour11=2
      { day: '2026-08-10', venues: { v1: metricsWithHourly(hourly(100, 0)) } }, // Monday — a different weekday, must not mix into Sunday's average
      { day: '2026-08-16', venues: {} }, // Sunday, but v1 missing entirely — must be SKIPPED, not treated as a 0 sample (NOT a 3rd Sunday with a real 0)
    ];
    const forecast = buildVenueForecast(docs, 'v1', /* targetRequestsPerAttendantHour */ 6);

    // Sunday = weekday index 0 (rows are always Sunday..Saturday order — enforced by
    // `metricsForecastSchema`'s own `.refine`). hour10 samples: [4, 6] (08-16 skipped) -> mean 5.
    // hour11 samples: [1, 2] -> mean 1.5.
    expect(forecast.byWeekdayHour[0]!.weekday).toBe(0);
    expect(forecast.byWeekdayHour[0]!.hours[10]).toBe(5);
    expect(forecast.byWeekdayHour[0]!.hours[11]).toBe(1.5);
    // Monday = weekday index 1, isolated from Sunday's samples.
    expect(forecast.byWeekdayHour[1]!.hours[10]).toBe(100);
    // An hour with zero samples anywhere in the window averages to 0.
    expect(forecast.byWeekdayHour[0]!.hours[0]).toBe(0);

    expect(forecast.suggestedAttendants[0]!.hours[10]).toBe(1); // ceil(5/6) = 1
    expect(forecast.suggestedAttendants[0]!.hours[11]).toBe(1); // ceil(1.5/6) = 1
    expect(forecast.suggestedAttendants[1]!.hours[10]).toBe(17); // ceil(100/6) = 17 — proves ceiling, not rounding (100/6 = 16.67)
  });

  it('a venue with zero historical data forecasts an all-zero grid, not a crash', () => {
    const forecast = buildVenueForecast([], 'v1', 6);
    expect(forecast.byWeekdayHour.every((row) => row.hours.every((v) => v === 0))).toBe(true);
    expect(forecast.suggestedAttendants.every((row) => row.hours.every((v) => v === 0))).toBe(true);
  });
});

describe('buildForecastHandler', () => {
  it('reads the trailing 28-day window, honors platform/config.targetRequestsPerAttendantHour, and writes to the correct isoWeek doc', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc('platform/config').set({ tipPresets: [18, 20, 25], laborRateDefault: 1800, targetRequestsPerAttendantHour: 2, rideEndorsements: [] });

    // One full trailing week (yesterday back 7 days) of daily docs, so every weekday has exactly
    // ONE sample — isolates this test to WIRING (read range / config / write path), not the
    // averaging math itself (already covered by `buildVenueForecast`'s own unit tests above).
    const yesterday = '2026-08-22'; // Saturday
    for (let i = 0; i < 7; i++) {
      const day = new Date(Date.parse(yesterday) - i * 86_400_000).toISOString().slice(0, 10);
      const hourly = Array.from({ length: 24 }, () => 0);
      hourly[9] = 5;
      const vm: VenueMetrics = { ...toVenueMetrics(emptyVenueDayRaw()), hourly };
      const doc: MetricsDaily = { venues: { [V1]: vm }, operator: vm, day, updatedAt: deps.now() };
      await deps.db.doc(P.metricsDay(OP, day)).set(doc);
    }

    const result = await buildForecastHandler(deps);
    expect(result.operators).toBe(1);
    expect(result.venues).toBe(1);

    // "today" (NOW = 2026-08-23T21:00:00.000Z, Indianapolis EDT) is a Sunday -> isoWeek 2026-W34.
    const stored = (await deps.db.doc(P.metricsForecastWeek(OP, '2026-W34')).get()).data() as MetricsForecast | undefined;
    expect(stored?.isoWeek).toBe('2026-W34');
    expect(stored?.weeksAveraged).toBe(1); // 7 of 28 candidate days had data -> round(7/7) = 1
    // Yesterday (2026-08-22) is a Saturday = weekday index 6; its lone sample is hourly[9] = 5.
    expect(stored?.venues[V1]?.byWeekdayHour[6]?.hours[9]).toBe(5);
    expect(stored?.venues[V1]?.suggestedAttendants[6]?.hours[9]).toBe(3); // ceil(5/2) = 3, using the SEEDED target of 2, not the schema default of 6
  });

  it('a brand-new operator with zero rollup history still gets a (zeroed) forecast doc, not a crash', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const result = await buildForecastHandler(deps);
    expect(result.operators).toBe(1);
    const stored = (await deps.db.doc(P.metricsForecastWeek(OP, '2026-W34')).get()).data() as MetricsForecast | undefined;
    expect(stored?.weeksAveraged).toBe(0);
    expect(stored?.venues[V1]?.byWeekdayHour[0]?.hours[0]).toBe(0);
  });

  it('a suspended operator is excluded', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const result = await buildForecastHandler(deps);
    expect(result.operators).toBe(0);
    expect((await deps.db.doc(P.metricsForecastWeek(OP, '2026-W34')).get()).exists).toBe(false);
  });
});
