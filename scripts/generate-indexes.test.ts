import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildIndexes, buildMergedIndexes, fieldOverrideKey, indexKey } from './generate-indexes';

it('builds composite indexes for multi-field queries and collection groups', () => {
  const out = buildIndexes();
  expect(out.indexes.find((i) => i.collectionGroup === 'tickets' && i.fields.map((f) => f.fieldPath).join(',') === 'venueId,status,times.requestedAt')).toBeTruthy();
  expect(out.indexes.find((i) => i.collectionGroup === 'custodyEvents' && i.queryScope === 'COLLECTION_GROUP')).toBeTruthy();
  expect(out.fieldOverrides.find((f) => f.collectionGroup === 'custodyEvents' && f.fieldPath === 'actorUid')).toBeTruthy();
});
it('field overrides are unique per (collectionGroup, fieldPath) and include both COLLECTION and COLLECTION_GROUP defaults (finding 6 / Ruling Y)', () => {
  const out = buildIndexes();
  const keys = out.fieldOverrides.map((f) => `${f.collectionGroup} ${f.fieldPath}`);
  expect(new Set(keys).size).toBe(keys.length); // no duplicates — firebase deploy rejects them
  expect(keys).toContain('tickets status'); // guestByPhone + archiveClosed + archiveCancelled all reference this field — must collapse to one
  for (const f of out.fieldOverrides) {
    const scopes = f.indexes.map((i) => `${i.queryScope}:${i.order}`).sort();
    expect(scopes).toEqual(['COLLECTION:ASCENDING', 'COLLECTION:DESCENDING', 'COLLECTION_GROUP:ASCENDING', 'COLLECTION_GROUP:DESCENDING']);
  }
});
it('keyTagByValue is excluded from the composite-index output — equality-only, no composite index needed (queries.ts\'s own comment)', () => {
  const out = buildIndexes();
  expect(out.indexes.find((i) => i.collectionGroup === 'keyTags' && i.fields.some((f) => f.fieldPath === 'value'))).toBeUndefined();
});

// Fix round 3 (task-platform-report.md): buildMergedIndexes must PRESERVE every committed entry
// buildIndexes() wouldn't itself produce (hand-added Admin-SDK-only entries), and only ever APPEND
// a missing QUERIES-derived entry — never remove or reorder anything already on disk.
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'indexes-test-'));
  file = join(dir, 'firestore.indexes.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('preserves a hand-added entry the generator would never itself produce', () => {
  // Deliberately 2+ fields: this example used to be a SINGLE-field `users`/`status` entry, which is
  // exactly the shape Firestore rejects at deploy time (HTTP 400, "this index is not necessary") —
  // the merge now converts those to fieldOverrides, so a single-field entry can no longer stand in
  // for "hand-added". The preservation contract this test exists for is unchanged.
  const handAdded = {
    collectionGroup: 'users',
    queryScope: 'COLLECTION_GROUP' as const,
    fields: [{ fieldPath: 'status', order: 'ASCENDING' as const }, { fieldPath: 'operatorId', order: 'ASCENDING' as const }],
  };
  const generated = buildIndexes();
  writeFileSync(file, JSON.stringify({ indexes: [handAdded, ...generated.indexes], fieldOverrides: generated.fieldOverrides }, null, 2));
  const merged = buildMergedIndexes(file);
  expect(merged.indexes[0]).toEqual(handAdded); // still first — order preserved, not dropped
  expect(merged.indexes.find((i) => i.collectionGroup === 'users' && i.queryScope === 'COLLECTION_GROUP')).toEqual(handAdded);
});

it('appends a missing QUERIES-derived entry without disturbing existing entries\' order', () => {
  const generated = buildIndexes();
  const [first, ...rest] = generated.indexes;
  // Omit the first generated entry from the "committed" file — merge must add it back, at the end.
  writeFileSync(file, JSON.stringify({ indexes: rest, fieldOverrides: generated.fieldOverrides }, null, 2));
  const merged = buildMergedIndexes(file);
  expect(merged.indexes.slice(0, rest.length)).toEqual(rest); // original order untouched
  expect(merged.indexes).toContainEqual(first); // the missing one was appended
  expect(merged.indexes).toHaveLength(generated.indexes.length);
});

it('is idempotent — running the merge again against its own output is a byte-for-byte no-op', () => {
  const handAdded = { collectionGroup: 'someAdminOnly', queryScope: 'COLLECTION_GROUP' as const, fields: [{ fieldPath: 'weirdField', order: 'ASCENDING' as const }] };
  const generated = buildIndexes();
  writeFileSync(file, JSON.stringify({ indexes: [...generated.indexes, handAdded], fieldOverrides: generated.fieldOverrides }, null, 2));
  const firstMerge = buildMergedIndexes(file);
  writeFileSync(file, JSON.stringify(firstMerge, null, 2));
  const secondMerge = buildMergedIndexes(file);
  expect(secondMerge).toEqual(firstMerge);
});

it('with no committed file at all, falls back to plain buildIndexes() output', () => {
  const merged = buildMergedIndexes(join(dir, 'does-not-exist.json'));
  expect(merged).toEqual(buildIndexes());
});

it('regression guard: merging against the REAL committed firestore.indexes.json is a no-op (Fix round 3 verification)', () => {
  const realPath = fileURLToPath(new URL('../firestore.indexes.json', import.meta.url));
  const merged = buildMergedIndexes(realPath);
  const committed = JSON.parse(readFileSync(realPath, 'utf8')) as ReturnType<typeof buildIndexes>;
  expect(merged).toEqual(committed);
});

/**
 * Fix round 4 (task-platform-report.md): C1's guard (functions/src/lib/indexCoverage.test.ts)
 * only scans functions/src's OWN source for literal `collectionGroup(...).where(...)` calls — it
 * has no visibility into a CLIENT repo (e.g. goldstar-mobile) writing a raw Firestore query. That
 * gap is exactly how `guest/use-my-tickets.ts`'s `collectionGroup('tickets').where('guest.uid',
 * '==', uid).orderBy('times.checkedInAt', 'desc')` shipped with no matching index: it was never
 * registered in QUERIES at all, so nothing here or in functions/ had any reason to check it.
 *
 * This test closes the OTHER half of that class — not "did someone register a client query"
 * (this repo has no way to see into a sibling repo's source), but "does EVERY query someone DID
 * register in QUERIES actually have its required index committed" — i.e. it directly asserts the
 * registry-to-indexes-file contract queries.ts's own doc comment promises ("Plan 1b generates
 * firestore.indexes.json from this table"). The Fix round 3 "merge is a no-op" test above proves
 * this indirectly (if a QUERIES-derived entry were missing, merging would have appended it,
 * making that test fail too) — this test asserts it directly and by name, per the exact ruling
 * wording, and reports precisely which entry is missing rather than a merge diff.
 */
it('every QUERIES-derived index and fieldOverride — including collectionGroup ones — has a matching entry in the committed firestore.indexes.json (Fix round 4)', () => {
  const realPath = fileURLToPath(new URL('../firestore.indexes.json', import.meta.url));
  const committed = JSON.parse(readFileSync(realPath, 'utf8')) as ReturnType<typeof buildIndexes>;
  const generated = buildIndexes();

  const committedIndexKeys = new Set(committed.indexes.map(indexKey));
  const missingIndexes = generated.indexes.filter((i) => !committedIndexKeys.has(indexKey(i)));
  expect(missingIndexes, `missing composite index(es) for: ${missingIndexes.map((i) => `${i.collectionGroup}/${i.queryScope} ${i.fields.map((f) => f.fieldPath).join('+')}`).join(', ')}`).toEqual([]);

  const committedOverrideKeys = new Set(committed.fieldOverrides.map(fieldOverrideKey));
  const missingOverrides = generated.fieldOverrides.filter((f) => !committedOverrideKeys.has(fieldOverrideKey(f)));
  expect(missingOverrides, `missing fieldOverride(s) for: ${missingOverrides.map(fieldOverrideKey).join(', ')}`).toEqual([]);
});

it('drops single-field composite entries and converts COLLECTION_GROUP ones to fieldOverrides (Firestore rejects them at deploy: HTTP 400 "this index is not necessary")', () => {
  writeFileSync(
    file,
    JSON.stringify({
      indexes: [
        { collectionGroup: 'users', queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'status', order: 'ASCENDING' }] },
        { collectionGroup: 'shifts', queryScope: 'COLLECTION', fields: [{ fieldPath: 'venueId', order: 'ASCENDING' }] },
        { collectionGroup: 'keep', queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'ASCENDING' }] },
      ],
      fieldOverrides: [],
    }),
  );
  const out = buildMergedIndexes(file);
  expect(out.indexes.filter((i) => i.fields.length < 2)).toEqual([]);
  expect(out.indexes.find((i) => i.collectionGroup === 'keep')).toBeTruthy(); // 2+ fields survive untouched
  const override = out.fieldOverrides.find((f) => f.collectionGroup === 'users' && f.fieldPath === 'status');
  expect(override?.indexes.map((i) => `${i.queryScope}:${i.order}`).sort()).toEqual([
    'COLLECTION:ASCENDING',
    'COLLECTION:DESCENDING',
    'COLLECTION_GROUP:ASCENDING',
    'COLLECTION_GROUP:DESCENDING',
  ]);
  // A COLLECTION-scope single-field entry needs no override at all — Firestore indexes every field
  // of a collection by default; only the collection-GROUP variant has to be asked for.
  expect(out.fieldOverrides.find((f) => f.collectionGroup === 'shifts')).toBeUndefined();
});

it('the committed firestore.indexes.json has no single-field composite entry (the deploy-time gate, run locally)', () => {
  const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../firestore.indexes.json', import.meta.url)), 'utf8')) as ReturnType<typeof buildIndexes>;
  expect(committed.indexes.filter((i) => i.fields.length < 2)).toEqual([]);
});
