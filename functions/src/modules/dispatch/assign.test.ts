import { beforeEach, expect, it, vi } from 'vitest';
import { dispatchAssignHandler, dispatchQuoteHandler } from './assign.js';
import type { MapsProvider } from '../maps/port.js';
import * as mapsRegistry from '../maps/registry.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import type { Caller } from '../../lib/callable.js';

beforeEach(async () => {
  await wipe(testDeps());
});

const LEAD: Caller = { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] };

interface JobView {
  status?: string;
  guestToken?: string;
  attendants?: { primaryDriverUid?: string; chaseDriverUid?: string; chaseVehicleId?: string };
  driveHome?: { chase?: { status?: string }; quote?: { expiresAt?: string }; route?: string };
  times?: { assignedAt?: string };
  vehicle?: { fleetVehicleId?: string };
}
interface FleetView {
  status?: string;
  currentDriverUid?: string;
  accessible?: boolean;
}
interface PushView {
  toUid?: string;
  kind?: string;
  data?: { role?: string };
}
interface SmsView {
  template?: string;
  vars?: Record<string, unknown>;
}

async function seedDriver(deps: ReturnType<typeof testDeps>, uid: string, eligibility: { driveHome: boolean; passengerRide: boolean }) {
  await deps.db.doc(P.user(OP, uid)).set({
    uid,
    operatorId: OP,
    displayName: `Driver ${uid}`,
    email: `${uid}@example.com`,
    roles: ['driver'],
    venueIds: [V1],
    status: 'active',
    eligibility: { ...eligibility, reasons: [] },
    payoutStatus: 'none',
    fcmTokens: [],
    invitedAt: NOW,
  });
}

async function seedFleetVehicle(deps: ReturnType<typeof testDeps>, id: string, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.fleetVehicle(OP, id)).set({ id, operatorId: OP, plate: 'FLT-1', make: 'Ford', model: 'Transit', color: 'White', capacity: 4, accessible: false, status: 'available', ...over });
}

async function seedConfirmedJob(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'drive_home',
    status: 'confirmed',
    driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'pending' } },
    // H1(b): dispatchAssignHandler now requires an authorized/paid card before confirmed->assigned —
    // a real 'confirmed' job always has this (guestConfirmDriveHome's runCheckout call sets it), so
    // the default fixture carries it too; individual tests override via `over` where they need to
    // exercise the payment_not_authorized rejection specifically.
    payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_test' },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  return job;
}

it('drive_home: assigns an eligible, distinct primary+chase pair — sets attendants, chase status, SMS with {{eta}}, and pushes both drivers', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });

  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' });

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('assigned');
  expect(t.attendants).toMatchObject({ primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' });
  expect(t.driveHome?.chase).toEqual({ status: 'pending' });
  expect(t.times?.assignedAt).toBe(NOW);

  const sms = await deps.db.collection('outboundMessages').get();
  const assignedSms = sms.docs.find((d) => (d.data() as SmsView).template === 'driveHomeAssigned');
  expect(assignedSms).toBeDefined();
  // quote.durationSec = 900 -> 15 min
  expect((assignedSms!.data() as SmsView).vars?.eta).toBe('15 min');

  const pushes = await deps.db.collection('pushEvents').get();
  const primaryPush = pushes.docs.find((d) => (d.data() as PushView).toUid === 'primary1' && (d.data() as PushView).kind === 'dispatch.assigned');
  const chasePush = pushes.docs.find((d) => (d.data() as PushView).toUid === 'chase1' && (d.data() as PushView).kind === 'dispatch.assigned');
  expect(primaryPush).toBeDefined();
  expect(chasePush).toBeDefined();
  expect((primaryPush!.data() as PushView).data?.role).toBe('primary');
  expect((chasePush!.data() as PushView).data?.role).toBe('chase');

  // driver info now derives automatically into the job's own projection.
  const proj = (await deps.db.doc(P.guestTicket(t.guestToken!)).get()).data() as { driver?: { firstName?: string } };
  expect(proj.driver?.firstName).toBe('Driver');
});

it('drive_home: assigns an optional chase fleet vehicle and marks it in_use with the CHASE driver as currentDriverUid', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await seedFleetVehicle(deps, 'fv1');

  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1', fleetVehicleId: 'fv1' });

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.attendants?.chaseVehicleId).toBe('fv1');
  const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
  expect(fv).toMatchObject({ status: 'in_use', currentDriverUid: 'chase1' });
});

// Fix round 1 (Major #1): DRIVE_HOME_RULES' requires clause never consults ctx.hasFleetVehicle
// (unlike RIDE_RULES), so without an explicit guard an already-in_use chase vehicle would sail
// straight through canTransition and get double-booked.
it('drive_home: rejects an already-in_use chase vehicle with failed_precondition, and does not touch the ticket or the vehicle', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await seedFleetVehicle(deps, 'fv1', { status: 'in_use', currentDriverUid: 'someone-else' });

  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1', fleetVehicleId: 'fv1' })).rejects.toMatchObject({ code: 'failed_precondition' });

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('confirmed'); // unassigned — the rejection happened before any write
  const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
  expect(fv).toMatchObject({ status: 'in_use', currentDriverUid: 'someone-else' }); // untouched
});

it('passenger_ride: requires an available, accessible-if-needed fleet vehicle and an eligible primary driver', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'confirmed',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: true, billTo: 'guest', quote: { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] } },
    payment: { status: 'authorized', base: 1000, tip: 0, tax: 0, fees: 0, total: 1500, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_test' },
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  await seedDriver(deps, 'primary1', { driveHome: false, passengerRide: true });
  await seedFleetVehicle(deps, 'fv1', { accessible: false });

  // The only fleet vehicle is non-accessible but the ride requires accessible -> rejected.
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', fleetVehicleId: 'fv1' })).rejects.toMatchObject({ code: 'driver_not_eligible' });

  await deps.db.doc(P.fleetVehicle(OP, 'fv1')).update({ accessible: true });
  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', fleetVehicleId: 'fv1' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('assigned');
  expect(t.vehicle?.fleetVehicleId).toBe('fv1');
  const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
  expect(fv).toMatchObject({ status: 'in_use', currentDriverUid: 'primary1' });
});

it('rejects an ineligible primary or chase driver with driver_not_eligible', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'primary1', { driveHome: false, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'driver_not_eligible' });
});

it('rejects the same uid for primary and chase before any eligibility lookup', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'same1', { driveHome: true, passengerRide: false });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'same1', chaseDriverUid: 'same1' })).rejects.toMatchObject({ code: 'invalid_argument' });
});

it('rejects assigning a ticket that is not in the confirmed state', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps, { status: 'quoted' });
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'ticket_invalid_transition' });
});

// H1(b): the free-ride hole — a confirmed job whose card was never actually authorized must not be
// dispatchable. Covers both "no payment object at all" (e.g. checkout never ran) and "payment exists
// but is still pending/failed" (checkout ran but the card hasn't cleared yet).
it('rejects assigning a confirmed job whose payment is not authorized/paid, and does not touch the ticket or eligible drivers', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps, { payment: undefined });
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'ticket_invalid_transition', message: 'payment_not_authorized' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('confirmed');
});

it('rejects assigning a confirmed job whose payment is still pending', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps, { payment: { status: 'pending', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest' } });
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'ticket_invalid_transition', message: 'payment_not_authorized' });
});

it('allows assigning a confirmed job whose payment is already paid (not just authorized)', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps, { payment: { status: 'paid', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest' } });
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('assigned');
});

// H1(b) correction (controller ruling): the payment gate must be conditional on who's paying —
// a venue-billed ride has no guest card to authorize by design, so requiring one would make
// Plan 7 T1's venue-billed rides permanently undispatchable. ride.billTo === 'venue' bypasses the
// payment requirement entirely; ride.billTo === 'guest' (or drive_home, which has no billTo at
// all) still requires it.
it("passenger_ride: billTo:'venue' assigns with NO payment field at all", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'confirmed',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'venue', quote: { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] } },
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  await seedDriver(deps, 'primary1', { driveHome: false, passengerRide: true });
  await seedFleetVehicle(deps, 'fv1');

  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', fleetVehicleId: 'fv1' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('assigned');
});

// Ruling W (v0.4.2): a room-charged ride — the guest's hotel folio is the obligation — dispatches
// with no card authorization, exactly like a venue-billed one. Without the gate standing down for
// 'room', every room-charged ride would be permanently undispatchable.
it("passenger_ride: billTo:'room' assigns with NO payment field at all (Ruling W)", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'confirmed',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'room', quote: { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] } },
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  await seedDriver(deps, 'primary1', { driveHome: false, passengerRide: true });
  await seedFleetVehicle(deps, 'fv1');

  await dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', fleetVehicleId: 'fv1' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('assigned');
});

// Regression-proof: a guest-billed ride must still be blocked — this is the assertion that proves
// the gate wasn't simply widened away. Must FAIL if someone later relaxes the check to cover
// venue-billed rides by, say, dropping the isDriveHome/billTo condition entirely.
it("passenger_ride: billTo:'guest' still requires payment (regression check for the H1(b) fix)", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'confirmed',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest', quote: { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] } },
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  await seedDriver(deps, 'primary1', { driveHome: false, passengerRide: true });
  await seedFleetVehicle(deps, 'fv1');

  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', fleetVehicleId: 'fv1' })).rejects.toMatchObject({ code: 'ticket_invalid_transition', message: 'payment_not_authorized' });
});

it('rejects a caller without a manager/platform_admin role, and requires an active operator', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps);
  await seedDriver(deps, 'primary1', { driveHome: true, passengerRide: false });
  await seedDriver(deps, 'chase1', { driveHome: true, passengerRide: false });
  const attendant: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
  await expect(dispatchAssignHandler(deps, attendant, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'permission_denied' });

  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  await expect(dispatchAssignHandler(deps, LEAD, { ticketId: TID, primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' })).rejects.toMatchObject({ code: 'failed_precondition' });
});

function fakeMaps(): MapsProvider {
  const maps: MapsProvider = {
    autocomplete: () => Promise.reject(new Error('not stubbed')),
    retrieve: () => Promise.reject(new Error('not stubbed')),
    route: () => Promise.resolve({ distanceMeters: 20_000, durationSec: 1200, polyline: 'p2' }),
  };
  vi.spyOn(mapsRegistry, 'getMaps').mockReturnValue(maps);
  return maps;
}

it('dispatchQuote re-quotes a still-quoted job with a fresh quote/route/expiry', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps, { status: 'quoted', driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 1, durationSec: 1, amount: 3900, breakdown: [], expiresAt: '2020-01-01T00:00:00.000Z' }, chase: { status: 'pending' } } });
  fakeMaps();
  const out = await dispatchQuoteHandler(deps, LEAD, { ticketId: TID });
  expect(out.quote.expiresAt).toBe(new Date(Date.parse(NOW) + 15 * 60_000).toISOString());
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.driveHome?.quote?.expiresAt).toBe(out.quote.expiresAt);
  expect(t.driveHome?.route).toBe('p2');
});

it('dispatchQuote rejects a job that has already moved past quoted', async () => {
  const deps = testDeps();
  await seedConfirmedJob(deps); // status: confirmed
  fakeMaps();
  await expect(dispatchQuoteHandler(deps, LEAD, { ticketId: TID })).rejects.toMatchObject({ code: 'ticket_invalid_transition' });
});
