import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@goldstar/platform';
import { computeEligibility, recomputeEligibilityHandler, recomputeEligibilitySweep } from './eligibility.js';
import { NOW, OP, V1, testDeps, seedOperator, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const now = '2026-08-23T00:00:00.000Z';

// Given verbatim (task-6-brief.md Step 1).
it('driver with valid license, insurance, approved background is eligible; each failure listed', () => {
  const ok = computeEligibility(
    { roles: ['attendant', 'driver'], credentials: { licenseExpiresAt: '2027-01-01T00:00:00.000Z', insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved', at: now }, endorsements: [] } },
    now,
  );
  expect(ok).toEqual({ driveHome: true, passengerRide: true, reasons: [] });
  const bad = computeEligibility({ roles: ['attendant'], credentials: { licenseExpiresAt: '2026-08-01T00:00:00.000Z', backgroundCheck: { status: 'pending', at: now }, endorsements: [] } }, now);
  expect(bad).toEqual({ driveHome: false, passengerRide: false, reasons: ['missing_driver_role', 'license_expired', 'insurance_missing', 'background_not_approved'] });
});

describe('computeEligibility: ride endorsements', () => {
  it('passengerRide requires every configured endorsement once driveHome already passes; missing_ride_endorsement is its own reason', () => {
    const base = { roles: ['driver'] as Role[], credentials: { licenseExpiresAt: '2027-01-01T00:00:00.000Z', insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved' as const, at: now }, endorsements: ['wheelchair'] } };
    expect(computeEligibility(base, now, ['wheelchair'])).toEqual({ driveHome: true, passengerRide: true, reasons: [] });
    expect(computeEligibility(base, now, ['wheelchair', 'child_seat'])).toEqual({ driveHome: true, passengerRide: false, reasons: ['missing_ride_endorsement'] });
    // driveHome already failing (no background approval) must not ALSO report missing_ride_endorsement for the same underlying gap.
    const notEligible = { roles: ['driver'] as Role[], credentials: { licenseExpiresAt: '2027-01-01T00:00:00.000Z', insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'pending' as const, at: now }, endorsements: [] } };
    expect(computeEligibility(notEligible, now, ['wheelchair'])).toEqual({ driveHome: false, passengerRide: false, reasons: ['background_not_approved'] });
  });
  it('a credential expiring within 1 day counts as already expired', () => {
    const soon = new Date(Date.parse(now) + 12 * 3_600_000).toISOString(); // 12h out
    const c = { roles: ['driver'] as Role[], credentials: { licenseExpiresAt: soon, insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved' as const, at: now }, endorsements: [] } };
    expect(computeEligibility(c, now)).toEqual({ driveHome: false, passengerRide: false, reasons: ['license_expired'] });
  });
});

beforeEach(async () => {
  await wipe(testDeps());
});

function driverUser(over: Record<string, unknown> = {}) {
  return {
    uid: 'd1', operatorId: OP, displayName: 'Dana Driver', email: 'dana@x.example.com', roles: ['driver'], venueIds: [], status: 'active', fcmTokens: [], invitedAt: NOW, payoutStatus: 'none',
    credentials: { licenseExpiresAt: '2027-01-01T00:00:00.000Z', insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved', at: NOW }, endorsements: [] },
    eligibility: { driveHome: false, passengerRide: false, reasons: [] },
    ...over,
  };
}

describe('recomputeEligibilityHandler (Task 6: onUserWritten extension)', () => {
  it('recomputes and writes eligibility from the user doc\'s current roles/credentials', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser());
    await recomputeEligibilityHandler(deps, { operatorId: OP, uid: 'd1' });
    const after = (await deps.db.doc(P.user(OP, 'd1')).get()).data();
    expect(after?.eligibility).toEqual({ driveHome: true, passengerRide: true, reasons: [] });
  });

  it('applies platform/config.rideEndorsements when computing passengerRide', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc('platform/config').set({ tipPresets: [18, 20, 25], laborRateDefault: 1800, targetRequestsPerAttendantHour: 6, rideEndorsements: ['wheelchair'] });
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser());
    await recomputeEligibilityHandler(deps, { operatorId: OP, uid: 'd1' });
    const after = (await deps.db.doc(P.user(OP, 'd1')).get()).data();
    expect(after?.eligibility).toEqual({ driveHome: true, passengerRide: false, reasons: ['missing_ride_endorsement'] });
  });

  it('no-ops (no write) when the computed eligibility already matches the stored value', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser({ eligibility: { driveHome: true, passengerRide: true, reasons: [] } }));
    // A doc whose eligibility is already correct must not be re-written — assert via updateTime staying put.
    const before = (await deps.db.doc(P.user(OP, 'd1')).get()).updateTime;
    await recomputeEligibilityHandler(deps, { operatorId: OP, uid: 'd1' });
    const afterSnap = await deps.db.doc(P.user(OP, 'd1')).get();
    expect(afterSnap.updateTime!.isEqual(before!)).toBe(true);
  });

  it('a missing user doc is a no-op', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(recomputeEligibilityHandler(deps, { operatorId: OP, uid: 'ghost' })).resolves.toBeUndefined();
  });
});

describe('recomputeEligibilitySweep: daily recompute + 30/7/1-day expiry notifications', () => {
  it('recomputes every active user across operators and counts writes', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser());
    await deps.db.doc(P.user(OP, 'd2')).set(driverUser({ uid: 'd2', email: 'd2@x.example.com', status: 'suspended' })); // excluded: not active
    const res = await recomputeEligibilitySweep(deps);
    expect(res.recomputed).toBe(1);
    expect((await deps.db.doc(P.user(OP, 'd1')).get()).data()?.eligibility).toEqual({ driveHome: true, passengerRide: true, reasons: [] });
    expect((await deps.db.doc(P.user(OP, 'd2')).get()).data()?.eligibility).toEqual({ driveHome: false, passengerRide: false, reasons: [] }); // untouched — suspended, never swept
  });

  it("fires a leads-topic push PER VENUE and an email outboundMessage per active admin at the 30-day threshold; not at 29 — and never the subscriber-less admins_ topic", async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // Second venue: credential expiry is operator-scoped, so the push FANS OUT to every venue's
    // leads topic — `leads_{op}_{venueId}` is the only manager-reaching topic family any client
    // subscribes to (mobile's leadsTopic(); the old `admins_{op}` target had zero subscribers in
    // all three repos and every send vanished into the void).
    const v1Data = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Record<string, unknown>;
    await deps.db.doc(P.venue(OP, 'v2')).set({ ...v1Data, id: 'v2', name: 'Rooftop' });
    await deps.db.doc(P.user(OP, 'own1')).set({ uid: 'own1', operatorId: OP, displayName: 'Olivia Owner', email: 'owner@x.example.com', roles: ['owner'], venueIds: [], status: 'active', fcmTokens: [], invitedAt: NOW, payoutStatus: 'none', eligibility: { driveHome: false, passengerRide: false, reasons: [] } });
    const expiresAt = new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString();
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser({ credentials: { licenseExpiresAt: expiresAt, insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved', at: NOW }, endorsements: [] } }));
    await recomputeEligibilitySweep(deps);
    // Plan 8 Task 12 (#15): PER MANAGER UID, once each, operator-wide — own1 is the only active
    // manager seeded here, so exactly one push, addressed to a uid, never to a topic. (Ruling BL's
    // per-venue leads fan-out reached a lead at N venues N times and, being a topic, could be joined
    // by any app instance that read a venue doc.)
    const pushes = await deps.db.collection('pushEvents').where('kind', '==', 'credential.expiring').get();
    expect(pushes.docs.map((d) => d.id)).toEqual([`credential_d1_license_30_own1`]);
    for (const d of pushes.docs) {
      expect(d.data()).toMatchObject({ toUid: 'own1', data: { field: 'license', days: '30', displayName: 'Dana Driver' } });
      expect(Object.hasOwn(d.data(), 'toTopic')).toBe(false);
    }
    const emails = await deps.db.collection('outboundMessages').where('channel', '==', 'email').where('template', '==', 'credentialExpiring').get();
    expect(emails.size).toBe(1);
    expect(emails.docs[0]!.data()).toMatchObject({ to: 'owner@x.example.com', operatorId: OP });

    // Not a threshold day (29 days out) — no additional notification.
    await deps.db.doc(P.user(OP, 'd1')).update({ 'credentials.licenseExpiresAt': new Date(Date.parse(NOW) + 29 * 86_400_000).toISOString() });
    await recomputeEligibilitySweep(deps);
    expect((await deps.db.collection('pushEvents').where('kind', '==', 'credential.expiring').get()).size).toBe(1); // still just own1's
  });

  it('M1 (final whole-branch review): an admin with notificationPrefs.emailCredentials=false gets no email (still gets the push); absent/true still gets the email', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'own1')).set({ uid: 'own1', operatorId: OP, displayName: 'Olivia Owner', email: 'owner@x.example.com', roles: ['owner'], venueIds: [], status: 'active', fcmTokens: [], invitedAt: NOW, payoutStatus: 'none', eligibility: { driveHome: false, passengerRide: false, reasons: [] }, notificationPrefs: { emailClaims: true, emailCredentials: false, pushRequests: true } });
    await deps.db.doc(P.user(OP, 'admin2')).set({ uid: 'admin2', operatorId: OP, displayName: 'Andy Admin', email: 'admin2@x.example.com', roles: ['admin'], venueIds: [], status: 'active', fcmTokens: [], invitedAt: NOW, payoutStatus: 'none', eligibility: { driveHome: false, passengerRide: false, reasons: [] } }); // no notificationPrefs -> defaults to on
    const expiresAt = new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString();
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser({ credentials: { licenseExpiresAt: expiresAt, insuranceExpiresAt: '2027-01-01T00:00:00.000Z', backgroundCheck: { status: 'approved', at: NOW }, endorsements: [] } }));
    await recomputeEligibilitySweep(deps);
    // The push still fires regardless of email prefs (a separate channel): Plan 8 Task 12 delivers it
    // per manager uid, so BOTH own1 and admin2 get one — email prefs never touch push.
    expect((await deps.db.collection('pushEvents').where('kind', '==', 'credential.expiring').get()).size).toBe(2);
    const emails = await deps.db.collection('outboundMessages').where('channel', '==', 'email').where('template', '==', 'credentialExpiring').get();
    expect(emails.size).toBe(1);
    expect(emails.docs[0]!.data().to).toBe('admin2@x.example.com'); // own1 (emailCredentials: false) excluded
  });

  it('re-running the sweep the same day dedupes via the deterministic id (no duplicate push/email)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'own1')).set({ uid: 'own1', operatorId: OP, displayName: 'Olivia Owner', email: 'owner@x.example.com', roles: ['owner'], venueIds: [], status: 'active', fcmTokens: [], invitedAt: NOW, payoutStatus: 'none', eligibility: { driveHome: false, passengerRide: false, reasons: [] } });
    const expiresAt = new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString();
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser({ credentials: { licenseExpiresAt: '2027-01-01T00:00:00.000Z', insuranceExpiresAt: expiresAt, backgroundCheck: { status: 'approved', at: NOW }, endorsements: [] } }));
    await recomputeEligibilitySweep(deps);
    await recomputeEligibilitySweep(deps);
    expect((await deps.db.collection('pushEvents').where('kind', '==', 'credential.expiring').get()).size).toBe(1);
    expect((await deps.db.collection('outboundMessages').where('channel', '==', 'email').get()).size).toBe(1);
  });

  // Fix round 1 (task-6-review.md Major 1): a concurrent credential edit racing the sweep — modeled
  // as REAL concurrency via Promise.all against the emulator (same testing convention as
  // generateKeyTags.test.ts's M1 transactional-numbering regression test), not a synthetic hook —
  // must never be clobbered by a stale sweep write. Both writers here (the sweep's per-doc
  // transaction, and the direct update + recomputeEligibilityHandler standing in for what
  // onUserWritten's trigger actually does) read fresh immediately before writing, so the FINAL
  // committed state must reflect the concurrent edit regardless of which one's commit lands last —
  // that invariant is what this asserts, since the exact interleaving isn't controllable from outside.
  it('a concurrent credential edit racing the sweep is never clobbered by a stale sweep write (Major 1)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'd1')).set(driverUser()); // starts fully eligible (driveHome: true)

    await Promise.all([
      recomputeEligibilitySweep(deps),
      (async () => {
        // Simulates the real onUserWritten flow: an admin edits credentials, then the trigger calls
        // recomputeEligibilityHandler with a FRESH read (claims.ts's extended trigger, task-6).
        await deps.db.doc(P.user(OP, 'd1')).update({ 'credentials.backgroundCheck': { status: 'rejected', at: NOW } });
        await recomputeEligibilityHandler(deps, { operatorId: OP, uid: 'd1' });
      })(),
    ]);

    const after = (await deps.db.doc(P.user(OP, 'd1')).get()).data();
    // Whichever writer's commit landed last, the STORED eligibility must reflect the concurrent
    // edit (background rejected -> ineligible) — never revert to the pre-edit eligible state, and
    // never silently drop the reason.
    expect(after?.eligibility).toEqual({ driveHome: false, passengerRide: false, reasons: ['background_not_approved'] });
  });
});
