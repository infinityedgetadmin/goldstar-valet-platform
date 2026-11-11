import type { Deps } from '../../lib/deps.js';

// firebase-admin/firestore's own QueryDocumentSnapshot generic defaults would drag in the full
// FirebaseFirestore.DocumentData typing ceremony for no benefit here — every caller reads fields
// off `.data()` with its own narrow cast anyway (same convention as every ticket handler in this
// codebase), so this is typed loosely on purpose.
type TicketDoc = FirebaseFirestore.QueryDocumentSnapshot;

/**
 * Fix round 1 ruling (task-platform-report.md): paginates EVERY ticket doc (any operator, any
 * status) currently carrying `guest.uid == uid`, `pageSize` at a time, via document-path cursoring
 * — shared by guestDeleteAccount.ts (must exhaust every page; account deletion is a legal-
 * obligation completion, not a best-effort sweep) and onGuestWritten.ts (bounded by `maxPages` —
 * see that file's own comment on why a *trigger* needs a ceiling that a one-shot user-initiated
 * callable does not).
 *
 * Single equality-filter query (`guest.uid == uid`) plus an `orderBy('__name__')` for cursor
 * stability (`orderBy('__name__')` needs no index of its own — Firestore's implicit document-path
 * order is always available at any scope). Fix round 2 (task-platform-review.md, C1): a
 * COLLECTION_GROUP-scoped query is NOT automatically indexed by Firestore's default single-field
 * indexing the way a same-shaped COLLECTION-scoped query is — that has to be configured explicitly,
 * even for one bare equality filter. `guest.uid` needs the `COLLECTION_GROUP`-scope index added to
 * `firestore.indexes.json` alongside this change (mirrors `identity/eligibility.ts`'s own
 * `users.status` collection-group index, added for the identical reason: an Admin-SDK-only
 * collectionGroup query with no client-facing `QUERIES` registration).
 *
 * `onPage` receives one page of docs and returns how many it actually WROTE (a caller may skip
 * docs that already match its target value, or that fail its own further filtering, e.g.
 * TERMINAL_STATUSES) — the total this function returns is the sum of actual writes, not docs
 * merely visited, matching what each caller's own audit/return value means today.
 */
export async function paginateGuestTickets(
  deps: Deps,
  uid: string,
  opts: { pageSize: number; maxPages?: number },
  onPage: (docs: TicketDoc[]) => Promise<number>,
): Promise<number> {
  let total = 0;
  let cursor: TicketDoc | undefined;
  let pages = 0;
  for (;;) {
    let q = deps.db.collectionGroup('tickets').where('guest.uid', '==', uid).orderBy('__name__').limit(opts.pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    total += await onPage(snap.docs);
    cursor = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.docs.length < opts.pageSize) break; // last page reached — done
    if (opts.maxPages !== undefined && pages >= opts.maxPages) break; // ceiling (trigger callers only)
  }
  return total;
}
