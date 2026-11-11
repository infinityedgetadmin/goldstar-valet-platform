import { expect, it, beforeEach, vi } from 'vitest';
import { audit } from './audit.js';
import { testDeps, wipe, OP } from '../../test/helpers.js';
import { toHttpsError, err } from './errors.js';

beforeEach(async () => {
  await wipe(testDeps());
});

it('audit writes an entry under the operator', async () => {
  const deps = testDeps();
  const id = await audit(deps, { operatorId: OP, actorUid: 'u1', action: 'test', target: 'x' });
  const snap = await deps.db.doc(`operators/${OP}/auditLog/${id}`).get();
  expect(snap.data()).toMatchObject({ actorUid: 'u1', action: 'test', at: '2026-08-23T21:00:00.000Z' });
});

it('maps platform errors', () => {
  expect(toHttpsError(err('permission_denied')).code).toBe('permission-denied');
  expect(toHttpsError(new Error('x')).code).toBe('internal');
});

it('catch-all logs only { name, code } for an unrecognized error — never message/stack/the raw object', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  toHttpsError(new Error('guestTickets/tok_super-secret-capability-token leaked in a gRPC error string'));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('unhandled callable error', { name: 'Error', code: 'internal' });
  spy.mockRestore();
});
