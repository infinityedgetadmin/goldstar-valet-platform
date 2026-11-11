import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { ICalScheduleProvider } from './ical.adapter.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import type { ProviderContext } from './port.js';

const fixturePath = fileURLToPath(new URL('../../../test/fixtures/ical/three-events.ics', import.meta.url));
const THREE_EVENTS_ICS = readFileSync(fixturePath, 'utf8');

function ctx(deps: ReturnType<typeof testDeps>, config: Record<string, unknown>): ProviderContext {
  return { deps, operatorId: OP, config, secret: () => '' };
}

beforeEach(async () => {
  await wipe(testDeps());
});

it('parses 3 VEVENTs — 2 single occurrences plus a weekly recurrence — into 5 ExternalShifts in a 2-week range', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response(THREE_EVENTS_ICS, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  expect(result.errors).toEqual([]);
  expect(result.shifts).toHaveLength(5);
  expect(result.shifts.every((s) => s.venueId === 'v1')).toBe(true);
});

it('maps a single VEVENT to an ExternalShift with the right externalId, times, and attendee email', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response(THREE_EVENTS_ICS, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  const single = result.shifts.find((s) => s.externalId === 'single-valet-event-1@goldstar.example.com');
  expect(single).toEqual({
    externalId: 'single-valet-event-1@goldstar.example.com',
    venueId: 'v1',
    date: '2026-09-02',
    startsAt: '2026-09-02T13:00:00.000Z',
    endsAt: '2026-09-02T21:00:00.000Z',
    assignments: [{ email: 'john@goldstar.example.com', role: 'attendant' }],
  });
});

it('a SUMMARY containing "lead" (case-insensitive) assigns role "lead" to every attendee on that event', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response(THREE_EVENTS_ICS, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  const lead = result.shifts.find((s) => s.externalId === 'single-lead-event-2@goldstar.example.com');
  expect(lead!.assignments).toEqual([{ email: 'jane@goldstar.example.com', role: 'lead' }]);
});

it('a recurring event\'s 3 occurrences each get a distinct externalId derived from the UID', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response(THREE_EVENTS_ICS, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  const weekly = result.shifts.filter((s) => s.externalId.startsWith('weekly-valet-event-3@goldstar.example.com'));
  expect(weekly).toHaveLength(3);
  const ids = new Set(weekly.map((s) => s.externalId));
  expect(ids.size).toBe(3); // no collisions
  expect(weekly.map((s) => s.date).sort()).toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
});

it('RECURRENCE-ID overrides replace the master\'s slot (no phantom original) and two overrides on the same series don\'t collide (M2)', async () => {
  const deps = testDeps();
  // A weekly 3-occurrence series (Sep 1 / 8 / 15) with TWO overrides, matching a "drag one
  // occurrence to a different day" edit in Google Calendar: Sep 1's occurrence is moved to Sep 2,
  // and Sep 8's occurrence is moved to Sep 9. Both overrides keep the master's UID and carry their
  // own RECURRENCE-ID (the ORIGINAL slot they replace) plus their own (moved) DTSTART/DTEND.
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Goldstar Test Fixture//EN
BEGIN:VEVENT
UID:weekly-override-series@goldstar.example.com
DTSTAMP:20260825T120000Z
DTSTART:20260901T130000Z
DTEND:20260901T210000Z
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Weekly Valet Shift
ATTENDEE:mailto:sam@goldstar.example.com
END:VEVENT
BEGIN:VEVENT
UID:weekly-override-series@goldstar.example.com
RECURRENCE-ID:20260901T130000Z
DTSTAMP:20260825T120000Z
DTSTART:20260902T140000Z
DTEND:20260902T220000Z
SUMMARY:Weekly Valet Shift (moved)
ATTENDEE:mailto:sam@goldstar.example.com
END:VEVENT
BEGIN:VEVENT
UID:weekly-override-series@goldstar.example.com
RECURRENCE-ID:20260908T130000Z
DTSTAMP:20260825T120000Z
DTSTART:20260909T140000Z
DTEND:20260909T220000Z
SUMMARY:Weekly Valet Shift (moved)
ATTENDEE:mailto:sam@goldstar.example.com
END:VEVENT
END:VCALENDAR
`;
  const fetchFn = () => Promise.resolve(new Response(ics, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  const series = result.shifts.filter((s) => s.externalId.startsWith('weekly-override-series@goldstar.example.com'));
  // 3 total: the untouched Sep 15 master occurrence, plus the two overrides. NOT 5 (which is what
  // the bug produced: 3 master expansions including the two now-superseded original slots, plus
  // the 2 overrides each colliding onto the SAME bare-UID externalId and losing one of them).
  expect(series).toHaveLength(3);
  const ids = series.map((s) => s.externalId).sort();
  expect(ids).toEqual([
    'weekly-override-series@goldstar.example.com#2026-09-01', // override, keyed by the ORIGINAL slot it replaces
    'weekly-override-series@goldstar.example.com#2026-09-08', // override, keyed by the ORIGINAL slot it replaces
    'weekly-override-series@goldstar.example.com#2026-09-15', // untouched master occurrence
  ]);
  const moved1 = series.find((s) => s.externalId.endsWith('#2026-09-01'))!;
  expect(moved1.startsAt).toBe('2026-09-02T14:00:00.000Z'); // the override's OWN (moved) time, not the original slot's
  const moved2 = series.find((s) => s.externalId.endsWith('#2026-09-08'))!;
  expect(moved2.startsAt).toBe('2026-09-09T14:00:00.000Z');
  const untouched = series.find((s) => s.externalId.endsWith('#2026-09-15'))!;
  expect(untouched.startsAt).toBe('2026-09-15T13:00:00.000Z');
});

it('DESCRIPTION "email:" line is used when the VEVENT has no ATTENDEE property', async () => {
  const deps = testDeps();
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Goldstar Test Fixture//EN
BEGIN:VEVENT
UID:description-fallback@goldstar.example.com
DTSTAMP:20260825T120000Z
DTSTART:20260903T130000Z
DTEND:20260903T210000Z
SUMMARY:Valet Shift
DESCRIPTION:Notes: bring extra cones. email: pat@goldstar.example.com
END:VEVENT
END:VCALENDAR
`;
  const fetchFn = () => Promise.resolve(new Response(ics, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  expect(result.shifts[0]!.assignments).toEqual([{ email: 'pat@goldstar.example.com', role: 'attendant' }]);
});

it('matchBy "name" resolves the ATTENDEE\'s CN parameter against operators/{op}/users and uses that user\'s real email', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(`operators/${OP}/users/u_ana`).set({ id: 'u_ana', name: 'Ana Rivera', email: 'ana.real@goldstar.example.com', roles: ['attendant'] });
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Goldstar Test Fixture//EN
BEGIN:VEVENT
UID:name-match@goldstar.example.com
DTSTAMP:20260825T120000Z
DTSTART:20260904T130000Z
DTEND:20260904T210000Z
SUMMARY:Valet Shift
ATTENDEE;CN=Ana Rivera:mailto:calendar-address-goes-unused@example.com
END:VEVENT
END:VCALENDAR
`;
  const fetchFn = () => Promise.resolve(new Response(ics, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'name' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  expect(result.shifts[0]!.assignments).toEqual([{ email: 'ana.real@goldstar.example.com', role: 'attendant' }]);
  expect(result.errors).toEqual([]);
});

it('matchBy "name" reports (does not throw or silently drop the shift for) a CN with no matching user', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Goldstar Test Fixture//EN
BEGIN:VEVENT
UID:name-unmatched@goldstar.example.com
DTSTAMP:20260825T120000Z
DTSTART:20260904T130000Z
DTEND:20260904T210000Z
SUMMARY:Valet Shift
ATTENDEE;CN=Nobody Here:mailto:calendar-address-goes-unused@example.com
END:VEVENT
END:VCALENDAR
`;
  const fetchFn = () => Promise.resolve(new Response(ics, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'name' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  expect(result.shifts).toHaveLength(1);
  expect(result.shifts[0]!.assignments).toEqual([]);
  expect(result.errors).toEqual(['unresolved name "Nobody Here" on name-unmatched@goldstar.example.com']);
});

it('healthCheck: a 200 response with at least one VCALENDAR is ok', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response(THREE_EVENTS_ICS, { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.healthCheck(ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }));

  expect(result).toEqual({ ok: true });
});

it('healthCheck: a non-200 response is not ok, with a message', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response('not found', { status: 404 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.healthCheck(ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }));

  expect(result.ok).toBe(false);
  expect(result.message).toContain('404');
});

it('healthCheck: a 200 response with no VCALENDAR content is not ok', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.resolve(new Response('not a calendar', { status: 200 }));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.healthCheck(ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }));

  expect(result.ok).toBe(false);
});

it('sync reports a fetch failure as a SyncResult error rather than throwing', async () => {
  const deps = testDeps();
  const fetchFn = () => Promise.reject(new Error('network down'));
  const provider = new ICalScheduleProvider(fetchFn);

  const result = await provider.sync(
    ctx(deps, { feedUrl: 'https://example.com/feed.ics', venueId: 'v1', matchBy: 'email' }),
    { from: '2026-09-01', to: '2026-09-15' },
  );

  expect(result.shifts).toEqual([]);
  expect(result.errors).toEqual(['network down']);
});
