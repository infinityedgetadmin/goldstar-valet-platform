import { beforeEach, expect, it } from 'vitest';
import { pushClockEventHandler } from './pushClock.js';
import { registerScheduleProvider } from './registry.js';
import { PermanentPushError, type ProviderContext, type ScheduleProvider } from './port.js';
import { OP, V1, NOW, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Deps } from '../../lib/deps.js';

const SHIFT_ID = 'when_i_work_4001';
const EVENT_ID = 'ev1';
// `occurredAt` is the CloudEvent's own `.time` (when the triggering write happened) — stable
// across a retry redelivery of the same event, unlike the payload's own fields. 1 minute before
// `NOW` (helpers.ts's fixed `deps.now()`), safely under BOTH thresholds, is the default for every
// test that isn't specifically exercising the age-based report/give-up split (M1).
const OCCURRED_AT_RECENT = '2026-08-23T20:59:00.000Z';
// 30 minutes before NOW — past the 2-minute report threshold, still under the 1-hour give-up one.
const OCCURRED_AT_REPORTING = '2026-08-23T20:30:00.000Z';
// 3 hours before NOW — past the 1-hour give-up threshold.
const OCCURRED_AT_STALE = '2026-08-23T18:00:00.000Z';

async function seedWiwOperator(deps: Deps, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ 'modules.scheduling': { provider: 'when_i_work', config: {} } });
  await deps.db.doc(P.integration(OP, 'when_i_work')).set({
    config: { locationId: '111', workplaceUserId: '999', venueMap: { '501': V1 }, roleMap: { '8': 'attendant' }, pushClock: true, ...over },
    secretRef: 'GOLDSTAR',
  });
}

async function seedWiwShift(deps: Deps, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.shift(OP, SHIFT_ID)).set({
    id: SHIFT_ID,
    operatorId: OP,
    venueId: V1,
    date: '2026-09-02',
    startsAt: '2026-09-02T13:00:00.000Z',
    endsAt: '2026-09-02T21:00:00.000Z',
    status: 'open',
    assignments: [],
    notes: '',
    assignedUids: ['u1'],
    source: { provider: 'when_i_work', externalId: '4001', syncedAt: NOW, hash: 'h1' },
    ...over,
  });
}

async function seedUser(deps: Deps, uid: string, externalIds: Record<string, string> = {}) {
  await deps.db.doc(P.user(OP, uid)).set({ id: uid, name: 'Att One', email: 'att1@goldstar.example.com', roles: ['attendant'], externalIds });
}

function clockEventData(over: Record<string, unknown> = {}) {
  return { id: EVENT_ID, uid: 'u1', type: 'in', at: '2026-09-02T13:05:00.000Z', deviceId: 'device-1', ...over };
}

async function seedClockEvent(deps: Deps, data: Record<string, unknown>) {
  await deps.db.doc(P.clockEvent(OP, SHIFT_ID, EVENT_ID)).set(data);
}

function callHandler(deps: Deps, event: Record<string, unknown>, occurredAt: string = OCCURRED_AT_RECENT) {
  return pushClockEventHandler(deps, { operatorId: OP, shiftId: SHIFT_ID, eventId: EVENT_ID, event: event as never, occurredAt });
}

class FakeProvider implements ScheduleProvider {
  kind = 'when_i_work';
  calls: { ctx: ProviderContext; e: { shiftExternalId: string; uid: string; externalUserId?: string; type: string; at: string } }[] = [];
  behavior: 'succeed' | 'permanent' | 'transient' = 'succeed';

  sync(): Promise<never> {
    return Promise.reject(new Error('not used in this test'));
  }
  healthCheck(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  pushClockEvent(ctx: ProviderContext, e: { shiftExternalId: string; uid: string; externalUserId?: string; type: string; at: string }): Promise<void> {
    this.calls.push({ ctx, e });
    if (this.behavior === 'permanent') return Promise.reject(new PermanentPushError('permanent test failure'));
    if (this.behavior === 'transient') return Promise.reject(new Error('transient test failure'));
    return Promise.resolve();
  }
}

let fakeProvider: FakeProvider;

beforeEach(async () => {
  await wipe(testDeps());
  fakeProvider = new FakeProvider();
  registerScheduleProvider('when_i_work', () => fakeProvider);
});

async function getClockEvent(deps: Deps) {
  return (await deps.db.doc(P.clockEvent(OP, SHIFT_ID, EVENT_ID)).get()).data() as
    | { pushedToProviderAt?: string; pushClaim?: { status: 'pending' | 'pushed' | 'failed'; at: string } }
    | undefined;
}

async function getIntegration(deps: Deps) {
  return (await deps.db.doc(P.integration(OP, 'when_i_work')).get()).data() as { lastError?: string; health?: { ok: boolean } } | undefined;
}

it('does not push a dashboard-correction event', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData({ deviceId: 'dashboard-correction' });
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(0);
});

it('a malformed operator doc is logged and skipped, not thrown — an uncaught TypeError in a retry:true trigger would silently loop forever, compounding M1 (L1)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  // Deliberately malformed — overwrites the seeded operator with a doc missing `modules` entirely,
  // so `op.modules.scheduling.provider` would throw a TypeError on the unguarded cast.
  await deps.db.doc(P.operator(OP)).set({ id: OP });
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await expect(callHandler(deps, ev)).resolves.toBeUndefined();

  expect(fakeProvider.calls).toHaveLength(0);
});

it('does not push when the DOC is already stamped, even though the event payload (frozen at creation) never carries the stamp — real retry-redelivery shape (H1)', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  // onDocumentCreated's payload is the CREATION-time snapshot — it can NEVER carry
  // pushedToProviderAt, since that field is written later, by this same handler, after a
  // successful push. A retry (redelivered after a crash between the successful push and the
  // stamp write, or between the stamp write and the audit call) redelivers this identical
  // unstamped payload every time. The idempotency check has to be against the LIVE doc, not the
  // payload — seeding the stamp into the payload itself (as the old version of this test did)
  // tests a state no real delivery ever produces.
  const ev = clockEventData();
  await seedClockEvent(deps, { ...ev, pushedToProviderAt: '2026-09-02T13:06:00.000Z' });

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(0);
});

it('does not push when the operator scheduling provider is not when_i_work', async () => {
  const deps = testDeps();
  await seedOperator(deps); // default modules.scheduling.provider === 'internal'
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(0);
});

it('does not push when pushClock is not enabled in the integration config', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps, { pushClock: false });
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(0);
});

it('does not push when the shift itself was not synced from when_i_work', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps, { source: { provider: 'internal' } });
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(0);
});

it('pushes with the resolved shiftExternalId and externalUserId, then stamps pushedToProviderAt on success', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(1);
  expect(fakeProvider.calls[0]!.e).toEqual({ shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2026-09-02T13:05:00.000Z' });
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBe(NOW);
  expect(stored!.pushClaim).toEqual({ status: 'pushed', at: NOW }); // N1: the claim is finalized alongside the success stamp
});

it('calls the provider with no externalUserId when the user has no when_i_work mapping', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', {});
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(1);
  expect(fakeProvider.calls[0]!.e.externalUserId).toBeUndefined();
});

it('a PermanentPushError is caught, reported onto the integration doc, and NOT rethrown; pushedToProviderAt stays unset', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  fakeProvider.behavior = 'permanent';
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await expect(callHandler(deps, ev)).resolves.toBeUndefined();

  const integ = await getIntegration(deps);
  expect(integ!.health).toEqual({ ok: false });
  expect(integ!.lastError).toContain('permanent test failure');
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBeUndefined();
  // N1: the claim is released to 'failed' on every failure exit — a genuine subsequent retry
  // (a corrected credential, a new delivery) must not be blocked behind a stale 'pending' claim.
  expect(stored!.pushClaim).toEqual({ status: 'failed', at: NOW });
});

it('a transient failure under the report threshold propagates and does NOT report onto the integration doc yet', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  fakeProvider.behavior = 'transient';
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await expect(callHandler(deps, ev, OCCURRED_AT_RECENT)).rejects.toThrow('transient test failure');

  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBeUndefined();
  // seedWiwOperator already seeds the integration doc (config/secretRef) — assert the FAILURE
  // fields specifically weren't added, not that the whole doc is absent.
  const integ = await getIntegration(deps);
  expect(integ?.lastError).toBeUndefined();
  expect(integ?.health).toBeUndefined();
});

it('a transient failure past the report threshold but under the give-up threshold IS reported onto the integration doc, but still propagates (keeps retrying) — M1 split', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  fakeProvider.behavior = 'transient';
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await expect(callHandler(deps, ev, OCCURRED_AT_REPORTING)).rejects.toThrow('transient test failure');

  const integ = await getIntegration(deps);
  expect(integ!.health).toEqual({ ok: false });
  expect(integ!.lastError).toContain('transient test failure');
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBeUndefined();
});

it('a transient failure that has outlived the give-up window is reported onto the integration doc and NOT rethrown (M1)', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  fakeProvider.behavior = 'transient';
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  await expect(callHandler(deps, ev, OCCURRED_AT_STALE)).resolves.toBeUndefined();

  const integ = await getIntegration(deps);
  expect(integ!.health).toEqual({ ok: false });
  expect(integ!.lastError).toContain('transient test failure');
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBeUndefined();
});

it('two concurrent deliveries of the same event only push once — the transactional claim, not just the fresh idempotency read, prevents the double-punch (N1)', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev);

  // Real overlapping deliveries against the real emulator — not reasoning about transactional
  // atomicity in the abstract. Both invocations pass the EARLIER, non-transactional
  // pushedToProviderAt read (neither has written it yet); only the claim transaction right
  // before the actual push can and must serialize them.
  await Promise.all([callHandler(deps, ev), callHandler(deps, ev)]);

  expect(fakeProvider.calls).toHaveLength(1);
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBe(NOW);
});

it('a stale (past-TTL) pending claim admits the retry AND reports — the earlier attempt\'s outcome is genuinely unknowable, so it must be visible (Ruling BE)', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  // 91s before NOW — 1s past the 90s TTL derived from wheniwork.adapter.ts's own TIMEOUT_MS chain
  // (see pushClock.ts's own doc comment). A claim this old is a crash, not an in-flight push —
  // but WHETHER the crashed attempt's own external call reached WIW before it died is unknowable
  // (no idempotency key on their side to check). Silently re-pushing turns an unknowable state
  // into an invisible duplicate; Ruling BE requires pushing (the common case is it genuinely
  // didn't land) AND reporting, so a human can go verify and delete a duplicate if one exists.
  await seedClockEvent(deps, { ...ev, pushClaim: { status: 'pending', at: '2026-08-23T20:58:29.000Z' } });

  await callHandler(deps, ev);

  expect(fakeProvider.calls).toHaveLength(1);
  const stored = await getClockEvent(deps);
  expect(stored!.pushedToProviderAt).toBe(NOW);
  const integ = await getIntegration(deps);
  expect(integ!.health).toEqual({ ok: false });
  expect(integ!.lastError).toMatch(/verify/i);
  expect(integ!.lastError).toContain(EVENT_ID);
});

it('a genuinely fresh push attempt (no prior claim at all) reports nothing — only a stale-pending retry is unknowable', async () => {
  const deps = testDeps();
  await seedWiwOperator(deps);
  await seedWiwShift(deps);
  await seedUser(deps, 'u1', { when_i_work: '55' });
  const ev = clockEventData();
  await seedClockEvent(deps, ev); // no pushClaim at all — the ordinary first-ever attempt

  await callHandler(deps, ev);

  const integ = await getIntegration(deps);
  expect(integ?.lastError).toBeUndefined();
  expect(integ?.health).toBeUndefined();
});
