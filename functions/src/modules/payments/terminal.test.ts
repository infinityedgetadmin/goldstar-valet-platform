import { beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalConnectionTokenHandler } from './terminal.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from './registry.js';
import { StripeGateway } from './stripe.adapter.js';

type VenueLocationView = { stripeLocationId?: string };

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

describe('terminalConnectionTokenHandler', () => {
  it('venue scope denial: non-owner/admin staff without the venue in their claims is denied', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      terminalConnectionTokenHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v2'] }, { venueId: V1 }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('tapToPay feature gate (default disabled)', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      terminalConnectionTokenHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { venueId: V1 }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('write-once stripeLocationId: second call reuses it and creates no second Stripe location; returns the connection secret', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ 'features.tapToPay': true });
    const out = await terminalConnectionTokenHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { venueId: V1 });
    expect(out).toMatchObject({ secret: 'pst_secret', locationId: 'tml_new' });
    const first = ((await deps.db.doc(P.venue(OP, V1)).get()).data() as VenueLocationView | undefined)?.stripeLocationId;
    expect(first).toBe('tml_new');
    const out2 = await terminalConnectionTokenHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { venueId: V1 });
    expect(out2.locationId).toBe('tml_new');
    expect(fake.calls.locationsCreate).toHaveLength(1);
  });

  // Ruling C-2: "reuse" pattern — terminalConnectionTokenHandler already fetches `op` (for the
  // tapToPay feature gate just below) before this callable does anything else, so requireActiveOperator
  // is called with that op passed through — zero extra reads.
  it('rejects with failed_precondition when the operator is suspended (Ruling C-2)', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ 'features.tapToPay': true, status: 'suspended' });
    await expect(
      terminalConnectionTokenHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { venueId: V1 }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  // Ruling AP (1d final review, finding 9): under this plan's destination-charge model, Terminal
  // location + connection token must BOTH live on the platform account — connectionTokens.create never
  // forwards stripeAccount, so a location created on the connected account was invisible to the token.
  it('a connected operator still creates the Terminal location on the PLATFORM account (no stripeAccount forwarded) (Ruling AP)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ 'features.tapToPay': true, 'modules.payments.connectedAccountId': 'acct_conn' });
    await terminalConnectionTokenHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { venueId: V1 });
    expect(fake.calls.locationsCreate).toHaveLength(1);
    expect(fake.calls.locationsCreate[0]!.options).not.toHaveProperty('stripeAccount');
  });
});
