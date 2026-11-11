import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsHealthCheckHandler } from './healthCheck.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { registerScheduleProvider } from '../scheduling/registry.js';
import type { ProviderContext, ScheduleProvider } from '../scheduling/port.js';
import * as pmsRegistry from '../pms/registry.js';
import * as posRegistry from '../pos/registry.js';
import type { PmsProvider } from '../pms/port.js';
import type { PosProvider } from '../pos/port.js';

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

describe('integrationsHealthCheckHandler', () => {
  it('internal scheduling provider: the only real adapter healthCheck — returns ok:true and persists health only (m1: never lastSyncAt — this handler does not sync)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'internal' });
    expect(out).toEqual({ ok: true });
    const integ = (await deps.db.doc(P.integration(OP, 'internal')).get()).data() as { health?: { ok: boolean }; lastSyncAt?: string; lastError?: string } | undefined;
    expect(integ?.health).toEqual({ ok: true });
    expect(integ?.lastSyncAt).toBeUndefined(); // m1 (final whole-branch review): a health check must never stamp "last synced"
    expect(integ?.lastError).toBeUndefined();
  });

  it('m1: a successful check after a prior failure does not clear a stale lastError (this handler only ever ADDS lastError on failure, never removes it on success)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.integration(OP, 'internal')).set({ lastError: 'stale error from before', lastErrorAt: deps.now() }, { merge: true });
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'internal' });
    expect(out).toEqual({ ok: true });
    const integ = (await deps.db.doc(P.integration(OP, 'internal')).get()).data() as { health?: { ok: boolean }; lastSyncAt?: string; lastError?: string } | undefined;
    expect(integ?.health).toEqual({ ok: true });
    expect(integ?.lastSyncAt).toBeUndefined();
  });

  it('an unregistered-but-real scheduling provider (ical) gets an honest not-implemented result, not a thrown error', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'ical' });
    expect(out).toEqual({ ok: false, message: 'health check not implemented for this provider yet' });
    const integ = (await deps.db.doc(P.integration(OP, 'ical')).get()).data() as { health?: { ok: boolean; message?: string }; lastError?: string } | undefined;
    expect(integ?.health).toEqual({ ok: false, message: 'health check not implemented for this provider yet' });
    expect(integ?.lastError).toBe('health check not implemented for this provider yet');
  });

  it('a provider with no healthCheck-capable port at all (stripe, payments module) also gets the honest not-implemented result', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'stripe' });
    expect(out).toEqual({ ok: false, message: 'health check not implemented for this provider yet' });
  });

  it('twilio (messaging module) also gets the honest not-implemented result', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'twilio' });
    expect(out).toEqual({ ok: false, message: 'health check not implemented for this provider yet' });
  });

  it('venue-scoped provider (opera_cloud) + venueId: reads/writes the composite {provider}_{venueId} doc id — pms is now a real branch (Rulings AV/AC), see the pms describe block below for its own coverage', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud', venueId: 'v1' });
    expect(out).toEqual({ ok: true, message: 'pms not configured for this venue' });
    const integ = (await deps.db.doc(P.integration(OP, 'opera_cloud_v1')).get()).data() as { health?: { ok: boolean } } | undefined;
    expect(integ?.health).toEqual({ ok: true, message: 'pms not configured for this venue' });
  });

  it('rejects a missing venueId for a venue-scoped provider', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects venueId for an operator-scoped provider', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'twilio', venueId: 'v1' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('admin is allowed (wider than integrationsSetSecret — mirrors auditQuery role gate)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await integrationsHealthCheckHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { provider: 'internal' });
    expect(out).toEqual({ ok: true });
  });

  it('non-manager staff (attendant) is denied', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      integrationsHealthCheckHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [] }, { provider: 'internal' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('unauthenticated caller is denied', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(integrationsHealthCheckHandler(deps, null, { provider: 'internal' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('owner is blocked when the operator is suspended (Ruling C-2)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'internal' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it("merges operator.modules.scheduling.config into ctx ONLY when testing the operator's currently-active scheduling provider — never leaked into a health check for an inactive one", async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // seedOperator seeds modules.scheduling.provider = 'internal' (test/helpers.ts) with no config —
    // register a fake for 'ical' (a real, distinct scheduling manifest id) to capture what ctx.config
    // it's actually called with, without needing 'ical' to be the ACTIVE provider.
    let receivedCtx: ProviderContext | undefined;
    const fake: ScheduleProvider = {
      kind: 'ical',
      sync: () => Promise.resolve({ upserted: 0, errors: [], shifts: [] }),
      healthCheck: (ctx) => {
        receivedCtx = ctx;
        return Promise.resolve({ ok: true });
      },
    };
    registerScheduleProvider('ical', () => fake);

    // 'ical' is registered but NOT the active provider ('internal' is) — its health check must not
    // see 'internal'-provider config leak in. seedOperator's operator has no scheduling.config at all,
    // so this also covers the "no active-provider config to leak" case.
    await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'ical' });
    expect(receivedCtx?.config).toEqual({});

    // Now make 'ical' the ACTIVE provider with real config — its health check must see that config.
    await deps.db.doc(P.operator(OP)).update({ 'modules.scheduling.provider': 'ical', 'modules.scheduling.config': { feedUrl: 'https://x', venueId: 'v1', matchBy: 'email' } });
    await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'ical' });
    expect(receivedCtx?.config).toEqual({ feedUrl: 'https://x', venueId: 'v1', matchBy: 'email' });
  });

  it('an assumed platform_admin (roles: platform_admin+admin) bypasses the suspended-operator gate — inspect, not a money callable', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await integrationsHealthCheckHandler(
      deps,
      { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] },
      { provider: 'internal' },
    );
    expect(out).toEqual({ ok: true });
  });

  describe('pms (Ruling AV: never health.ok:false or lastError — no live adapter exists, only the mock)', () => {
    it('unconfigured venue (no venue.pms) reports a non-error result — Ruling AC ground truth from the venue doc', async () => {
      const deps = testDeps();
      await seedOperator(deps); // seeds V1 with no venue.pms
      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud', venueId: V1 });

      expect(out.ok).toBe(true);
      const integ = (await deps.db.doc(P.integration(OP, `opera_cloud_${V1}`)).get()).data() as { health?: { ok: boolean }; lastError?: string } | undefined;
      expect(integ?.health?.ok).toBe(true);
      expect(integ?.lastError).toBeUndefined();
    });

    it('CONFIGURED venue, no live adapter (Ruling H) — STILL a non-error result, never ok:false or lastError (the acceptance pin)', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      await deps.db.doc(P.venue(OP, V1)).update({ pms: { provider: 'opera_cloud', hotelId: 'h1', noPostBehavior: 'block', chargeCode: 'VALET' } });
      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud', venueId: V1 });

      // The prohibition, asserted directly rather than described: a configured PMS with no live
      // adapter must NOT read as "broken" — that would manufacture red for a platform limitation,
      // not an operator problem.
      expect(out.ok).toBe(true);
      const integ = (await deps.db.doc(P.integration(OP, `opera_cloud_${V1}`)).get()).data() as { health?: { ok: boolean }; lastError?: string } | undefined;
      expect(integ?.health?.ok).toBe(true);
      expect(integ?.lastError).toBeUndefined();
    });

    it('Ruling AW: goes through getPms (the registry), not a rebuilt generic secret context', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      const spy = vi.spyOn(pmsRegistry, 'getPms');

      await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud', venueId: V1 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe(OP);
      expect(spy.mock.calls[0]![2]).toMatchObject({ id: V1 });
    });

    it('even if a real provider were spied in and its own healthCheck genuinely failed, that real result passes through unmodified — the prohibition is about the platform-limitation cases, not about hiding a real adapter\'s real answer', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      await deps.db.doc(P.venue(OP, V1)).update({ pms: { provider: 'opera_cloud', hotelId: 'h1', noPostBehavior: 'block', chargeCode: 'VALET' } });
      const fake: PmsProvider = {
        lookupReservation: () => Promise.resolve({ reservations: [] }),
        postCharge: () => Promise.reject(new Error('not used')),
        reverseCharge: () => Promise.reject(new Error('not used')),
        healthCheck: () => Promise.resolve({ ok: false, message: 'bad OHIP credentials' }),
      };
      vi.spyOn(pmsRegistry, 'getPms').mockResolvedValue(fake);

      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'opera_cloud', venueId: V1 });

      expect(out).toEqual({ ok: false, message: 'bad OHIP credentials' });
      const integ = (await deps.db.doc(P.integration(OP, `opera_cloud_${V1}`)).get()).data() as { health?: { ok: boolean }; lastError?: string } | undefined;
      expect(integ?.lastError).toBe('bad OHIP credentials');
    });
  });

  describe('pos (Ruling AW: real probe through the registry — Toast, unlike PMS, can genuinely fail)', () => {
    it('unconfigured venue (no venue.pos) reports a non-error result (Ruling AC)', async () => {
      const deps = testDeps();
      await seedOperator(deps); // seeds V1 with no venue.pos
      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'toast', venueId: V1 });

      expect(out.ok).toBe(true);
      const integ = (await deps.db.doc(P.integration(OP, `toast_${V1}`)).get()).data() as { health?: { ok: boolean }; lastError?: string } | undefined;
      expect(integ?.health?.ok).toBe(true);
      expect(integ?.lastError).toBeUndefined();
    });

    it('configured venue, real provider healthy — ok:true through getPos (the registry), never a rebuilt generic secret context', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      await deps.db.doc(P.venue(OP, V1)).update({ pos: { provider: 'toast', restaurantGuid: 'r1' } });
      const fake: PosProvider = {
        findCheck: () => Promise.resolve({ checks: [] }),
        applyValidation: () => Promise.reject(new Error('not used')),
        addCharge: () => Promise.reject(new Error('not used')),
        healthCheck: () => Promise.resolve({ ok: true }),
      };
      const spy = vi.spyOn(posRegistry, 'getPos').mockResolvedValue(fake);

      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'toast', venueId: V1 });

      expect(out).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe(OP);
      expect(spy.mock.calls[0]![2]).toMatchObject({ id: V1 });
    });

    it('configured venue, real provider UNHEALTHY — ok:false AND lastError written, unlike PMS — Toast is a real live probe, not a platform limitation', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      await deps.db.doc(P.venue(OP, V1)).update({ pos: { provider: 'toast', restaurantGuid: 'r1' } });
      const fake: PosProvider = {
        findCheck: () => Promise.resolve({ checks: [] }),
        applyValidation: () => Promise.reject(new Error('not used')),
        addCharge: () => Promise.reject(new Error('not used')),
        healthCheck: () => Promise.resolve({ ok: false, message: 'toast authentication failed' }),
      };
      vi.spyOn(posRegistry, 'getPos').mockResolvedValue(fake);

      const out = await integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'toast', venueId: V1 });

      expect(out).toEqual({ ok: false, message: 'toast authentication failed' });
      const integ = (await deps.db.doc(P.integration(OP, `toast_${V1}`)).get()).data() as { health?: { ok: boolean }; lastError?: string } | undefined;
      expect(integ?.health).toEqual({ ok: false, message: 'toast authentication failed' });
      expect(integ?.lastError).toBe('toast authentication failed');
    });
  });

  it('a venue-scoped check against a venue that does not exist is a real error, not a manufactured health state', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      integrationsHealthCheckHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'toast', venueId: 'no-such-venue' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
