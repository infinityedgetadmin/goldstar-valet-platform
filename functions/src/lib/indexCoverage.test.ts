import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERIES, type QuerySpec } from '@goldstar/platform';

/**
 * Static guard for the bug class C1 found: a `collectionGroup(...)` query in `functions/src` with
 * no matching COLLECTION_GROUP index in `firestore.indexes.json`. That combination passes every
 * local test — the Firestore EMULATOR does not enforce collection-group index requirements the way
 * production does — and then fails on EVERY invocation once deployed.
 *
 * M2 (Plan 6 final wave): this guard previously had the SAME class of hole it exists to catch, and
 * the reviewer demonstrated it by execution rather than by reading. Two independent defects:
 *
 *   1. `orderBy(...)` was never scanned — only `.where(...)`.
 *   2. Coverage was accepted PER FIELD: every field of every composite index was added to a flat
 *      `covered` set individually, so a field appearing anywhere in any index counted as covered
 *      regardless of which index, or alongside what.
 *
 * Together those let this probe pass:
 *
 *     db.collectionGroup('tickets').where('guest.uid', '==', uid).orderBy('times.completedAt', 'desc')
 *
 * `guest.uid` is covered by the existing `[guest.uid, times.checkedInAt]` composite; the orderBy
 * field is never looked at at all. In production that query needs a `[guest.uid,
 * times.completedAt]` composite that does not exist, so it fails on every call — exactly the
 * shape of the original shipped bug.
 *
 * Now ported from the mobile-side guard (`goldstar-mobile/src/lib/firestore-query-coverage.test.ts`
 * — the FIXED version, which had its own comment-parsing silent-drop bug repaired separately):
 *
 * - `stripComments` runs over each file BEFORE the chain walker. Without it, an unescaped
 *   apostrophe in a `//` comment ("the guest's ticket") flips the walker's string-literal parity,
 *   and a later real literal containing a `)` closes the span early — silently dropping the rest of
 *   the chain's clauses. That is a silent PASS, the worst failure mode for a guard.
 * - The chain walker consumes `.identifier( … )` links with balanced, string-aware paren counting,
 *   so a Prettier-wrapped multi-line query is scanned in full. The old per-line regex saw only what
 *   shared a physical line with `.collectionGroup(`.
 * - BOTH `.where(...)` and `.orderBy(...)` contribute to the query's required field set.
 * - Coverage requires ONE index whose fields are a SUPERSET of that whole set — not per-field
 *   accumulation across different indexes.
 *
 * Deliberately still "lightweight, not a full Firestore index verifier" (the original ruling):
 * superset membership is NECESSARY but not sufficient — it does not verify Firestore's
 * equality-fields-then-ordered-orderBy prefix rule, so a query whose fields all appear in one index
 * in the wrong ORDER still passes. It is also one axis wider than that sentence alone implies:
 * the comparison reads only each index field's `fieldPath` and never its `order`, so a DIRECTION
 * mismatch is over-accepted too — an all-ASCENDING index satisfies this guard for a mixed
 * `orderBy(a asc, b desc)` that Firestore will not actually serve from it (an index's full
 * REVERSE works; a partial flip does not). Not reachable today; carried to Plan 8 with the
 * variable-split-chain blind spot below. Superset is chosen over exact-set-equality deliberately: a
 * composite `[a, b, c]` legitimately serves a prefix query on `[a, b]`, and exact matching would
 * flag that as missing — a false positive, which is how a guard earns a bypass. What it now
 * reliably catches is "these fields are not indexed together anywhere," which is the real class.
 *
 * A filter field computed at runtime (tickets/archive.ts's dynamic `field` variable) can't be
 * resolved statically and is skipped, not flagged either way.
 */

interface CollectionGroupQuery {
  collectionGroup: string;
  fields: string[];
  file: string;
  line: number;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Replaces every `//...` line comment and block comment with equivalent whitespace (newlines kept,
 * so reported line numbers stay accurate), string-literal-aware so a `//` inside a literal is left
 * alone. Ported from the mobile guard's R1 fix — see this file's header for why a guard that skips
 * this silently passes instead of failing.
 */
function stripComments(content: string): string {
  let out = '';
  let inString: string | null = null;
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < content.length) {
        out += ch + (content[i + 1] ?? '');
        i += 2;
        continue;
      }
      out += ch;
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Consumes a balanced, string-literal-aware `( … )` starting at `open`. Returns the index just past `)`. */
function skipBalancedParens(content: string, open: number): number {
  let i = open + 1;
  let depth = 1;
  let inString: string | null = null;
  while (i < content.length && depth > 0) {
    const ch = content[i]!;
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    i++;
  }
  return i;
}

/**
 * From just past a `.collectionGroup('x')` call, consumes the chained `.identifier( … )` links that
 * follow — across newlines — and returns the chain's full text. Stops at the first thing that isn't
 * a chained call (`;`, an enclosing `)`, an assignment, ...), so a following unrelated statement is
 * never absorbed. A terminal `.get()`/`.stream()` is consumed harmlessly: it carries no fields.
 */
function readChain(content: string, from: number): { text: string; end: number } {
  let i = from;
  for (;;) {
    let j = i;
    while (j < content.length && /\s/.test(content[j]!)) j++;
    if (content[j] !== '.') break;
    const m = /^\.[A-Za-z_$][\w$]*\(/.exec(content.slice(j));
    if (!m) break;
    i = skipBalancedParens(content, j + m[0].length - 1);
  }
  return { text: content.slice(from, i), end: i };
}

function scanCollectionGroupQueries(srcDir: string): CollectionGroupQuery[] {
  const found: CollectionGroupQuery[] = [];
  for (const file of walkTsFiles(srcDir)) {
    const content = stripComments(readFileSync(file, 'utf8'));
    const cgRe = /\.collectionGroup\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let cg: RegExpExecArray | null;
    while ((cg = cgRe.exec(content)) !== null) {
      const collectionGroup = cg[1]!;
      const { text } = readChain(content, cg.index + cg[0].length);

      const fields = new Set<string>();
      for (const re of [/\.where\(\s*['"`]([\w.]+)['"`]/g, /\.orderBy\(\s*['"`]([\w.]+)['"`]/g]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) fields.add(m[1]!);
      }
      // `__name__` is Firestore's document-ID pseudo-field, which it appends to EVERY index
      // automatically — it is never written into firestore.indexes.json (zero occurrences there
      // today) and never needs to be. `guest/ticketsByGuest.ts`'s `orderBy('__name__')` cursor
      // pagination is a legitimate, fully-indexed query; requiring it would be a false positive,
      // and a guard that fails correct code is one people learn to bypass. Found by running the
      // hardened guard against real source rather than by reading it.
      fields.delete('__name__');
      // A bare `collectionGroup(...)` with neither filter nor ordering needs no index.
      if (fields.size === 0) continue;

      found.push({ collectionGroup, fields: [...fields], file, line: content.slice(0, cg.index).split('\n').length });
    }
  }
  return found;
}

interface FirestoreIndexes {
  indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string }[] }[];
  fieldOverrides: { collectionGroup: string; fieldPath: string; indexes: { queryScope: string }[] }[];
}

describe('COLLECTION_GROUP indexes on disk are all used (Plan 8 Task 16, carry #32 — the orphan direction)', () => {
  it('every COLLECTION_GROUP index in firestore.indexes.json is either a QUERIES entry or covers a functions/src collectionGroup query', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const indexesPath = fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url));
    const indexesJson = JSON.parse(readFileSync(indexesPath, 'utf8')) as FirestoreIndexes;
    const scanned = scanCollectionGroupQueries(srcDir);
    const registered = (Object.values(QUERIES) as QuerySpec[]).filter(
      (q): q is QuerySpec & { collectionGroup: string } => typeof q.collectionGroup === 'string',
    );
    const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((f) => b.includes(f));
    const orphans = indexesJson.indexes
      .filter((i) => i.queryScope === 'COLLECTION_GROUP')
      .filter((idx) => {
        const fields = idx.fields.map((f) => f.fieldPath);
        const byContract = registered.some((q) => q.collectionGroup === idx.collectionGroup && sameSet(q.fields, fields));
        const byFunctions = scanned.some((q) => q.collectionGroup === idx.collectionGroup && q.fields.every((f) => fields.includes(f)));
        return !byContract && !byFunctions;
      })
      .map((idx) => `${idx.collectionGroup} [${idx.fields.map((f) => f.fieldPath).join(', ')}]`);
    // An orphan is an index nothing queries: dead deploy surface at best, and at worst the fossil of
    // a query that was renamed without its index — which is exactly how a live query ends up
    // uncovered. Delete the index (via scripts/generate-indexes.ts's merge rules) or register the query.
    expect(orphans).toEqual([]);
  });
});

describe('collectionGroup query index coverage (static guard; M2-hardened)', () => {
  it('every collectionGroup query in functions/src has ONE COLLECTION_GROUP index covering all of its where + orderBy fields', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const indexesPath = fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url));
    const indexesJson = JSON.parse(readFileSync(indexesPath, 'utf8')) as FirestoreIndexes;

    // Each entry is ONE index's field set — deliberately not flattened into a per-field set, which
    // is the defect this rewrite removes.
    const cgIndexes = indexesJson.indexes
      .filter((i) => i.queryScope === 'COLLECTION_GROUP')
      .map((i) => ({ collectionGroup: i.collectionGroup, fields: new Set(i.fields.map((f) => f.fieldPath)) }));

    // A single-field collection-group query can also be served by a fieldOverride.
    const singleFieldOverrides = new Set(
      indexesJson.fieldOverrides
        .filter((fo) => fo.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP'))
        .map((fo) => `${fo.collectionGroup} ${fo.fieldPath}`),
    );

    const isCovered = (q: CollectionGroupQuery): boolean => {
      if (q.fields.length === 1 && singleFieldOverrides.has(`${q.collectionGroup} ${q.fields[0]}`)) return true;
      return cgIndexes.some((idx) => idx.collectionGroup === q.collectionGroup && q.fields.every((f) => idx.fields.has(f)));
    };

    const queries = scanCollectionGroupQueries(srcDir);
    // If this ever finds zero collectionGroup queries the scanner itself is broken (a regex or path
    // change silently made it vacuous) — fail loudly rather than pass for free.
    expect(queries.length).toBeGreaterThan(0);

    const missing = queries.filter((q) => !isCovered(q));
    if (missing.length > 0) {
      const lines = missing
        .map(
          (m) =>
            `  ${m.file}:${m.line} — collectionGroup('${m.collectionGroup}') using [${m.fields.join(', ')}] has no single COLLECTION_GROUP index covering all of those fields`,
        )
        .join('\n');
      throw new Error(`Missing COLLECTION_GROUP index coverage for ${missing.length} quer${missing.length === 1 ? 'y' : 'ies'}:\n${lines}`);
    }
  });
});
