import { beforeEach, expect, it } from 'vitest';
import { quoteJob } from './quote.js';
import type { MapsProvider } from '../maps/port.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Operator, Ticket, Venue } from '@goldstar/platform';

beforeEach(async () => {
  await wipe(testDeps());
});

function fakeMaps(overrides: Partial<MapsProvider> = {}): MapsProvider {
  return {
    autocomplete: () => Promise.reject(new Error('autocomplete not stubbed')),
    retrieve: () => Promise.reject(new Error('retrieve not stubbed')),
    route: () => Promise.resolve({ distanceMeters: 16_093, durationSec: 900, polyline: 'enc_poly' }), // 10 miles, 15 min
    ...overrides,
  };
}

async function loadOpAndVenue(deps: ReturnType<typeof testDeps>): Promise<{ op: Operator; venue: Venue }> {
  const op = (await deps.db.doc(P.operator(OP)).get()).data() as Operator;
  const venue = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Venue;
  return { op, venue };
}

it('routes from venue.geo to driveHome.destination.geo, prices via venue.rates.driveHome, and stamps a 15-minute expiry', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { op, venue } = await loadOpAndVenue(deps);
  const seen: { from: unknown; to: unknown }[] = [];
  const maps = fakeMaps({
    route: (i) => {
      seen.push(i);
      return Promise.resolve({ distanceMeters: 16_093, durationSec: 900, polyline: 'enc_poly' });
    },
  });
  const ticket: Ticket = ticketDoc({
    id: TID,
    jobType: 'drive_home',
    status: 'requested',
    driveHome: { destination: { address: '1 Home St', geo: { lat: 39.8, lng: -86.1 } }, chase: { status: 'pending' } },
  }) as unknown as Ticket;
  const { quote, route } = await quoteJob(deps, op, venue, ticket, maps);
  expect(seen).toEqual([{ from: venue.geo, to: { lat: 39.8, lng: -86.1 } }]);
  expect(route).toBe('enc_poly');
  // venue.rates.driveHome = { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 } (test/helpers.ts)
  // 10 miles * 250 = 2500; 15 min * 50 = 750; base 2500 -> raw 5750, above the 3900 minimum.
  expect(quote).toMatchObject({ base: 2500, distanceMeters: 16_093, durationSec: 900, amount: 5750 });
  expect(quote.expiresAt).toBe(new Date(Date.parse(NOW) + 15 * 60_000).toISOString());
});

it('routes to ride.dropoff.geo and prices via venue.rates.passengerRide for a passenger_ride ticket', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { op, venue } = await loadOpAndVenue(deps);
  const maps = fakeMaps({ route: () => Promise.resolve({ distanceMeters: 1609.344, durationSec: 60, polyline: 'p' }) }); // 1 mile, 1 min
  const ticket: Ticket = ticketDoc({
    id: TID,
    jobType: 'passenger_ride',
    status: 'requested',
    ride: { pickup: { geo: venue.geo, venueId: V1 }, dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } }, passengers: 2, accessible: false, billTo: 'guest' },
  }) as unknown as Ticket;
  const { quote } = await quoteJob(deps, op, venue, ticket, maps);
  // venue.rates.passengerRide = { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 }
  // 1 mile * 200 = 200; 1 min * 40 = 40; base 1000 -> raw 1240, below the 1500 minimum -> clamped.
  expect(quote.amount).toBe(1500);
  expect(quote.breakdown.find((b) => b.label === 'Minimum fare adjustment')).toBeDefined();
});

it('throws invalid_argument for a valet ticket (no trip rates) and for a job ticket missing its destination', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { op, venue } = await loadOpAndVenue(deps);
  const maps = fakeMaps();
  const valet = ticketDoc({ id: TID }) as unknown as Ticket;
  await expect(quoteJob(deps, op, venue, valet, maps)).rejects.toMatchObject({ code: 'invalid_argument' });
  const noDest = ticketDoc({ id: TID, jobType: 'drive_home', status: 'requested' }) as unknown as Ticket;
  await expect(quoteJob(deps, op, venue, noDest, maps)).rejects.toMatchObject({ code: 'invalid_argument' });
});
