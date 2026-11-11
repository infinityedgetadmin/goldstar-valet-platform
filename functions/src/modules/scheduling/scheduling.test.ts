import { beforeEach, expect, it } from 'vitest';
import { upsertExternalShifts } from './upsert.js';
import { InternalScheduleProvider } from './internal.adapter.js';
import { schedulingSyncNowHandler } from './sync.js';
import { NOW, OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => { await wipe(testDeps()); });

it('internal provider sync is a no-op', async () => {
  expect(await new InternalScheduleProvider().sync({} as never, { from: '2026-08-23', to: '2026-08-24' })).toEqual({ upserted: 0, errors: [], shifts: [] });
});

it('upsert maps emails to uids, skips unchanged, preserves status and clock events', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.user(OP, 'att1')).set({ uid: 'att1', operatorId: OP, email: 'ana@x.example.com', roles: ['attendant'], venueIds: ['v1'], status: 'active' });
  const ext = [{ externalId: 'e1', venueId: 'v1', date: '2026-08-23', startsAt: NOW, endsAt: '2026-08-24T03:00:00.000Z', assignments: [{ email: 'ana@x.example.com', role: 'attendant' as const }, { email: 'ghost@x.example.com', role: 'attendant' as const }] }];
  const r1 = await upsertExternalShifts(deps, OP, 'ical', ext); expect(r1.upserted).toBe(1); expect(r1.errors).toEqual(['unmatched user ghost@x.example.com']);
  const ref = deps.db.doc(P.shift(OP, 'ical_e1'));
  expect((await ref.get()).data()).toMatchObject({ venueId: 'v1', status: 'planned', assignments: [{ uid: 'att1', role: 'attendant', confirmed: false }], source: { provider: 'ical', externalId: 'e1' } });
  await ref.update({ status: 'open' });
  await ref.collection('clockEvents').doc('01912345-7abc-7def-8123-456789abcde1').set({ uid: 'att1', type: 'in', at: NOW, deviceId: 'd' });
  expect((await upsertExternalShifts(deps, OP, 'ical', ext)).upserted).toBe(0);
  const r3 = await upsertExternalShifts(deps, OP, 'ical', [{ ...ext[0]!, endsAt: '2026-08-24T04:00:00.000Z' }]); expect(r3.upserted).toBe(1);
  expect((await ref.get()).data()).toMatchObject({ status: 'open', endsAt: '2026-08-24T04:00:00.000Z' });
  expect((await ref.collection('clockEvents').get()).size).toBe(1);
});

it('upsert denormalizes assignedUids from assignments[].uid so myShifts (array-contains) can find the shift', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.user(OP, 'att1')).set({ uid: 'att1', operatorId: OP, email: 'ana@x.example.com', roles: ['attendant'], venueIds: ['v1'], status: 'active' });
  const ext = [{ externalId: 'e2', venueId: 'v1', date: '2026-08-23', startsAt: NOW, endsAt: '2026-08-24T03:00:00.000Z', assignments: [{ email: 'ana@x.example.com', role: 'attendant' as const }] }];
  await upsertExternalShifts(deps, OP, 'ical', ext);
  const ref = deps.db.doc(P.shift(OP, 'ical_e2'));
  expect((await ref.get()).data()).toMatchObject({ assignedUids: ['att1'] });
});

it('schedulingSyncNow rejects an attendant caller', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await expect(
    schedulingSyncNowHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, {}),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

it('schedulingSyncNow resolves for an admin caller on an internal-provider operator', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await expect(
    schedulingSyncNowHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, {}),
  ).resolves.toEqual({ upserted: 0, errors: [] });
});
