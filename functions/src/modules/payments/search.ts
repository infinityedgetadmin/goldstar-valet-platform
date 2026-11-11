import { FieldPath, type Query } from 'firebase-admin/firestore';
import type { CallableParsedInput, CallableOutput, Transaction } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { canAccessVenue } from '../../lib/venueAccess.js';

const MAX_VENUE_IN = 30; // Firestore's own cap on `in` clause size — mirrors ticketsSearch/search.ts.

interface Cursor {
  /** last-returned transaction's `at` (the query's sort key). */
  at: string;
  /** last-returned transaction's doc id (tiebreaker) — the transaction's own `id`/`providerRef`
   * (`applyEvent.ts` writes `id: ev.providerRef` into the doc body AND keys the doc by that same
   * value via `P.tx(operatorId, ev.providerRef)`, so `snap.docs[i].id` and `.data().id` agree,
   * exactly like `ticketsSearch`'s ticket-id precedent). */
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.at === 'string' && typeof parsed.id === 'string') return parsed as Cursor;
  } catch {
    // fall through to the invalid_argument below
  }
  throw err('invalid_argument', 'invalid cursor');
}

/** Verbatim copy of `tickets/search.ts`'s `resolveLeadVenueIds` — see that function's own comment
 * for the full rationale (claims-truncation fallback for a caller assigned to 20+ venues). Not
 * factored into a shared helper: `tickets/search.ts` is Task 4's landed, reviewed file and this
 * task was told to mirror its architecture, not refactor it — disclosed duplication, same call as
 * `use-tickets-search.ts`'s dashboard-side counterpart (task-6-report.md). */
async function resolveLeadVenueIds(deps: Deps, c: Caller & { operatorId: string }): Promise<string[]> {
  if (c.venueIds.length < 20) return c.venueIds;
  const u = (await deps.db.doc(P.user(c.operatorId, c.uid)).get()).data() as { venueIds?: string[] } | undefined;
  return u?.venueIds ?? c.venueIds;
}

/**
 * Every optional filter is re-checked here regardless of whether it was already composed into the
 * Firestore query below — same fails-closed reasoning as `tickets/search.ts`'s own `matches()`.
 */
function matches(t: Transaction, input: CallableParsedInput<'paymentsSearch'>, venueEquals: string | undefined, venueIn: string[] | undefined): boolean {
  if (venueEquals !== undefined && t.venueId !== venueEquals) return false;
  if (venueIn !== undefined && !venueIn.includes(t.venueId)) return false;
  if (input.status && t.status !== input.status) return false;
  if (t.at < input.from || t.at > input.to) return false;
  return true;
}

/**
 * Mirrors `tickets/search.ts`'s `ticketsSearchHandler` architecture exactly, per task-6-brief.md:
 * registered-base-query + always-in-memory-narrow + fails-closed + fresh venue scoping before
 * cursor decode + max 200 (contract's own `limit` schema) + role gate (owner/admin, or lead scoped
 * to their own venues) + `requireActiveOperator` with the `auditQuery`-style `platform_admin`
 * exemption (this is read-only inspection, not money movement).
 *
 * ## Single-phase — no archive branch (verified, not assumed)
 *
 * `tickets/archive.ts`'s scheduled sweep only ever touches the `tickets` collection group
 * (`archiveHandler`'s own `collectionGroup('tickets')` query, with `ARCHIVED_SUBCOLLECTIONS =
 * ['custodyEvents']`) — `transactions` is never moved, deleted, or otherwise archived anywhere in
 * this codebase (grepped `functions/src` directly). So there is no second "archive phase" this
 * cursor needs to hand off into, unlike `ticketsSearch`'s `Cursor.phase` — the cursor here is just
 * `{at, id}`, always resolved against the live `transactions` collection.
 *
 * ## Base-query index selection (verified against `src/queries.ts` + `firestore.indexes.json`)
 *
 * Exactly one client-facing index is registered for `transactions`: `transactionsByVenue` —
 * `{venueId ASC, at DESC}` (`src/queries.ts` line 32; mirrored in `firestore.indexes.json`).
 * There is no `status`-inclusive composite (unlike `ticketsSearch`'s `venueParked`), so `status` is
 * ALWAYS filtered in-memory by `matches()` below, never composed into the query — even when a
 * venue filter is also present. Two servable shapes:
 *   - `venueId == / in` + `at` range, ordered by `at desc` -> `transactionsByVenue`.
 *   - no venue filter (operator-wide admin/owner search) -> `at`'s automatic single-field index
 *     alone carries the range + orderBy + `FieldPath.documentId()` tiebreaker, same as
 *     `ticketsSearch`'s own "no plate, no venue filter" branch (single-field indexes always
 *     implicitly append the document id last, so no new composite is needed for the tiebreaker).
 * This callable adds no new index.
 */
export async function paymentsSearchHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'paymentsSearch'>): Promise<CallableOutput<'paymentsSearch'>> {
  const c = requireOperator(caller);
  const isManager = c.roles.some((r) => ['owner', 'admin'].includes(r));
  if (!isManager && !c.roles.includes('lead')) throw err('permission_denied');
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  // ---- venue scoping (server-side; a client-supplied filter is never trusted on its own) ----
  let venueEquals: string | undefined;
  let venueIn: string[] | undefined;
  if (input.venueId) {
    if (!(await canAccessVenue(deps, c, input.venueId))) throw err('permission_denied');
    venueEquals = input.venueId;
  } else if (!isManager) {
    const ids = await resolveLeadVenueIds(deps, c);
    if (ids.length === 0) return { transactions: [] };
    if (ids.length > MAX_VENUE_IN) throw err('invalid_argument', 'select a venue to narrow this search');
    venueIn = ids;
  }

  const cursor = decodeCursor(input.cursor);

  const col = deps.db.collection(`operators/${c.operatorId}/transactions`);
  let q: Query = col;
  if (venueEquals !== undefined || venueIn !== undefined) {
    // transactionsByVenue: venueId, at desc. Firestore's `in` uses the same composite index as `==`
    // on that field, so a lead's multi-venue `in` filter is served exactly as an admin-picked
    // single venue's `==` would be.
    q = venueEquals !== undefined ? q.where('venueId', '==', venueEquals) : q.where('venueId', 'in', venueIn!);
  }
  // else: no venue filter (operator-wide admin/owner search) — `at`'s automatic single-field index
  // carries the query alone; `status` filtered in-memory either way (see header comment).
  q = q
    .where('at', '>=', input.from)
    .where('at', '<=', input.to)
    .orderBy('at', 'desc')
    .orderBy(FieldPath.documentId(), 'desc') // stable tiebreaker
    .limit(input.limit);
  if (cursor) q = q.startAfter(cursor.at, cursor.id);

  const snap = await q.get();
  const raw = snap.docs.map((d) => d.data() as Transaction);
  // Same sparse-page caveat as `ticketsSearch`: `limit` bounds the RAW fetch, `matches()` can only
  // shrink it further (the `status` filter here always runs in-memory) — a page can legitimately
  // come back with fewer than `limit` rows while `nextCursor` is still set. Keyed on the raw docs
  // fetched (never the post-filtered count), so pagination never skips a row.
  const transactions = raw.filter((t) => matches(t, input, venueEquals, venueIn));

  let nextCursor: string | undefined;
  if (snap.docs.length === input.limit) {
    const last = snap.docs[snap.docs.length - 1]!;
    nextCursor = encodeCursor({ at: (last.data() as Transaction).at, id: last.id });
  }
  return { transactions, ...(nextCursor ? { nextCursor } : {}) };
}

export const paymentsSearch = defineCallable('paymentsSearch', {}, paymentsSearchHandler);
