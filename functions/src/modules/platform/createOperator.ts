import { platformConfigSchema, type CallableParsedInput, type CallableOutput } from '@goldstar/platform';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { inviteHandler } from '../identity/invite.js';

export async function createOperatorHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'platformCreateOperator'>,
): Promise<CallableOutput<'platformCreateOperator'>> {
  const c = requireRole(caller, ['platform_admin']);
  const { ownerEmail, ownerName, ...operatorFields } = input;

  // The operator doc id doubles as its human-facing slug everywhere else in this codebase
  // (test/helpers.ts's seedOperator, firestore.rules' `request.resource.data.id == op` create
  // guard, the Storage branding path `operators/{op}/branding/{file}`) — enforced here defensively
  // rather than relaxed, since nothing downstream (routing, claims, Storage paths) resolves an
  // operator by any key other than this one. Not required by the contract itself (`id` and `slug`
  // are independent fields on `operatorSchema`), so this is a Functions-layer invariant, not a
  // contract rule — disclosed in task-3-report.md.
  if (operatorFields.id !== operatorFields.slug) throw err('invalid_argument', 'operator id must equal slug');

  const opRef = deps.db.doc(P.operator(operatorFields.id));
  // .create() (not get-then-set) for atomic duplicate-slug rejection under concurrent requests —
  // same ALREADY_EXISTS (code 6) convention as ticket.handler.ts's enqueueSms/enqueuePush, except
  // here the collision is a real error to surface (a duplicate operator), not a redelivery to
  // swallow as a no-op.
  await opRef
    .create({
      ...operatorFields,
      status: 'onboarding',
      createdAt: deps.now(),
      updatedAt: deps.now(),
      createdBy: c.uid,
    })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code === 6) throw err('already_exists', 'operator');
      throw e;
    });

  // Platform-wide defaults doc — created once, on first operator, with the schema's own documented
  // defaults (platformConfigSchema.parse({})). Same .create()-dedupe convention: a second operator's
  // creation racing this one just hits ALREADY_EXISTS and is swallowed, leaving the first writer's
  // doc (and any admin edits made to it since) untouched.
  await deps.db
    .doc('platform/config')
    .create(platformConfigSchema.parse({}))
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });

  // Explicit operatorId override: the real caller is a platform_admin with no operatorId claim of
  // their own (or, mid-`assumeOperator` session, a DIFFERENT operator's) — inviteHandler derives its
  // target operator from `requireOperator(caller).operatorId`, so a synthetic Caller pinned to the
  // just-created operator is threaded through instead of the real one. `invitedBy` still records the
  // real platform admin's uid (inviteHandler reads `c.uid`, which this override preserves).
  // `roles: ['platform_admin']` on the synthetic caller satisfies inviteHandler's `isOwner` check
  // (platform_admin bypasses the same as an owner) so it's allowed to invite an 'owner'.
  const { inviteId } = await inviteHandler(
    deps,
    { uid: c.uid, operatorId: operatorFields.id, roles: ['platform_admin'], venueIds: [] },
    { email: ownerEmail, roles: ['owner'], venueIds: [], displayName: ownerName },
  );

  // Dual-scope audit: no existing precedent writes one audit() call to two scopes at once — audit()
  // takes a single optional operatorId and writes exactly one doc (see lib/audit.ts). This follows
  // its single-scope pattern twice: once platform-scoped (operatorId omitted, lands under
  // platform/auditLog/entries) and once operator-scoped (lands under operators/{id}/auditLog), per
  // the task brief's dual-scope requirement. Disclosed in task-3-report.md.
  const auditAfter = { name: operatorFields.name, slug: operatorFields.slug, ownerEmail };
  await audit(deps, { actorUid: c.uid, action: 'platform.createOperator', target: operatorFields.id, after: auditAfter });
  await audit(deps, { operatorId: operatorFields.id, actorUid: c.uid, action: 'platform.createOperator', target: operatorFields.id, after: auditAfter });

  return { operatorId: operatorFields.id, inviteId };
}

export const platformCreateOperator = defineCallable('platformCreateOperator', {}, createOperatorHandler);
