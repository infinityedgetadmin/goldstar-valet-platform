import type { Role } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

export interface Claims {
  operatorId?: string;
  roles: Role[];
  venueIds?: string[];
  claimsVersion: number;
  /**
   * Plan 8 Task 10 (#8): present (and true) only while the PARENT operator is suspended. The
   * claims-readable flag storage.rules' >=20-venueIds fallback branch needs — that branch already
   * spends Storage Rules' full 2-document read budget (ticket + user doc) reaching the check, so the
   * operator's status has to arrive on the token, not from a third read. Distinct from user-level
   * suspension (H2), which empties `roles` instead. Omitted, never `false`, so unaffected tokens are
   * byte-identical to before.
   */
  operatorSuspended?: true;
}

export function buildClaims(u: { operatorId?: string; roles: Role[]; venueIds?: string[]; claimsVersion: number; operatorSuspended?: boolean }): Claims {
  const c: Claims = { roles: u.roles, claimsVersion: u.claimsVersion };
  if (u.operatorId) c.operatorId = u.operatorId;
  if (u.venueIds && u.venueIds.length > 0) c.venueIds = u.venueIds.slice(0, 20);
  if (u.operatorSuspended) c.operatorSuspended = true;
  return c;
}

/**
 * H2 (task-6-security-fix.md): two independent findings, both fixed here.
 *
 * (1) stale-token privilege lag — `setCustomUserClaims` only affects claims minted on a FUTURE
 * token refresh; a currently-live ID/refresh token pair keeps its OLD claims (stale privilege)
 * until that refresh happens (up to ~1h) otherwise. `revokeRefreshTokens` forces the CLIENT's next
 * token-refresh attempt (silent or explicit) to fail and require a real sign-in, closing the "keeps
 * money-callable access after being fired/demoted" window down to "until the current, already-
 * issued ID token's own natural expiry" — note this does NOT retroactively invalidate an ID token
 * that's already live and unexpired for THIS codebase's callables specifically: `onCall`'s
 * `request.auth` is populated by Firebase's own internal token verification, which never opts into
 * `checkRevoked` (confirmed via Context7 against firebase-admin's own "detect ID token revocation"
 * docs — that requires manually calling `verifyIdToken(idToken, true)` against the raw bearer
 * token, which `CallableRequest` doesn't expose without materially restructuring
 * `defineCallable`'s auth path for every callable — out of scope for this fix). Called on the two
 * cases that actually matter for money-callable access: suspension (roles just went to []) and any
 * role REDUCTION (the staffer lost a role they previously held) — not on every claims sync, since a
 * lateral/additive change (a promotion, a venueIds-only edit, first-invite-acceptance via accept.ts
 * which has no `priorRoles` to compare) doesn't need to interrupt an active session.
 *
 * (2) `claimsVersion` — KEPT, incrementing exactly as before. A first pass at this fix deleted it as
 * "written but never read" based on a grep scoped to THIS repo only; that was wrong and got caught
 * in review before commit. It IS read, by both consumers, as a proactive-refresh trigger — NOT as a
 * rules-enforcement mechanism: goldstar-transportation's session-provider.tsx watches this doc via
 * onSnapshot and calls `readClaims(u, true)` when `userDoc.claimsVersion > claims.claimsVersion`;
 * goldstar-mobile's use-session.ts does the same via `subscribeDoc` and `refreshClaims()`. Both
 * apps intersect `claimsVersion` onto their own local `User` type specifically for this (it isn't
 * part of the published `@goldstar/platform` schema, so this couldn't be caught by
 * check:consumers or a same-repo grep). Deleting the increment would have made H2 worse, not
 * better: the branch that proactively forces an early refresh would simply stop firing, silently
 * (nothing here would fail), leaving both apps to fall back on the SAME up-to-1h natural-expiry
 * window H2 exists to shrink — the exact regression this fix is supposed to prevent. `claimsVersion`
 * and `revokeRefreshTokens` are complements, not alternatives: the version bump makes an affected
 * client go get a fresh token proactively; revoke makes a stale token that's still being presented
 * (this client crashed, that one's offline, a script never subscribed) fail on its next refresh
 * attempt regardless. H2 wants both, and now has both.
 *
 * Wiring `claimsVersion` into firestore.rules enforcement (comparing `request.auth.token
 * .claimsVersion` against a fresh get() of this doc, in `inOperator()` — the one shared choke point
 * every staff-gated rule in this file already goes through) was genuinely attempted, not theorized
 * away: `tickets/{ticketId}`'s update rule sits right at the Firestore rules interpreter's
 * undocumented ~1000-expression-per-evaluation ceiling (see that rule's own comment in
 * firestore.rules), and this session independently proved — empirically, across four separate lean
 * formulations of an unrelated H1(b) addition to that SAME rule — that even a single cheap boolean
 * clause reliably tips it over. `inOperator()` is called MORE times per evaluation than the branch
 * H1(b) targeted, and this file's own prior history (the Ruling C comment on `inOperator()`) already
 * documents a get()-based addition to `inOperator()` specifically blowing this exact ceiling before.
 * So: `claimsVersion` stays exactly as it was, purely as the client-side propagation signal both
 * consumers already depend on — it is NOT, and per the above cannot cheaply be made, a
 * rules-enforced staleness guard. That gap is real; `revokeRefreshTokens` below is this fix's answer
 * to it.
 */
export async function syncClaimsHandler(deps: Deps, e: { operatorId: string; uid: string; priorRoles?: Role[] }): Promise<void> {
  const ref = deps.db.doc(P.user(e.operatorId, e.uid));
  const [snap, opSnap] = await Promise.all([ref.get(), deps.db.doc(P.operator(e.operatorId)).get()]);
  if (!snap.exists) return;
  const d = snap.data() as { roles: Role[]; venueIds?: string[]; status: string; claimsVersion?: number };
  const version = (d.claimsVersion ?? 0) + 1;
  const suspended = d.status === 'suspended';
  // Plan 8 Task 10 (#8): the parent operator's status rides along as a claims bit. This is the ONE
  // thing read off the operator doc here — roles stay populated exactly as before (the platform
  // setStatus.ts comment explains why: an owner can still see who is affected and reactivate without
  // every session re-signing in). Same `.get('status','active') != 'suspended'` idiom as the rules:
  // only an explicit 'suspended' sets the bit. setStatus.ts fans this sync out to every user of the
  // operator on a suspend/reactivate, and the claimsVersion bump below is what makes an online client
  // refresh proactively — so the bit lands within seconds for live sessions and at natural token
  // expiry for the rest, the same posture as H2.
  const operatorSuspended = (opSnap.data() as { status?: string } | undefined)?.status === 'suspended';
  const claims = suspended
    ? { roles: [], claimsVersion: version }
    : buildClaims({ operatorId: e.operatorId, roles: d.roles, claimsVersion: version, operatorSuspended, ...(d.venueIds ? { venueIds: d.venueIds } : {}) });
  try {
    await deps.auth.setCustomUserClaims(e.uid, claims);
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return;
    throw err;
  }
  await ref.update({ claimsVersion: version, claimsSyncedAt: deps.now() });

  const reduced = e.priorRoles !== undefined && e.priorRoles.some((r) => !d.roles.includes(r));
  if (suspended || reduced) {
    try {
      await deps.auth.revokeRefreshTokens(e.uid);
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') return;
      throw err;
    }
  }
}
