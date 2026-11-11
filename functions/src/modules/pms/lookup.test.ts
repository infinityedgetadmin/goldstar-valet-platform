import { beforeEach, expect, it, vi } from 'vitest';
import type { Venue } from '@goldstar/platform';
import type { Caller } from '../../lib/callable.js';
import { MockPmsProvider } from './mock.adapter.js';
import { MOCK_RESERVATIONS } from '../../../test/pmsFixtures.js';
import { pmsLookupHandler } from './lookup.js';
import * as registry from './registry.js';
import { getPms } from './registry.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };
const ATTENDANT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
const ADMIN: Caller = { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function useMockPms() {
  const pms = new MockPmsProvider(MOCK_RESERVATIONS);
  vi.spyOn(registry, 'getPms').mockResolvedValue(pms);
  return pms;
}

async function seedPmsVenue(deps: ReturnType<typeof testDeps>, noPostBehavior: 'block' | 'fallback_card' = 'block') {
  await seedOperator(deps);
  await deps.db.doc(P.venue(OP, V1)).update({ pms: { provider: 'opera_cloud', hotelId: 'H1', noPostBehavior, chargeCode: 'VALET' } });
}

// ---------- authorization (§9.1 acceptance criterion — dual gate, unlike the POS callables) ----------

it('SECURITY: rejects a venue_user whose claim lacks the venue and an attendant not at the venue; admits venue_user, attendant-with-claim, and admin (bypass)', async () => {
  const deps = testDeps();
  await seedPmsVenue(deps);
  useMockPms();
  const foreignHost: Caller = { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] };
  const foreignAtt: Caller = { uid: 'att2', operatorId: OP, roles: ['attendant'], venueIds: ['v-other'] };
  await expect(pmsLookupHandler(deps, foreignHost, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(pmsLookupHandler(deps, foreignAtt, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(pmsLookupHandler(deps, null, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'unauthenticated' });
  for (const ok of [HOST, ATTENDANT, ADMIN]) {
    expect((await pmsLookupHandler(deps, ok, { venueId: V1, room: '412' })).reservations).toHaveLength(1);
  }
});

it('rejects under a suspended operator', async () => {
  const deps = testDeps();
  await seedPmsVenue(deps);
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  useMockPms();
  await expect(pmsLookupHandler(deps, HOST, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- behavior ----------

it('requires name or room — a filterless call would dump the hotel guest list (PII)', async () => {
  const deps = testDeps();
  await seedPmsVenue(deps);
  useMockPms();
  await expect(pmsLookupHandler(deps, HOST, { venueId: V1 })).rejects.toMatchObject({ code: 'invalid_argument' });
});

it('returns ONLY the contract fields — the port-level arrival/departure never leave the server under 0.4.x', async () => {
  const deps = testDeps();
  await seedPmsVenue(deps);
  useMockPms();
  const out = await pmsLookupHandler(deps, HOST, { venueId: V1, name: 'Avery' });
  expect(out.reservations).toEqual([{ reservationRef: 'res_100', guestName: 'Avery Sample', room: '412', noPost: false }]);
});

it('the REAL registry: no pms config → failed_precondition; opera_cloud configured → HONEST provider_unavailable (Ruling H), never a silent mock', async () => {
  const deps = testDeps();
  await seedOperator(deps); // seed venue has no `pms` block
  const bare = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Venue;
  await expect(getPms(deps, OP, bare)).rejects.toMatchObject({ code: 'failed_precondition' });
  await expect(pmsLookupHandler(deps, HOST, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'failed_precondition' });

  await deps.db.doc(P.venue(OP, V1)).update({ pms: { provider: 'opera_cloud', hotelId: 'H1', noPostBehavior: 'block', chargeCode: 'VALET' } });
  const configured = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Venue;
  await expect(getPms(deps, OP, configured)).rejects.toMatchObject({ code: 'provider_unavailable' });
  await expect(pmsLookupHandler(deps, HOST, { venueId: V1, room: '412' })).rejects.toMatchObject({ code: 'provider_unavailable' });
});
