import { beforeEach, expect, it, vi } from 'vitest';
import { callables } from '@goldstar/platform';
import { auditQueryHandler } from './query.js';
import { audit } from '../../lib/audit.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

it('non-admin roles are denied', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(
    auditQueryHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [] }, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', limit: 100 }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

it('admin queries entries written via audit(); output schema parses the round trip', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await audit(deps, { operatorId: OP, actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-1', before: { status: 'requested' }, after: { reason: 'guest left' } });
  const out = await auditQueryHandler(
    deps,
    { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
    { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', limit: 100 },
  );
  const parsed = callables.auditQuery.output.parse(out);
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]).toMatchObject({ operatorId: OP, actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-1' });
});

it('action filter narrows results to matching entries', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await audit(deps, { operatorId: OP, actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-1' });
  await audit(deps, { operatorId: OP, actorUid: 'lead1', action: 'guest.cancel', target: 'ticket-2' });
  const out = await auditQueryHandler(
    deps,
    { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] },
    { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', action: 'ticket.cancel', limit: 100 },
  );
  expect(out.entries).toHaveLength(1);
  expect(out.entries[0]).toMatchObject({ action: 'ticket.cancel', target: 'ticket-1' });
});

it('rejects when both action and actorUid filters are set (no composite index for that combination)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(
    auditQueryHandler(
      deps,
      { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
      { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', action: 'ticket.cancel', actorUid: 'lead1', limit: 100 },
    ),
  ).rejects.toMatchObject({ code: 'invalid_argument' });
});

// Ruling C-2: "new read" pattern for a non-platform_admin caller — auditQueryHandler doesn't
// otherwise fetch the operator doc, so requireActiveOperator does the one added read itself.
it('rejects an owner/admin with failed_precondition when the operator is suspended (Ruling C-2)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  await expect(
    auditQueryHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', limit: 100 }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
});

// Ruling C-2: deliberate carve-out, disclosed in query.ts's own comment — platform_admin is exempt
// from this specific gate (unlike the other 6 staff callables, which stay gated for every caller
// including an assumed platform_admin). The original Ruling C explicitly required "platform_admin
// still allowed on a suspended operator — they must be able to reactivate/inspect", and reading the
// audit log is read-only inspection, not a money-moving action.
it('platform_admin (including an assumeOperator session) can still query a suspended operator\'s audit log (Ruling C-2)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await audit(deps, { operatorId: OP, actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-1' });
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  const out = await auditQueryHandler(
    deps,
    { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] }, // assumeOperator's minted claims shape
    { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', limit: 100 },
  );
  expect(out.entries).toHaveLength(1);
});

it('drops a malformed audit doc instead of failing the whole query; warns with a count only, never content', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await audit(deps, { operatorId: OP, actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-1' });
  // Simulates a doc that bypassed audit() (or a legacy partial write) — missing requestId, fails auditLogEntrySchema.
  await deps.db.doc(`operators/${OP}/auditLog/bad1`).set({ id: 'bad1', actorUid: 'lead1', action: 'ticket.cancel', target: 'ticket-2', before: null, after: null, at: '2026-08-15T00:00:00.000Z' });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const out = await auditQueryHandler(
    deps,
    { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
    { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', limit: 100 },
  );
  expect(out.entries).toHaveLength(1);
  expect(out.entries[0]).toMatchObject({ target: 'ticket-1' });
  expect(warnSpy).toHaveBeenCalledWith('auditQuery: dropped malformed entries', { count: 1 });
  warnSpy.mockRestore();
});
