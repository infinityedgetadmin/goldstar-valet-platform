import { beforeEach, describe, expect, it } from 'vitest';
import { correctClockHandler } from './correctClock.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Caller } from '../../lib/callable.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function caller(over: Partial<Caller> = {}): Caller {
  return { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [], ...over };
}

async function seedShift(deps: ReturnType<typeof testDeps>) {
  await seedOperator(deps);
  await deps.db.doc(P.shift(OP, 'shift1')).set({
    id: 'shift1', operatorId: OP, venueId: V1, date: '2026-08-23', startsAt: '2026-08-23T21:00:00.000Z', endsAt: '2026-08-24T05:00:00.000Z',
    status: 'open', assignments: [], notes: '', assignedUids: ['att1'], source: { provider: 'internal' },
  });
}

// m4 (final whole-branch review) fixtures: shift1's window is 2026-08-23T21:00 -> 2026-08-24T05:00.
const SHIFT_START = '2026-08-23T21:00:00.000Z';
const SHIFT_END = '2026-08-24T05:00:00.000Z';

describe('shiftsCorrectClock', () => {
  it('a lead writes a correction clockEvent for the target uid and it is audited under the correcting actor', async () => {
    const deps = testDeps();
    await seedShift(deps);

    const out = await correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'forgot to clock out' });

    const eventSnap = await deps.db.doc(P.clockEvent(OP, 'shift1', out.eventId)).get();
    expect(eventSnap.data()).toMatchObject({ id: out.eventId, uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z' });

    const entries = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'shifts.correctClock').get();
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()).toMatchObject({
      operatorId: OP,
      actorUid: 'lead1', // the correcting LEAD, not the corrected attendant
      target: 'shift1',
      after: { eventId: out.eventId, uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'forgot to clock out' },
    });
  });

  it('an admin can also correct clock events', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const out = await correctClockHandler(deps, caller({ uid: 'admin1', roles: ['admin'] }), { shiftId: 'shift1', uid: 'att1', type: 'in', at: '2026-08-23T21:05:00.000Z', note: 'late device sync' });
    expect(out.eventId).toBeTruthy();
  });

  it('a platform_admin (assumed) can correct clock events on an active operator', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const out = await correctClockHandler(deps, caller({ uid: 'pa1', roles: ['platform_admin', 'admin'] }), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'correction' });
    expect(out.eventId).toBeTruthy();
  });

  // M3 (final whole-branch review): correctClock is an *act* (writes a clock event feeding tip-pool/
  // labor cost), not an *inspect* — unlike `auditQuery`'s platform_admin carve-out, the active-operator
  // gate here is now UNCONDITIONAL, matching `ticketsRevealPhone`/`claimsGenerateBundle`. A platform_admin
  // session no longer bypasses it.
  it('M3: a platform_admin (assumed) is NOT exempt from the suspended-operator gate — unlike auditQuery, this is an act-class mutation', async () => {
    const deps = testDeps();
    await seedShift(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      correctClockHandler(deps, caller({ uid: 'pa1', roles: ['platform_admin', 'admin'] }), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'correction' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('rejects a non-manager caller (attendant) with permission_denied, before touching Firestore', async () => {
    const deps = testDeps();
    await seedShift(deps);
    await expect(correctClockHandler(deps, caller({ uid: 'att2', roles: ['attendant'] }), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'nope' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deps.db.collection(`operators/${OP}/shifts/shift1/clockEvents`).get()).size).toBe(0);
  });

  it('rejects a driver caller too — lead/admin/owner only, not every staff role', async () => {
    const deps = testDeps();
    await seedShift(deps);
    await expect(correctClockHandler(deps, caller({ roles: ['driver'] }), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'nope' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('denies a lead/admin caller on a suspended operator with failed_precondition (Ruling C-2)', async () => {
    const deps = testDeps();
    await seedShift(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'x' })).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('m4: rejects a uid that is not assigned to the shift with invalid_argument, before writing anything', async () => {
    const deps = testDeps();
    await seedShift(deps);
    await expect(
      correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'not-on-shift', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'typo uid' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect((await deps.db.collection(`operators/${OP}/shifts/shift1/clockEvents`).get()).size).toBe(0);
  });

  it('m4: rejects an `at` more than 24h before the shift starts with invalid_argument', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const tooEarly = new Date(Date.parse(SHIFT_START) - 24 * 3_600_000 - 60_000).toISOString(); // 24h1m before start
    await expect(correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'in', at: tooEarly, note: 'wrong year' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('m4: rejects an `at` more than 24h after the shift ends with invalid_argument', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const tooLate = new Date(Date.parse(SHIFT_END) + 24 * 3_600_000 + 60_000).toISOString(); // 24h1m after end
    await expect(correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: tooLate, note: 'wrong day' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('m4: accepts an `at` exactly at the 24h boundary either side (inclusive)', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const exactlyEarly = new Date(Date.parse(SHIFT_START) - 24 * 3_600_000).toISOString();
    const exactlyLate = new Date(Date.parse(SHIFT_END) + 24 * 3_600_000).toISOString();
    const a = await correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'in', at: exactlyEarly, note: 'boundary early' });
    const b = await correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: exactlyLate, note: 'boundary late' });
    expect(a.eventId).toBeTruthy();
    expect(b.eventId).toBeTruthy();
  });

  it('404s on a shift that does not exist under the caller operator', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(correctClockHandler(deps, caller(), { shiftId: 'nope', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('mints a fresh eventId on each call — two corrections for the same uid/type do not collide', async () => {
    const deps = testDeps();
    await seedShift(deps);
    const a = await correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', note: 'first' });
    const b = await correctClockHandler(deps, caller(), { shiftId: 'shift1', uid: 'att1', type: 'out', at: '2026-08-24T01:30:00.000Z', note: 'second' });
    expect(a.eventId).not.toBe(b.eventId);
    expect((await deps.db.collection(`operators/${OP}/shifts/shift1/clockEvents`).get()).size).toBe(2);
  });
});
