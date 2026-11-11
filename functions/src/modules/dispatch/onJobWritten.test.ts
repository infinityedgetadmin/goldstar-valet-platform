import { beforeEach, describe, expect, it } from 'vitest';
import { jobWrittenHandler, shouldProcessJobWrite } from './onJobWritten.js';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import type { PaymentGateway } from '../payments/port.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  status?: string;
  times?: { inTransitAt?: string };
  payment?: { status?: string; total?: number; lastIntentId?: string };
}
interface FleetView {
  status?: string;
  currentDriverUid?: string;
}

function fakeGateway(overrides: Partial<PaymentGateway> = {}): PaymentGateway {
  return {
    createCheckout: () => Promise.reject(new Error('not stubbed')),
    capture: () => Promise.resolve(),
    updateTip: () => Promise.reject(new Error('not stubbed')),
    refund: () => Promise.reject(new Error('not stubbed')),
    cancelIntent: () => Promise.reject(new Error('not stubbed')),
    cancelAuthorization: () => Promise.reject(new Error('not stubbed')),
    createTerminalConnectionToken: () => Promise.reject(new Error('not stubbed')),
    ensureTerminalLocation: () => Promise.reject(new Error('not stubbed')),
    connectOnboardingLink: () => Promise.reject(new Error('not stubbed')),
    transfer: () => Promise.reject(new Error('not stubbed')),
    ensureCustomer: () => Promise.reject(new Error('not stubbed')),
    parseWebhook: () => Promise.reject(new Error('not stubbed')),
    getAccountStatus: () => Promise.reject(new Error('not stubbed')),
    listPaymentMethods: () => Promise.reject(new Error('not stubbed')),
    retrievePaymentMethod: () => Promise.reject(new Error('not stubbed')),
    detachPaymentMethod: () => Promise.reject(new Error('not stubbed')),
    createSetupIntent: () => Promise.reject(new Error('not stubbed')),
    ...overrides,
  };
}

/**
 * Carry #20/#25 (ruled-but-unlanded until this wave): the gate must count the report's REAL
 * `photos` subcollection, never the denormalized `photoCount` field. To make these tests fail
 * against any field-reading implementation, the seeded report carries a deliberately WRONG
 * `photoCount` — inverted against the real photo-doc count (0 when the subcollection qualifies,
 * 99 when it doesn't). A gate that reads the field gets every gate test wrong in BOTH directions;
 * a gate that counts the subcollection ignores the lie entirely.
 */
async function seedDamageReport(deps: ReturnType<typeof testDeps>, id: string, ticketId: string, phase: 'pre_drive' | 'post_drive', photos: number) {
  const lyingPhotoCount = photos >= 4 ? 0 : 99;
  await deps.db.doc(P.damage(OP, id)).set({ id, operatorId: OP, ticketId, vehicleSnapshot: {}, phase, diagramMarks: [], notes: '', createdBy: 'driver1', createdAt: NOW, photoCount: lyingPhotoCount });
  await Promise.all(
    Array.from({ length: photos }, (_, i) =>
      deps.db.doc(P.photo(OP, id, `p${i + 1}`)).set({
        id: `p${i + 1}`, storagePath: `operators/${OP}/tickets/${ticketId}/photos/p${i + 1}.jpg`, stage: 'wide', at: NOW,
        actorUid: 'driver1', deviceId: 'd1', bytes: 100, width: 10, height: 10, sha256: 'a'.repeat(64),
      }),
    ),
  );
}

async function seedJob(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'drive_home',
    status: 'in_transit',
    attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' },
    driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'following' } },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  return job;
}

/**
 * Mirrors production ordering: the client (driver's app) writes `after` to the ticket doc FIRST — the
 * Firestore write firing the trigger IS that persisted state — and only then does the trigger react
 * to it. `jobWrittenHandler` itself never writes `status` forward on its own (only backward, on a
 * gate failure) — it reacts to an already-persisted status, so a test that never persists `after`
 * before calling the handler can't observe the "gate passed, nothing reverted" case at all.
 */
async function applyJobWrite(deps: ReturnType<typeof testDeps>, before: Record<string, unknown>, after: Record<string, unknown>, gateway?: PaymentGateway) {
  await deps.db.doc(P.ticket(OP, TID)).set(after);
  await jobWrittenHandler(deps, { operatorId: OP, ticketId: TID, before, after }, gateway);
}

describe('shouldProcessJobWrite', () => {
  it('excludes valet tickets, ticket creation, and same-status writes; includes a real status change on a job', () => {
    expect(shouldProcessJobWrite({ status: 'checked_in' }, { status: 'requested', jobType: 'valet' })).toBe(false);
    expect(shouldProcessJobWrite(null, { status: 'requested', jobType: 'drive_home' })).toBe(false);
    expect(shouldProcessJobWrite({ status: 'in_transit', jobType: 'drive_home' }, { status: 'in_transit', jobType: 'drive_home' })).toBe(false);
    expect(shouldProcessJobWrite({ status: 'pre_drive_inspection', jobType: 'drive_home' }, { status: 'in_transit', jobType: 'drive_home' })).toBe(true);
    expect(shouldProcessJobWrite({ status: 'requested', jobType: 'drive_home' }, undefined)).toBe(false);
  });

  // Minor m1 (final review, upgraded to this wave): a driveHome.chase.status-only write (the
  // ticket's own `status` field unchanged) must ALSO reach the handler, so the chase-vehicle
  // release branch (keyed off chase.status reaching 'done') actually runs.
  it('also processes a driveHome.chase.status change even when the ticket status itself is unchanged', () => {
    expect(
      shouldProcessJobWrite(
        { status: 'completed', jobType: 'drive_home', driveHome: { chase: { status: 'returning_driver' } } },
        { status: 'completed', jobType: 'drive_home', driveHome: { chase: { status: 'done' } } },
      ),
    ).toBe(true);
    expect(
      shouldProcessJobWrite(
        { status: 'completed', jobType: 'drive_home', driveHome: { chase: { status: 'done' } } },
        { status: 'completed', jobType: 'drive_home', driveHome: { chase: { status: 'done' } } },
      ),
    ).toBe(false);
  });
});

describe('in_transit inspection gate', () => {
  it('reverts to pre_drive_inspection, audits, and pushes the primary driver when no qualifying pre_drive report exists', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, { status: 'pre_drive_inspection' });
    await applyJobWrite(deps, job, { ...job, status: 'in_transit' });

    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('pre_drive_inspection');
    expect(t.times?.inTransitAt).toBeUndefined();

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.revert_in_transit').get();
    expect(audits.size).toBe(1);

    const pushes = await deps.db.collection('pushEvents').where('kind', '==', 'dispatch.revert_in_transit').get();
    expect(pushes.size).toBe(1);
    expect(pushes.docs[0]!.data().toUid).toBe('primary1');
  });

  it('a 4-photo pre_drive report lets in_transit stand — no revert, no audit', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, { status: 'pre_drive_inspection' });
    await seedDamageReport(deps, 'r1', TID, 'pre_drive', 4);
    await applyJobWrite(deps, job, { ...job, status: 'in_transit' });

    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('in_transit');
    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.revert_in_transit').get();
    expect(audits.size).toBe(0);
  });

  it('a pre_drive report with fewer than 4 photos does NOT satisfy the gate', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, { status: 'pre_drive_inspection' });
    await seedDamageReport(deps, 'r1', TID, 'pre_drive', 3);
    await applyJobWrite(deps, job, { ...job, status: 'in_transit' });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('pre_drive_inspection');
  });

  // Carry #20/#25 regression, pinned by name: a report whose `photoCount` FIELD claims 4+ while its
  // photos subcollection is EMPTY must NOT open the gate. This is the fabricated-count path the
  // unguarded `increment(1)` + field-read design allowed (an inflated counter passing the pre-drive
  // safety gate with fewer real photos). The seeding helper above inverts the field for every other
  // test; this one states the dangerous direction explicitly so it cannot be "simplified" away.
  it('carry #20/#25: a lying photoCount field with an empty photos subcollection does not open the gate', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, { status: 'pre_drive_inspection' });
    await deps.db.doc(P.damage(OP, 'lie1')).set({ id: 'lie1', operatorId: OP, ticketId: TID, vehicleSnapshot: {}, phase: 'pre_drive', diagramMarks: [], notes: '', createdBy: 'driver1', createdAt: NOW, photoCount: 4 });
    await applyJobWrite(deps, job, { ...job, status: 'in_transit' });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('pre_drive_inspection');
  });

  // The other direction of the same divergence: 4 REAL photo docs whose report doc has NO
  // photoCount field at all (the field's writer is deleted in this same wave) must open the gate.
  it('carry #20/#25: four real photo docs qualify even with no photoCount field on the report', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, { status: 'pre_drive_inspection' });
    await deps.db.doc(P.damage(OP, 'real1')).set({ id: 'real1', operatorId: OP, ticketId: TID, vehicleSnapshot: {}, phase: 'pre_drive', diagramMarks: [], notes: '', createdBy: 'driver1', createdAt: NOW });
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        deps.db.doc(P.photo(OP, 'real1', `q${i + 1}`)).set({
          id: `q${i + 1}`, storagePath: `operators/${OP}/tickets/${TID}/photos/q${i + 1}.jpg`, stage: 'wide', at: NOW,
          actorUid: 'driver1', deviceId: 'd1', bytes: 100, width: 10, height: 10, sha256: 'a'.repeat(64),
        }),
      ),
    );
    await applyJobWrite(deps, job, { ...job, status: 'in_transit' });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('in_transit');
  });
});

describe('completion: post-drive inspection gate + capture', () => {
  it('captures the authorized total when a qualifying post_drive report exists, and audits', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, {
      status: 'arrived',
      payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_job1' },
    });
    await seedDamageReport(deps, 'post1', TID, 'post_drive', 5);
    const captureCalls: { providerRef: string; amount?: number }[] = [];
    const gw = fakeGateway({ capture: (i) => { captureCalls.push(i); return Promise.resolve(); } });

    await applyJobWrite(deps, job, { ...job, status: 'completed' }, gw);

    expect(captureCalls).toEqual([{ providerRef: 'pi_job1', amount: 5750 }]);
    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.capture').get();
    expect(audits.size).toBe(1);
  });

  // Fix round 1 (Critical #1): this used to only assert `captured === false`, which is also true of a
  // silent no-op — it never distinguished "correctly reverted" from "silently did nothing forever".
  // Rewritten to assert the actual revert contract: status back to 'arrived', times.completedAt
  // cleared, an audit row, and a push to the primary driver — mirroring the in_transit gate's own
  // test exactly.
  it('reverts to arrived, audits, and pushes the primary driver when no qualifying post_drive report exists — drive_home', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, {
      status: 'arrived',
      payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_job2' },
    });
    let captured = false;
    const gw = fakeGateway({ capture: () => { captured = true; return Promise.resolve(); } });
    await applyJobWrite(deps, job, { ...job, status: 'completed' }, gw);

    expect(captured).toBe(false);
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView & { times?: { completedAt?: string } };
    expect(t.status).toBe('arrived');
    expect(t.times?.completedAt).toBeUndefined();

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.revert_completed').get();
    expect(audits.size).toBe(1);

    const pushes = await deps.db.collection('pushEvents').where('kind', '==', 'dispatch.revert_completed').get();
    expect(pushes.size).toBe(1);
    expect(pushes.docs[0]!.data().toUid).toBe('primary1');
  });

  // Fix round 2 (controller ruling): the plan's T3 ride flow has no inspection step at all
  // (Assigned -> pickup -> transit -> arrived -> Complete) — the spec's inspection gates are §5.2
  // drive-home specific. This REPLACES fix round 1's "reverts for passenger_ride too" test, which
  // was itself the bug the controller reverted: a ride must complete and capture WITHOUT ever
  // needing a post_drive report, exactly as it did before fix round 1 touched this branch.
  it('passenger_ride completes and captures directly — no post-drive gate, no report required', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // Now that this ride actually reaches 'completed' (no gate blocking it), it also hits the
    // fleet-release branch — needs a real fleetVehicles doc to update.
    await deps.db.doc(P.fleetVehicle(OP, 'fv1')).set({ id: 'fv1', operatorId: OP, plate: 'X', make: 'Toyota', model: 'Sienna', color: 'Black', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'primary1' });
    const job = ticketDoc({
      id: TID,
      parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
      jobType: 'passenger_ride',
      status: 'arrived',
      attendants: { primaryDriverUid: 'primary1' },
      vehicle: { fleetVehicleId: 'fv1' },
      ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
      payment: { status: 'authorized', base: 1000, tip: 0, tax: 0, fees: 0, total: 1500, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_ride1' },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(job);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
    // Deliberately NO seedDamageReport call — the whole point of this test.
    const captureCalls: { providerRef: string; amount?: number }[] = [];
    const gw = fakeGateway({ capture: (i) => { captureCalls.push(i); return Promise.resolve(); } });
    await applyJobWrite(deps, job, { ...job, status: 'completed' }, gw);

    expect(captureCalls).toEqual([{ providerRef: 'pi_ride1', amount: 1500 }]);
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('completed');
    const revertAudits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.revert_completed').get();
    expect(revertAudits.size).toBe(0);
    const captureAudits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.capture').get();
    expect(captureAudits.size).toBe(1);
  });

  it('a redelivered trigger invocation for the same completion does not capture twice', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, {
      status: 'arrived',
      payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_job3' },
    });
    await seedDamageReport(deps, 'post2', TID, 'post_drive', 4);
    let captureCount = 0;
    const gw = fakeGateway({ capture: () => { captureCount++; return Promise.resolve(); } });
    const after = { ...job, status: 'completed' };
    await deps.db.doc(P.ticket(OP, TID)).set(after);
    await jobWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: job, after }, gw);
    await jobWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: job, after }, gw); // redelivery: same before/after, no re-write needed
    expect(captureCount).toBe(1);
  });

  // Fix round 1 instruction: verify the revert-then-retry sequence end to end — once the qualifying
  // report actually lands and the driver re-completes, capture still fires, exactly once, via the
  // SAME dedup key (`processedEvents/dispatch_capture_{ticketId}`) — a prior revert (ok===false)
  // never touched that key, so this later, genuinely-successful completion is still its first writer.
  it('after the report lands and the driver re-completes, capture fires exactly once', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, {
      status: 'arrived',
      payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_job4' },
    });
    let captureCount = 0;
    const gw = fakeGateway({ capture: () => { captureCount++; return Promise.resolve(); } });

    // First attempt: no report yet -> reverted.
    await applyJobWrite(deps, job, { ...job, status: 'completed' }, gw);
    let t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('arrived');
    expect(captureCount).toBe(0);

    // The driver adds the post-drive report, then re-completes.
    await seedDamageReport(deps, 'post3', TID, 'post_drive', 4);
    const reverted = { ...job, status: 'arrived' };
    await applyJobWrite(deps, reverted, { ...reverted, status: 'completed' }, gw);

    t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('completed');
    expect(captureCount).toBe(1);

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.capture').get();
    expect(audits.size).toBe(1);
  });

  // M2 (final review): the old marker-BEFORE-capture ordering permanently lost the capture on any
  // transient gateway error — the marker was already written, so the redelivered retry hit it and
  // returned early without ever re-attempting Stripe. The restructured handler attempts capture
  // FIRST and only writes the marker once it resolves, so a transient failure leaves no trace and
  // the genuinely-redelivered retry (same before/after, Cloud Functions' own retry:true) captures
  // for real.
  it('a transient capture failure leaves no marker; the redelivered retry re-attempts and captures exactly once', async () => {
    const deps = testDeps();
    const job = await seedJob(deps, {
      status: 'arrived',
      payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_transient1' },
    });
    await seedDamageReport(deps, 'post-transient', TID, 'post_drive', 4);
    let captureCalls = 0;
    const gw = fakeGateway({
      capture: () => {
        captureCalls++;
        if (captureCalls === 1) return Promise.reject(Object.assign(new Error('gateway timeout'), { code: 'api_connection_error' }));
        return Promise.resolve();
      },
    });
    const after = { ...job, status: 'completed' };

    // First invocation: a genuine transient failure must propagate uncaught (that's what Cloud
    // Functions' retry:true redelivers on) and must leave NO marker and NO audit row behind.
    await expect(applyJobWrite(deps, job, after, gw)).rejects.toThrow('gateway timeout');
    let markerSnap = await deps.db.doc(`processedEvents/dispatch_capture_${TID}`).get();
    expect(markerSnap.exists).toBe(false);
    let audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.capture').get();
    expect(audits.size).toBe(0);

    // Redelivery: identical before/after — this time the gateway succeeds.
    await applyJobWrite(deps, job, after, gw);
    expect(captureCalls).toBe(2);
    markerSnap = await deps.db.doc(`processedEvents/dispatch_capture_${TID}`).get();
    expect(markerSnap.exists).toBe(true);
    audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.capture').get();
    expect(audits.size).toBe(1);
  });
});

describe('fleet vehicle release', () => {
  // Minor m1 (final review, upgraded to this wave): the OLD trigger (ticket status:'completed')
  // released the drive_home chase vehicle while the chase driver was still physically driving it
  // back — dispatch would see it 'available' and could double-book it for the length of the return
  // leg. It must now stay 'in_use' through the whole return leg (chase.status: 'returning_driver'),
  // even once the ticket itself reaches 'completed'.
  it('does NOT release the chase vehicle (drive_home) at ticket completed — still on the return leg', async () => {
    const deps = testDeps();
    await deps.db.doc(P.fleetVehicle(OP, 'fv1')).set({ id: 'fv1', operatorId: OP, plate: 'X', make: 'Ford', model: 'Transit', color: 'White', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'chase1' });
    const job = await seedJob(deps, {
      status: 'arrived',
      attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1', chaseVehicleId: 'fv1' },
      driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'returning_driver' } },
      payment: { status: 'paid', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', billTo: 'guest' },
    });
    // A qualifying post_drive report is required to actually REACH 'completed' (fix round 1,
    // Critical #1) — without one this write reverts to 'arrived' before the fleet-release branch is
    // ever reached, which the completion describe block above covers separately.
    await seedDamageReport(deps, 'post-release', TID, 'post_drive', 4);
    await applyJobWrite(deps, job, { ...job, status: 'completed' });
    const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
    expect(fv.status).toBe('in_use'); // still returning — NOT released
    expect(fv.currentDriverUid).toBe('chase1');
  });

  it('releases the chase vehicle (drive_home) once driveHome.chase.status reaches done — ticket status itself unchanged', async () => {
    const deps = testDeps();
    await deps.db.doc(P.fleetVehicle(OP, 'fv1')).set({ id: 'fv1', operatorId: OP, plate: 'X', make: 'Ford', model: 'Transit', color: 'White', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'chase1' });
    const driveHome = { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'returning_driver' } };
    const job = await seedJob(deps, {
      status: 'completed',
      attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1', chaseVehicleId: 'fv1' },
      driveHome,
      payment: { status: 'paid', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', billTo: 'guest' },
    });
    await seedDamageReport(deps, 'post-chase-done', TID, 'post_drive', 4);
    const after = { ...job, driveHome: { ...driveHome, chase: { status: 'done' } } };
    await deps.db.doc(P.ticket(OP, TID)).set(after);
    await jobWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: job, after });
    const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
    expect(fv.status).toBe('available');
    expect(fv.currentDriverUid).toBeUndefined();
  });

  it('releases the ride vehicle (passenger_ride) on completed — unchanged by the chase-timing fix', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.fleetVehicle(OP, 'fv2')).set({ id: 'fv2', operatorId: OP, plate: 'Y', make: 'Toyota', model: 'Sienna', color: 'Black', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'primary1' });
    const job = ticketDoc({
      id: TID,
      parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
      jobType: 'passenger_ride',
      status: 'arrived',
      attendants: { primaryDriverUid: 'primary1' },
      vehicle: { fleetVehicleId: 'fv2' },
      ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
      payment: { status: 'paid', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', billTo: 'guest' },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(job);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
    await applyJobWrite(deps, job, { ...job, status: 'completed' });
    const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv2')).get()).data() as FleetView;
    expect(fv.status).toBe('available');
    expect(fv.currentDriverUid).toBeUndefined();
  });

  it('releases the ride vehicle (passenger_ride) on cancelled', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.fleetVehicle(OP, 'fv2')).set({ id: 'fv2', operatorId: OP, plate: 'Y', make: 'Toyota', model: 'Sienna', color: 'Black', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'primary1' });
    const job = ticketDoc({
      id: TID,
      parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
      jobType: 'passenger_ride',
      status: 'assigned',
      vehicle: { fleetVehicleId: 'fv2' },
      attendants: { primaryDriverUid: 'primary1' },
      ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(job);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
    await applyJobWrite(deps, job, { ...job, status: 'cancelled' });
    const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv2')).get()).data() as FleetView;
    expect(fv.status).toBe('available');
    expect(fv.currentDriverUid).toBeUndefined();
  });
});

it('a status transition that matches none of the three gates (e.g. assigned -> en_route_to_guest) is a pure no-op: no revert, no capture, no fleet release', async () => {
  const deps = testDeps();
  await deps.db.doc(P.fleetVehicle(OP, 'fv1')).set({ id: 'fv1', operatorId: OP, plate: 'X', make: 'Ford', model: 'Transit', color: 'White', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: 'chase1' });
  const job = await seedJob(deps, { status: 'assigned', attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1', chaseVehicleId: 'fv1' } });
  await applyJobWrite(deps, job, { ...job, status: 'en_route_to_guest' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('en_route_to_guest');
  const fv = (await deps.db.doc(P.fleetVehicle(OP, 'fv1')).get()).data() as FleetView;
  expect(fv.status).toBe('in_use'); // untouched — not completed/cancelled
});
