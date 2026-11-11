import type { CallableOutput, CallableParsedInput, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

/**
 * `keyTags.value` doesn't carry a dedicated "venue code" field in the contract (`venueSchema` has
 * no `code`/`shortCode` — verified against `@goldstar/platform`'s schema directly), and the design
 * doc's own `keyTagSchema` smoke test (`schemas1.test.ts`) uses `value: 'GS-V1-0001'` for a venue
 * whose id is literally `'v1'` — i.e. the venue's own id, uppercased, IS the precedent. Real venue
 * ids are uuidv7 (this task's `VenueForm` mints them that way), so using the full id verbatim would
 * make an unwieldy, dash-heavy physical tag code; this takes the last 6 alphanumeric characters
 * (uuidv7's trailing bytes are the random bits — see `ids.ts`'s own layout comment — so this avoids
 * the timestamp-correlated leading hex digits two venues created close together would share) and
 * upper-cases them. For a short id like the fixture `'v1'` (≤6 alnum chars) this reduces to exactly
 * the smoke test's `'V1'`. Collisions across two venues under the same operator are physically
 * survivable — `keyTagByValue` (contracts v0.3.5 query registry) looks up by (venueId, value)
 * together, never `value` alone, so a shared 6-char venue code can't cause the mobile scan-lookup to
 * resolve the wrong venue's tag. Disclosed as a judgment call — flag if a different convention was
 * intended.
 */
function venueCodeFor(venue: Venue): string {
  const alnum = venue.id.replace(/[^a-zA-Z0-9]/g, '');
  return (alnum.length <= 6 ? alnum : alnum.slice(-6)).toUpperCase();
}

export async function generateKeyTagsHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'venueGenerateKeyTags'>,
): Promise<CallableOutput<'venueGenerateKeyTags'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => r === 'owner' || r === 'admin' || r === 'platform_admin')) throw err('permission_denied');
  // Ruling C-2 pattern (mirrors audit/query.ts, integrations/setSecret.ts): an assumed platform_admin
  // session is exempt from the active-operator gate; an owner/admin caller is gated normally, same as
  // every other operator-scoped callable.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  const venueSnap = await deps.db.doc(P.venue(c.operatorId, input.venueId)).get();
  if (!venueSnap.exists) throw err('not_found', 'venue');
  const venue = venueSnap.data() as Venue;
  const venueCode = venueCodeFor(venue);

  /**
   * Fix round 1, M1 (task-5-review.md): the read-existing-then-write-batch shape below used to be
   * two separate, unsynchronized Firestore calls — a plain `WriteBatch` is atomic for the WRITE, but
   * gives zero protection against two concurrent invocations both reading the same `max` and
   * minting overlapping value ranges (verified reproducible: two admin sessions, or one admin
   * double-clicking "Generate" before `KeyTagsPanel`'s disabled-button re-render lands). Two distinct
   * keyTags docs sharing the same (venueId, value) is exactly the "wrong car's keys" scenario the
   * brief asked this task to adjudicate — `keyTagByValue`'s (venueId, value) scan-lookup mobile
   * check-in relies on would resolve ambiguously.
   *
   * Fixed with `runTransaction`: the read (this same venueId-scoped query) and every write happen
   * inside one transaction, so Firestore's optimistic concurrency control detects when a CONCURRENT
   * transaction commits a new keyTags doc for this venue in between this transaction's read and its
   * own commit attempt, and automatically retries the whole callback (re-reading, so `max` reflects
   * the now-current state) rather than committing a stale, colliding range. Admin SDK transactions
   * support up to 500 writes — same as the batch cap this replaces — so `input.count`'s existing
   * `.max(500)` schema ceiling still holds with no change needed.
   */
  const { batchId, values } = await deps.db.runTransaction(async (tx) => {
    // Continuation numbering: scan the venue's existing tags for the highest numeric suffix and
    // start the new batch one past it — regardless of which prefix produced each existing tag,
    // since the product invariant is "no venue ever has two physical key tags sharing a number",
    // not "no two tags sharing a number for the same prefix". Firestore doesn't have a MAX()
    // aggregate on a text field, so this reads every existing tag's `value` for the venue rather
    // than pushing the computation server-side — acceptable at this scale (a venue's live physical
    // tag stock, not an unbounded historical collection). All transaction READS must precede all
    // transaction WRITES (Firestore's own requirement), so this stays first in the callback.
    const existing = await tx.get(deps.db.collection(`operators/${c.operatorId}/keyTags`).where('venueId', '==', input.venueId));
    let max = 0;
    for (const doc of existing.docs) {
      const value = (doc.data() as { value?: string }).value;
      const m = value ? /-(\d+)$/.exec(value) : null;
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }

    const batchId = deps.newId();
    const values: string[] = [];
    for (let i = 1; i <= input.count; i++) {
      const value = `${input.prefix}-${venueCode}-${String(max + i).padStart(4, '0')}`;
      values.push(value);
      const id = deps.newId();
      tx.set(deps.db.doc(P.keyTag(c.operatorId, id)), {
        id,
        operatorId: c.operatorId,
        value,
        venueId: input.venueId,
        status: 'available',
        printedBatchId: batchId,
      });
    }
    return { batchId, values };
  });

  // Outside the transaction, same as every other callable in this codebase (audit() always issues
  // its own independent read+write, never bundled into the transaction/batch it's auditing).
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.generateKeyTags', target: input.venueId, after: { count: input.count, batchId, prefix: input.prefix } });

  return { batchId, values };
}

export const venueGenerateKeyTags = defineCallable('venueGenerateKeyTags', {}, generateKeyTagsHandler);
