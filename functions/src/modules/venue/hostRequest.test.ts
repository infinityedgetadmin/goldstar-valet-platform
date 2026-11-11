import { beforeEach, expect, it, vi } from 'vitest';
import type { Ticket } from '@goldstar/platform';
import type { Caller } from '../../lib/callable.js';
import { etaToInstant, venueHostRequestHandler } from './hostRequest.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { MapsProvider } from '../maps/port.js';
import * as mapsRegistry from '../maps/registry.js';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function useMaps() {
  const maps = {
    route: () => Promise.resolve({ distanceMeters: 8000, durationSec: 900, polyline: 'abc' }),
    autocomplete: () => Promise.resolve({ suggestions: [] }),
  } as unknown as MapsProvider;
  vi.spyOn(mapsRegistry, 'getMaps').mockReturnValue(maps);
  return maps;
}

async function seedParked(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc({ status: 'checked_in', ...over });
  await deps.db.doc(P.ticket(OP, (t as { id: string }).id)).set(t);
  return t;
}

async function hostRequests(deps: ReturnType<typeof testDeps>): Promise<Record<string, unknown>[]> {
  const snap = await deps.db.collection(`operators/${OP}/hostRequests`).get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

// ---------- authorization (T1b gap-5 ruling) ----------

it('rejects a caller without the venue_user role', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(
    venueHostRequestHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] }, { venueId: V1, kind: 'car', phoneLast4: '0123' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

it('SECURITY: rejects a venue_user whose claim does not carry the target venue — input.venueId is never trusted', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(
    venueHostRequestHandler(deps, { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] }, { venueId: V1, kind: 'car', phoneLast4: '0123' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

it('rejects when the operator is suspended (staff-scoped ACT)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  await expect(venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '0123' })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- kind: car ----------

it('car, matched: transitions the checked_in ticket to requested with the hostRequest block, and returns its id', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '0123', table: '12', note: 'in a hurry' });

  expect(out.ticketId).toBe(TID);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as Ticket;
  expect(t.status).toBe('requested');
  expect(t.times.requestedAt).toBe(NOW);
  expect(t.hostRequest).toEqual({ requestedBy: 'host1', table: '12', note: 'in a hurry' });
  const [hr] = await hostRequests(deps);
  expect(hr).toMatchObject({ kind: 'car', status: 'matched', ticketId: TID, phoneLast4: '0123', by: 'host1', venueId: V1 });
});

it('car, matched via a full phoneE164 (last-4 derived)', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneE164: '+13175550123' });
  expect(out.ticketId).toBe(TID);
});

it('car, unmatched: creates an unmatched hostRequests doc, notifies the venue topic, returns no ticketId', async () => {
  const deps = testDeps();
  await seedOperator(deps); // no parked ticket at all
  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '9999', name: 'Ana' });

  expect(out.ticketId).toBeUndefined();
  const [hr] = await hostRequests(deps);
  expect(hr).toMatchObject({ kind: 'car', status: 'unmatched', phoneLast4: '9999', name: 'Ana' });
  const push = (await deps.db.doc(`pushEvents/venue_car_${out.hostRequestId}`).get()).data()!;
  expect(push).toMatchObject({ kind: 'venue.request', toTopic: 'venue_slug_v1', status: 'queued' });
});

it('car, AMBIGUOUS: two same-last-4 parked cars with no name goes unmatched — never guesses which car to send up', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const second = ticketDoc({ id: '01912345-7abc-7def-8123-456789abcd77', status: 'checked_in', guest: { phoneE164: '+13185550123', phoneLast4: '0123', consentSms: true, name: 'Ben' } });
  await deps.db.doc(P.ticket(OP, second.id)).set(second);

  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '0123' });
  expect(out.ticketId).toBeUndefined();
  expect((await hostRequests(deps))[0]).toMatchObject({ status: 'unmatched' });
  // both tickets untouched
  expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as Ticket).status).toBe('checked_in');
});

it('car, ambiguous-then-narrowed: the optional name disambiguates to exactly one and matches it', async () => {
  const deps = testDeps();
  await seedParked(deps, { guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, name: 'Ana Rivera' } });
  const second = ticketDoc({ id: '01912345-7abc-7def-8123-456789abcd77', status: 'checked_in', guest: { phoneE164: '+13185550123', phoneLast4: '0123', consentSms: true, name: 'Ben Cho' } });
  await deps.db.doc(P.ticket(OP, second.id)).set(second);

  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '0123', name: 'ana rivera' });
  expect(out.ticketId).toBe(TID);
});

it('car: a ticket at another venue or already in motion never matches', async () => {
  const deps = testDeps();
  await seedParked(deps, { status: 'requested' }); // already requested
  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car', phoneLast4: '0123' });
  expect(out.ticketId).toBeUndefined();
});

it('car: requires a phone in some form', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'car' })).rejects.toMatchObject({ code: 'invalid_argument' });
});

// ---------- kind: pre_arrival ----------

it('pre_arrival: creates an open hostRequests doc with eta/partySize/vip and pushes the venue topic', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const out = await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'pre_arrival', name: 'Ana Rivera', eta: '19:30', partySize: 6, vip: true, note: 'Anniversary' });

  const [hr] = await hostRequests(deps);
  // RULING AD: eta is stored as an ISO INSTANT anchored to the venue timezone, never the bare
  // local string. NOW is 21:00Z = 17:00 America/Indiana/Indianapolis (EDT, UTC-4); a 19:30 local
  // ETA is therefore 23:30Z the same day. The push payload keeps the venue-LOCAL display form.
  expect(hr).toMatchObject({ kind: 'pre_arrival', status: 'open', name: 'Ana Rivera', eta: '2026-08-23T23:30:00.000Z', partySize: 6, vip: true, note: 'Anniversary' });
  const push = (await deps.db.doc(`pushEvents/venue_prearrival_${out.hostRequestId}`).get()).data()!;
  expect(push).toMatchObject({ kind: 'venue.pre_arrival', toTopic: 'venue_slug_v1', data: { name: 'Ana Rivera', eta: '7:30 PM', partySize: '6', vip: '1' } });
});

it('RULING AF: an ETA just past venue-local now clamps to NOW — the card surfaces tonight, not tomorrow', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  // 16:45 local is 15 min before local-now (17:00) — inside the 30-min grace -> clamps to NOW.
  await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'pre_arrival', name: 'Ana', eta: '16:45' });
  const [hr] = await hostRequests(deps);
  expect(hr!.eta).toBe(NOW);
});

it('RULING AD/AF: an ETA well past venue-local now still rolls to the NEXT occurrence (tomorrow)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  // 12:15 local is 4h45m before local-now (17:00) — far outside the grace -> next day, 16:15Z.
  await venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'pre_arrival', name: 'Ana', eta: '12:15' });
  const [hr] = await hostRequests(deps);
  expect(hr!.eta).toBe('2026-08-24T16:15:00.000Z');
});

it('RULING AD: a non-HH:mm eta is rejected rather than stored ambiguous', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'pre_arrival', name: 'Ana', eta: 'around 7' })).rejects.toMatchObject({
    code: 'invalid_argument',
    message: 'eta must be HH:mm',
  });
});

it('RULING AD unit: etaToInstant anchors to the zone and rejects non-HH:mm', () => {
  const now = '2026-08-23T21:00:00.000Z'; // 17:00 in America/Indiana/Indianapolis (EDT)
  expect(etaToInstant('19:30', 'America/Indiana/Indianapolis', now)).toBe('2026-08-23T23:30:00.000Z');
  // A different zone reads the same wall clock differently — the whole point of storing an instant.
  expect(etaToInstant('19:30', 'America/Los_Angeles', now)).toBe('2026-08-24T02:30:00.000Z');
  expect(etaToInstant('7pm', 'America/Indiana/Indianapolis', now)).toBeUndefined();
  expect(etaToInstant('24:00', 'America/Indiana/Indianapolis', now)).toBeUndefined();
});

it('RULING AL: DST — an ETA straddling the spring-forward transition lands on the correct instant; the two-pass offset fixed point is what prevents a one-hour error', () => {
  // 2026-03-08, America/Indiana/Indianapolis: 02:00 EST springs forward to 03:00 EDT.
  // now = 06:00Z = 01:00 EST (pre-transition); eta 03:30 is POST-transition (EDT, UTC-4).
  // Correct: 2026-03-08T07:30:00.000Z. A single-pass version — offset taken at the naive wall
  // reading, still EST — returns 08:30Z, a full hour late: a guest at the door while the stand
  // expects them at the top of the next hour. This test is what makes the second pass in
  // etaToInstant load-bearing rather than an odd-looking double computation.
  expect(etaToInstant('03:30', 'America/Indiana/Indianapolis', '2026-03-08T06:00:00.000Z')).toBe('2026-03-08T07:30:00.000Z');
});

it('RULING AF unit: the grace-window boundaries — just inside clamps, exactly at clamps, just outside rolls, cross-midnight rolls', () => {
  const now = '2026-08-23T21:00:00.000Z'; // 17:00 venue-local (EDT)
  const tz = 'America/Indiana/Indianapolis';
  // 29 min past — inside the window -> clamps to NOW.
  expect(etaToInstant('16:31', tz, now)).toBe(now);
  // exactly 30 min past — "up to 30 minutes" is inclusive -> clamps to NOW.
  expect(etaToInstant('16:30', tz, now)).toBe(now);
  // 31 min past — outside the window -> rolls to tomorrow, 20:29Z.
  expect(etaToInstant('16:29', tz, now)).toBe('2026-08-24T20:29:00.000Z');
  // the genuine next-day case (11:50pm host typing 12:15am) still rolls.
  const lateNow = '2026-08-24T03:50:00.000Z'; // 23:50 venue-local on the 23rd
  expect(etaToInstant('00:15', tz, lateNow)).toBe('2026-08-24T04:15:00.000Z'); // 00:15 local on the 24th
});

it('pre_arrival: name is required', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'pre_arrival' })).rejects.toMatchObject({ code: 'invalid_argument' });
});

// ---------- kind: ride (Rulings Q + R) ----------

const RIDE_INPUT = {
  venueId: V1,
  kind: 'ride' as const,
  dropoff: { address: '500 Festival Way', geo: { lat: 39.9, lng: -86.2 } },
  passengers: 4,
  accessible: true,
  name: 'Ana Rivera',
};

const { dropoff: RIDE_DROPOFF, passengers: RIDE_PAX, accessible: RIDE_ACC, ...RIDE_REST } = RIDE_INPUT;
const RIDE_WITHOUT: Record<'dropoff' | 'passengers' | 'accessible', typeof RIDE_INPUT> = {
  dropoff: { ...RIDE_REST, passengers: RIDE_PAX, accessible: RIDE_ACC } as typeof RIDE_INPUT,
  passengers: { ...RIDE_REST, dropoff: RIDE_DROPOFF, accessible: RIDE_ACC } as typeof RIDE_INPUT,
  accessible: { ...RIDE_REST, dropoff: RIDE_DROPOFF, passengers: RIDE_PAX } as typeof RIDE_INPUT,
};

it.each([['dropoff'], ['passengers'], ['accessible']] as const)(
  'RULING R: ride with %s absent is rejected with invalid_argument naming the field — no defaults, ever',
  async (field) => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(venueHostRequestHandler(deps, HOST, RIDE_WITHOUT[field])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: `${field} required for a ride request`,
    });
  },
);

it('RULING R: ride with all three absent names all three', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueHostRequestHandler(deps, HOST, { venueId: V1, kind: 'ride' })).rejects.toMatchObject({
    code: 'invalid_argument',
    message: 'dropoff, passengers, accessible required for a ride request',
  });
});

it('RULING Q: ride creates a venue-billed passenger_ride at confirmed — quoted, dispatchable, one write', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  useMaps();
  const out = await venueHostRequestHandler(deps, HOST, RIDE_INPUT);

  expect(out.ticketId).toBeDefined();
  const t = (await deps.db.doc(P.ticket(OP, out.ticketId!)).get()).data() as Ticket;
  expect(t).toMatchObject({ jobType: 'passenger_ride', status: 'confirmed', source: 'host_portal' });
  expect(t.flags.accessibleVehicle).toBe(true);
  expect(t.ride).toMatchObject({ billTo: 'venue', passengers: 4, accessible: true, dropoff: RIDE_INPUT.dropoff });
  // pickup is the venue itself
  expect(t.ride!.pickup.geo).toEqual({ lat: 39.765, lng: -86.158 });
  expect(t.ride!.pickup.address).toContain('127 S Illinois St');
  // quoted server-side; the quote is what invoicing bills from (Ruling O/T framing)
  expect(t.ride!.quote!.amount).toBeGreaterThan(0);
  // no phone given -> the documented schema-valid sentinel, never an invented real-looking number
  expect(t.guest.phoneLast4).toBe('0000');
  expect(t.guest.name).toBe('Ana Rivera');

  const [hr] = await hostRequests(deps);
  expect(hr).toMatchObject({ kind: 'ride', status: 'matched', ticketId: out.ticketId });
});

it('ride: rejected when the operator has passenger rides disabled', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ 'features.passengerRides': false });
  useMaps();
  await expect(venueHostRequestHandler(deps, HOST, RIDE_INPUT)).rejects.toMatchObject({ code: 'failed_precondition' });
});
