import type { MetricsDaily, VenueMetrics } from '../../src/schemas/metricsDaily';
import type { MetricsForecast, VenueForecast } from '../../src/schemas/metricsForecast';
import { OP, V_EVENT, V_HOTEL, V1 } from './constants';
import type { DemoClock } from './context';
import type { SeedDoc } from './types';

/**
 * Daily metrics and the staffing forecast are normally written by scheduled jobs
 * (rollupMetrics, buildForecast) that never run in the emulator, so the demo writes believable
 * numbers directly. Values follow a weekly rhythm (busy Fri/Sat, quiet Mon) with a deterministic
 * wobble so charts look real but the seed is reproducible.
 */
export const METRICS_DAYS = 60;

interface VenueProfile {
  id: string;
  baseTickets: number;
  price: number;
  /** Fraction of tickets that tip, and the average tip in cents. */
  tipRate: number;
  avgTip: number;
  /** Peak hour (venue-local 0-23) of the arrival curve. */
  peakHour: number;
}

const PROFILES: readonly VenueProfile[] = [
  { id: V1, baseTickets: 70, price: 1500, tipRate: 0.62, avgTip: 420, peakHour: 19 },
  { id: V_HOTEL, baseTickets: 45, price: 4800, tipRate: 0.41, avgTip: 600, peakHour: 17 },
  { id: V_EVENT, baseTickets: 25, price: 2000, tipRate: 0.33, avgTip: 300, peakHour: 18 },
];

/** Busy-day multiplier by weekday (0 = Sunday). */
const WEEKDAY_LOAD = [0.9, 0.55, 0.7, 0.8, 1.0, 1.45, 1.6] as const;

const wobble = (seed: number): number => 1 + 0.12 * Math.sin(seed * 12.9898);

function hourlyCurve(total: number, peakHour: number): number[] {
  const weights = Array.from({ length: 24 }, (_, h) => (h < 10 ? 0 : Math.exp(-((h - peakHour) ** 2) / 6)));
  const sum = weights.reduce((s, w) => s + w, 0);
  const hours = weights.map((w) => Math.floor((w / sum) * total));
  const peak = hours[peakHour] ?? 0;
  hours[peakHour] = peak + (total - hours.reduce((s, x) => s + x, 0));
  return hours;
}

function venueDay(p: VenueProfile, weekday: number, seed: number): VenueMetrics {
  const tickets = Math.round(p.baseTickets * (WEEKDAY_LOAD[weekday] ?? 1) * wobble(seed));
  const tipping = Math.round(tickets * p.tipRate);
  const tips = tipping * p.avgTip;
  const revenue = tickets * p.price;
  const laborCostTotal = Math.round(tickets * 380 * wobble(seed + 1));
  return {
    tickets,
    retrievalP50: Math.round(260 * wobble(seed + 2)),
    retrievalP90: Math.round(470 * wobble(seed + 3)),
    throughputPerAttendantHour: Number((7.5 * wobble(seed + 4)).toFixed(1)),
    tips,
    avgTip: tipping ? p.avgTip : null,
    tipRate: Number(p.tipRate.toFixed(2)),
    revenue,
    damageReports: Math.round(tickets * 0.18),
    claims: seed % 11 === 0 ? 1 : 0,
    laborCostPerVehicle: tickets ? Math.round(laborCostTotal / tickets) : null,
    hourly: hourlyCurve(tickets, p.peakHour),
    driveHome: p.id === V1 ? { jobs: Math.round(3 * (WEEKDAY_LOAD[weekday] ?? 1)), completionSec: 1_640, chaseUtilization: 0.71 } : { jobs: 0, completionSec: null, chaseUtilization: null },
    rides: { jobs: p.id === V_HOTEL ? Math.round(4 * (WEEKDAY_LOAD[weekday] ?? 1)) : 0 },
    credentialCompliance: 96,
    offlineSyncSuccess: 99.6,
    laborCostTotal,
    platformFees: Math.round(revenue * 0.015),
    refundedTotal: seed % 9 === 0 ? 1_905 : 0,
  };
}

function sumMetrics(parts: VenueMetrics[]): VenueMetrics {
  const sum = (pick: (m: VenueMetrics) => number): number => parts.reduce((s, m) => s + pick(m), 0);
  const tickets = sum((m) => m.tickets);
  const tips = sum((m) => m.tips);
  const tipping = parts.reduce((s, m) => s + (m.avgTip ? m.tips / m.avgTip : 0), 0);
  const laborCostTotal = sum((m) => m.laborCostTotal);
  const weighted = (pick: (m: VenueMetrics) => number | null): number | null => (tickets ? Math.round(parts.reduce((s, m) => s + (pick(m) ?? 0) * m.tickets, 0) / tickets) : null);
  return {
    tickets,
    retrievalP50: weighted((m) => m.retrievalP50),
    retrievalP90: weighted((m) => m.retrievalP90),
    throughputPerAttendantHour: Number((parts.reduce((s, m) => s + (m.throughputPerAttendantHour ?? 0), 0) / parts.length).toFixed(1)),
    tips,
    avgTip: tipping ? Math.round(tips / tipping) : null,
    tipRate: tickets ? Number((tipping / tickets).toFixed(2)) : null,
    revenue: sum((m) => m.revenue),
    damageReports: sum((m) => m.damageReports),
    claims: sum((m) => m.claims),
    laborCostPerVehicle: tickets ? Math.round(laborCostTotal / tickets) : null,
    hourly: Array.from({ length: 24 }, (_, h) => parts.reduce((s, m) => s + (m.hourly[h] ?? 0), 0)),
    driveHome: { jobs: sum((m) => m.driveHome.jobs), completionSec: 1_640, chaseUtilization: 0.71 },
    rides: { jobs: sum((m) => m.rides.jobs) },
    credentialCompliance: 96,
    offlineSyncSuccess: 99.6,
    laborCostTotal,
    platformFees: sum((m) => m.platformFees),
    refundedTotal: sum((m) => m.refundedTotal),
  };
}

/** ISO-8601 week id (e.g. 2026-W43) for a YYYY-MM-DD calendar day. */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function forecastFor(p: VenueProfile): VenueForecast {
  const byWeekdayHour = WEEKDAY_LOAD.map((load, weekday) => ({ weekday, hours: hourlyCurve(Math.round(p.baseTickets * load), p.peakHour) }));
  return {
    byWeekdayHour,
    // One attendant per ~6 arrivals in an hour, minimum one while open.
    suggestedAttendants: byWeekdayHour.map((row) => ({ weekday: row.weekday, hours: row.hours.map((n, h) => (h < 10 ? 0 : Math.max(1, Math.ceil(n / 6)))) })),
  };
}

export function buildMetrics(clock: DemoClock): SeedDoc[] {
  const docs: SeedDoc[] = [];
  for (let daysAgo = 0; daysAgo < METRICS_DAYS; daysAgo++) {
    const day = clock.localDay(daysAgo);
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const venues: Record<string, VenueMetrics> = {};
    PROFILES.forEach((p, i) => {
      venues[p.id] = venueDay(p, weekday, daysAgo * 7 + i);
    });
    const data: MetricsDaily = { venues, operator: sumMetrics(Object.values(venues)), day, updatedAt: clock.minutesAgo(daysAgo === 0 ? 10 : daysAgo * 1440 - 120) };
    docs.push({ kind: 'metricsDaily', path: `operators/${OP}/metrics/daily/days/${day}`, data });
  }
  const venues: Record<string, VenueForecast> = Object.fromEntries(PROFILES.map((p) => [p.id, forecastFor(p)]));
  for (const weeksAhead of [0, 1]) {
    const week = isoWeek(clock.localDay(-7 * weeksAhead));
    const data: MetricsForecast = { venues, isoWeek: week, weeksAveraged: 4, updatedAt: clock.minutesAgo(180) };
    docs.push({ kind: 'metricsForecast', path: `operators/${OP}/metrics/forecast/weeks/${week}`, data });
  }
  return docs;
}
