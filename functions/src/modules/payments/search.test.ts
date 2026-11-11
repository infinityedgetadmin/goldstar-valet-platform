import { beforeEach, describe, expect, it } from 'vitest';
import { paymentsSearchHandler } from './search.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const V2 = 'v2'; // a second venue with no seeded doc — fine, these handler tests never read the venue doc itself.

const FROM = '2026-08-23T00:00:00.000Z';
const TO = '2026-08-23T23:59:59.000Z';

function tx(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    operatorId: OP,
    venueId: V1,
    ticketId: '01912345-7abc-7def-8123-456789abcdef',
    provider: 'stripe',
    providerRef: id,
    kind: 'charge',
    status: 'succeeded',
    base: 1500,
    tip: 300,
    tax: 105,
    fees: 0,
    total: 1905,
    currency: 'USD',
    method: 'web',
    at: '2026-08-23T10:00:00.000Z',
    refunds: [],
    ...over,
  };
}

beforeEach(async () => {
  await wipe(testDeps());
});

describe('paymentsSearch: role gate', () => {
  it('denies an attendant, a driver, and a venue_user', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    for (const role of ['attendant', 'driver', 'venue_user'] as const) {
      await expect(
        paymentsSearchHandler(deps, { uid: 'u1', operatorId: OP, roles: [role], venueIds: [V1] }, { venueId: V1, from: FROM, to: TO, limit: 50 }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('rejects owner/admin/lead with failed_precondition when the operator is suspended', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    for (const roles of [['owner'], ['admin'], ['lead']] as const) {
      await expect(
        paymentsSearchHandler(deps, { uid: 'u1', operatorId: OP, roles: [...roles], venueIds: [V1] }, { venueId: V1, from: FROM, to: TO, limit: 50 }),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
    }
  });

  it('platform_admin (assumeOperator session) can still search a suspended operator (auditQuery parity)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.tx(OP, 'pi_1')).set(tx('pi_1'));
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await paymentsSearchHandler(
      deps,
      { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] },
      { venueId: V1, from: FROM, to: TO, limit: 50 },
    );
    expect(out.transactions).toHaveLength(1);
  });
});

describe('paymentsSearch: venue scoping', () => {
  it('denies a lead an explicit venueId outside their claims', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      paymentsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V2] }, { venueId: V1, from: FROM, to: TO, limit: 50 }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a lead with no venueId filter only sees transactions from their own venues; admin sees every venue', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.tx(OP, 'pi_v1')).set(tx('pi_v1', { venueId: V1 }));
    await deps.db.doc(P.tx(OP, 'pi_v2')).set(tx('pi_v2', { venueId: V2 }));

    const leadOut = await paymentsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] }, { from: FROM, to: TO, limit: 50 });
    expect(leadOut.transactions.map((t) => t.id)).toEqual(['pi_v1']);

    const adminOut = await paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, limit: 50 });
    expect(adminOut.transactions.map((t) => t.id).sort()).toEqual(['pi_v1', 'pi_v2']);
  });

  it('a lead with zero venues returns an empty result rather than erroring', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await paymentsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [] }, { from: FROM, to: TO, limit: 50 });
    expect(out.transactions).toEqual([]);
  });
});

describe('paymentsSearch: filters', () => {
  it('status filters in-memory (no composite index covers venue+status for transactions)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.tx(OP, 'pi_ok')).set(tx('pi_ok', { status: 'succeeded' }));
    await deps.db.doc(P.tx(OP, 'pi_refunded')).set(tx('pi_refunded', { status: 'refunded' }));

    const out = await paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, status: 'refunded', limit: 50 });
    expect(out.transactions.map((t) => t.id)).toEqual(['pi_refunded']);
  });

  it('excludes a transaction outside the date range', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.tx(OP, 'pi_in')).set(tx('pi_in', { at: '2026-08-23T10:00:00.000Z' }));
    await deps.db.doc(P.tx(OP, 'pi_out')).set(tx('pi_out', { at: '2026-08-24T10:00:00.000Z' }));

    const out = await paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, limit: 50 });
    expect(out.transactions.map((t) => t.id)).toEqual(['pi_in']);
  });
});

describe('paymentsSearch: pagination', () => {
  it('paginates via nextCursor without skipping or duplicating a row', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const ids = ['pi_1', 'pi_2', 'pi_3'];
    for (const [i, id] of ids.entries()) {
      await deps.db.doc(P.tx(OP, id)).set(tx(id, { at: `2026-08-23T1${i}:00:00.000Z` }));
    }

    const page1 = await paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, limit: 2 });
    expect(page1.transactions).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, limit: 2, cursor: page1.nextCursor });
    expect(page2.transactions).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    const seen = [...page1.transactions, ...page2.transactions].map((t) => t.id).sort();
    expect(seen).toEqual(['pi_1', 'pi_2', 'pi_3']);
  });

  it('an invalid cursor is rejected rather than silently ignored', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      paymentsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, limit: 50, cursor: 'not-a-real-cursor' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});
