import { beforeEach, describe, expect, it } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import { createOperatorHandler } from './createOperator.js';
import { setOperatorStatusHandler } from './setStatus.js';
import { NOW, OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

const goodInput = {
  id: 'valetb',
  name: 'Valet Co B',
  slug: 'valetb',
  timezone: 'America/Chicago',
  currency: 'USD',
  isSandbox: false,
  plan: 'standard',
  branding: { displayName: 'Valet Co B', primaryColor: '#ab6034', accentColor: '#ffc30c' },
  security: { requireMfaForAdmins: false },
  modules: {
    payments: { provider: 'stripe' as const, chargeModel: 'destination' as const, platformFeeBps: 0, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' as const },
    messaging: { provider: 'twilio' as const },
    scheduling: { provider: 'internal' as const },
    vision: { provider: 'none' as const },
    accounting: { provider: 'csv' as const },
  },
  features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: true, payouts: true },
  ownerEmail: 'owner@valetb.example.com',
  ownerName: 'Pat Owner',
};

describe('platformCreateOperator', () => {
  it('platform admin creates the operator doc (status onboarding), platform/config defaults, and invites the owner; audited in both scopes', async () => {
    const deps = testDeps();
    const out = await createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, goodInput);
    expect(out.operatorId).toBe('valetb');
    expect(out.inviteId).toBeTruthy();

    const opDoc = (await deps.db.doc(P.operator('valetb')).get()).data();
    expect(opDoc).toMatchObject({ id: 'valetb', slug: 'valetb', name: 'Valet Co B', status: 'onboarding', createdBy: 'pa1' });

    const config = (await deps.db.doc('platform/config').get()).data();
    expect(config).toMatchObject({ tipPresets: [18, 20, 25], laborRateDefault: 1800, targetRequestsPerAttendantHour: 6, rideEndorsements: [] });

    const invitations = await deps.db.collection('invitations').where('operatorId', '==', 'valetb').get();
    expect(invitations.size).toBe(1);
    expect(invitations.docs[0]!.data()).toMatchObject({ email: 'owner@valetb.example.com', operatorId: 'valetb', roles: ['owner'], displayName: 'Pat Owner', invitedBy: 'pa1' });

    const outbound = await deps.db.collection('outboundMessages').where('operatorId', '==', 'valetb').get();
    expect(outbound.size).toBe(1);
    expect(outbound.docs[0]!.data()).toMatchObject({ channel: 'email', template: 'invitation', to: 'owner@valetb.example.com' });

    const platformAudit = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'platform.createOperator').get();
    expect(platformAudit.size).toBe(1);
    expect(platformAudit.docs[0]!.data()).toMatchObject({ actorUid: 'pa1', target: 'valetb' });
    expect(platformAudit.docs[0]!.data()).not.toHaveProperty('operatorId'); // platform-scoped entry — no operatorId field, unlike the operator-scoped one below

    const operatorAudit = await deps.db.collection('operators/valetb/auditLog').where('action', '==', 'platform.createOperator').get();
    expect(operatorAudit.size).toBe(1);
    expect(operatorAudit.docs[0]!.data()).toMatchObject({ operatorId: 'valetb', actorUid: 'pa1', target: 'valetb' });
  });

  it('does not overwrite an existing platform/config doc', async () => {
    const deps = testDeps();
    await deps.db.doc('platform/config').set({ tipPresets: [10], laborRateDefault: 999, targetRequestsPerAttendantHour: 1, rideEndorsements: ['x'] });
    await createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, goodInput);
    const config = (await deps.db.doc('platform/config').get()).data();
    expect(config).toMatchObject({ tipPresets: [10], laborRateDefault: 999 });
  });

  it('non-platform-admin callers are denied', async () => {
    const deps = testDeps();
    await expect(
      createOperatorHandler(deps, { uid: 'own1', operatorId: OP, roles: ['owner'], venueIds: [] }, goodInput),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(createOperatorHandler(deps, null, goodInput)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a duplicate slug (operator id already exists)', async () => {
    const deps = testDeps();
    await createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, goodInput);
    await expect(
      createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, goodInput),
    ).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('rejects an id/slug mismatch', async () => {
    const deps = testDeps();
    await expect(
      createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { ...goodInput, id: 'other-id' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('platformSetOperatorStatus', () => {
  it('platform admin transitions onboarding -> active; audited in both scopes', async () => {
    const deps = testDeps();
    await createOperatorHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, goodInput);
    const out = await setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: 'valetb', status: 'active' });
    expect(out.ok).toBe(true);
    expect((await deps.db.doc(P.operator('valetb')).get()).data()).toMatchObject({ status: 'active' });

    const platformAudit = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'platform.setOperatorStatus').get();
    expect(platformAudit.size).toBe(1);
    const operatorAudit = await deps.db.collection('operators/valetb/auditLog').where('action', '==', 'platform.setOperatorStatus').get();
    expect(operatorAudit.size).toBe(1);
    expect(operatorAudit.docs[0]!.data()).toMatchObject({ before: { status: 'onboarding' }, after: { status: 'active' } });
  });

  it('active <-> suspended round trip works, and fans the operatorSuspended claims bit out to every user both ways (Plan 8 Task 10, #8)', async () => {
    const deps = testDeps();
    await seedOperator(deps); // OP starts 'active'
    for (const uid of ['fan1', 'fan2']) {
      await deps.auth.createUser({ uid, email: `${uid}@x.example.com`, password: 'password123' });
      await deps.db.doc(P.user(OP, uid)).set({ uid, operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active', eligibility: { driveHome: false, passengerRide: false, reasons: [] }, createdAt: NOW, updatedAt: NOW });
    }
    await setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP, status: 'suspended' });
    expect((await deps.db.doc(P.operator(OP)).get()).data()).toMatchObject({ status: 'suspended' });
    for (const uid of ['fan1', 'fan2']) expect((await deps.auth.getUser(uid)).customClaims).toMatchObject({ operatorId: OP, roles: ['attendant'], operatorSuspended: true, claimsVersion: 1 });
    await setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP, status: 'active' });
    expect((await deps.db.doc(P.operator(OP)).get()).data()).toMatchObject({ status: 'active' });
    for (const uid of ['fan1', 'fan2']) {
      const claims = (await deps.auth.getUser(uid)).customClaims ?? {};
      expect(claims).toMatchObject({ claimsVersion: 2 }); // bumped again, so a live client refreshes
      expect(Object.hasOwn(claims, 'operatorSuspended')).toBe(false);
    }
  });

  it('non-platform-admin callers are denied', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      setOperatorStatusHandler(deps, { uid: 'own1', operatorId: OP, roles: ['owner'], venueIds: [] }, { operatorId: OP, status: 'suspended' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects an unknown operator', async () => {
    const deps = testDeps();
    await expect(
      setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: 'nope', status: 'active' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects invalid transitions: same-status no-op, and suspended back to onboarding', async () => {
    const deps = testDeps();
    await seedOperator(deps); // OP is 'active'
    await expect(
      setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP, status: 'active' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    await setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP, status: 'suspended' });
    await expect(
      setOperatorStatusHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP, status: 'onboarding' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('F8a: two concurrent transition requests never both commit + double-audit (TOCTOU) — one wins, the loser re-reads inside the transaction and fails', async () => {
    const deps = testDeps();
    await seedOperator(deps); // OP starts 'active'
    const caller: Caller = { uid: 'pa1', roles: ['platform_admin'], venueIds: [] };
    const results = await Promise.allSettled([
      setOperatorStatusHandler(deps, caller, { operatorId: OP, status: 'suspended' }),
      setOperatorStatusHandler(deps, caller, { operatorId: OP, status: 'suspended' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'failed_precondition' });
    expect((await deps.db.doc(P.operator(OP)).get()).data()).toMatchObject({ status: 'suspended' });

    // exactly one audit entry per scope — not two (the TOCTOU double-audit this fix closes).
    const platformAudit = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'platform.setOperatorStatus').get();
    expect(platformAudit.size).toBe(1);
    const operatorAudit = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'platform.setOperatorStatus').get();
    expect(operatorAudit.size).toBe(1);
  });
});
