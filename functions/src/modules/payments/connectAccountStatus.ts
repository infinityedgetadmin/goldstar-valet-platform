import type { CallableParsedInput, CallableOutput, Operator } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { getGateway } from './registry.js';

/**
 * Task 6 (task-6-brief.md): read-only Stripe Connect status for the OPERATOR's own account —
 * `chargesEnabled`/`payoutsEnabled`/`requirementsDue`, consumed by `payments-settings.tsx`,
 * `first-run-checklist.tsx` (both landed in Plan 4a already calling this exact callable, wrapped in
 * a graceful `.catch()` for the "not implemented yet" gap this fills — task-6-brief.md's carry) and
 * this task's new `connect-status-card.tsx`.
 *
 * ## Role gate: mirrors `ticketsSearch`'s manager gate, not `connectOnboardingLink`'s per-kind split
 *
 * Every real call site is a manager-only surface: Settings (`nav.ts` — owner-only), Home's
 * first-run checklist (rendered inside the `(operator)` shell, which `layout.tsx`'s `OperatorGate`
 * already restricts to owner/admin/lead/platform_admin — verified directly, not assumed from the
 * nav config alone), and this task's Payments page (`nav.ts` — `MANAGER_ROLES`). Unlike
 * `connectOnboardingLink`'s `kind: 'worker'` branch (deliberately open to ANY staff so a driver can
 * onboard their OWN payout account), nothing here needs a non-manager caller — so this stays
 * `isManager()`-gated like `ticketsSearch`/`paymentsSearch`, not opened to every staff role.
 *
 * ## `accountId` input: narrowed to "this operator's own account only" — a deliberate, disclosed gap
 *
 * The installed contract's `input.accountId` is an arbitrary optional string with no structural tie
 * back to the caller's operator. Blindly passing a caller-supplied `accountId` straight to
 * `stripe.accounts.retrieve` would make this callable a cross-tenant Stripe-account status oracle —
 * any authenticated manager of ANY operator could probe `chargesEnabled`/`payoutsEnabled`/
 * `requirementsDue` for an arbitrary Stripe Connect account id, including one belonging to a
 * DIFFERENT operator entirely (Stripe's platform-level API key can read any connected account's
 * top-level status regardless of which operator "owns" it in this app's own data model). Every
 * actual consumer (`payments-settings.tsx`, `first-run-checklist.tsx`, this task's new card) always
 * calls with `{}` — no consumer needs to inspect a WORKER's own payout account
 * (`user.stripeConnectAccountId`) here; that's Plan 8/payouts territory, not this task's scope. So:
 * `accountId` omitted -> defaults to the operator's own `modules.payments.connectedAccountId`;
 * `accountId` explicitly provided -> must equal that same value or the call is `permission_denied`.
 * Disclosed in task-6-report.md as a narrower reading of the contract than its type alone implies.
 */
export async function connectAccountStatusHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'connectAccountStatus'>): Promise<CallableOutput<'connectAccountStatus'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'lead'].includes(r)) && !c.roles.includes('platform_admin')) throw err('permission_denied');
  const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator;
  // Ruling (auditQuery parity, task-6-brief.md): read-only inspection — a platform_admin assuming a
  // suspended operator to check its Connect status (e.g. before deciding whether to reactivate it)
  // is the same "inspect, don't move money" case Ruling C-2 carved out for auditQuery. Extended here
  // by this task's own judgment call (the brief only stated it for paymentsSearch) — flagged for
  // controller review in task-6-report.md.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId, op);

  const ownAccountId = op.modules.payments.connectedAccountId;
  if (input.accountId !== undefined && input.accountId !== ownAccountId) throw err('permission_denied');
  const accountId = input.accountId ?? ownAccountId;
  if (!accountId) throw err('failed_precondition', 'no connected account');

  const gw = getGateway(deps, op);
  return gw.getAccountStatus({ accountId });
}

export const connectAccountStatus = defineCallable('connectAccountStatus', { secrets: ['STRIPE_SECRET_KEY'] }, connectAccountStatusHandler);
