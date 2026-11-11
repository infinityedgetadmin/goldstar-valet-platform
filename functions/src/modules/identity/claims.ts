import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { Role } from '@goldstar/platform';
import { makeDeps } from '../../lib/deps.js';
import { syncClaimsHandler } from './claims.handler.js';
import { recomputeEligibilityHandler } from './eligibility.js';

/**
 * Task 6 extension: also recomputes `eligibility` (via `eligibility.ts`'s Admin-SDK-only writer)
 * whenever `roles`/`credentials` changed. Deliberately its OWN guard, independent of the
 * claims-relevant guard below — `credentials` never affects custom claims, and `roles` affects both.
 * This also self-guards against the recursion the claims guard comments on: `recomputeEligibilityHandler`
 * only ever writes the `eligibility` key, so a self-triggered re-invocation always sees `roles`/
 * `credentials` unchanged from `before` and skips without needing a separate version counter.
 */
export const onUserWritten = onDocumentWritten('operators/{op}/users/{uid}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after) return;
  const deps = makeDeps();
  const relevant = ['roles', 'venueIds', 'status'] as const;
  // no-op guard: skip when none of the claims-relevant fields changed. Also prevents a self-trigger
  // loop from the claimsVersion/claimsSyncedAt write that syncClaimsHandler itself makes — except on
  // first create (before.claimsVersion === undefined), where a second sync is an accepted inefficiency.
  if (!(before && relevant.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k])) && before.claimsVersion !== undefined)) {
    await syncClaimsHandler(deps, { operatorId: event.params.op, uid: event.params.uid, ...(before ? { priorRoles: before.roles as Role[] } : {}) });
  }
  const eligibilityRelevant = !before || JSON.stringify(before.roles) !== JSON.stringify(after.roles) || JSON.stringify(before.credentials) !== JSON.stringify(after.credentials);
  if (eligibilityRelevant) {
    await recomputeEligibilityHandler(deps, { operatorId: event.params.op, uid: event.params.uid });
  }
});
