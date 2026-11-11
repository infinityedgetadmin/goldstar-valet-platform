import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { makeDeps, type Deps } from '../../lib/deps.js';

/**
 * Plan 6 (guest account): mints `roles:['guest']` custom claims the first time a `guests/{uid}` doc
 * is created, for any path that creates one WITHOUT already having minted the claim itself first
 * (identity/guestLink.ts's guestLinkHandler already mints the claim inline before writing the guest
 * doc — this trigger is a defense-in-depth safety net for any other producer, present or future, not
 * that specific call site; firing redundantly there is harmless since both write the identical
 * literal `{roles: ['guest'], claimsVersion: 1}`).
 *
 * "claims REPLACE" carry: `auth.setCustomUserClaims` REPLACES the entire custom-claims object, it
 * does not merge — so this must read the caller's CURRENT claims first and refuse to stomp anything
 * richer than a bare guest claim. Mirrors guestLinkHandler's own gate (identity/guestLink.ts: deny any
 * caller carrying an operatorId claim or any role other than 'guest') — a guest doc write must never
 * be able to downgrade/clobber a staff identity's operatorId/roles/venueIds.
 */
export async function guestCreatedHandler(deps: Deps, e: { uid: string }): Promise<void> {
  const user = await deps.auth.getUser(e.uid).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  });
  if (!user) return; // Auth user gone (e.g. raced with account deletion) — nothing to claim
  const claims = (user.customClaims ?? {}) as { roles?: string[]; operatorId?: string; claimsVersion?: number };
  const roles = claims.roles ?? [];
  const richer = !!claims.operatorId || roles.some((r) => r !== 'guest');
  if (richer) return; // never overwrite a staff identity's claims from a guest doc write
  if (roles.includes('guest')) return; // already has it — no-op, don't bump claimsVersion for nothing
  await deps.auth.setCustomUserClaims(e.uid, { roles: ['guest'], claimsVersion: 1 });
}

export const onGuestCreated = onDocumentCreated({ document: 'guests/{uid}', retry: true }, async (event) => {
  await guestCreatedHandler(makeDeps(), { uid: event.params.uid });
});
