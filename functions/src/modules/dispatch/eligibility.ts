import type { User } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

/**
 * Reads the driver's STORED eligibility snapshot (`users/{uid}.eligibility`) rather than
 * recomputing it from credentials here — mirrors `firestore.rules`' own `eligible()` helper exactly
 * (`get(...).data.eligibility[field] == true`). `eligibility` is recomputed and written ONLY by
 * `identity/eligibility.ts` (credential-change trigger + daily sweep); re-deriving it independently
 * here would risk this callable disagreeing with what the rules layer separately re-checks via the
 * same field on the SAME transition (a manager could pass this check yet still have the write denied
 * by rules for a mobile-originated equivalent, or vice versa).
 */
export async function isDriverEligible(deps: Deps, operatorId: string, uid: string, field: 'driveHome' | 'passengerRide'): Promise<boolean> {
  const snap = await deps.db.doc(P.user(operatorId, uid)).get();
  if (!snap.exists) return false;
  const u = snap.data() as User;
  return u.eligibility[field];
}
