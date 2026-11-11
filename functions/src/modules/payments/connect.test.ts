import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectOnboardingLinkHandler } from './connect.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from './registry.js';
import { StripeGateway } from './stripe.adapter.js';

type OperatorPaymentsView = { modules?: { payments?: { connectedAccountId?: string } } };
type UserPayoutsView = { stripeConnectAccountId?: string; payoutStatus?: string };

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

describe('connectOnboardingLinkHandler', () => {
  it('operator branch: non-owner is denied', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      connectOnboardingLinkHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { kind: 'operator' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('operator branch: write-once connectedAccountId — second call reuses it and creates no second Stripe account', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOnboardingLinkHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { kind: 'operator' });
    const first = ((await deps.db.doc(P.operator(OP)).get()).data() as OperatorPaymentsView | undefined)?.modules?.payments?.connectedAccountId;
    expect(first).toBe('acct_new');
    await connectOnboardingLinkHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { kind: 'operator' });
    const second = ((await deps.db.doc(P.operator(OP)).get()).data() as OperatorPaymentsView | undefined)?.modules?.payments?.connectedAccountId;
    expect(second).toBe('acct_new');
    expect(fake.calls.accountsCreate).toHaveLength(1);
  });

  it('worker branch: payouts feature gate', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ 'features.payouts': false });
    await expect(
      connectOnboardingLinkHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { kind: 'worker' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('worker branch: stores stripeConnectAccountId and payoutStatus on the user doc', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'att1')).set({ roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await connectOnboardingLinkHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { kind: 'worker' });
    const u = (await deps.db.doc(P.user(OP, 'att1')).get()).data() as UserPayoutsView | undefined;
    expect(u).toMatchObject({ stripeConnectAccountId: 'acct_new', payoutStatus: 'onboarding' });
  });

  it('worker branch: return/refresh URLs are HTTPS dashboard pages, never a custom app scheme (Plan 8 Task 4 — Stripe live mode rejects non-HTTPS)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'att1')).set({ roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await connectOnboardingLinkHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { kind: 'worker' });
    expect(fake.calls.accountLinks).toHaveLength(1);
    const params = fake.calls.accountLinks[0]!.params;
    expect(params.return_url).toBe('https://app.goldstar.example.com/payouts/return?done=1');
    expect(params.refresh_url).toBe('https://app.goldstar.example.com/payouts/return?refresh=1');
  });

  it('worker branch: no user profile doc yet → failed_precondition, not a raw error (Ruling V)', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      connectOnboardingLinkHandler(deps, { uid: 'att-no-profile', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { kind: 'worker' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });
});
