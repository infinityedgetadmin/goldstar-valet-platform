import { createHash, randomBytes } from 'node:crypto';
import { type CallableParsedInput, type CallableOutput, type Role } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function inviteHandler(deps: Deps, caller: Caller, input: CallableParsedInput<'identityInvite'>): Promise<CallableOutput<'identityInvite'> & { token: string }> {
  const c = requireOperator(caller);
  // final-review.md F3 / Ruling G-4a: inviting is at least as much an ACT as revoke.ts's
  // requireActiveOperator call (that file's own comment: "revoke is an ACT — no platform_admin
  // exemption") — a suspended operator's owner/admin must not be able to mint invitation tokens or
  // queue invitation emails. platform_admin IS exempted here (unlike revoke.ts) because
  // createOperator.ts's synthetic caller (`roles: ['platform_admin']`, pinned to the just-created
  // operator) invites the new operator's owner while that operator is still 'onboarding', not
  // 'active' — requireActiveOperator would incorrectly block onboarding, not just suspended, since it
  // only special-cases 'suspended' explicitly and 'onboarding' would otherwise pass anyway; the
  // exemption here is about not gating the ONBOARDING callpath on this check at all, matching how a
  // real platform_admin invite (e.g. re-inviting an owner via assumeOperator) is a platform-level act,
  // not a suspended-operator's own staff action.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);
  const roles = input.roles as Role[];
  const isOwner = c.roles.includes('owner') || c.roles.includes('platform_admin');
  if (!(isOwner || c.roles.includes('admin'))) throw err('permission_denied');
  if (roles.includes('owner') && !isOwner) throw err('permission_denied', 'only owners invite owners');
  if (roles.includes('platform_admin')) throw err('permission_denied');
  const token = randomBytes(24).toString('base64url');
  const inviteId = deps.newId();
  const expiresAt = new Date(Date.parse(deps.now()) + 7 * 86_400_000).toISOString();
  await deps.db.doc(P.invitation(inviteId)).set({
    id: inviteId,
    email: input.email.toLowerCase(),
    operatorId: c.operatorId,
    roles,
    venueIds: input.venueIds,
    displayName: input.displayName ?? null,
    tokenHash: hashToken(token),
    expiresAt,
    acceptedAt: null,
    invitedBy: c.uid,
    createdAt: deps.now(),
  });
  const outboundId = deps.newId();
  await deps.db.doc(P.outbound(outboundId)).set({
    id: outboundId,
    channel: 'email',
    operatorId: c.operatorId,
    template: 'invitation',
    to: input.email.toLowerCase(),
    // `inviteeName` — NOT `displayName` — matches invitationEmailVarsSchema's actual field
    // (templates/email/invitation.ts). renderEmail's zod schemas silently strip unrecognized keys
    // (no `.strict()`/`.passthrough()` anywhere), so a key named anything else here would vanish at
    // parse time with no error, and the invitation email would keep falling back to a generic
    // greeting — the exact gap this is fixing (Task 1 review, Finding M1).
    vars: { token, operatorId: c.operatorId, ...(input.displayName !== undefined ? { inviteeName: input.displayName } : {}) },
    status: 'queued',
    attempts: 0,
    createdAt: deps.now(),
  });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'identity.invite', target: inviteId, after: { email: input.email, roles } });
  return { inviteId, token };
}

export const identityInvite = defineCallable('identityInvite', {}, async (deps, caller, input) => {
  const { inviteId } = await inviteHandler(deps, caller!, input);
  return { inviteId };
});
