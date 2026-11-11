import { beforeEach, describe, expect, it } from 'vitest';
import { ticketsSearchHandler } from './search.js';
import type { Caller } from '../../lib/callable.js';
import { OP, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const V2 = 'v2'; // a second venue with no seeded doc — fine, these handler tests never read the venue doc itself.

const FROM = '2026-08-23T00:00:00.000Z';
const TO = '2026-08-23T23:59:59.000Z';

function mkId(suffix: string): string {
  // Keeps the version(7)/variant(8) nibbles isUuid() requires; only the trailing 4 hex chars vary.
  return `01912345-7abc-7def-8123-456789ab${suffix}`;
}

function ticket(id: string, over: Record<string, unknown> = {}) {
  return ticketDoc({ id, ...over });
}

beforeEach(async () => {
  await wipe(testDeps());
});

describe('ticketsSearch: role gate', () => {
  it('denies an attendant and a driver', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    for (const role of ['attendant', 'driver'] as const) {
      await expect(
        ticketsSearchHandler(deps, { uid: 'u1', operatorId: OP, roles: [role], venueIds: [V1] }, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('denies a venue_user', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      ticketsSearchHandler(deps, { uid: 'u1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] }, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects owner/admin/lead with failed_precondition when the operator is suspended', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    for (const roles of [['owner'], ['admin'], ['lead']] as const) {
      await expect(
        ticketsSearchHandler(deps, { uid: 'u1', operatorId: OP, roles: [...roles], venueIds: [V1] }, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 }),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
    }
  });

  it('platform_admin (assumeOperator session) can still search a suspended operator (Ruling C-2 parity with auditQuery)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, mkId('0001'))).set(ticket(mkId('0001'), { venueId: V1, times: { checkedInAt: '2026-08-23T10:00:00.000Z' } }));
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await ticketsSearchHandler(
      deps,
      { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] },
      { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 },
    );
    expect(out.tickets).toHaveLength(1);
  });
});

describe('ticketsSearch: venue scoping', () => {
  it('denies a lead an explicit venueId outside their claims', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      ticketsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V2] }, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a lead with no venueId filter only sees tickets from their own venues; admin sees every venue', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, mkId('0001'))).set(ticket(mkId('0001'), { venueId: V1, times: { checkedInAt: '2026-08-23T09:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, mkId('0002'))).set(ticket(mkId('0002'), { venueId: V2, times: { checkedInAt: '2026-08-23T10:00:00.000Z' } }));

    const leadOut = await ticketsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] }, { from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(leadOut.tickets.map((t) => t.id)).toEqual([mkId('0001')]);

    const adminOut = await ticketsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(adminOut.tickets.map((t) => t.id).sort()).toEqual([mkId('0001'), mkId('0002')].sort());
  });

  it('a lead with zero assigned venues gets an empty result, not an error', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await ticketsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [] }, { from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(out.tickets).toEqual([]);
    expect(out.nextCursor).toBeUndefined();
  });
});

describe('ticketsSearch: filters', () => {
  it('venueId + status narrows results (venueParked-index path)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, mkId('0001'))).set(ticket(mkId('0001'), { venueId: V1, status: 'checked_in', times: { checkedInAt: '2026-08-23T09:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, mkId('0002'))).set(ticket(mkId('0002'), { venueId: V1, status: 'requested', times: { checkedInAt: '2026-08-23T09:30:00.000Z', requestedAt: '2026-08-23T09:30:00.000Z' } }));
    const out = await ticketsSearchHandler(
      deps,
      { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
      { venueId: V1, status: 'requested', from: FROM, to: TO, includeArchived: false, limit: 50 },
    );
    expect(out.tickets.map((t) => t.id)).toEqual([mkId('0002')]);
  });

  it('plate filter is an exact match across venues (platesByOperator-index path), post-filtered by the caller\'s venue scope', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, mkId('0001'))).set(ticket(mkId('0001'), { venueId: V1, vehicle: { plate: 'GSV999', state: 'IN' }, times: { checkedInAt: '2026-08-23T09:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, mkId('0002'))).set(ticket(mkId('0002'), { venueId: V2, vehicle: { plate: 'GSV999', state: 'IN' }, times: { checkedInAt: '2026-08-23T10:00:00.000Z' } }));
    // Deliberately NOT matched: a different plate, proving the equality filter (not just the date
    // range) is doing real work, and a same-plate-different-case ticket, proving the match is
    // case-sensitive/exact — no client-side normalization happens in this handler (search.ts's own
    // comment on `matches()`; the dashboard is expected to normalize casing before calling).
    await deps.db.doc(P.ticket(OP, mkId('0003'))).set(ticket(mkId('0003'), { venueId: V1, vehicle: { plate: 'ZZZ111', state: 'IN' }, times: { checkedInAt: '2026-08-23T11:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, mkId('0004'))).set(ticket(mkId('0004'), { venueId: V1, vehicle: { plate: 'gsv999', state: 'IN' }, times: { checkedInAt: '2026-08-23T12:00:00.000Z' } }));

    const adminOut = await ticketsSearchHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { plate: 'GSV999', from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(adminOut.tickets.map((t) => t.id).sort()).toEqual([mkId('0001'), mkId('0002')].sort());

    // A lead scoped to V1 only sees the V1 ticket, even though the plate-indexed base query itself
    // has no venue clause — proves the in-memory post-filter, not the Firestore query, is doing the
    // venue exclusion here.
    const leadOut = await ticketsSearchHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] }, { plate: 'GSV999', from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(leadOut.tickets.map((t) => t.id)).toEqual([mkId('0001')]);
  });

  it('phoneLast4 filters in-memory (no registered index for it)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, mkId('0001'))).set(ticket(mkId('0001'), { venueId: V1, guest: { phoneE164: '+13175551111', phoneLast4: '1111', consentSms: true }, times: { checkedInAt: '2026-08-23T09:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, mkId('0002'))).set(ticket(mkId('0002'), { venueId: V1, guest: { phoneE164: '+13175552222', phoneLast4: '2222', consentSms: true }, times: { checkedInAt: '2026-08-23T10:00:00.000Z' } }));
    const out = await ticketsSearchHandler(
      deps,
      { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
      { venueId: V1, phoneLast4: '2222', from: FROM, to: TO, includeArchived: false, limit: 50 },
    );
    expect(out.tickets.map((t) => t.id)).toEqual([mkId('0002')]);
  });
});

describe('ticketsSearch: cursor pagination', () => {
  it('two pages together cover every matching ticket exactly once, honestly', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const ids = [mkId('0001'), mkId('0002'), mkId('0003')];
    const times = ['2026-08-23T08:00:00.000Z', '2026-08-23T09:00:00.000Z', '2026-08-23T10:00:00.000Z'];
    for (let i = 0; i < ids.length; i++) {
      await deps.db.doc(P.ticket(OP, ids[i]!)).set(ticket(ids[i]!, { venueId: V1, times: { checkedInAt: times[i]! } }));
    }
    const caller: Caller = { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] };

    const page1 = await ticketsSearchHandler(deps, caller, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 2 });
    expect(page1.tickets.map((t) => t.id)).toEqual([ids[2], ids[1]]); // desc by times.checkedInAt
    expect(page1.nextCursor).toBeDefined();

    const page2 = await ticketsSearchHandler(deps, caller, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 2, cursor: page1.nextCursor });
    expect(page2.tickets.map((t) => t.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeUndefined(); // fewer raw docs than `limit` — collection exhausted

    const allIds = [...page1.tickets, ...page2.tickets].map((t) => t.id);
    expect(new Set(allIds).size).toBe(3); // no duplicates
    expect(allIds.sort()).toEqual([...ids].sort()); // no gaps
  });

  it('rejects a malformed cursor', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      ticketsSearchHandler(
        deps,
        { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] },
        { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50, cursor: 'not-a-real-cursor' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('ticketsSearch: includeArchived', () => {
  it('an archived ticket (operators/{op}/archive/tickets_{id}) is invisible by default and found once includeArchived is set', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const archivedId = mkId('0009');
    // Mirrors archiveHandler's exact write shape (archive.ts): full original ticket data at
    // `operators/{op}/archive/tickets_{id}` — a doc in the `archive` collection with a `tickets_`
    // id prefix, not a `tickets` subcollection.
    await deps.db.doc(P.archiveTicket(OP, archivedId)).set(ticket(archivedId, { venueId: V1, status: 'closed', times: { checkedInAt: '2026-08-23T09:00:00.000Z', closedAt: '2026-08-23T09:30:00.000Z' } }));
    const caller: Caller = { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] };

    const withoutArchived = await ticketsSearchHandler(deps, caller, { venueId: V1, from: FROM, to: TO, includeArchived: false, limit: 50 });
    expect(withoutArchived.tickets).toEqual([]);
    expect(withoutArchived.nextCursor).toBeUndefined();

    // Live phase finds nothing (0 raw docs, below `limit`), so the FIRST includeArchived call hands
    // back an empty live page plus a cursor into the archive phase — the second call actually scans
    // the archive collection. Documented, honest two-call shape (search.ts's own header comment).
    const first = await ticketsSearchHandler(deps, caller, { venueId: V1, from: FROM, to: TO, includeArchived: true, limit: 50 });
    expect(first.tickets).toEqual([]);
    expect(first.nextCursor).toBeDefined();

    const second = await ticketsSearchHandler(deps, caller, { venueId: V1, from: FROM, to: TO, includeArchived: true, limit: 50, cursor: first.nextCursor });
    expect(second.tickets.map((t) => t.id)).toEqual([archivedId]);
  });
});
