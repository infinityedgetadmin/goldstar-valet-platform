import { onSchedule } from 'firebase-functions/v2/scheduler';
import { metricsForecastSchema, platformConfigSchema, type MetricsDaily, type Operator, type VenueForecast } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { addDays, dayStringInTz, parseDay } from './rollup.js';

/**
 * ISO-8601 week string (`YYYY-Www`) for the calendar date `day` (`YYYY-MM-DD`) — the standard
 * "nearest Thursday" algorithm (ISO 8601 defines week 1 as the week containing the year's first
 * Thursday, equivalently the week containing Jan 4th). Pure calendar arithmetic on the date STRING,
 * done in UTC-as-calendar (no timezone conversion — `day` already IS a calendar day, from
 * `rollup.ts`'s own tz-aware bucketing; this just numbers it).
 */
export function isoWeekString(day: string): string {
  const { y, m, d } = parseDay(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoDayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - isoDayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstIsoDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDayNum + 3);
  const weekNum = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Sunday=0..Saturday=6, matching `metricsForecastSchema`'s own doc comment on `byWeekdayHour`'s indexing. */
function weekdayOfDay(day: string): number {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * 4-week trailing moving average of the `hourly` request-volume histogram from
 * `metrics/daily/days/*`, grouped by weekday × venue-local hour, for ONE venue.
 *
 * `dailyDocs` is every daily rollup doc found in the 28-day window ending yesterday (some days may
 * be missing — a new operator with <4 weeks of history, or a day the hourly sweep hasn't reached
 * yet — a missing day simply contributes no sample to whichever weekday×hour cells it would have
 * fed, rather than being treated as a real zero). A cell with zero samples (e.g., a brand-new venue)
 * averages to 0, and `Math.ceil(0 / target) === 0` staffing — a defensible floor, not a crash.
 */
export function buildVenueForecast(dailyDocs: Pick<MetricsDaily, 'day' | 'venues'>[], venueId: string, targetRequestsPerAttendantHour: number): VenueForecast {
  const samples: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [] as number[]));
  for (const doc of dailyDocs) {
    const vm = doc.venues[venueId];
    if (!vm) continue;
    const wd = weekdayOfDay(doc.day);
    for (let h = 0; h < 24; h++) samples[wd]![h]!.push(vm.hourly[h] ?? 0);
  }
  // Firestore rejects a field that's an array directly containing another array — `samples` (and
  // its derived `number[][]`) can only live as an in-memory intermediate; the schema's own shape
  // (`metricsForecast.ts`'s `weekdayRows`) is an array of `{weekday, hours}` rows.
  const byWeekdayHour = samples.map((hours, weekday) => ({ weekday, hours: hours.map((cell) => mean(cell)) }));
  const suggestedAttendants = byWeekdayHour.map((row) => ({ weekday: row.weekday, hours: row.hours.map((expected) => Math.ceil(expected / targetRequestsPerAttendantHour)) }));
  return { byWeekdayHour, suggestedAttendants };
}

async function platformConfig(deps: Deps) {
  const snap = await deps.db.doc('platform/config').get();
  return platformConfigSchema.parse(snap.data() ?? {});
}

/**
 * Weekly (design spec §13): for every active operator, builds a forecast for the UPCOMING ISO week
 * (the week `deps.now()` falls in) from the 28 days of ALREADY-COMPUTED `metrics/daily/days/*`
 * histograms ending yesterday — i.e., the 4 most recently completed weeks, not the week this
 * function runs in (that week has no history yet to average). `weeksAveraged` records how many of
 * those 28 candidate days actually had a rollup doc (rounded to the nearest whole week, capped at
 * 4) — a coarse "how much history backs this forecast" disclosure, not a per-cell sample count.
 */
export async function buildForecastHandler(deps: Deps): Promise<{ operators: number; venues: number }> {
  const opsSnap = await deps.db.collection('operators').where('status', '==', 'active').get();
  let venues = 0;
  for (const opDoc of opsSnap.docs) {
    const op = opDoc.data() as Operator;
    const tz = op.timezone || 'America/Indiana/Indianapolis';
    const today = dayStringInTz(Date.parse(deps.now()), tz);
    const isoWeek = isoWeekString(today);
    const targetDays = Array.from({ length: 28 }, (_, i) => addDays(today, -1 - i));
    const config = await platformConfig(deps);

    const daySnaps = targetDays.length > 0 ? await deps.db.getAll(...targetDays.map((d) => deps.db.doc(P.metricsDay(op.id, d)))) : [];
    const dailyDocs = daySnaps.filter((s) => s.exists).map((s) => s.data() as MetricsDaily);
    const weeksAveraged = Math.min(4, Math.round(dailyDocs.length / 7));

    const venuesSnap = await deps.db.collection(`operators/${op.id}/venues`).where('status', '==', 'active').get();
    const venuesOut: Record<string, VenueForecast> = {};
    for (const v of venuesSnap.docs) {
      venuesOut[v.id] = buildVenueForecast(dailyDocs, v.id, config.targetRequestsPerAttendantHour);
      venues++;
    }

    const parsed = metricsForecastSchema.parse({ venues: venuesOut, isoWeek, weeksAveraged, updatedAt: deps.now() });
    await deps.db.doc(P.metricsForecastWeek(op.id, isoWeek)).set(parsed);
  }
  return { operators: opsSnap.size, venues };
}

// AppEngine-syntax weekday schedule (matches `tickets/archive.ts`/`identity/eligibility.ts`'s own
// `every day HH:MM` precedent, extended with a weekday) — Monday pre-dawn, ahead of the staffing
// week it's forecasting so a manager reviewing `/reports/forecast` Monday morning already has it.
export const buildForecast = onSchedule({ schedule: 'every monday 05:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await buildForecastHandler(makeDeps());
});
