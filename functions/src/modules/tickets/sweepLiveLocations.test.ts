import { beforeEach, describe, expect, it } from 'vitest';
import { sweepEphemeraHandler, GUEST_TICKET_PURGE_GRACE_MS, LIVE_LOCATION_SWEEP_GRACE_MS } from './sweepLiveLocations.js';
import { NOW, OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const T = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

async function seedSecondOperator(deps: ReturnType<typeof testDeps>) {
  await deps.db.doc(P.operator('op2')).set({ id: 'op2', name: 'Second', slug: 'op2', status: 'active' });
}

beforeEach(async () => { await wipe(testDeps()); });

describe('sweepEphemeraHandler (carry #29)', () => {
  it('deletes liveLocations expired past the grace window, in EVERY operator; keeps recent and live ones', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedSecondOperator(deps);
    // expired long past grace → swept
    await deps.db.doc(P.liveLocation(OP, 'stale1')).set({ geo: { lat: 1, lng: 2 }, expiresAt: iso(T - LIVE_LOCATION_SWEEP_GRACE_MS - 60_000) });
    // second operator's stale doc — proves the sweep iterates operators, not just one
    await deps.db.doc(P.liveLocation('op2', 'stale2')).set({ geo: { lat: 1, lng: 2 }, expiresAt: iso(T - LIVE_LOCATION_SWEEP_GRACE_MS - 60_000) });
    // expired, but within grace → kept (readers already ignore it via their own expiresAt check)
    await deps.db.doc(P.liveLocation(OP, 'recent')).set({ geo: { lat: 1, lng: 2 }, expiresAt: iso(T - 60_000) });
    // still live → kept
    await deps.db.doc(P.liveLocation(OP, 'live')).set({ geo: { lat: 1, lng: 2 }, expiresAt: iso(T + 600_000) });

    const res = await sweepEphemeraHandler(deps);

    expect(res.liveLocationsDeleted).toBe(2);
    expect((await deps.db.doc(P.liveLocation(OP, 'stale1')).get()).exists).toBe(false);
    expect((await deps.db.doc(P.liveLocation('op2', 'stale2')).get()).exists).toBe(false);
    expect((await deps.db.doc(P.liveLocation(OP, 'recent')).get()).exists).toBe(true);
    expect((await deps.db.doc(P.liveLocation(OP, 'live')).get()).exists).toBe(true);
  });

  it('purges guestTickets projections whose expiresAt is more than the grace past; keeps expired-but-recent and live ones', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // expiresAt + 7d elapsed → purged
    await deps.db.doc(P.guestTicket('PurgeMeToken0000000000')).set({ status: 'closed', expiresAt: iso(T - GUEST_TICKET_PURGE_GRACE_MS - 60_000) });
    // expired 1 minute ago — inside the grace (guest links say "expired", support can still see it) → kept
    await deps.db.doc(P.guestTicket('KeepExpiredToken000000')).set({ status: 'closed', expiresAt: iso(T - 60_000) });
    // live → kept
    await deps.db.doc(P.guestTicket('KeepLiveToken000000000')).set({ status: 'checked_in', expiresAt: iso(T + 600_000) });

    const res = await sweepEphemeraHandler(deps);

    expect(res.projectionsDeleted).toBe(1);
    expect((await deps.db.doc(P.guestTicket('PurgeMeToken0000000000')).get()).exists).toBe(false);
    expect((await deps.db.doc(P.guestTicket('KeepExpiredToken000000')).get()).exists).toBe(true);
    expect((await deps.db.doc(P.guestTicket('KeepLiveToken000000000')).get()).exists).toBe(true);
  });

  it('audits a platform-level summary row when anything was deleted, and none when nothing was', async () => {
    const deps = testDeps();
    await seedOperator(deps);

    const empty = await sweepEphemeraHandler(deps);
    expect(empty).toEqual({ liveLocationsDeleted: 0, projectionsDeleted: 0 });
    expect((await deps.db.collection('platform/auditLog/entries').where('action', '==', 'tickets.sweep_ephemera').get()).size).toBe(0);

    await deps.db.doc(P.liveLocation(OP, 'stale1')).set({ geo: { lat: 1, lng: 2 }, expiresAt: iso(T - LIVE_LOCATION_SWEEP_GRACE_MS - 60_000) });
    const res = await sweepEphemeraHandler(deps);
    expect(res.liveLocationsDeleted).toBe(1);
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'tickets.sweep_ephemera').get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0]!.data()).toMatchObject({ actorUid: 'system', after: { liveLocationsDeleted: 1, projectionsDeleted: 0 } });
  });
});
