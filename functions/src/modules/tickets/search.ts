import { FieldPath, type Query } from 'firebase-admin/firestore';
import type { CallableParsedInput, CallableOutput, Ticket } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { canAccessVenue } from '../../lib/venueAccess.js';

const MAX_VENUE_IN = 30; // Firestore's own cap on `in` clause size.

interface Cursor {
  phase: 'live' | 'archive';
  /** live phase only: last-returned ticket's `times.checkedInAt` (the query's sort key). */
  at?: string;
  /** live phase: last-returned ticket's doc id (tiebreaker). archive phase: last-returned ticket's
   * bare id (without the `tickets_` doc-id prefix) to resume the archive scan after. */
  id?: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (parsed.phase === 'live' || parsed.phase === 'archive') return parsed as Cursor;
  } catch {
    // fall through to the invalid_argument below
  }
  throw err('invalid_argument', 'invalid cursor');
}

/**
 * Mirrors `canAccessVenue`'s claims-truncation fallback (at most 20 venue ids ride in the auth
 * token; a caller with more falls back to reading their user doc's full list) but returns the
 * WHOLE list rather than testing membership in one. Needed here because, unlike every other
 * venue-scoped callable, `ticketsSearch` must scope an entire QUERY (not just validate one
 * already-known venueId) to "every venue this lead can see" when the caller omits `venueId`.
 */
async function resolveLeadVenueIds(deps: Deps, c: Caller & { operatorId: string }): Promise<string[]> {
  if (c.venueIds.length < 20) return c.venueIds;
  const u = (await deps.db.doc(P.user(c.operatorId, c.uid)).get()).data() as { venueIds?: string[] } | undefined;
  return u?.venueIds ?? c.venueIds;
}

/**
 * Every optional filter is re-checked here regardless of whether it was already composed into the
 * Firestore query below — cheap, and it means a base-query selection mistake fails closed (returns
 * fewer/no rows) rather than leaking a row across a venue/status/plate/phone boundary it shouldn't.
 */
function matches(t: Ticket, input: CallableParsedInput<'ticketsSearch'>, venueEquals: string | undefined, venueIn: string[] | undefined): boolean {
  if (venueEquals !== undefined && t.venueId !== venueEquals) return false;
  if (venueIn !== undefined && !venueIn.includes(t.venueId)) return false;
  if (input.status && t.status !== input.status) return false;
  if (input.jobType && t.jobType !== input.jobType) return false;
  // Exact match, no case-folding: the Firestore equality filter below is already case-sensitive
  // (`vehicle.plate == input.plate`), so uppercasing only the QUERY side here would silently
  // exclude any ticket whose plate wasn't ALSO stored uppercase — the in-memory filter can only
  // narrow what Firestore already fetched, never add back a row Firestore's own `==` excluded on a
  // case mismatch. Normalizing plate casing (e.g. always uppercase) is the dashboard filter's job
  // at the client, not this handler's — disclosed in task-4-report.md. Landed: `filters.tsx`
  // uppercases the plate at submit (mirrors goldstar-mobile's write-side `.toUpperCase()` on
  // `vehicle.plate`), so this handler still receives an already-normalized value and stays a plain
  // exact match — no change needed here (task-4-review.md M1).
  if (input.plate && t.vehicle.plate !== input.plate) return false;
  if (input.phoneLast4 && t.guest.phoneLast4 !== input.phoneLast4) return false;
  if (t.times.checkedInAt < input.from || t.times.checkedInAt > input.to) return false;
  return true;
}

/**
 * Archived tickets live at `operators/{op}/archive/tickets_{id}` (see `archive.ts`'s Ruling C
 * comment) — a doc in the `archive` collection whose id carries a `tickets_` PREFIX, not a nested
 * `tickets` subcollection. No composite index is registered for this collection (it has been a
 * scheduled-cleanup destination only, never a client query target, until this callable) and
 * Firestore allows exactly one range/inequality field per query; the document-id prefix range
 * below already claims that slot, so the date range and every other filter are applied in-memory
 * after the fetch instead of composed into the query. Ordered by document id (not a time field)
 * for the same reason — archive results are therefore NOT chronologically ordered relative to one
 * another and a single page may come back sparse (fewer than `limit` matches) even when more exist
 * further into the scan; the client keeps paging via `nextCursor` until it comes back unset. This
 * is a disclosed, known limitation of searching a collection nothing indexed before now.
 */
async function searchArchive(
  deps: Deps,
  operatorId: string,
  input: CallableParsedInput<'ticketsSearch'>,
  venueEquals: string | undefined,
  venueIn: string[] | undefined,
  afterId: string | undefined,
): Promise<CallableOutput<'ticketsSearch'>> {
  const col = deps.db.collection(`operators/${operatorId}/archive`);
  let q: Query = col
    .orderBy(FieldPath.documentId())
    .where(FieldPath.documentId(), '>=', 'tickets_')
    .where(FieldPath.documentId(), '<', 'tickets_');
  if (afterId) q = q.startAfter(`tickets_${afterId}`);
  q = q.limit(input.limit);

  const snap = await q.get();
  const raw = snap.docs.map((d) => d.data() as Ticket);
  const tickets = raw.filter((t) => matches(t, input, venueEquals, venueIn)).slice(0, input.limit);

  let nextCursor: string | undefined;
  if (snap.docs.length === input.limit) {
    const lastDocId = snap.docs[snap.docs.length - 1]!.id; // `tickets_{ticketId}`
    nextCursor = encodeCursor({ phase: 'archive', id: lastDocId.slice('tickets_'.length) });
  }
  return { tickets, ...(nextCursor ? { nextCursor } : {}) };
}

export async function ticketsSearchHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'ticketsSearch'>): Promise<CallableOutput<'ticketsSearch'>> {
  const c = requireOperator(caller);
  // Ruling (task-4-brief): search is lead-visible (scoped to their own venues below), unlike
  // auditQuery's owner/admin/platform_admin-only gate, which has no lead branch. platform_admin
  // sessions always carry 'admin' alongside 'platform_admin' (Ruling C-2, assume.ts's minted
  // claims), so no separate platform_admin clause is needed in this gate.
  const isManager = c.roles.some((r) => ['owner', 'admin'].includes(r));
  if (!isManager && !c.roles.includes('lead')) throw err('permission_denied');
  // Ruling: search is read-only inspection like auditQuery -> platform_admin is exempt from the
  // suspended-operator gate here; every other caller (owner/admin/lead) still goes through it.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  // ---- venue scoping (server-side; a client-supplied filter is never trusted on its own) ----
  let venueEquals: string | undefined;
  let venueIn: string[] | undefined;
  if (input.venueId) {
    if (!(await canAccessVenue(deps, c, input.venueId))) throw err('permission_denied');
    venueEquals = input.venueId;
  } else if (!isManager) {
    const ids = await resolveLeadVenueIds(deps, c);
    if (ids.length === 0) return { tickets: [] };
    if (ids.length > MAX_VENUE_IN) throw err('invalid_argument', 'select a venue to narrow this search');
    venueIn = ids;
  }

  const cursor = decodeCursor(input.cursor);
  if (cursor?.phase === 'archive') {
    if (!input.includeArchived) throw err('invalid_argument', 'invalid cursor');
    return searchArchive(deps, c.operatorId, input, venueEquals, venueIn, cursor.id);
  }

  const col = deps.db.collection(`operators/${c.operatorId}/tickets`);
  let q: Query = col;
  // Registered-index selection (`src/queries.ts` / `firestore.indexes.json`) — every branch below
  // is servable by an ALREADY-REGISTERED composite, or (the final `else`) by Firestore's automatic
  // single-field index on `times.checkedInAt`; this callable adds no new index. Whatever the chosen
  // index doesn't cover (status/jobType/phoneLast4, and venue when `plate` is set) is filtered
  // in-memory by `matches()` below rather than composed into the query.
  if (input.plate) {
    // platesByOperator: vehicle.plate ASC, times.checkedInAt DESC.
    q = q.where('vehicle.plate', '==', input.plate);
  } else if (venueEquals !== undefined || venueIn !== undefined) {
    q = venueEquals !== undefined ? q.where('venueId', '==', venueEquals) : q.where('venueId', 'in', venueIn!);
    // Firestore's `in` uses the same composite index as `==` on that field, so venueParked/
    // venueRecent below serve a lead's multi-venue `in` filter exactly as they'd serve a single
    // admin-picked venue's `==`.
    if (input.status) q = q.where('status', '==', input.status); // venueParked: venueId, status, times.checkedInAt desc
    // else: venueRecent: venueId, times.checkedInAt desc
  }
  // else: no plate, no venue filter (operator-wide admin/owner search) — times.checkedInAt's
  // automatic single-field index carries the query alone; status/jobType filtered in-memory.
  q = q
    .where('times.checkedInAt', '>=', input.from)
    .where('times.checkedInAt', '<=', input.to)
    .orderBy('times.checkedInAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc') // stable tiebreaker; every composite index above implicitly ends in __name__
    .limit(input.limit);
  if (cursor?.phase === 'live' && cursor.at !== undefined && cursor.id !== undefined) q = q.startAfter(cursor.at, cursor.id);

  const snap = await q.get();
  const raw = snap.docs.map((d) => d.data() as Ticket);
  // Same root cause as `searchArchive`'s own sparse-page note above: `limit` bounds the RAW
  // Firestore fetch, and `matches()` can only shrink that further (plate/no-venue queries, or any
  // filter this base query's index doesn't cover) — a returned page can legitimately have fewer
  // than `limit` tickets even though more matches exist past the cursor. `nextCursor` below is
  // still keyed on the raw docs fetched (not the post-filtered count), so pagination stays honest
  // (never skips a doc) at the cost of occasionally sparse pages — task-4-review.md's Minor.
  const tickets = raw.filter((t) => matches(t, input, venueEquals, venueIn));

  let nextCursor: string | undefined;
  if (snap.docs.length === input.limit) {
    const last = snap.docs[snap.docs.length - 1]!;
    nextCursor = encodeCursor({ phase: 'live', at: (last.data() as Ticket).times.checkedInAt, id: last.id });
  } else if (input.includeArchived) {
    // Live collection exhausted along this ordering; the next page continues into the archive scan.
    nextCursor = encodeCursor({ phase: 'archive' });
  }
  return { tickets, ...(nextCursor ? { nextCursor } : {}) };
}

export const ticketsSearch = defineCallable('ticketsSearch', {}, ticketsSearchHandler);
