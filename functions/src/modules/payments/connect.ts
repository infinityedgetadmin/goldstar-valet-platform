import type { CallableParsedInput, CallableOutput, Operator } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { getGateway } from './registry.js';

export async function connectOnboardingLinkHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'connectOnboardingLink'>): Promise<CallableOutput<'connectOnboardingLink'>> {
  const c = requireOperator(caller);
  const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator;
  await requireActiveOperator(deps, c.operatorId, op); // Ruling C-2 — zero extra read, op already fetched above
  const gw = getGateway(deps, op);
  const host = process.env.DASHBOARD_HOST ?? 'app.goldstar.example.com';
  if (input.kind === 'operator') {
    if (!c.roles.includes('owner')) throw err('permission_denied');
    const { url, accountId } = await gw.connectOnboardingLink({
      operatorId: c.operatorId,
      kind: 'operator',
      ...(op.modules.payments.connectedAccountId !== undefined ? { accountId: op.modules.payments.connectedAccountId } : {}),
      refreshUrl: `https://${host}/settings/payments?refresh=1`,
      returnUrl: `https://${host}/settings/payments?done=1`,
    });
    // TODO: read-then-write race — two concurrent onboarding-link requests for the same operator can
    // both read connectedAccountId as unset, each create a distinct Stripe account, and the second
    // write here wins, orphaning the first. Not wrapped in a Firestore transaction; low-frequency
    // path (operator onboarding, not a hot path) so left as a known gap rather than fixed this round.
    if (!op.modules.payments.connectedAccountId) await deps.db.doc(P.operator(c.operatorId)).update({ 'modules.payments.connectedAccountId': accountId });
    await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'payments.connectOnboarding', target: accountId });
    return { url };
  }
  if (!op.features.payouts) throw err('failed_precondition', 'payouts disabled');
  const uSnap = await deps.db.doc(P.user(c.operatorId, c.uid)).get();
  if (!uSnap.exists) throw err('failed_precondition', 'user profile missing');
  const u = uSnap.data() as { stripeConnectAccountId?: string; email?: string };
  const { url, accountId } = await gw.connectOnboardingLink({
    operatorId: c.operatorId,
    kind: 'worker',
    ...(u.stripeConnectAccountId !== undefined ? { accountId: u.stripeConnectAccountId } : {}),
    ...(u.email !== undefined ? { email: u.email } : {}),
    // Plan 8 Task 4: Stripe Account Links require HTTPS return/refresh URLs in live mode (verified
    // against docs.stripe.com/connect/saas/tasks/onboard — "HTTP is supported in testing
    // environments, but live mode requires HTTPS"), so the previous custom-scheme
    // `goldstarvalet://payouts` targets would have been REJECTED at link creation in production
    // (and, even if accepted, named the GUEST app's scheme, not the staff app's). Both now land on
    // the dashboard's public `/payouts/return` page, which tells the worker to close the in-app
    // browser sheet; the app's live user-doc subscription picks up `payoutStatus` as the
    // `account.updated` webhook flips it (applyEvent.ts), so no deep link back is needed.
    refreshUrl: `https://${host}/payouts/return?refresh=1`,
    returnUrl: `https://${host}/payouts/return?done=1`,
  });
  if (!u.stripeConnectAccountId) await deps.db.doc(P.user(c.operatorId, c.uid)).update({ stripeConnectAccountId: accountId, payoutStatus: 'onboarding' });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'payouts.onboarding', target: accountId });
  return { url };
}

export const connectOnboardingLink = defineCallable('connectOnboardingLink', { secrets: ['STRIPE_SECRET_KEY'] }, connectOnboardingLinkHandler);
