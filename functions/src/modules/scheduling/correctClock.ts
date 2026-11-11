import type { CallableOutput, CallableParsedInput, Shift } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

/**
 * `shiftsCorrectClock` — already declared in the installed `@goldstar/platform` v0.3.5 contract
 * (`callables.ts`: `{ shiftId, uid, type, at, note }` -> `{ eventId }`); this is its Functions
 * implementation, needed because `firestore.rules`' `shifts/{shiftId}/clockEvents/{eventId}` only
 * allows a SELF create (`request.resource.data.uid == request.auth.uid`) and forbids update/delete
 * outright — a lead/admin correcting someone ELSE's punch has no rules-level path at all and must go
 * through the Admin SDK.
 *
 * ## `note`/who-corrected-it: audit log, not a new `clockEvents` field — disclosed schema reconciliation
 *
 * `clockEventSchema` (contracts v0.3.5, unchanged by this task) is `{ id, uid, type, at, geo?,
 * deviceId, pushedToProviderAt? }` — no `note` or `actorUid` field. The controller ruling for this
 * task says the written event should have "actorUid=caller uid=target note='correction', audited";
 * read literally that could mean adding two new fields to the clockEvent doc itself, but the SAME
 * ruling also says contracts is unchanged from v0.3.5 ("the brief's 'add to contracts' is stale") —
 * and this codebase's the package versioning policy bumps the package version for ANY change to
 * `src/`, which nothing else about this task calls for. Reconciled as: the clockEvent doc itself
 * stays exactly `clockEventSchema`-shaped (`uid` = the CORRECTED person, i.e. `input.uid` — matching
 * every other event in the same subcollection, so `myShifts`/clock-audit-panel timelines read it
 * identically to a self-punched event); "actorUid" and "note" are recorded on the AUDIT LOG entry
 * instead, which already HAS an `actorUid` field built for exactly "who performed this action" and an
 * `after` payload free-form enough to carry `note`. `audit()`'s own write is what satisfies
 * "audited" here. If a future task wants "corrected by X, because Y" visible on the clock event doc
 * ITSELF (not just in the audit log), that's a real contracts schema change or a stated separate
 * follow-up — not something this task can do silently.
 */
export async function correctClockHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'shiftsCorrectClock'>): Promise<CallableOutput<'shiftsCorrectClock'>> {
  const c = requireOperator(caller);
  // lead/admin (Ruling: "shiftsCorrectClock callable: lead/admin") — isManager()'s rules-side
  // definition is owner/admin/lead; platform_admin (assumed or not) is always allowed too, same
  // ceiling every other operator-scoped callable in this file uses.
  if (!c.roles.some((r) => r === 'owner' || r === 'admin' || r === 'lead' || r === 'platform_admin')) throw err('permission_denied');
  // M3 (final whole-branch review): `requireActiveOperator` runs UNCONDITIONALLY — no platform_admin
  // exemption. This callable WRITES a clock event (an *act*, not an *inspect*) that feeds tip-pool
  // allocation and labor cost directly — money-adjacent, same class as `ticketsRevealPhone` /
  // `claimsGenerateBundle` (both unconditional, per their own header comments), not the read-only
  // `auditQuery`-style inspect callables (`analyticsSummary`, `ticketsSearch`, `paymentsSearch`,
  // `connectAccountStatus`, `integrationsHealthCheck`) that keep the exemption. A suspended
  // operator's clock state must not be mutable by anyone, platform_admin included.
  await requireActiveOperator(deps, c.operatorId);

  const shiftRef = deps.db.doc(P.shift(c.operatorId, input.shiftId));
  const shiftSnap = await shiftRef.get();
  if (!shiftSnap.exists) throw err('not_found', 'shift');

  // m4 (final whole-branch review): a manager-only, unaudited-until-after-the-fact callable that
  // feeds tip-pool allocation and labor cost directly — a typo'd `uid`/`at` would silently distort
  // both. Two cheap server-side sanity bounds, not full validation of the correction's truthfulness
  // (which no server-side check can verify):
  // - `at` must fall within 24h either side of the shift window — generous enough to cover a
  //   genuine forgot-to-clock-out/in that spans the boundary, tight enough to catch an obviously
  //   wrong date (wrong day/month/year).
  // - `uid` must be one of the shift's OWN assignees — this callable corrects an existing assignee's
  //   punch; it is not a backdoor to add a new person to the shift's clock history.
  const shift = shiftSnap.data() as Shift;
  if (!shift.assignedUids.includes(input.uid)) throw err('invalid_argument', 'uid is not assigned to this shift');
  const atMs = Date.parse(input.at);
  const lowerBoundMs = Date.parse(shift.startsAt) - 24 * 3_600_000;
  const upperBoundMs = Date.parse(shift.endsAt) + 24 * 3_600_000;
  if (atMs < lowerBoundMs || atMs > upperBoundMs) throw err('invalid_argument', 'at is outside the shift window');

  const eventId = deps.newId();
  const event = { id: eventId, uid: input.uid, type: input.type, at: input.at, deviceId: 'dashboard-correction' };
  await deps.db.doc(P.clockEvent(c.operatorId, input.shiftId, eventId)).set(event);

  await audit(deps, {
    operatorId: c.operatorId,
    actorUid: c.uid,
    action: 'shifts.correctClock',
    target: input.shiftId,
    after: { eventId, uid: input.uid, type: input.type, at: input.at, note: input.note },
  });

  return { eventId };
}

export const shiftsCorrectClock = defineCallable('shiftsCorrectClock', {}, correctClockHandler);
