import { beforeEach, expect, it } from 'vitest';
import { etaRefreshHandler } from './eta.js';
import type { MapsProvider } from '../maps/port.js';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  driveHome?: { etaAt?: string };
}
interface ProjView {
  driver?: { firstName?: string; etaAt?: string; geo?: { lat: number; lng: number } };
}

function fakeMaps(overrides: Partial<MapsProvider> = {}): MapsProvider {
  return {
    autocomplete: () => Promise.reject(new Error('not stubbed')),
    retrieve: () => Promise.reject(new Error('not stubbed')),
    route: () => Promise.resolve({ distanceMeters: 5000, durationSec: 300, polyline: 'p' }),
    ...overrides,
  };
}

async function seedInTransitJob(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'drive_home',
    status: 'in_transit',
    attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' },
    driveHome: { destination: { address: 'x', geo: { lat: 40, lng: -86 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'following' } },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  return job;
}

it('routes from the primary driver last live location to the destination and updates both the ticket etaAt and the projection driver.etaAt/geo', async () => {
  const deps = testDeps();
  const job = await seedInTransitJob(deps);
  await deps.db.doc(P.liveLocation(OP, 'primary1')).set({ ticketId: TID, geo: { lat: 39.9, lng: -86.05 }, heading: 90, speed: 15, at: NOW, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() });
  const seenRoutes: { from: unknown; to: unknown }[] = [];
  const maps = fakeMaps({
    route: (i) => {
      seenRoutes.push(i);
      return Promise.resolve({ distanceMeters: 5000, durationSec: 300, polyline: 'p' });
    },
  });

  const out = await etaRefreshHandler(deps, maps);
  expect(out).toEqual({ updated: 1, skipped: 0 });
  expect(seenRoutes).toEqual([{ from: { lat: 39.9, lng: -86.05 }, to: { lat: 40, lng: -86 } }]);

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  const expectedEta = new Date(Date.parse(NOW) + 300_000).toISOString();
  expect(t.driveHome?.etaAt).toBe(expectedEta);

  const proj = (await deps.db.doc(P.guestTicket(job.guestToken)).get()).data() as ProjView;
  expect(proj.driver?.etaAt).toBe(expectedEta);
  expect(proj.driver?.geo).toEqual({ lat: 39.9, lng: -86.05 });
});

it('does not clobber driver.firstName/photoUrl already on the projection — a targeted field update, not a full-map replace', async () => {
  const deps = testDeps();
  const job = await seedInTransitJob(deps);
  await deps.db.doc(P.liveLocation(OP, 'primary1')).set({ ticketId: TID, geo: { lat: 39.9, lng: -86.05 }, heading: 90, speed: 15, at: NOW, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() });
  // Simulate a prior full projection rebuild that already derived driver.firstName (dispatchAssign's
  // own ticketWrittenHandler call would have set this via deriveDriverInfo).
  await deps.db.doc(P.guestTicket(job.guestToken)).update({ 'driver.firstName': 'Pat' });

  await etaRefreshHandler(deps, fakeMaps());

  const proj = (await deps.db.doc(P.guestTicket(job.guestToken)).get()).data() as ProjView;
  expect(proj.driver?.firstName).toBe('Pat');
  expect(proj.driver?.etaAt).toBeDefined();
});

it('skips a job with no live location, or an EXPIRED one, without throwing', async () => {
  const deps = testDeps();
  await seedInTransitJob(deps); // no liveLocations doc at all
  expect(await etaRefreshHandler(deps, fakeMaps())).toEqual({ updated: 0, skipped: 1 });

  await deps.db.doc(P.liveLocation(OP, 'primary1')).set({ ticketId: TID, geo: { lat: 1, lng: 2 }, heading: 0, speed: 0, at: NOW, expiresAt: '2020-01-01T00:00:00.000Z' });
  expect(await etaRefreshHandler(deps, fakeMaps())).toEqual({ updated: 0, skipped: 1 });
});

it("a route failure for one job doesn't block the sweep — counted as skipped, not thrown", async () => {
  const deps = testDeps();
  await seedInTransitJob(deps);
  await deps.db.doc(P.liveLocation(OP, 'primary1')).set({ ticketId: TID, geo: { lat: 39.9, lng: -86.05 }, heading: 90, speed: 15, at: NOW, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() });
  const maps = fakeMaps({ route: () => Promise.reject(new Error('mapbox down')) });
  await expect(etaRefreshHandler(deps, maps)).resolves.toEqual({ updated: 0, skipped: 1 });
});

it('ignores a passenger_ride job with no primaryDriverUid assigned yet', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'in_transit',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  expect(await etaRefreshHandler(deps, fakeMaps())).toEqual({ updated: 0, skipped: 1 });
});
