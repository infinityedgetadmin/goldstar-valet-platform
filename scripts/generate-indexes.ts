import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { QUERIES } from '../src/queries';

/**
 * Fix round 3 (task-platform-report.md): this script used to be destructive — running it OVERWROTE
 * the committed `firestore.indexes.json` with `buildIndexes()`'s output alone, silently DROPPING any
 * entry that isn't derivable from `QUERIES`. That's a real gap: `QUERIES` only registers CLIENT-
 * facing queries (its own doc comment: "Every client query must be registered here"), while a
 * handful of committed entries exist for Functions-internal (Admin SDK) `collectionGroup(...)`
 * queries that never go through a client and were never meant to force a contracts-package version
 * bump (`QUERIES` lives in `src/`, the published `@goldstar/platform` package) — see
 * `identity/eligibility.ts`'s `users.status` and `guest/ticketsByGuest.ts`/`guest/emailReceipt.ts`'s
 * own comments for the individual cases.
 *
 * Fixed here: `buildMergedIndexes()` below PRESERVES every entry already in the committed file that
 * `buildIndexes()` (the `QUERIES`-derived pass, unchanged) wouldn't itself produce, and only ever
 * APPENDS a new `QUERIES`-derived entry that isn't already present — it never removes or reorders
 * anything that's already committed. Running this script is now safe (idempotent: running it twice
 * in a row produces byte-identical output both times), and CI's `rules` job
 * (`indexes:generate && git diff --exit-code firestore.indexes.json`, `.github/workflows/ci.yml`)
 * can pass again — verified locally by running the exact command and confirming a clean diff.
 *
 * `keyTagByValue` (queries.ts) is DELIBERATELY excluded from `buildIndexes()`'s composite-index
 * output (see the `NO_COMPOSITE_INDEX` set below) rather than preserved-if-present: that query is
 * equality-only (`venueId ==`, `value ==`) and queries.ts's own comment on it says Firestore serves
 * it via automatic single-field index merging — no composite index needed at all. The committed file
 * has never carried one; this fix keeps it that way instead of letting a future regeneration add a
 * genuinely unnecessary index.
 *
 * A merge can still only ever GROW the file (never shrink or restructure an existing entry) — if a
 * `QUERIES` entry's shape genuinely changes (a field renamed, an order flipped), the OLD shape stays
 * as a stale, harmless-but-orphaned entry alongside the new one rather than being silently replaced.
 * That's the deliberate, safer failure mode for an automated merge; a stale composite index is inert
 * dead weight, not a correctness risk the way silently dropping a live one is. Prune stale entries by
 * hand if it ever matters (Firestore has no per-index cost signal that makes this urgent).
 */

interface IndexField { fieldPath: string; order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: 'CONTAINS' }
interface Index { collectionGroup: string; queryScope: 'COLLECTION' | 'COLLECTION_GROUP'; fields: IndexField[] }
interface FieldOverrideEntry { order: 'ASCENDING' | 'DESCENDING'; queryScope: 'COLLECTION' | 'COLLECTION_GROUP' }
interface FieldOverride { collectionGroup: string; fieldPath: string; indexes: FieldOverrideEntry[] }
interface IndexesFile { indexes: Index[]; fieldOverrides: FieldOverride[] }

const NO_COMPOSITE_INDEX: ReadonlySet<string> = new Set(['keyTagByValue']);

export function buildIndexes(): IndexesFile {
  const indexes: Index[] = [];
  const overrides = new Map<string, FieldOverride>();
  for (const [name, q] of Object.entries(QUERIES)) {
    const group = 'collectionGroup' in q ? q.collectionGroup : q.collection;
    const scope = 'collectionGroup' in q ? 'COLLECTION_GROUP' : 'COLLECTION';
    const fields: IndexField[] = q.fields.map((f) => ('arrayContains' in q && q.arrayContains === f ? { fieldPath: f, arrayConfig: 'CONTAINS' } : { fieldPath: f, order: 'desc' in q && q.desc === f ? 'DESCENDING' : 'ASCENDING' }));
    if (fields.length > 1 && !NO_COMPOSITE_INDEX.has(name)) indexes.push({ collectionGroup: group, queryScope: scope, fields });
    if (scope === 'COLLECTION_GROUP') {
      for (const f of q.fields) {
        const key = `${group} ${f}`;
        // Finding 6 / Ruling Y: a fieldOverride REPLACES all default per-field indexing for this field
        // in this collectionGroup name — including the default COLLECTION-scope single-field index that
        // plain equality/order queries against the non-collection-group path rely on. List both scopes
        // explicitly so deploying the override doesn't silently disable those defaults, and dedupe by
        // (collectionGroup, fieldPath) — firebase deploy rejects duplicate overrides, and the same field
        // can legitimately appear in more than one registered query (e.g. tickets.status via
        // guestByPhone/archiveClosed/archiveCancelled).
        if (!overrides.has(key)) overrides.set(key, singleFieldOverride(group, f));
      }
    }
  }
  return { indexes, fieldOverrides: [...overrides.values()] };
}

// Exported so generate-indexes.test.ts's Fix round 4 coverage check (every QUERIES-derived entry
// has a match in the committed file) can compare with the exact same identity rules this file's
// own merge uses, instead of a second, potentially-drifting definition of "the same entry."
export function indexKey(i: Index): string {
  return JSON.stringify([i.collectionGroup, i.queryScope, i.fields.map((f) => [f.fieldPath, f.order ?? null, f.arrayConfig ?? null])]);
}

export function fieldOverrideKey(f: FieldOverride): string {
  return `${f.collectionGroup} ${f.fieldPath}`;
}

/** The single-field override shape this generator emits everywhere — see the Ruling Y comment in
 * `buildIndexes` for why both scopes and both orders are always listed. */
function singleFieldOverride(collectionGroup: string, fieldPath: string): FieldOverride {
  return {
    collectionGroup,
    fieldPath,
    indexes: [
      { order: 'ASCENDING', queryScope: 'COLLECTION' },
      { order: 'DESCENDING', queryScope: 'COLLECTION' },
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
      { order: 'DESCENDING', queryScope: 'COLLECTION_GROUP' },
    ],
  };
}

/**
 * Merge-preserving: starts from the file already on disk (in its EXACT current order — hand-added
 * entries stay exactly where they are) and appends only the `QUERIES`-derived entries that aren't
 * already present, in `QUERIES`' own (stable, insertion-order) iteration order. Never removes or
 * reorders an existing entry. Deterministic: the same `(committed file, QUERIES)` pair always
 * produces the same output, byte for byte — running it twice in a row is a no-op the second time.
 * With no committed file yet (first-ever run), this degrades to plain `buildIndexes()` output.
 */
export function buildMergedIndexes(committedPath: string): IndexesFile {
  const generated = buildIndexes();
  if (!existsSync(committedPath)) return generated;
  const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as IndexesFile;

  // A composite index needs 2+ fields: Firestore REJECTS a single-field entry outright at deploy
  // time ("this index is not necessary, configure using single field index controls", HTTP 400) —
  // a production-only failure the emulator never reproduces, so four of these survived every local
  // gate until the first real deploy. `buildIndexes` has always skipped them for QUERIES-derived
  // entries (`fields.length > 1`); this applies the same rule to the hand-added committed ones the
  // merge preserves verbatim. A dropped COLLECTION_GROUP entry is not lost — it becomes the
  // fieldOverride below, which is how a single-field collection-group query is actually served.
  const singles = committed.indexes.filter((i) => i.fields.length < 2);
  const indexes = committed.indexes.filter((i) => i.fields.length >= 2);
  const indexKeys = new Set(indexes.map(indexKey));
  for (const i of generated.indexes) {
    const key = indexKey(i);
    if (!indexKeys.has(key)) {
      indexes.push(i);
      indexKeys.add(key);
    }
  }

  const fieldOverrides = [...committed.fieldOverrides];
  const overrideKeys = new Set(fieldOverrides.map(fieldOverrideKey));
  for (const i of singles) {
    if (i.queryScope !== 'COLLECTION_GROUP') continue;
    const override = singleFieldOverride(i.collectionGroup, i.fields[0]!.fieldPath);
    const key = fieldOverrideKey(override);
    if (!overrideKeys.has(key)) {
      fieldOverrides.push(override);
      overrideKeys.add(key);
    }
  }
  for (const f of generated.fieldOverrides) {
    const key = fieldOverrideKey(f);
    if (!overrideKeys.has(key)) {
      fieldOverrides.push(f);
      overrideKeys.add(key);
    }
  }

  return { indexes, fieldOverrides };
}

if (process.argv[1]?.endsWith('generate-indexes.ts')) {
  const path = 'firestore.indexes.json';
  writeFileSync(path, JSON.stringify(buildMergedIndexes(path), null, 2) + '\n');
  console.log('firestore.indexes.json written (merge-preserving — see this file\'s header comment)');
}
