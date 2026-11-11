import { beforeEach, describe, expect, it } from 'vitest';
import { canAccessVenue } from './venueAccess.js';
import { OP, testDeps, wipe } from '../../test/helpers.js';
import { P } from './paths.js';
import type { Caller } from './callable.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function caller(over: Partial<Caller> = {}): Caller & { operatorId: string } {
  return { uid: 'u1', operatorId: OP, roles: ['attendant'], venueIds: [], ...over };
}

describe('canAccessVenue', () => {
  it('owner/admin bypass regardless of venueIds', async () => {
    const deps = testDeps();
    expect(await canAccessVenue(deps, caller({ roles: ['owner'], venueIds: [] }), 'v1')).toBe(true);
    expect(await canAccessVenue(deps, caller({ roles: ['admin'], venueIds: ['v2'] }), 'v1')).toBe(true);
  });

  it('claims venueIds directly including the venue is allowed', async () => {
    const deps = testDeps();
    expect(await canAccessVenue(deps, caller({ roles: ['attendant'], venueIds: ['v1'] }), 'v1')).toBe(true);
  });

  it('under the 20-id truncation threshold and not included: denied without consulting the user doc', async () => {
    const deps = testDeps();
    // User doc DOES include v1 — if the helper wrongly fell back here, this would pass. It must not.
    await deps.db.doc(P.user(OP, 'u1')).set({ roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    expect(await canAccessVenue(deps, caller({ roles: ['attendant'], venueIds: ['v2'] }), 'v1')).toBe(false);
  });

  const TRUNCATED = Array.from({ length: 20 }, (_, i) => `x${i + 1}`);

  it('at/over the 20-id threshold and not included: falls back to the user doc — allow when present', async () => {
    const deps = testDeps();
    await deps.db.doc(P.user(OP, 'u1')).set({ roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    expect(await canAccessVenue(deps, caller({ roles: ['attendant'], venueIds: TRUNCATED }), 'v1')).toBe(true);
  });

  it('at/over the 20-id threshold and not included: falls back to the user doc — deny when absent', async () => {
    const deps = testDeps();
    await deps.db.doc(P.user(OP, 'u1')).set({ roles: ['attendant'], venueIds: ['v2'], status: 'active' });
    expect(await canAccessVenue(deps, caller({ roles: ['attendant'], venueIds: TRUNCATED }), 'v1')).toBe(false);
  });
});
