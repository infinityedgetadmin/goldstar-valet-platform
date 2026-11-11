import type { Deps } from './deps.js';
import { P } from './paths.js';
import { err } from './errors.js';
import { requireOperator, type Caller } from './callable.js';

/**
 * Staff venue-scoping check shared by every callable that gates on "does this staff member have
 * access to this venue": owner/admin bypass entirely; otherwise the caller's auth-claims venueIds
 * must include the venue. Claims carry at most 20 venue ids (mirrors firestore.rules' inVenue()),
 * so a truncated token falls back to the user doc's full venueIds list before denying — mirrors
 * staffCancel.ts's pre-extraction logic exactly.
 */
export async function canAccessVenue(deps: Deps, caller: Caller & { operatorId: string }, venueId: string): Promise<boolean> {
  if (caller.roles.some((r) => ['owner', 'admin'].includes(r))) return true;
  if (caller.venueIds.includes(venueId)) return true;
  if (caller.venueIds.length < 20) return false;
  const u = (await deps.db.doc(P.user(caller.operatorId, caller.uid)).get()).data() as { venueIds?: string[] } | undefined;
  return u?.venueIds?.includes(venueId) ?? false;
}

/**
 * Dual venue gate for callables BOTH venue hosts (hotel/venue portal) and operator staff call —
 * the PMS callables are the first such surface (`pmsLookup` from the portal's lookup dialog AND
 * the staff app's "Charge to room" sheet). Deliberately unlike the POS callables, which are
 * venue-portal-only by design (their tests assert an operator admin is REJECTED).
 *
 * venue_user is gated purely on claims — venue users have no `operators/{op}/users` doc, so
 * `canAccessVenue`'s >=20-venues fallback read would always deny them for the wrong reason.
 * Everyone else goes through `canAccessVenue` (owner/admin bypass, venueIds claim, doc fallback).
 */
export async function requireVenueUserOrStaff(deps: Deps, caller: Caller | null, venueId: string): Promise<Caller & { operatorId: string }> {
  const c = requireOperator(caller);
  if (c.roles.includes('venue_user')) {
    if (!c.venueIds.includes(venueId)) throw err('permission_denied');
    return c;
  }
  if (!(await canAccessVenue(deps, c, venueId))) throw err('permission_denied');
  return c;
}
