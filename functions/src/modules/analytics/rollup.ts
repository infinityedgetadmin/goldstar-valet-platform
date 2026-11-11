import { onSchedule } from 'firebase-functions/v2/scheduler';
import { metricsDailySchema, percentile, platformConfigSchema, type ClockEvent, type MetricsDaily, type Operator, type PlatformConfig, type Shift, type Ticket, type Transaction, type User, type Venue, type VenueMetrics } from '@goldstar/platform';
import { computeClockedHours } from '../scheduling/tipPool.js';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

// ---------------------------------------------------------------------------------------------
// Timezone-aware day/hour bucketing.
//
// No date-tz library is installed in `functions/` (verified — `functions/package.json` has none,
// and no existing module needed one; `archive.ts`/`eligibility.ts`'s own `onSchedule({ timeZone })`
// only controls WHEN the Cloud Scheduler trigger fires, not how a document's own timestamp maps to
// a calendar day). These three helpers do the minimum needed with `Intl.DateTimeFormat` alone.
//
// `startOfDayUtcMs` uses the standard "format a naive-UTC guess in the target tz, then correct by
// the observed offset" trick: DST transitions in every US zone this platform uses happen at 2am
// local, never at midnight, so a single offset sample at the naive guess (which is always within
// ~24h of the true instant) is exact for this platform's timezones. Documented rather than
// generalized to a library — correct here, not a claim about arbitrary IANA zones.
// ---------------------------------------------------------------------------------------------
function formatPartsInTz(ms: number, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(new Date(ms));
  return parts.reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
}

function tzOffsetMinutes(ms: number, tz: string): number {
  const p = formatPartsInTz(ms, tz, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - ms) / 60_000;
}

/** UTC epoch ms of local midnight for `day` (`YYYY-MM-DD`) in `tz`. */
/** `day` is always `dayStringSchema`-shaped (`\d{4}-\d{2}-\d{2}`) at every call site in this
 * module — a plain `.split('-').map(Number)` destructure is `(number|undefined)[]` under
 * `noUncheckedIndexedAccess`; this asserts the three parts are present rather than repeating a
 * non-null assertion at each of `startOfDayUtcMs`/`addDays`/`forecast.ts`'s own two call sites. */
export function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function startOfDayUtcMs(day: string, tz: string): number {
  const { y, m, d } = parseDay(day);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  return naiveUtc - tzOffsetMinutes(naiveUtc, tz) * 60_000;
}

/** The `YYYY-MM-DD` calendar day `ms` (a UTC epoch) falls on in `tz`. */
export function dayStringInTz(ms: number, tz: string): string {
  const p = formatPartsInTz(ms, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The venue-local hour (0-23) `iso` falls in, in `tz`.
 *
 * Fix round 1 (Minor #3, task-7-review.md — the brief explicitly asked for a DST adjudication and
 * the first pass's report was silent on it): on a US DST FALL-BACK day, local hour 1 (for example)
 * occurs twice in real wall-clock time; both occurrences map to the same `hourly[1]` bucket, so that
 * one day's histogram cell absorbs roughly 2x its true sample weight for that hour — one cell, once
 * per year, per operator timezone. This does NOT affect `ticketsCount`, revenue, or any other total
 * (every ticket is still counted exactly once) — only `hourly[]`'s distribution for that single day,
 * and by extension its contribution to `forecast.ts`'s `buildVenueForecast` 4-week average for that
 * weekday/hour cell (one sample out of up to 28, not the whole average). SPRING-FORWARD (23-hour)
 * days are harmless by contrast — the skipped hour just gets zero samples that day, no
 * double-counting. Accepted as a rare, bounded-impact edge case rather than fixed (correctly
 * disambiguating the two fall-back occurrences would need each ticket's UTC offset at write time,
 * not just its local wall-clock hour — not worth the complexity for a once-a-year, one-cell,
 * roughly-2x-not-10x skew).
 */
export function hourInTz(iso: string, tz: string): number {
  const p = formatPartsInTz(Date.parse(iso), tz, { hourCycle: 'h23', hour: '2-digit' });
  return Number(p.hour) % 24;
}

/** Calendar-arithmetic day-string shift (no tz involved — pure `YYYY-MM-DD` +/- n days). */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Raw per-venue-day accumulator. `toVenueMetrics` derives the contract's `VenueMetrics` shape
// from this; kept separate so the OPERATOR aggregate (below) can be computed by summing/pooling
// these raw accumulators across every venue rather than re-deriving from already-rounded rates —
// exact where the contract's own per-day shape allows it (see `analytics/summary.ts`'s own header
// comment for the ONE place this repo cannot stay exact: aggregating rates across multiple DAYS,
// where only the already-derived daily rate is persisted, not its raw numerator/denominator).
// ---------------------------------------------------------------------------------------------
export interface VenueDayRaw {
  ticketsCount: number;
  retrievalSecs: number[];
  deliveredCount: number;
  tipsTotal: number;
  revenueTotal: number;
  txnCount: number;
  tippedTxnCount: number;
  platformFeesTotal: number;
  /** Plan 8 Task 5 (#5): sum of refunds[] over rows still `succeeded` — see metricsDaily.ts. */
  refundedTotal: number;
  laborCostTotal: number;
  clockedHoursTotal: number;
  driverClockedHoursTotal: number;
  chaseHoursTotal: number;
  driveHomeJobs: number;
  driveHomeTripSecs: number[];
  ridesJobs: number;
  damageReportsCount: number;
  claimsCount: number;
  hourly: number[]; // length 24
  credentialCompliance: number | null;
  offlineSyncSuccess: number | null;
}

export function emptyVenueDayRaw(): VenueDayRaw {
  return {
    ticketsCount: 0, retrievalSecs: [], deliveredCount: 0, tipsTotal: 0, revenueTotal: 0, txnCount: 0, tippedTxnCount: 0, platformFeesTotal: 0, refundedTotal: 0,
    laborCostTotal: 0, clockedHoursTotal: 0, driverClockedHoursTotal: 0, chaseHoursTotal: 0,
    driveHomeJobs: 0, driveHomeTripSecs: [], ridesJobs: 0, damageReportsCount: 0, claimsCount: 0,
    hourly: Array.from({ length: 24 }, () => 0), credentialCompliance: null, offlineSyncSuccess: null,
  };
}

/** Merges `b` into `a` IN PLACE, for building the operator-wide accumulator across venues. */
function mergeRaw(a: VenueDayRaw, b: VenueDayRaw): void {
  a.ticketsCount += b.ticketsCount;
  a.retrievalSecs.push(...b.retrievalSecs);
  a.deliveredCount += b.deliveredCount;
  a.tipsTotal += b.tipsTotal;
  a.revenueTotal += b.revenueTotal;
  a.txnCount += b.txnCount;
  a.tippedTxnCount += b.tippedTxnCount;
  a.platformFeesTotal += b.platformFeesTotal;
  a.refundedTotal += b.refundedTotal;
  a.laborCostTotal += b.laborCostTotal;
  a.clockedHoursTotal += b.clockedHoursTotal;
  a.driverClockedHoursTotal += b.driverClockedHoursTotal;
  a.chaseHoursTotal += b.chaseHoursTotal;
  a.driveHomeJobs += b.driveHomeJobs;
  a.driveHomeTripSecs.push(...b.driveHomeTripSecs);
  a.ridesJobs += b.ridesJobs;
  a.damageReportsCount += b.damageReportsCount;
  a.claimsCount += b.claimsCount;
  for (let h = 0; h < 24; h++) a.hourly[h] = (a.hourly[h] ?? 0) + (b.hourly[h] ?? 0);
}

/**
 * Derives the contract's `VenueMetrics` from a raw accumulator.
 *
 * `credentialCompliance`/`offlineSyncSuccess` are NOT summed/pooled the way the rest of `raw` is —
 * they're operator-wide-computed percentages threaded straight through onto every venue AND the
 * operator (see `rollupOperatorDay`'s own comment: a driver's `venueIds` can span more than one
 * venue, and `telemetry/{uid}` carries no venue at all, so there is no exact per-venue partition to
 * sum from — `raw.credentialCompliance`/`raw.offlineSyncSuccess` already hold the venue-scoped (or
 * operator-scoped, for the operator aggregate) value computed by the caller).
 */
export function toVenueMetrics(raw: VenueDayRaw): VenueMetrics {
  const retrievalP50 = percentile(raw.retrievalSecs, 50);
  const retrievalP90 = percentile(raw.retrievalSecs, 90);
  const throughputPerAttendantHour = raw.clockedHoursTotal > 0 ? raw.deliveredCount / raw.clockedHoursTotal : null;
  const avgTip = raw.tippedTxnCount > 0 ? Math.round(raw.tipsTotal / raw.tippedTxnCount) : null;
  const tipRate = raw.txnCount > 0 ? (raw.tippedTxnCount / raw.txnCount) * 100 : null;
  const laborCostPerVehicle = raw.ticketsCount > 0 ? Math.round(raw.laborCostTotal / raw.ticketsCount) : null;
  const driveHomeCompletionSec = raw.driveHomeTripSecs.length > 0 ? Math.round(raw.driveHomeTripSecs.reduce((s, v) => s + v, 0) / raw.driveHomeTripSecs.length) : null;
  const chaseUtilization = raw.driverClockedHoursTotal > 0 ? (raw.chaseHoursTotal / raw.driverClockedHoursTotal) * 100 : null;
  return {
    tickets: raw.ticketsCount, retrievalP50, retrievalP90, throughputPerAttendantHour,
    tips: raw.tipsTotal, avgTip, tipRate, revenue: raw.revenueTotal,
    damageReports: raw.damageReportsCount, claims: raw.claimsCount, laborCostPerVehicle, laborCostTotal: raw.laborCostTotal, platformFees: raw.platformFeesTotal, refundedTotal: raw.refundedTotal,
    hourly: raw.hourly,
    driveHome: { jobs: raw.driveHomeJobs, completionSec: driveHomeCompletionSec, chaseUtilization },
    rides: { jobs: raw.ridesJobs },
    credentialCompliance: raw.credentialCompliance, offlineSyncSuccess: raw.offlineSyncSuccess,
  };
}

async function platformConfig(deps: Deps): Promise<PlatformConfig> {
  const snap = await deps.db.doc('platform/config').get();
  return platformConfigSchema.parse(snap.data() ?? {});
}

// ---------------------------------------------------------------------------------------------
// Per-venue-day ticket/transaction/labor accumulation.
// ---------------------------------------------------------------------------------------------
interface DayWindow {
  day: string;
  startIso: string;
  endIso: string; // exclusive
  tz: string;
}

function dayWindow(day: string, tz: string): DayWindow {
  return { day, tz, startIso: new Date(startOfDayUtcMs(day, tz)).toISOString(), endIso: new Date(startOfDayUtcMs(addDays(day, 1), tz)).toISOString() };
}

/**
 * Labor: clocked hours (all roles, for `throughputPerAttendantHour`/`laborCostPerVehicle`) AND
 * driver-only clocked hours (for `chaseUtilization`'s denominator) + total labor cost, for one
 * venue on one day. Role comes from the SHIFT's own `assignments[].role` (already denormalized
 * onto the shift, no per-uid `users` read needed to know who's a driver) — a clocked-in uid absent
 * from `assignments` (a punch with no matching assignment row) still counts toward
 * `clockedHoursTotal`/labor cost, just not toward the driver-only bucket, since its role can't be
 * confirmed from data already in hand.
 */
async function laborForVenueDay(deps: Deps, operatorId: string, venueId: string, day: string, userHourlyRate: (uid: string) => Promise<number | undefined>, laborRateDefault: number): Promise<{ clockedHoursTotal: number; driverClockedHoursTotal: number; laborCostTotal: number }> {
  const shiftsSnap = await deps.db.collection(`operators/${operatorId}/shifts`).where('venueId', '==', venueId).where('date', '==', day).get();
  let clockedHoursTotal = 0;
  let driverClockedHoursTotal = 0;
  let laborCostTotal = 0;
  await Promise.all(
    shiftsSnap.docs.map(async (d) => {
      const shift = d.data() as Shift;
      const roleByUid = new Map(shift.assignments.map((a) => [a.uid, a.role]));
      const clockSnap = await d.ref.collection('clockEvents').get();
      const events = clockSnap.docs.map((c) => c.data() as ClockEvent);
      const hoursByUid = computeClockedHours(events, shift.endsAt);
      for (const [uid, hours] of Object.entries(hoursByUid)) {
        clockedHoursTotal += hours;
        if (roleByUid.get(uid) === 'driver') driverClockedHoursTotal += hours;
        const rate = (await userHourlyRate(uid)) ?? laborRateDefault;
        laborCostTotal += Math.round(hours * rate);
      }
    }),
  );
  return { clockedHoursTotal, driverClockedHoursTotal, laborCostTotal };
}

async function ticketsForVenueDay(deps: Deps, operatorId: string, venueId: string, w: DayWindow): Promise<VenueDayRaw> {
  const col = deps.db.collection(`operators/${operatorId}/tickets`);
  const [checkedInSnap, readySnap, deliveredSnap, completedSnap] = await Promise.all([
    col.where('venueId', '==', venueId).where('times.checkedInAt', '>=', w.startIso).where('times.checkedInAt', '<', w.endIso).get(),
    col.where('venueId', '==', venueId).where('times.readyAt', '>=', w.startIso).where('times.readyAt', '<', w.endIso).get(),
    col.where('venueId', '==', venueId).where('times.deliveredAt', '>=', w.startIso).where('times.deliveredAt', '<', w.endIso).get(),
    col.where('venueId', '==', venueId).where('times.completedAt', '>=', w.startIso).where('times.completedAt', '<', w.endIso).get(),
  ]);
  const raw = emptyVenueDayRaw();
  // `tickets`/`hourly` (Task 7 brief: "vehicles" volume + the forecast's hourly staffing signal) —
  // scoped to `jobType === 'valet'` so a drive-home/ride pickup doesn't get double-counted here AND
  // in `driveHome.jobs`/`rides.jobs` below. Bucketed by `times.checkedInAt`'s own venue-local hour.
  for (const d of checkedInSnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType !== 'valet') continue;
    raw.ticketsCount++;
    const h = hourInTz(t.times.checkedInAt, w.tz);
    raw.hourly[h] = (raw.hourly[h] ?? 0) + 1;
  }
  for (const d of readySnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType !== 'valet' || t.metrics?.retrievalSec === undefined) continue;
    raw.retrievalSecs.push(t.metrics.retrievalSec);
  }
  for (const d of deliveredSnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType === 'valet') raw.deliveredCount++;
  }
  for (const d of completedSnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType === 'drive_home') {
      raw.driveHomeJobs++;
      if (t.metrics?.tripSec !== undefined) raw.driveHomeTripSecs.push(t.metrics.tripSec);
      if (t.attendants.chaseDriverUid && t.metrics?.tripSec !== undefined) raw.chaseHoursTotal += t.metrics.tripSec / 3600;
    } else if (t.jobType === 'passenger_ride') {
      raw.ridesJobs++;
    }
  }
  return raw;
}

/**
 * Revenue/tips: `succeeded` transactions only (Ruling — matches `scheduling/tipPool.ts`'s own
 * "authoritative source" reasoning verbatim: `transactions.status` is the webhook-confirmed ledger,
 * `ticket.payment.tip`/`.total` are pre-confirmation and don't self-clear on refund/cancel). `revenue`
 * is `base + tax + fees` — deliberately EXCLUDES `tip` (owed straight through to the worker, tracked
 * separately as `tips`) and `platformFee` (the platform's own destination-charge cut, a cost line on
 * the executive P&L, not operator/venue revenue). `avgTip` is the average size of a GIVEN tip (tips
 * total / count of transactions that included a tip, not / all transactions) — `tipRate` is the
 * companion "% of transactions that tipped" figure; a reader wanting "average tip including
 * non-tippers" can recover it as `tips / tickets`. Both are judgment calls, disclosed in
 * task-7-report.md.
 *
 * ## Rulings M2(b)/M2(c) (final whole-branch review, recorded in the ledger) — refunds and this window
 *
 * This function only ever looks at a transaction's CURRENT `status` + amounts within `[w.startIso,
 * w.endIso)`, bucketed by the row's own `at` (fixed at the original charge time — see applyEvent.ts's
 * C1 fix comment; a refund never migrates a row across this window). Two consequences followed
 * from that; BOTH ARE NOW CLOSED (Plan 8 Task 5) and the paragraphs below are kept as the record of
 * what was accepted and why the closure takes the shape it does:
 *
 * - M2(b) is closed by the recompute marker: applyEvent.ts writes `metricsRecompute/{txId}` in the
 *   same transaction as any refund, and `rollupMetricsHandler` recomputes the CHARGE day those
 *   markers name — not just today/yesterday — then clears them. A full refund on a closed day no
 *   longer overstates that day forever.
 * - M2(c) is closed by `refundedTotal`: partial refunds are still not netted out of `revenue`/`tips`
 *   (the attribution problem described below is real), but the exact refunded figure is now a line
 *   on every venue metrics doc, so the un-netted amount is visible instead of silent.
 *
 * - **M2(b) — a full refund landing AFTER this day's rollup has already run** (the hourly sweep only
 *   recomputes today+yesterday; a closed day is never revisited) permanently overstates that day's
 *   revenue/tips — the transaction flips to `status: 'refunded'` in `transactions/{id}`, but the
 *   already-written `metrics/daily` doc for the charge day keeps the original `succeeded`-era
 *   amounts forever. Accepted for now; Plan 8 candidate: a refund-aware recompute that revisits the
 *   specific day(s) named in the refunded transaction's `refunds[].at`, not just today/yesterday.
 * - **M2(c) — a PARTIAL refund is never netted here, even within the window.** `refunds[]` (the
 *   per-entry ledger `applyEvent.ts` appends to) is read nowhere in this function — a $20 partial
 *   refund on a $100 succeeded charge still counts the full $100 toward `revenue`/`tips` forever,
 *   because the transaction's own `status` stays `'succeeded'` (Ruling AK) and its top-level
 *   `base`/`tip`/`tax`/`fees` fields are the ORIGINAL charge amounts, never adjusted downward.
 *   Netting attribution is genuinely ambiguous (a partial refund's amount isn't split across
 *   base/tip/tax the way the original charge was — same reason T2 ruled per-refund tip-attribution
 *   impossible for `tipPool.ts`). Accepted as a documented characteristic; Plan 8 candidate: add an
 *   explicit `refundedTotal` line to `VenueMetrics`/`venueMetrics` so a reader can at least SEE that
 *   revenue includes un-netted refunds, rather than a silent gap.
 *
 * See `scheduling/tipPool.ts`'s own Ruling M2(a) comment for the related-but-different consequence
 * on the PAYOUT side of this same refund model (tips are never clawed back once allocated).
 */
async function transactionsForVenueDay(deps: Deps, operatorId: string, venueId: string, w: DayWindow): Promise<Pick<VenueDayRaw, 'tipsTotal' | 'revenueTotal' | 'txnCount' | 'tippedTxnCount' | 'platformFeesTotal' | 'refundedTotal'>> {
  const snap = await deps.db.collection(`operators/${operatorId}/transactions`).where('venueId', '==', venueId).where('at', '>=', w.startIso).where('at', '<', w.endIso).get();
  let tipsTotal = 0;
  let revenueTotal = 0;
  let txnCount = 0;
  let tippedTxnCount = 0;
  let platformFeesTotal = 0;
  let refundedTotal = 0;
  for (const d of snap.docs) {
    const tx = d.data() as Transaction;
    if (tx.status !== 'succeeded') continue;
    txnCount++;
    // Plan 8 Task 5 (#5): a row that is still `succeeded` after a refund is a PARTIAL refund
    // (applyEvent.ts, Ruling AK) — count it in full above, and expose what came back out here. A
    // fully refunded row has already been skipped by the status guard, so it lands in neither.
    // `refunds` is typed non-optional because transactionSchema gives it `.default([])` — but that
    // default applies on PARSE, and applyEvent.ts only spreads `refunds` onto the row for refund
    // events, so a plain succeeded row in Firestore has NO such key. The widening is the runtime
    // truth, not a lint dodge; without it this is `undefined.reduce` on every unrefunded charge.
    refundedTotal += ((tx.refunds as Transaction['refunds'] | undefined) ?? []).reduce((sum, r) => sum + r.amount, 0);
    tipsTotal += tx.tip;
    revenueTotal += tx.base + tx.tax + tx.fees;
    if (tx.tip > 0) tippedTxnCount++;
    // `platformFee` is optional on the schema (not every provider path sets it) — 0 when absent,
    // exact when present. Summed here (not derived from `revenue * operator.modules.payments.
    // platformFeeBps`) so the executive P&L's "platform fees" row reflects what was ACTUALLY
    // charged per transaction, not a flat-rate estimate that can drift from Stripe's own rounding.
    platformFeesTotal += tx.platformFee ?? 0;
  }
  return { tipsTotal, revenueTotal, txnCount, tippedTxnCount, platformFeesTotal, refundedTotal };
}

// ---------------------------------------------------------------------------------------------
// Operator-wide, venue-joined data: damageReports/claims (no `venueId` field on either schema —
// joined through `ticketId -> ticket.venueId`, batch-fetched once per operator/day and bucketed by
// venue rather than re-queried per venue) and driver credential compliance / telemetry sync health
// (both genuinely operator-scoped — see `toVenueMetrics`'s own comment on why these two fields
// aren't summed from per-venue buckets).
// ---------------------------------------------------------------------------------------------
async function ticketVenueMap(deps: Deps, operatorId: string, ticketIds: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ticketIds)];
  if (uniq.length === 0) return new Map();
  const refs = uniq.map((id) => deps.db.doc(P.ticket(operatorId, id)));
  const snaps = await deps.db.getAll(...refs);
  const map = new Map<string, string>();
  for (const s of snaps) {
    const t = s.data() as Ticket | undefined;
    if (t) map.set(s.id, t.venueId);
  }
  return map;
}

async function damageReportsAndClaimsByVenue(deps: Deps, operatorId: string, w: DayWindow): Promise<{ damageByVenue: Map<string, number>; claimsByVenue: Map<string, number> }> {
  const [damageSnap, claimsSnap] = await Promise.all([
    deps.db.collection(`operators/${operatorId}/damageReports`).where('createdAt', '>=', w.startIso).where('createdAt', '<', w.endIso).get(),
    deps.db.collection(`operators/${operatorId}/claims`).where('createdAt', '>=', w.startIso).where('createdAt', '<', w.endIso).get(),
  ]);
  const allTicketIds = [...damageSnap.docs.map((d) => (d.data() as { ticketId: string }).ticketId), ...claimsSnap.docs.map((d) => (d.data() as { ticketId: string }).ticketId)];
  const venueByTicket = await ticketVenueMap(deps, operatorId, allTicketIds);
  const damageByVenue = new Map<string, number>();
  for (const d of damageSnap.docs) {
    const venueId = venueByTicket.get((d.data() as { ticketId: string }).ticketId);
    if (venueId) damageByVenue.set(venueId, (damageByVenue.get(venueId) ?? 0) + 1);
  }
  const claimsByVenue = new Map<string, number>();
  for (const d of claimsSnap.docs) {
    const venueId = venueByTicket.get((d.data() as { ticketId: string }).ticketId);
    if (venueId) claimsByVenue.set(venueId, (claimsByVenue.get(venueId) ?? 0) + 1);
  }
  return { damageByVenue, claimsByVenue };
}

/**
 * % of the operator's active `driver`-role users with `eligibility.driveHome === true` — "credential
 * compliance". Per-venue value buckets a driver by `user.venueIds.includes(venueId)`; a driver with
 * NO venueIds (unscoped) counts only toward the operator-wide figure, never a venue bucket
 * (disclosed — there's no venue to attribute them to). Null (not 0) when a bucket has zero drivers.
 */
function complianceByVenue(drivers: { venueIds: string[]; eligible: boolean }[], venueIds: string[]): { operator: number | null; byVenue: Map<string, number | null> } {
  const rate = (pool: { eligible: boolean }[]): number | null => (pool.length === 0 ? null : (pool.filter((d) => d.eligible).length / pool.length) * 100);
  const byVenue = new Map<string, number | null>();
  for (const v of venueIds) byVenue.set(v, rate(drivers.filter((d) => d.venueIds.includes(v))));
  return { operator: rate(drivers), byVenue };
}

/**
 * Offline sync success from `telemetry/{uid}` (top-level collection, ONE rolling doc per uid — the
 * app overwrites it daily, per that schema's own `day` field; it is NOT a per-day history). Filtered
 * to `operatorId == op && day == <the day being rolled up>` — for "today" this is accurate as long
 * as the app hasn't already rolled the doc to tomorrow; for a "previous day" recompute where the app
 * has since overwritten with a newer day, the query returns nothing for that uid and its prior day's
 * sync health is simply unavailable (falls through to `null`, not a false zero) — a genuine,
 * disclosed accuracy gap of the given schema, not a bug in this rollup. Nothing writes this
 * collection yet anywhere in this codebase (verified by grep, matches the brief's own "nothing
 * writes it yet" note) — every value is `null`/absent until the mobile app is instrumented.
 *
 * Success = `(photosUploaded - photosNeedsAttention) / photosUploaded`, summed across the docs in
 * scope (not averaged per-doc) so one heavy-volume device doesn't get diluted by many idle ones.
 * Per-venue bucketing joins through `users/{uid}.venueIds`, same caveat as `complianceByVenue`.
 */
function offlineSyncByVenue(rows: { venueIds: string[]; photosUploaded: number; photosNeedsAttention: number }[], venueIds: string[]): { operator: number | null; byVenue: Map<string, number | null> } {
  const rate = (pool: typeof rows): number | null => {
    const uploaded = pool.reduce((s, r) => s + r.photosUploaded, 0);
    if (uploaded === 0) return null;
    const needsAttention = pool.reduce((s, r) => s + r.photosNeedsAttention, 0);
    return ((uploaded - needsAttention) / uploaded) * 100;
  };
  const byVenue = new Map<string, number | null>();
  for (const v of venueIds) byVenue.set(v, rate(rows.filter((r) => r.venueIds.includes(v))));
  return { operator: rate(rows), byVenue };
}

// ---------------------------------------------------------------------------------------------
// Top-level: one operator, one day. Writes `operators/{op}/metrics/daily/days/{day}`.
// ---------------------------------------------------------------------------------------------
export async function rollupOperatorDay(deps: Deps, op: Operator, day: string): Promise<MetricsDaily> {
  // Task 7 disclosed simplification: the WHOLE doc (every venue's bucket) shares ONE canonical day
  // boundary, computed from the OPERATOR's timezone — not each venue's own `timezone` override
  // (which exists on `venueSchema` but, per that field's own placement alongside
  // `stripeLocationId`, reads as a payments/display concern, not a rollup-bucketing one). A single
  // `metrics/daily/days/{day}` doc needs ONE `day` value for all its nested venues to stay
  // internally consistent; using a per-venue tz here would let two venues in the same doc disagree
  // about which calendar day a given instant belongs to.
  const tz = op.timezone || 'America/Indiana/Indianapolis';
  const w = dayWindow(day, tz);
  const config = await platformConfig(deps);

  const venuesSnap = await deps.db.collection(`operators/${op.id}/venues`).where('status', '==', 'active').get();
  const venues = venuesSnap.docs.map((d) => d.data() as Venue);
  const venueIds = venues.map((v) => v.id);

  const [{ damageByVenue, claimsByVenue }, driversSnap, telemetrySnap] = await Promise.all([
    damageReportsAndClaimsByVenue(deps, op.id, w),
    deps.db.collection(`operators/${op.id}/users`).where('roles', 'array-contains', 'driver').where('status', '==', 'active').get(),
    deps.db.collection('telemetry').where('operatorId', '==', op.id).where('day', '==', day).get(),
  ]);
  const drivers = driversSnap.docs.map((d) => {
    const u = d.data() as User;
    return { venueIds: u.venueIds, eligible: u.eligibility.driveHome };
  });
  const telemetryUids = telemetrySnap.docs.map((d) => d.id);
  const telemetryUserSnaps = telemetryUids.length > 0 ? await deps.db.getAll(...telemetryUids.map((uid) => deps.db.doc(P.user(op.id, uid)))) : [];
  const venueIdsByUid = new Map(telemetryUserSnaps.map((s) => [s.id, (s.data() as User | undefined)?.venueIds ?? []]));
  const telemetryRows = telemetrySnap.docs.map((d) => {
    const t = d.data() as { photosUploaded: number; photosNeedsAttention: number };
    return { venueIds: venueIdsByUid.get(d.id) ?? [], photosUploaded: t.photosUploaded, photosNeedsAttention: t.photosNeedsAttention };
  });
  const compliance = complianceByVenue(drivers, venueIds);
  const offlineSync = offlineSyncByVenue(telemetryRows, venueIds);

  const hourlyRateCache = new Map<string, number | undefined>();
  const userHourlyRate = async (uid: string): Promise<number | undefined> => {
    if (hourlyRateCache.has(uid)) return hourlyRateCache.get(uid);
    const snap = await deps.db.doc(P.user(op.id, uid)).get();
    const rate = (snap.data() as User | undefined)?.hourlyRate;
    hourlyRateCache.set(uid, rate);
    return rate;
  };

  const venuesOut: Record<string, VenueMetrics> = {};
  const operatorRaw = emptyVenueDayRaw();
  await Promise.all(
    venues.map(async (v) => {
      const [tickets, txns, labor] = await Promise.all([
        ticketsForVenueDay(deps, op.id, v.id, w),
        transactionsForVenueDay(deps, op.id, v.id, w),
        laborForVenueDay(deps, op.id, v.id, day, userHourlyRate, config.laborRateDefault),
      ]);
      const raw: VenueDayRaw = {
        ...tickets, ...txns, ...labor,
        damageReportsCount: damageByVenue.get(v.id) ?? 0, claimsCount: claimsByVenue.get(v.id) ?? 0,
        credentialCompliance: compliance.byVenue.get(v.id) ?? null, offlineSyncSuccess: offlineSync.byVenue.get(v.id) ?? null,
      };
      venuesOut[v.id] = toVenueMetrics(raw);
      mergeRaw(operatorRaw, raw);
    }),
  );
  operatorRaw.credentialCompliance = compliance.operator;
  operatorRaw.offlineSyncSuccess = offlineSync.operator;

  const parsed = metricsDailySchema.parse({ venues: venuesOut, operator: toVenueMetrics(operatorRaw), day, updatedAt: deps.now() });
  await deps.db.doc(P.metricsDay(op.id, day)).set(parsed);
  return parsed;
}

/**
 * Hourly sweep (Plan 4b Task 7): for every active operator, recomputes TODAY's and YESTERDAY's
 * `metrics/daily/days/{day}` doc — idempotent full overwrite (`.set()`, not `.update()`), so a
 * redelivered/retried invocation converges to the same result rather than double-counting.
 * "Yesterday" is recomputed too because a rollup that only ever wrote TODAY's doc would leave
 * yesterday's numbers permanently understated by whatever settled after midnight (a Stripe webhook
 * landing seconds into the new day for a charge made minutes before it, a damage report filed after
 * a shift's actual midnight close, etc.) — this sweep gives every day exactly ONE more hourly chance
 * (its first hour as "today", then 24 more hourly passes as "yesterday") to pick up that
 * late-settling data before it stops being recomputed at all. Data older than yesterday is
 * considered final; `archiveClosedTickets`' 90-day cutoff (`tickets/archive.ts`) is comfortably past
 * that window, so this sweep never needs to read the `archive/` subtree.
 */
export async function rollupMetricsHandler(deps: Deps): Promise<{ operators: number; venueDays: number }> {
  const opsSnap = await deps.db.collection('operators').where('status', '==', 'active').get();
  let venueDays = 0;
  for (const opDoc of opsSnap.docs) {
    const op = opDoc.data() as Operator;
    const tz = op.timezone || 'America/Indiana/Indianapolis';
    const today = dayStringInTz(Date.parse(deps.now()), tz);
    const yesterday = addDays(today, -1);
    const days = new Set([today, yesterday]);
    // Plan 8 Task 5 (carry #4): a refund that landed on a CLOSED day left that day's doc overstated
    // forever, because only today/yesterday were ever recomputed. applyEvent.ts now writes a
    // marker naming the refunded row (in the same transaction as the refund itself); each marker's
    // charge time is bucketed into this operator's day and that day is recomputed here too. Markers
    // are deleted only AFTER their day's rollup has been written, so a crash between the two just
    // recomputes the day again next hour — never loses one.
    const markersSnap = await deps.db.collection(`operators/${op.id}/metricsRecompute`).get();
    const markerDays = new Map<string, FirebaseFirestore.DocumentReference[]>();
    for (const m of markersSnap.docs) {
      const at = (m.data() as { at?: string }).at;
      const day = at ? dayStringInTz(Date.parse(at), tz) : today;
      days.add(day);
      markerDays.set(day, [...(markerDays.get(day) ?? []), m.ref]);
    }
    for (const day of days) {
      const result = await rollupOperatorDay(deps, op, day);
      venueDays += Object.keys(result.venues).length;
      const consumed = markerDays.get(day) ?? [];
      if (consumed.length > 0) {
        const batch = deps.db.batch();
        for (const ref of consumed) batch.delete(ref);
        await batch.commit();
      }
    }
  }
  return { operators: opsSnap.size, venueDays };
}

export const rollupMetrics = onSchedule({ schedule: 'every 1 hours' }, async () => {
  await rollupMetricsHandler(makeDeps());
});
