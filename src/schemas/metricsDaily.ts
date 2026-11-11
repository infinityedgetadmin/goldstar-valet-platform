import { z } from 'zod';
import { dayStringSchema, isoDateSchema, moneySchema } from './common';
// Plan 4b Task 7: exported (was module-local) so `callables.ts`'s `analyticsSummary` output can
// reuse this exact shape (minus `hourly`, which the range-summary callable omits — see that file's
// own comment) instead of hand-duplicating every field a second time.
export const venueMetricsSchema = z.object({
  tickets: z.number().int(), retrievalP50: z.number().nullable(), retrievalP90: z.number().nullable(), throughputPerAttendantHour: z.number().nullable(),
  tips: moneySchema, avgTip: moneySchema.nullable(), tipRate: z.number().nullable(), revenue: moneySchema,
  damageReports: z.number().int(), claims: z.number().int(), laborCostPerVehicle: moneySchema.nullable(),
  hourly: z.array(z.number().int()).length(24),
  driveHome: z.object({ jobs: z.number().int(), completionSec: z.number().nullable(), chaseUtilization: z.number().nullable() }),
  rides: z.object({ jobs: z.number().int() }),
  // Plan 4b Task 7 (task-7-brief.md): the two `METRIC_DEFINITIONS` keys (`src/metrics.ts`) that
  // v0.3.5's `venueMetricsSchema` didn't yet carry — added here rather than left as a rollup-side
  // gap, per the controller's ruling that the rollup must produce (and the dashboard tiles must
  // consume) EXACTLY `METRIC_DEFINITIONS`' keys. Both nullable percentages (0-100), matching the
  // existing nullable-ratio convention on this same schema (`tipRate`, `chaseUtilization`, etc.) —
  // null when there's no denominator to divide by (no drivers at the venue; no telemetry docs
  // reporting for the operator that day), not 0, so a dashboard tile can render "—" instead of a
  // misleading "0%".
  credentialCompliance: z.number().min(0).max(100).nullable(),
  offlineSyncSuccess: z.number().min(0).max(100).nullable(),
  // Task 7, second pass (task-7-report.md): the Executive page's per-venue P&L rows need
  // "revenue, tips, labor, platform fees, net" — `laborCostPerVehicle` and `revenue`/`tips` already
  // covered 3 of those 5, but neither a TOTAL labor cost nor platform fees existed anywhere on this
  // schema (the raw labor-cost accumulator was already computed rollup-side for
  // `laborCostPerVehicle`'s division, just never exposed; platform fees weren't summed at all).
  // Added as exact sums (same `succeeded`-transactions-only source as `tips`/`revenue`) rather than
  // approximating either from other fields (`laborCostPerVehicle * tickets` re-introduces rounding
  // error from the earlier division; a flat `revenue * platformFeeBps` estimate can drift from the
  // real per-transaction Stripe fee) — money figures on a P&L stay exact, not estimated.
  laborCostTotal: moneySchema,
  platformFees: moneySchema,
  // Plan 8 Task 5 (carry #5, contracts v0.4.9): money refunded OUT OF the rows this line's `revenue`
  // and `tips` count. Definition, precisely: the sum of `refunds[].amount` over transactions still
  // `succeeded` (partial refunds) — a FULLY refunded row (`status: 'refunded'`) is excluded from
  // `revenue` altogether and contributes nothing here, so `revenue - refundedTotal` is the net for
  // the rows counted. Bucketed by the row's own `at` (the CHARGE day), never the refund day: a
  // refund is a correction to the day the money was taken. Until this line existed a $20 partial on
  // a $100 charge counted the full $100 forever with nothing to show it — a reader could not SEE
  // that revenue included un-netted refunds (rollup.ts, Ruling M2(c)). Netting is not applied to
  // `revenue`/`tips` themselves because a partial refund's amount is not split across base/tip/tax
  // the way the charge was; the exact figure is exposed instead of an estimated split.
  refundedTotal: moneySchema,
});
export type VenueMetrics = z.infer<typeof venueMetricsSchema>;
export const metricsDailySchema = z.object({
  venues: z.record(z.string(), venueMetricsSchema), operator: venueMetricsSchema, day: dayStringSchema, updatedAt: isoDateSchema,
});
export type MetricsDaily = z.infer<typeof metricsDailySchema>;
