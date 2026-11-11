/**
 * Shared clock + deterministic id helpers for the owner-demo dataset (scripts/seed-demo.ts).
 *
 * Every timestamp is RELATIVE to the `now` the dataset is built for, so the demo always looks
 * live: queue SLA timers read minutes, "today" shifts exist, and 30-day reports have data. The
 * base seed (seed-emulator.ts) pins NOW to 2026-08-23 for its own deterministic tests, which is
 * why the demo layer re-times the base tickets too.
 *
 * Ids are deterministic (a counter, not random) so re-running the seed overwrites the same
 * documents instead of piling up duplicates, and so tests can assert on exact ids.
 */
import { DEMO_TIMEZONE } from './constants';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface DemoClock {
  /** The instant the dataset is built for. */
  readonly now: Date;
  /** ISO timestamp `minutes` before now (negative = in the future). */
  minutesAgo(minutes: number): string;
  /** ISO timestamp `days` before now, optionally shifted by `minutes`. */
  daysAgo(days: number, minutes?: number): string;
  /** Venue-local calendar day (YYYY-MM-DD) `days` before today (negative = future). */
  localDay(daysAgo: number): string;
  /** Venue-local month (YYYY-MM) `months` before this month. */
  localMonth(monthsAgo: number): string;
  /** ISO timestamp for a venue-local wall-clock time on a venue-local day (hour 0-23). */
  localTime(daysAgo: number, hour: number, minute?: number): string;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: DEMO_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Offset (ms) of DEMO_TIMEZONE from UTC at `instant`, e.g. -4h during US daylight time. */
function zoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DEMO_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function demoClock(now: Date): DemoClock {
  const nowMs = now.getTime();
  const localDay = (daysAgo: number): string => dayFormatter.format(new Date(nowMs - daysAgo * DAY_MS));
  return {
    now,
    minutesAgo: (minutes) => new Date(nowMs - minutes * MINUTE_MS).toISOString(),
    daysAgo: (days, minutes = 0) => new Date(nowMs - days * DAY_MS - minutes * MINUTE_MS).toISOString(),
    localDay,
    localMonth: (monthsAgo) => {
      const [year, month] = localDay(0).split('-').map(Number) as [number, number];
      const index = year * 12 + (month - 1) - monthsAgo;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    },
    localTime: (daysAgo, hour, minute = 0) => {
      const [y, m, d] = localDay(daysAgo).split('-').map(Number) as [number, number, number];
      const naiveUtc = Date.UTC(y, m - 1, d, hour, minute);
      // Interpret the wall-clock time in DEMO_TIMEZONE: subtract the zone offset at that instant.
      return new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc))).toISOString();
    },
  };
}

/**
 * Deterministic UUID that satisfies `isUuid` (version nibble 7, variant 8). `n` is unique per
 * demo document; the fixed `d3m0`-style prefix keeps every demo id recognisable in the console.
 */
export function demoUuid(n: number): string {
  return `0193d3e0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Deterministic 22-character url-safe token (secretTokenSchema). */
export function demoToken(n: number): string {
  return `DemoToken${String(n).padStart(13, '0')}`;
}

/** 64-char lowercase hex (photoSchema / claim bundle sha256) derived from `n`. */
export function demoSha256(n: number): string {
  return n.toString(16).padStart(64, '0');
}
