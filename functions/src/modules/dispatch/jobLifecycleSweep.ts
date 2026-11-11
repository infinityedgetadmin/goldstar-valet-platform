import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Ticket } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { audit } from '../../lib/audit.js';

/** completed -> closed once this long has elapsed since `times.completedAt` (M4, final review). */
const CLOSE_AFTER_MS = 60 * 60 * 1000; // 1 hour

/** quoted -> cancelled once the quote has been expired this long with no confirmation (M4). */
const QUOTE_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours past driveHome/ride.quote.expiresAt

export interface JobLifecycleSweepResult {
  closed: number;
  quoteExpired: number;
}

/**
 * M4 (final review, RULED — build the sweep now, priority (a) over a Plan 6/8 deferral): nothing
 * anywhere previously wrote `status:'closed'` on a job ticket — a completed drive_home/
 * passenger_ride sat in `completed` forever, inflating every driver's Jobs-tab badge
 * (`use-my-jobs.ts` includes `'completed'` in ACTIVE_JOB_STATUSES), the guest's linkedJobs
 * switcher, and the dashboard board's "Arrived / Completing" column with zero available actions.
 * `complete-screen.tsx`'s copy ("closes automatically once billing settles") promised exactly this
 * and nothing delivered it. An abandoned `quoted` job (guest never confirmed before the quote's own
 * `expiresAt`) had the same gap — staff can at least cancel those from the board, but nothing
 * expired them automatically.
 *
 * Two single-field-equality `collectionGroup` scans — `etaRefreshHandler` (eta.ts, same module)
 * already establishes this exact pattern for a low-volume, frequently-run sweep: no composite
 * index is needed because the cutoff/expiry comparison happens in memory rather than as a second
 * Firestore range clause, and each scan is capped at 200 docs per run the same way
 * `archiveHandler`/`retryRefunds` (tickets/archive.ts, payments/refund.ts) cap theirs.
 *
 * Both writes are plain `.update()`s straight to the ticket doc — the SAME privileged-write
 * pattern `jobWrittenHandler`'s own revert branches already use in this module, bypassing the
 * client-facing state machine rather than routing through a callable that exists for a guest/staff
 * actor (`completed -> closed` is already a legal SYS transition in `src/state/driveHome.ts` and
 * `ride.ts`; the quote-expiry cancellation is "system, unconditionally", which no existing callable
 * models). Each write is exactly the kind of status change `onTicketWritten`/`onJobWritten` already
 * react to elsewhere (projection refresh; for the cancelled branch, the fleet-release/refund-
 * trigger paths — both no-ops here, since a `quoted` job has no driver/vehicle assigned yet and no
 * authorized payment).
 */
export async function jobLifecycleSweepHandler(deps: Deps): Promise<JobLifecycleSweepResult> {
  const nowMs = Date.parse(deps.now());
  let closed = 0;
  let quoteExpired = 0;

  const completedSnap = await deps.db.collectionGroup('tickets').where('status', '==', 'completed').limit(200).get();
  for (const d of completedSnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType === 'valet') continue; // defensive — 'completed' is not a valet status, but a collectionGroup scan trusts nothing
    const completedAt = t.times.completedAt;
    if (!completedAt || nowMs - Date.parse(completedAt) < CLOSE_AFTER_MS) continue;
    await d.ref.update({ status: 'closed', 'times.closedAt': deps.now() });
    await audit(deps, { operatorId: t.operatorId, actorUid: 'system', action: 'dispatch.close_job', target: t.id, before: { status: 'completed' }, after: { status: 'closed' } });
    closed++;
  }

  const quotedSnap = await deps.db.collectionGroup('tickets').where('status', '==', 'quoted').limit(200).get();
  for (const d of quotedSnap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType === 'valet') continue; // defensive, same reasoning as above ('quoted' is not a valet status either)
    const expiresAt = t.jobType === 'drive_home' ? t.driveHome?.quote?.expiresAt : t.ride?.quote?.expiresAt;
    if (!expiresAt || nowMs - Date.parse(expiresAt) < QUOTE_EXPIRY_GRACE_MS) continue;
    await d.ref.update({ status: 'cancelled', cancelReason: 'quote_expired', 'times.cancelledAt': deps.now() });
    await audit(deps, { operatorId: t.operatorId, actorUid: 'system', action: 'dispatch.cancel_expired_quote', target: t.id, before: { status: 'quoted' }, after: { status: 'cancelled', cancelReason: 'quote_expired' } });
    quoteExpired++;
  }

  return { closed, quoteExpired };
}

export const jobLifecycleSweep = onSchedule({ schedule: 'every 60 minutes' }, async () => {
  await jobLifecycleSweepHandler(makeDeps());
});
