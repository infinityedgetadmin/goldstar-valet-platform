import { onSchedule } from 'firebase-functions/v2/scheduler';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { audit } from '../../lib/audit.js';

/**
 * Carry #29: nothing ever pruned `liveLocations` (one doc per driver per operator, written by the
 * mobile publisher, only ever read) or `guestTickets` projections past their `expiresAt` — both
 * accumulated forever. This daily sweep is the belt-and-braces cleanup the original Plan 8 §6
 * retention item described (a Firestore TTL policy, if later enabled in the console, would be the
 * braces; nothing in-repo can declare one).
 *
 * Grace windows, deliberately not zero:
 * - `liveLocations` docs carry their own `expiresAt` and EVERY reader already ignores expired docs
 *   (`eta.ts`, `projection.ts` both check `expiresAt > now`), so deletion timing changes no reader
 *   behavior. Sweeping only past a 24h grace keeps the last shift's trail visible to support/debug
 *   for a day and makes the sweep immune to small clock skew.
 * - `guestTickets` keeps each projection for 7 days past its `expiresAt` (matching the original
 *   plan's "expiresAt + 7d"): a guest re-opening an old link inside that week still gets the
 *   page's own "expired" rendering rather than a hard 404, and support can still inspect it.
 */
export const LIVE_LOCATION_SWEEP_GRACE_MS = 86_400_000; // 24h
export const GUEST_TICKET_PURGE_GRACE_MS = 7 * 86_400_000; // 7d

/** Batched delete honoring the same 450-op bound `archive.ts` uses (server cap is 500/commit). */
async function deleteAll(deps: Deps, refs: Array<FirebaseFirestore.DocumentReference>): Promise<void> {
  for (let i = 0; i < refs.length; i += 450) {
    const b = deps.db.batch();
    for (const ref of refs.slice(i, i + 450)) b.delete(ref);
    await b.commit();
  }
}

export async function sweepEphemeraHandler(deps: Deps): Promise<{ liveLocationsDeleted: number; projectionsDeleted: number }> {
  const now = deps.now();

  // liveLocations live under each operator, so iterate operators rather than a collectionGroup —
  // the operator list is small, and a plain per-subcollection query needs no collection-group
  // index (the indexCoverage guard scans collectionGroup call sites; keep it that way).
  const liveCutoff = new Date(Date.parse(now) - LIVE_LOCATION_SWEEP_GRACE_MS).toISOString();
  let liveLocationsDeleted = 0;
  const ops = await deps.db.collection('operators').select().get();
  for (const op of ops.docs) {
    const stale = await op.ref.collection('liveLocations').where('expiresAt', '<', liveCutoff).get();
    await deleteAll(deps, stale.docs.map((d) => d.ref));
    liveLocationsDeleted += stale.size;
  }

  // guestTickets is a top-level collection keyed by token; page the purge so one run stays bounded
  // even against a large backlog (the daily cadence drains it across runs).
  const purgeCutoff = new Date(Date.parse(now) - GUEST_TICKET_PURGE_GRACE_MS).toISOString();
  let projectionsDeleted = 0;
  for (let page = 0; page < 20; page++) {
    const batch = await deps.db.collection('guestTickets').where('expiresAt', '<', purgeCutoff).limit(450).get();
    if (batch.empty) break;
    await deleteAll(deps, batch.docs.map((d) => d.ref));
    projectionsDeleted += batch.size;
    if (batch.size < 450) break;
  }

  // Platform-level audit row (spans operators — no single operatorId to scope to), matching
  // `archive.ts`'s summary-row pattern: written only when something actually happened.
  if (liveLocationsDeleted > 0 || projectionsDeleted > 0) {
    await audit(deps, { actorUid: 'system', action: 'tickets.sweep_ephemera', target: 'sweep', after: { liveLocationsDeleted, projectionsDeleted } });
  }
  return { liveLocationsDeleted, projectionsDeleted };
}

// 04:00 local — an hour after archiveClosedTickets' 03:00, so the two daily janitors never
// contend on the same documents.
export const sweepEphemera = onSchedule({ schedule: 'every day 04:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await sweepEphemeraHandler(makeDeps());
});
