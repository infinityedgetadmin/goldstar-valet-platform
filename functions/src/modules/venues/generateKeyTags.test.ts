import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyTagsHandler } from './generateKeyTags.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Caller } from '../../lib/callable.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function caller(over: Partial<Caller> = {}): Caller {
  return { uid: 'u1', operatorId: OP, roles: ['owner'], venueIds: [], ...over };
}

describe('venueGenerateKeyTags', () => {
  it('an owner generates 50 unique key tags, all sharing one printedBatchId, each resolvable by the (venueId, value) registry lookup mobile check-in uses', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 50, prefix: 'GS' });

    expect(out.values).toHaveLength(50);
    expect(new Set(out.values).size).toBe(50); // all unique
    expect(out.values[0]).toBe('GS-V1-0001');
    expect(out.values[49]).toBe('GS-V1-0050');

    const docs = await deps.db.collection(`operators/${OP}/keyTags`).get();
    expect(docs.size).toBe(50);
    for (const d of docs.docs) {
      const data = d.data();
      expect(data).toMatchObject({ operatorId: OP, venueId: V1, status: 'available', printedBatchId: out.batchId });
    }

    // keyTagByValue (contracts v0.3.5 query registry: equality on venueId + value, no separate
    // registry collection — the keyTags docs themselves ARE what mobile's scan-lookup resolves
    // against) resolves a generated value to exactly one doc.
    const lookup = await deps.db.collection(`operators/${OP}/keyTags`).where('venueId', '==', V1).where('value', '==', 'GS-V1-0025').get();
    expect(lookup.size).toBe(1);
  });

  it('numbering continues from the venue existing max — generating 50 then 50 more produces 0001-0100 with no collisions', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const first = await generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 50, prefix: 'GS' });
    const second = await generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 50, prefix: 'GS' });

    expect(first.values[0]).toBe('GS-V1-0001');
    expect(first.values[49]).toBe('GS-V1-0050');
    expect(second.values[0]).toBe('GS-V1-0051');
    expect(second.values[49]).toBe('GS-V1-0100');
    expect(second.batchId).not.toBe(first.batchId);

    const all = [...first.values, ...second.values];
    expect(new Set(all).size).toBe(100);
    const docs = await deps.db.collection(`operators/${OP}/keyTags`).get();
    expect(docs.size).toBe(100);
  });

  it('M1 (fix round 1, task-5-review.md): two concurrent calls for the same venue never produce duplicate values, and both fully commit their own disjoint range', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const [a, b] = await Promise.all([
      generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 50, prefix: 'GS' }),
      generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 50, prefix: 'GS' }),
    ]);

    expect(a.values).toHaveLength(50);
    expect(b.values).toHaveLength(50);
    const all = [...a.values, ...b.values];
    expect(new Set(all).size).toBe(100); // zero duplicate VALUES across the two concurrent batches
    expect(a.batchId).not.toBe(b.batchId);

    const docs = await deps.db.collection(`operators/${OP}/keyTags`).get();
    expect(docs.size).toBe(100); // zero duplicate DOCS either — both batches fully committed

    // Disjoint numeric ranges (not merely unique-by-luck) — the second call to actually commit must
    // have observed the first's already-committed range and continued past it. If the transaction
    // fix were absent (or a no-op), both calls would read the same pre-contention max and each mint
    // 0001-0050, which the `new Set(...).size === 100` assertion above already would have caught —
    // this makes the mechanism explicit rather than just the symptom.
    const nums = (vals: string[]) => vals.map((v) => parseInt(/-(\d+)$/.exec(v)![1]!, 10)).sort((x, y) => x - y);
    const [numsA, numsB] = [nums(a.values), nums(b.values)];
    const rangeOverlaps = numsA.some((n) => numsB.includes(n));
    expect(rangeOverlaps).toBe(false);
    // Together the two ranges cover exactly 1-100 with no gaps and no repeats.
    expect([...numsA, ...numsB].sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('rejects a non-admin caller (attendant) with permission_denied, before touching Firestore', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(generateKeyTagsHandler(deps, caller({ roles: ['attendant'] }), { venueId: V1, count: 5, prefix: 'GS' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deps.db.collection(`operators/${OP}/keyTags`).get()).size).toBe(0);
  });

  it('rejects a lead caller too — admin+ only, not manager-tier', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(generateKeyTagsHandler(deps, caller({ roles: ['lead'] }), { venueId: V1, count: 5, prefix: 'GS' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('Ruling C-2: denies an owner/admin caller on a suspended operator with failed_precondition', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(generateKeyTagsHandler(deps, caller({ roles: ['admin'] }), { venueId: V1, count: 5, prefix: 'GS' })).rejects.toMatchObject({ code: 'failed_precondition' });
    expect((await deps.db.collection(`operators/${OP}/keyTags`).get()).size).toBe(0);
  });

  it('Ruling C-2: an assumed platform_admin session is exempt from the suspended-operator gate', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await generateKeyTagsHandler(deps, caller({ roles: ['platform_admin', 'admin'] }), { venueId: V1, count: 3, prefix: 'GS' });
    expect(out.values).toHaveLength(3);
  });

  it('404s on a venue that does not belong to (or exist under) the caller operator', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(generateKeyTagsHandler(deps, caller(), { venueId: 'nope', count: 5, prefix: 'GS' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('writes an audit entry recording the batch', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const out = await generateKeyTagsHandler(deps, caller(), { venueId: V1, count: 5, prefix: 'GS' });
    const entries = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'venue.generateKeyTags').get();
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()).toMatchObject({ operatorId: OP, actorUid: 'u1', target: V1, after: { count: 5, batchId: out.batchId, prefix: 'GS' } });
  });
});
