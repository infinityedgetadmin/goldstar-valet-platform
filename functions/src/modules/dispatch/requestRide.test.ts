import { beforeEach, expect, it, vi } from 'vitest';
import { guestRequestRideHandler } from './requestRide.js';
import type { MapsProvider } from '../maps/port.js';
import * as mapsRegistry from '../maps/registry.js';
import { OP, TID, TOKEN, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  ride?: { pickup?: { venueId?: string }; billTo?: string };
  flags?: { accessibleVehicle?: boolean };
}

function useFakeMaps(): MapsProvider {
  const maps: MapsProvider = {
    autocomplete: () => Promise.reject(new Error('not stubbed')),
    retrieve: () => Promise.reject(new Error('not stubbed')),
    route: () => Promise.resolve({ distanceMeters: 1609.344, durationSec: 120, polyline: 'p' }),
  };
  vi.spyOn(mapsRegistry, 'getMaps').mockReturnValue(maps);
  return maps;
}

async function seedParent(deps: ReturnType<typeof testDeps>) {
  await seedOperator(deps);
  const t = ticketDoc();
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
}

it('creates a linked passenger_ride job, deriving venueId from the parent ticket regardless of a client-supplied pickup.venueId', async () => {
  const deps = testDeps();
  await seedParent(deps);
  useFakeMaps();
  const out = await guestRequestRideHandler(deps, null, {
    token: TOKEN,
    pickup: { address: 'curbside', geo: { lat: 39.76, lng: -86.16 }, venueId: 'SOME_OTHER_VENUE_ID' },
    dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } },
    passengers: 2,
    accessible: true,
  });
  const jobs = await deps.db.collection(`operators/${OP}/tickets`).where('parentTicketId', '==', TID).get();
  expect(jobs.size).toBe(1);
  const job = jobs.docs[0]!.data() as JobView;
  expect(job).toMatchObject({ jobType: 'passenger_ride', status: 'quoted', guestToken: out.jobToken });
  // venueId is ALWAYS the parent's own venueId — never the client-supplied one.
  expect(job.ride?.pickup?.venueId).toBe(V1);
  expect(job.flags?.accessibleVehicle).toBe(true);
  expect(job.ride?.billTo).toBe('guest');

  // Fix round 1 (Critical #2): the job's own projection carries quote+dropoff+passengers; the parent
  // (valet) projection is unaffected.
  const jobProj = (await deps.db.doc(P.guestTicket(out.jobToken)).get()).data() as { ride?: { quote?: unknown; dropoff?: { address?: string }; passengers?: number }; driveHome?: unknown };
  expect(jobProj.ride?.quote).toEqual(out.quote);
  expect(jobProj.ride?.dropoff?.address).toBe('2 Away Ave');
  expect(jobProj.ride?.passengers).toBe(2);
  expect(jobProj.driveHome).toBeUndefined();
  const parentProj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as { ride?: unknown; driveHome?: unknown };
  expect(parentProj.ride).toBeUndefined();
  expect(parentProj.driveHome).toBeUndefined();
});

it('rejects when passenger_rides is not enabled for the operator', async () => {
  const deps = testDeps();
  await seedParent(deps);
  await deps.db.doc(P.operator(OP)).update({ 'features.passengerRides': false });
  useFakeMaps();
  await expect(
    guestRequestRideHandler(deps, null, { token: TOKEN, pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
});
