import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { syncClaimsHandler } from '../identity/claims.handler.js';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

type OperatorStatus = 'onboarding' | 'active' | 'suspended';

/**
 * Operator lifecycle transition matrix. Not specified by the design doc or contracts (`operatorSchema.status`
 * is just a 3-value enum, no state machine) — this is a Functions-layer design decision, disclosed in
 * task-3-report.md: `onboarding` is a one-way departure point (an operator that has left it never goes back —
 * platform admins reject/delete a bad signup rather than "un-onboard" it), `active`/`suspended` toggle freely,
 * and same-status transitions are rejected (idempotent no-ops here would silently mask a UI bug that re-sends
 * the same status rather than reading the operator's current one).
 *
 * IMPORTANT — what flipping `operators/{op}.status` to 'suspended' here actually does downstream (updated
 * after the final-branch-review fix wave; this file itself was last touched BEFORE any of this landed, so
 * don't trust an older revision of this comment). Four enforcement surfaces, all keyed off this one field:
 *  - firestore.rules' `inOperator()` (Ruling C, firestore.rules:48-51) denies every staff-side Firestore
 *    read/write for the operator the instant `status == 'suspended'` — the single choke point every
 *    operator-scoped rule in that file composes through.
 *  - storage.rules mirrors the same gate via its own `operatorActive(op)` helper (Ruling F-4a /
 *    final-review F2), applied to every branch with read-budget headroom: ticket-photo and incident
 *    reads/writes (manager + direct-venueIds branches), branding writes, avatar reads/writes, credentials
 *    reads/writes, claims reads, exports reads. One documented, deliberate gap: `inVenueOfTicket()`'s /
 *    `inVenueOfIncident()`'s >=20-venueIds fallback branch is NOT gated — it already spends the full
 *    2-unique-document Storage Rules cap (ticket/incident doc + user doc) getting there, so a third
 *    (operator) read would hard-deny active and suspended operators alike. See storage.rules' own comment
 *    on those two functions for the exact reasoning and the (narrow) window this leaves open.
 *  - `requireActiveOperator` (lib/callable.ts) is the Admin-SDK-side half — rules don't apply to
 *    callables. Called explicitly (no shared choke point on this side) from every staff-scoped callable
 *    that changes state or moves money: staffCancel, staffCreateCheckout, staffRefund, terminal, connect,
 *    revoke (identityRevokeInvitation), schedulingSync, setSecret, generateKeyTags, auditQuery, and — as
 *    of Ruling G-4a (final-review F3) — identityInvite and identityAcceptInvitation (invite.ts gates on
 *    the CALLER's operator, exempting only a platform_admin caller so createOperator.ts's synthetic
 *    owner-invite for a brand-new 'onboarding' operator keeps working; accept.ts gates on the INVITE's
 *    resolved operatorId, with no exemption, since an invitee has no onboarding callpath to protect).
 *  - identity/claims.handler.ts's `syncClaimsHandler` reads the individual `operators/{op}/users/{uid}`
 *    doc's own `status` for ROLES (a suspended operator's staff keep their roles — deliberate, not a
 *    gap: the rules/callable gates above are what actually deny them; claims staying populated is what
 *    lets an owner see who's affected and reactivate without every session needing a fresh sign-in),
 *    and — Plan 8 Task 10 (#8) — the PARENT operator doc's status for one claims bit,
 *    `operatorSuspended`, which storage.rules' >=20-venueIds fallback reads at zero document cost.
 *    This handler fans that sync out to every user of the operator on a suspend or reactivate (below);
 *    the claimsVersion bump makes live clients refresh at once, closing the fallback gap for them.
 * Deliberately NOT gated (ledgered, not overlooked): guest-facing callables and the `guestTickets` /
 * `venuePublic` public-projection reads — a suspended operator's already-checked-in guests can still see
 * their own ticket/pay page; the carve-out is scoped to guest surfaces only, never staff.
 */
const VALID_TRANSITIONS: Record<OperatorStatus, OperatorStatus[]> = {
  onboarding: ['active', 'suspended'],
  active: ['suspended'],
  suspended: ['active'],
};

export async function setOperatorStatusHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'platformSetOperatorStatus'>,
): Promise<CallableOutput<'platformSetOperatorStatus'>> {
  const c = requireRole(caller, ['platform_admin']);
  const ref = deps.db.doc(P.operator(input.operatorId));
  // F8a (task-3's T3-final-wave-parked item, picked up in this fix wave): transaction-wrapped —  the
  // previous plain get()-then-update() had a TOCTOU window where two concurrent transition requests
  // could both read the same pre-transition status, both independently pass VALID_TRANSITIONS, and
  // both commit + double-audit (the ledger's "double-audit" concern: two audit trail entries for a
  // single logical hop, e.g. two racing 'active'->'suspended' calls each individually legal in
  // isolation). Firestore serializes concurrent transactions touching the same doc — the loser
  // re-reads the (by-then already-transitioned) status inside the callback and throws
  // failed_precondition, identical in code/shape to a legitimately invalid transition.
  const before = await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw err('not_found', 'operator');
    const cur = snap.data() as { status: OperatorStatus };
    if (!VALID_TRANSITIONS[cur.status].includes(input.status)) {
      throw err('failed_precondition', `cannot transition operator from ${cur.status} to ${input.status}`);
    }
    tx.update(ref, { status: input.status, updatedAt: deps.now() });
    return cur;
  });

  // Dual-scope audit — see createOperator.ts's identical comment for why this is two audit() calls,
  // not one: no single-call dual-scope precedent exists in lib/audit.ts.
  const beforeStatus = { status: before.status };
  const afterStatus = { status: input.status };
  await audit(deps, { actorUid: c.uid, action: 'platform.setOperatorStatus', target: input.operatorId, before: beforeStatus, after: afterStatus });
  await audit(deps, { operatorId: input.operatorId, actorUid: c.uid, action: 'platform.setOperatorStatus', target: input.operatorId, before: beforeStatus, after: afterStatus });

  // Plan 8 Task 10 (#8): re-sync every user's claims whenever suspension is entered OR left, so the
  // `operatorSuspended` bit appears and disappears with the status. Sequential on purpose: a user
  // whose auth record is gone is skipped inside syncClaimsHandler, and one failure must not strand
  // the rest of the roster half-flagged — the loop continues and the error is rethrown at the end.
  if (before.status === 'suspended' || input.status === 'suspended') {
    const users = await deps.db.collection(`operators/${input.operatorId}/users`).get();
    let firstError: Error | undefined;
    for (const u of users.docs) {
      try {
        await syncClaimsHandler(deps, { operatorId: input.operatorId, uid: u.id });
      } catch (e) {
        firstError ??= e instanceof Error ? e : new Error(String(e));
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  return { ok: true };
}

export const platformSetOperatorStatus = defineCallable('platformSetOperatorStatus', {}, setOperatorStatusHandler);
