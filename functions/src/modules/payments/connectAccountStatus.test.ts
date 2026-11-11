import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectAccountStatusHandler } from './connectAccountStatus.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from './registry.js';
import { StripeGateway } from './stripe.adapter.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

async function connectOperator(deps: ReturnType<typeof testDeps>, accountId = 'acct_connected') {
  await deps.db.doc(P.operator(OP)).update({ 'modules.payments.connectedAccountId': accountId });
}

describe('connectAccountStatusHandler: role gate', () => {
  it('denies attendant, driver, and venue_user', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    for (const role of ['attendant', 'driver', 'venue_user'] as const) {
      await expect(
        connectAccountStatusHandler(deps, { uid: 'u1', operatorId: OP, roles: [role], venueIds: [] }, {}),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('allows owner, admin, and lead', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    for (const role of ['owner', 'admin', 'lead'] as const) {
      await expect(connectAccountStatusHandler(deps, { uid: 'u1', operatorId: OP, roles: [role], venueIds: [] }, {})).resolves.toMatchObject({
        chargesEnabled: true,
      });
    }
  });

  it('rejects owner/admin/lead with failed_precondition when the operator is suspended', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    for (const role of ['owner', 'admin', 'lead'] as const) {
      await expect(
        connectAccountStatusHandler(deps, { uid: 'u1', operatorId: OP, roles: [role], venueIds: [] }, {}),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
    }
  });

  it('platform_admin (assumeOperator session) can still inspect a suspended operator (auditQuery parity)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await connectAccountStatusHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] }, {});
    expect(out.chargesEnabled).toBe(true);
    expect(fake.calls.accountsRetrieve).toEqual(['acct_connected']);
  });
});

describe('connectAccountStatusHandler: account resolution', () => {
  it('defaults to the operator\'s own connectedAccountId when input.accountId is omitted', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOperator(deps, 'acct_op_own');
    await connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {});
    expect(fake.calls.accountsRetrieve).toEqual(['acct_op_own']);
  });

  it('accepts an explicit accountId that matches the operator\'s own', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOperator(deps, 'acct_op_own');
    await connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { accountId: 'acct_op_own' });
    expect(fake.calls.accountsRetrieve).toEqual(['acct_op_own']);
  });

  it('rejects an explicit accountId that does not match the operator\'s own — closes the cross-tenant status-oracle gap', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await connectOperator(deps, 'acct_op_own');
    await expect(
      connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { accountId: 'acct_someone_elses' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('no connected account configured — honest failed_precondition, not a raw Stripe error', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps); // never connected — modules.payments.connectedAccountId unset
    await expect(connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {})).rejects.toMatchObject({
      code: 'failed_precondition',
    });
  });
});

describe('connectAccountStatusHandler: output mapping', () => {
  it('maps requirements.currently_due through verbatim', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    fake.nextAccountStatus = { charges_enabled: false, payouts_enabled: false, requirements: { currently_due: ['individual.verification.document'] } };
    const out = await connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {});
    expect(out).toEqual({ chargesEnabled: false, payoutsEnabled: false, requirementsDue: ['individual.verification.document'] });
  });

  it('a null/absent requirements.currently_due maps to an empty array, never undefined', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await connectOperator(deps);
    fake.nextAccountStatus = { charges_enabled: true, payouts_enabled: true };
    const out = await connectAccountStatusHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {});
    expect(out.requirementsDue).toEqual([]);
  });
});
