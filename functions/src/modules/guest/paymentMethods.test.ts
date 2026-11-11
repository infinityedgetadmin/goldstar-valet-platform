import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guestDetachPaymentMethodHandler, guestListPaymentMethodsHandler, guestSetupIntentHandler } from './paymentMethods.js';
import type { Caller } from '../../lib/callable.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from '../payments/registry.js';
import { StripeGateway } from '../payments/stripe.adapter.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getPlatformGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

const GUEST: Caller = { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' };

describe('guestListPaymentMethods', () => {
  it('no guest doc / no stripeCustomerId → empty list, no Stripe call', async () => {
    const deps = testDeps();
    const fake = useFake();
    const out = await guestListPaymentMethodsHandler(deps, GUEST, {});
    expect(out).toEqual({ methods: [] });
    expect(fake.calls.paymentMethodsList).toHaveLength(0);
  });

  it('lists the caller-own Stripe customer\'s saved cards', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextPaymentMethods = [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }];
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_1', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    const out = await guestListPaymentMethodsHandler(deps, GUEST, {});
    expect(out).toEqual({ methods: [{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }] });
    expect(fake.calls.paymentMethodsList[0]!.params).toMatchObject({ customer: 'cus_1', type: 'card' });
  });

  it('unauthenticated caller is rejected', async () => {
    const deps = testDeps();
    useFake();
    await expect(guestListPaymentMethodsHandler(deps, null, {})).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a caller without the guest role is rejected', async () => {
    const deps = testDeps();
    useFake();
    await expect(guestListPaymentMethodsHandler(deps, { uid: 'att1', operatorId: 'goldstar', roles: ['attendant'], venueIds: [] }, {})).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('Task 7: rate limits per uid (30/60s) — the 31st call in the window rejects with rate_limited', async () => {
    const deps = testDeps();
    useFake();
    for (let i = 0; i < 30; i++) await guestListPaymentMethodsHandler(deps, GUEST, {});
    await expect(guestListPaymentMethodsHandler(deps, GUEST, {})).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('guestDetachPaymentMethod', () => {
  it('retrieves and verifies ownership before detaching; audited', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextRetrievedPaymentMethod = { id: 'pm_1', customer: 'cus_1' };
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_1', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    const out = await guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_1' });
    expect(out).toEqual({ ok: true });
    expect(fake.calls.paymentMethodsRetrieve).toEqual(['pm_1']);
    expect(fake.calls.paymentMethodsDetach).toEqual(['pm_1']);
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.detachPaymentMethod').get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0]!.data()).toMatchObject({ actorUid: 'g1', target: 'pm_1' });
  });

  it('a payment method owned by a DIFFERENT Stripe customer is rejected with permission_denied, never detached (cross-tenant-oracle)', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextRetrievedPaymentMethod = { id: 'pm_1', customer: 'cus_someone_else' };
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_1', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    await expect(guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_1' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fake.calls.paymentMethodsDetach).toHaveLength(0);
  });

  it('a genuinely nonexistent payment method id fails the SAME way as a mismatch — permission_denied, not a distinguishable error (no existence oracle)', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.paymentMethods.retrieve = () => Promise.reject(new Error('No such payment_method: pm_bogus'));
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_1', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    await expect(guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_bogus' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a guest with no Stripe customer at all is rejected without ever calling Stripe', async () => {
    const deps = testDeps();
    const fake = useFake();
    await expect(guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_1' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fake.calls.paymentMethodsRetrieve).toHaveLength(0);
  });

  it('Task 7: rate limits per uid (10/600s) — the 11th call in the window rejects with rate_limited', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextRetrievedPaymentMethod = { id: 'pm_1', customer: 'cus_1' };
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_1', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    for (let i = 0; i < 10; i++) await guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_1' });
    await expect(guestDetachPaymentMethodHandler(deps, GUEST, { id: 'pm_1' })).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('guestSetupIntent', () => {
  it('creates a Stripe customer + persists stripeCustomerId when absent, then returns a SetupIntent bundle; audited', async () => {
    const deps = testDeps();
    const fake = useFake();
    const out = await guestSetupIntentHandler(deps, GUEST, {});
    expect(out).toEqual({ clientSecret: 'seti_1_secret_abc', customerId: 'cus_new', ephemeralKey: 'ek_secret', publishableKey: 'pk_test_x' });
    expect(fake.calls.customersCreate).toHaveLength(1);
    expect(fake.calls.customersCreate[0]!.params).toMatchObject({ phone: '+13175550123' });
    expect(fake.calls.setupIntentsCreate[0]!.params).toMatchObject({ customer: 'cus_new' });
    expect((await deps.db.doc(P.guest('g1')).get()).data()).toMatchObject({ stripeCustomerId: 'cus_new' });
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.setupIntent').get();
    expect(logs.size).toBe(1);
  });

  it('an existing stripeCustomerId is reused — no new Stripe customer is minted', async () => {
    const deps = testDeps();
    const fake = useFake();
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', stripeCustomerId: 'cus_existing', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    const out = await guestSetupIntentHandler(deps, GUEST, {});
    expect(out.customerId).toBe('cus_existing');
    expect(fake.calls.customersCreate).toHaveLength(0);
    expect(fake.calls.setupIntentsCreate[0]!.params).toMatchObject({ customer: 'cus_existing' });
  });

  it('Task 7: rate limits per uid (10/600s) — the 11th call in the window rejects with rate_limited', async () => {
    const deps = testDeps();
    useFake();
    for (let i = 0; i < 10; i++) await guestSetupIntentHandler(deps, GUEST, {});
    await expect(guestSetupIntentHandler(deps, GUEST, {})).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
