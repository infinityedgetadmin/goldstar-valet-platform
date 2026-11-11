import type { CallableParsedInput, CallableOutput, Invitation } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

/**
 * `identityRevokeInvitation` (task-6-brief.md; contract already shipped in installed v0.3.5 —
 * `identityRevokeInvitation: { input: { inviteId }, output: { ok: true } }` — only the Functions
 * handler was missing). Ruling C-2 (task-6-brief.md controller ruling): revoke is an ACT, not an
 * inspect — `requireActiveOperator` runs UNCONDITIONALLY, with no `platform_admin` exemption (unlike
 * `generateKeyTags.ts`/`setSecret.ts`, which exempt an assumed platform_admin because those callables
 * are read/config-adjacent, not a staff-facing state change).
 *
 * `invitationSchema` has no `revokedAt`/status field (verified against `@goldstar/platform`'s
 * schema directly — contracts are consumed by tag, not edited here for this task). Revocation is
 * modeled as forcing expiry, which `acceptHandler`'s existing `expiresAt < deps.now()` check already
 * treats as "failed_precondition: invitation expired" — no new state machine, no schema change, and a
 * revoked invite reads identically to a naturally expired one to every existing consumer.
 *
 * The sentinel is a fixed past date (epoch), NOT `deps.now()`: `expiresAt < deps.now()` is a strict
 * inequality, so stamping "right now" only reads as expired once the wall clock has strictly
 * ADVANCED past that instant — true in production (any subsequent request is later in real time) but
 * not guaranteed for a revoke immediately followed by an accept under a fixed test clock (`testDeps`'s
 * `now()` returns the same constant every call). An unambiguous past sentinel is correct under either
 * clock and races nothing.
 */
const REVOKED_SENTINEL = '1970-01-01T00:00:00.000Z';
export async function revokeInvitationHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'identityRevokeInvitation'>): Promise<CallableOutput<'identityRevokeInvitation'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => r === 'owner' || r === 'admin' || r === 'platform_admin')) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId); // Ruling C-2: revoke is an ACT — no platform_admin exemption

  const ref = deps.db.doc(P.invitation(input.inviteId));
  const snap = await ref.get();
  if (!snap.exists) throw err('not_found', 'invitation');
  const inv = snap.data() as Invitation;
  // Cross-tenant guard: invitations is a top-level (not operator-scoped-by-path) collection, so the
  // doc's own operatorId must be checked explicitly — not_found (not permission_denied) so this
  // never confirms/denies an invite's existence under a DIFFERENT operator to the caller.
  if (inv.operatorId !== c.operatorId) throw err('not_found', 'invitation');
  if (inv.acceptedAt) throw err('already_exists', 'invitation used');

  await ref.update({ expiresAt: REVOKED_SENTINEL });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'identity.revokeInvitation', target: input.inviteId, after: { email: inv.email } });
  return { ok: true };
}

export const identityRevokeInvitation = defineCallable('identityRevokeInvitation', {}, async (deps, caller, input) => revokeInvitationHandler(deps, caller, input));
