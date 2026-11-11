import { MANAGER_ROLES, type Role, type User } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

/**
 * Plan 8 Task 12 (carry #15) — push-topic hygiene.
 *
 * FCM topic subscription is client-unrestricted: any app instance can subscribe to any topic name.
 * Topics were named after raw ids (`venue_{op}_{venueId}`, `leads_{op}_{venueId}`), so an app
 * instance that guessed an operator and venue id could receive that venue's staff notifications.
 * Two changes, both routed through here so no producer composes a topic name by hand again:
 *
 *  1. VENUE-WIDE kinds (venue.request, venue.pre_arrival) go to `venue_{pushSlug}` — a 128-bit
 *     random slug the venue trigger mints onto the venue doc, readable only by that venue's own
 *     staff (firestore.rules scopes venue reads) and client-immutable. A venue with no slug yet
 *     (the instant between a client create and the trigger) gets NO topic send — never a fallback
 *     to the guessable name, which would reintroduce the hole for exactly the venues least likely
 *     to be noticed.
 *  2. LEAD-ONLY kinds (incident.created, credential.expiring) are delivered PER UID, not to a
 *     topic at all. A slug alone cannot make a leads topic lead-only: attendants read the same
 *     venue doc, so they could subscribe to `leads_{slug}` too. Resolving the managers server-side
 *     and sending to each uid's registered tokens is the only delivery FCM can actually restrict.
 */
export function venueTopicFromSlug(pushSlug: string): string {
  return `venue_${pushSlug}`;
}

/** The venue's topic, or null when the venue has no slug yet (or does not exist). */
export async function venueTopicFor(deps: Deps, operatorId: string, venueId: string): Promise<string | null> {
  const slug = (await deps.db.doc(P.venue(operatorId, venueId)).get()).data()?.pushSlug as string | undefined;
  return slug ? venueTopicFromSlug(slug) : null;
}

/**
 * Active managers (owner/admin/lead) who should hear about a venue's lead-only events: owners and
 * admins always (venueIds is operator-wide for them — firestore.rules' venueMatch() admits isAdmin()
 * without a venue check, and this mirrors it), leads only when they hold the venue. `venueId: null`
 * means every active manager of the operator (credential expiry is operator-wide compliance).
 */
export async function managerUidsFor(deps: Deps, operatorId: string, venueId: string | null): Promise<string[]> {
  const snap = await deps.db
    .collection(`operators/${operatorId}/users`)
    .where('roles', 'array-contains-any', [...MANAGER_ROLES])
    .where('status', '==', 'active')
    .get();
  const managers: Role[] = ['owner', 'admin'];
  return snap.docs
    .map((d) => d.data() as User)
    .filter((u) => venueId === null || u.roles.some((r) => managers.includes(r)) || u.venueIds.includes(venueId))
    .map((u) => u.uid)
    .sort();
}
