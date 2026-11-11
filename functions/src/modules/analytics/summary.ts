import { MANAGER_ROLES, type CallableOutput, type CallableParsedInput, type MetricsDaily, type VenueMetrics } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import { requireVenueUserOrStaff } from '../../lib/venueAccess.js';
import { err } from '../../lib/errors.js';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { addDays, parseDay } from './rollup.js';

const ALLOWED_ROLES = [...MANAGER_ROLES, 'platform_admin'] as const;
/** ~13 months — generous enough for an executive trailing-year view, small enough that a caller
 * can't turn one callable invocation into thousands of doc reads. */
const MAX_RANGE_DAYS = 400;

/** O(1) day count via UTC-ms arithmetic — checked BEFORE `daysInRange` builds the actual list
 * (Fix round 1, Minor #4: the old order built the full day-string array first and only checked
 * `MAX_RANGE_DAYS` afterward; `dayStringSchema` has no semantic year bound, so an authenticated
 * manager could still force millions of loop iterations/string allocations — e.g. `from:
 * '0001-01-01', to: '9999-12-31'` — before the length check finally rejected). Inclusive both ends,
 * matching `daysInRange`'s own semantics (`from === to` is 1 day). */
function rangeDayCount(from: string, to: string): number {
  const f = parseDay(from);
  const t = parseDay(to);
  return Math.round((Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(f.y, f.m - 1, f.d)) / 86_400_000) + 1;
}

function daysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Weight-accumulating average — used below because `metrics/daily/days/*` only persists each day's
 * already-DERIVED rate/percentage (`retrievalP50`, `tipRate`, `chaseUtilization`, ...), never the raw
 * numerator/denominator a range aggregation would need to recompute an exact pooled statistic. A
 * plain (unweighted) mean-of-daily-rates would let a slow Tuesday (2 tickets, one of them a 40-minute
 * outlier retrieval) swing a month's `retrievalP50` as hard as a busy Saturday (200 tickets) — weighting
 * each day's rate by that day's own relevant COUNT (tickets, drive-home jobs, ...) is a materially
 * better approximation, but it is still an approximation, not the true pooled percentile/rate. A null
 * day (denominator was 0) contributes nothing, matching the daily field's own "null, not 0" convention.
 * Disclosed as a known limitation of the given (not-this-task's-to-redesign) `metricsDaily` shape in
 * task-7-report.md.
 */
class WeightedAvg {
  private sum = 0;
  private weight = 0;
  add(value: number | null, weight: number): void {
    if (value === null || weight <= 0) return;
    this.sum += value * weight;
    this.weight += weight;
  }
  result(): number | null {
    return this.weight > 0 ? this.sum / this.weight : null;
  }
}

type VenueMetricsSummary = Omit<VenueMetrics, 'hourly'>;

/**
 * Sums exact (count/money) fields; weight-averages the rest. `credentialCompliance`/
 * `offlineSyncSuccess` are point-in-time daily snapshots with no natural volume denominator of their
 * own, so they're weighted 1-per-non-null-day (an unweighted mean across the days that had data).
 *
 * Fix round 1 (Critical #1 + Major #2): `venueMetricsSchema` types `avgTip`/`laborCostPerVehicle` as
 * `moneySchema` — `z.number().int().nonnegative()` — but `WeightedAvg.result()` is a raw float
 * division. A multi-day range whose weighted average isn't a whole number (the near-universal case —
 * e.g. this file's own test fixture: `(100·10 + 200·20)/30 = 166.6\overline{6}`) produced a value
 * that PASSED this function but then THREW inside `defineCallable`'s `callables[name].output.parse(out)`
 * — the schema boundary the handler-level tests never exercised (they call `analyticsSummaryHandler`
 * directly, never the wrapped `analyticsSummary` export). That killed the ENTIRE response for any
 * operator with multi-day tip/labor activity — both dashboard pages default to a 30-day range.
 *
 * `laborCostPerVehicle` doesn't just need rounding — it needs to stop being a weighted average at
 * all. Unlike `avgTip` (whose true denominator, tipped-transaction count, isn't persisted on
 * `VenueMetricsSummary`), `laborCostPerVehicle`'s exact definition (`round(laborCostTotal / tickets)`,
 * `rollup.ts`'s `toVenueMetrics`) has BOTH its numerator and denominator already summed exactly by
 * this same function (`laborCostTotal`, `tickets`) — computing it directly from those sums, after the
 * loop, is exact (no double-rounding drift from averaging already-rounded daily values) and simpler
 * than routing it through `WeightedAvg` at all. `avgTip` keeps the weighted-average approximation
 * (still the best available given the given contract) but now `Math.round`s the final result.
 */
function aggregateRange(series: VenueMetrics[]): VenueMetricsSummary {
  let tickets = 0, tips = 0, revenue = 0, damageReports = 0, claims = 0, driveHomeJobs = 0, ridesJobs = 0, laborCostTotal = 0, platformFees = 0, refundedTotal = 0;
  const retrievalP50 = new WeightedAvg(), retrievalP90 = new WeightedAvg(), throughput = new WeightedAvg();
  const avgTip = new WeightedAvg(), tipRate = new WeightedAvg();
  const completionSec = new WeightedAvg(), chaseUtilization = new WeightedAvg();
  const credentialCompliance = new WeightedAvg(), offlineSyncSuccess = new WeightedAvg();
  for (const vm of series) {
    tickets += vm.tickets; tips += vm.tips; revenue += vm.revenue; damageReports += vm.damageReports; claims += vm.claims;
    driveHomeJobs += vm.driveHome.jobs; ridesJobs += vm.rides.jobs; laborCostTotal += vm.laborCostTotal; platformFees += vm.platformFees; refundedTotal += vm.refundedTotal;
    retrievalP50.add(vm.retrievalP50, vm.tickets);
    retrievalP90.add(vm.retrievalP90, vm.tickets);
    throughput.add(vm.throughputPerAttendantHour, vm.tickets);
    avgTip.add(vm.avgTip, vm.tickets);
    tipRate.add(vm.tipRate, vm.tickets);
    completionSec.add(vm.driveHome.completionSec, vm.driveHome.jobs);
    chaseUtilization.add(vm.driveHome.chaseUtilization, vm.driveHome.jobs);
    credentialCompliance.add(vm.credentialCompliance, 1);
    offlineSyncSuccess.add(vm.offlineSyncSuccess, 1);
  }
  const avgTipResult = avgTip.result();
  return {
    tickets, retrievalP50: retrievalP50.result(), retrievalP90: retrievalP90.result(), throughputPerAttendantHour: throughput.result(),
    tips, avgTip: avgTipResult === null ? null : Math.round(avgTipResult), tipRate: tipRate.result(), revenue,
    damageReports, claims, laborCostPerVehicle: tickets > 0 ? Math.round(laborCostTotal / tickets) : null, laborCostTotal, platformFees, refundedTotal,
    driveHome: { jobs: driveHomeJobs, completionSec: completionSec.result(), chaseUtilization: chaseUtilization.result() },
    rides: { jobs: ridesJobs },
    credentialCompliance: credentialCompliance.result(), offlineSyncSuccess: offlineSyncSuccess.result(),
  };
}

async function loadDailyDocs(deps: Deps, operatorId: string, days: string[]): Promise<MetricsDaily[]> {
  if (days.length === 0) return [];
  const snaps = await deps.db.getAll(...days.map((d) => deps.db.doc(P.metricsDay(operatorId, d))));
  return snaps.filter((s) => s.exists).map((s) => s.data() as MetricsDaily);
}

/**
 * Aggregates a period's daily docs into `{operator, venues}`. `venueId` (when set) restricts BOTH
 * to that one venue's own series — no cross-venue combination happens on this path, so `operator`
 * and `venues[venueId]` are identical, letting a tile layer read `operator` unconditionally
 * regardless of whether a venue filter is active. Unfiltered, `operator` aggregates the rollup's
 * OWN already-computed `.operator` bucket for each day (not re-derived by re-combining every
 * venue's numbers a second time — that bucket already exists and is exact for a single day; only
 * multi-DAY aggregation needs the `WeightedAvg` approximation above), while `venues` aggregates
 * each individual venue's own per-day series for the venue comparison table.
 */
function aggregatePeriod(dailyDocs: MetricsDaily[], venueId: string | undefined): { operator: VenueMetricsSummary; venues: Record<string, VenueMetricsSummary> } {
  if (venueId) {
    const series = dailyDocs.map((d) => d.venues[venueId]).filter((v): v is VenueMetrics => v !== undefined);
    const agg = aggregateRange(series);
    return { operator: agg, venues: { [venueId]: agg } };
  }
  const operator = aggregateRange(dailyDocs.map((d) => d.operator));
  const venueIds = new Set<string>();
  for (const d of dailyDocs) for (const id of Object.keys(d.venues)) venueIds.add(id);
  const venues: Record<string, VenueMetricsSummary> = {};
  for (const id of venueIds) venues[id] = aggregateRange(dailyDocs.map((d) => d.venues[id]).filter((v): v is VenueMetrics => v !== undefined));
  return { operator, venues };
}

/**
 * The per-day series carry #44 needs (contracts v0.4.6). Returns the rollup's OWN per-day numbers
 * for the scoped subject — that venue when `venueId` is set, the operator bucket otherwise — with
 * no aggregation at all, so `hourly` survives (it is meaningless once averaged across a range,
 * which is why `venueMetricsSummary` omits it, but it is exactly what a per-day heatmap wants).
 *
 * A day whose rollup has no bucket for this venue is SKIPPED rather than emitted as zeros: a venue
 * that did not exist yet, or was closed, did not have a zero-vehicle day — and a chart that draws
 * one asserts something the data does not say. `loadDailyDocs` already drops missing days for the
 * same reason.
 */
function perDaySeries(dailyDocs: MetricsDaily[], venueId: string | undefined): { day: string; metrics: VenueMetrics }[] {
  const out: { day: string; metrics: VenueMetrics }[] = [];
  for (const d of dailyDocs) {
    const metrics = venueId ? d.venues[venueId] : d.operator;
    if (metrics) out.push({ day: d.day, metrics });
  }
  return out;
}

/**
 * Manager+ (owner/admin/lead), with the SAME `platform_admin` inspect-a-suspended-operator
 * exemption as `auditQuery` (`audit/query.ts` — read-only, no money movement, so the "still gated
 * even for an assumed platform_admin" rule for money-moving callables doesn't apply here).
 */
export async function analyticsSummaryHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'analyticsSummary'>): Promise<CallableOutput<'analyticsSummary'>> {
  const c = requireOperator(caller);
  // Carry #44: a `venue_user` may now call this, but ONLY for a venue they hold and ONLY with the
  // query scoped to it. Without `venueId` the output's `operator` bucket is the operator-wide
  // aggregate, so an unscoped venue_user call would hand a single hotel's front desk the whole
  // company's numbers — replacing a document-read leak with a server-blessed one, which is worse.
  // Everyone else is unchanged: attendants and drivers are still refused outright (this checks the
  // venue_user ROLE before delegating, so `requireVenueUserOrStaff`'s staff branch cannot widen the
  // gate here), and managers keep the unscoped view they have always had.
  if (!c.roles.some((r) => (ALLOWED_ROLES as readonly string[]).includes(r))) {
    if (!c.roles.includes('venue_user') || !input.venueId) throw err('permission_denied');
    await requireVenueUserOrStaff(deps, caller, input.venueId);
  }
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);
  if (input.from > input.to) throw err('invalid_argument', 'from must not be after to');
  if (rangeDayCount(input.from, input.to) > MAX_RANGE_DAYS) throw err('invalid_argument', `range too large (max ${MAX_RANGE_DAYS} days)`);
  const days = daysInRange(input.from, input.to);

  const previousTo = addDays(input.from, -1);
  const previousFrom = addDays(previousTo, -(days.length - 1));
  const previousDays = daysInRange(previousFrom, previousTo);

  const [currentDocs, previousDocs] = await Promise.all([loadDailyDocs(deps, c.operatorId, days), loadDailyDocs(deps, c.operatorId, previousDays)]);
  const current = aggregatePeriod(currentDocs, input.venueId);
  const previous = aggregatePeriod(previousDocs, input.venueId);

  return { from: input.from, to: input.to, operator: current.operator, venues: current.venues, previousPeriod: { from: previousFrom, to: previousTo, operator: previous.operator, venues: previous.venues }, days: perDaySeries(currentDocs, input.venueId) };
}

export const analyticsSummary = defineCallable('analyticsSummary', {}, analyticsSummaryHandler);
