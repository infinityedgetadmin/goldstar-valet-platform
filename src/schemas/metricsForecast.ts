import { z } from 'zod';
import { isoDateSchema } from './common';
/**
 * Plan 4b Task 7 (task-7-brief.md / design spec §13 "Forecasting is 4-week moving averages by
 * weekday/hour for staffing suggestions"). No forecast schema existed anywhere in v0.3.5 (verified
 * by grep — `firestore.rules` already anticipated the READ path at `metrics/forecast/weeks/{week}`,
 * commented "Plan 4b T7 forecasting", but nothing defined the DOCUMENT shape) — this is a new
 * addition, not a gap-fill against an existing definition.
 *
 * `isoWeekSchema` matches the ISO-8601 week-numbering string (`YYYY-Www`, e.g. `2026-W35`) used as
 * both the doc id under `metrics/forecast/weeks/{isoWeek}` and this field — the forecast this doc
 * holds is FOR that upcoming week, computed as a 4-week trailing average ending the week before.
 *
 * `byWeekdayHour`/`suggestedAttendants` are an ARRAY OF 7 ROWS, not the brief's literal
 * `number[7][24]` — Firestore rejects a document field that is an array directly containing
 * another array ("Cannot convert an array value in an array value", hit for real writing this via
 * the emulator while implementing this task; disclosed in task-7-report.md). Each row is a small
 * object (`{ weekday, hours }`) — Firestore allows an array of MAPS, and each map's `hours` field
 * is itself a plain (non-nested) array, so this is the minimal restructuring that stays writable.
 * `weekday` is redundant with the row's own array index (rows are always written/read in
 * `weekday` order, enforced by the `.refine` below) but kept as an explicit field so a raw
 * Firestore console/export reader doesn't have to remember "index 0 = Sunday" — 0=Sunday..6=Saturday,
 * matching `Date#getUTCDay()`/`Intl.DateTimeFormat`'s own weekday numbering and the `hourly`
 * histogram (`metricsDaily.ts`) this is built from. `hours[h]` is the venue-local hour of day.
 * `byWeekdayHour` is the raw averaged request-volume expectation (same unit as `metricsDaily`'s
 * per-venue `hourly` field: ticket check-ins in that hour); `suggestedAttendants` is
 * `Math.ceil(byWeekdayHour[d].hours[h] / platform/config.targetRequestsPerAttendantHour)` — a
 * derived, pre-computed staffing count so the dashboard's `/reports/forecast` page doesn't need
 * `platform/config` just to render the table.
 */
export const isoWeekSchema = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
function weekdayRows<T extends z.ZodTypeAny>(hourSchema: T) {
  return z
    .array(z.object({ weekday: z.number().int().min(0).max(6), hours: z.array(hourSchema).length(24) }))
    .length(7)
    .refine((rows) => rows.every((row, i) => row.weekday === i), 'rows must be ordered Sunday(0)..Saturday(6), one row per weekday');
}
export const venueForecastSchema = z.object({ byWeekdayHour: weekdayRows(z.number()), suggestedAttendants: weekdayRows(z.number().int().nonnegative()) });
export const metricsForecastSchema = z.object({ venues: z.record(z.string(), venueForecastSchema), isoWeek: isoWeekSchema, weeksAveraged: z.number().int().min(0).max(4), updatedAt: isoDateSchema });
export type VenueForecast = z.infer<typeof venueForecastSchema>;
export type MetricsForecast = z.infer<typeof metricsForecastSchema>;
