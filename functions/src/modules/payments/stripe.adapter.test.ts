import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeGateway } from './stripe.adapter.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';

function idempotencyKeyFor(i: {
  ticketId: string;
  method: string;
  base: number;
  tip: number;
  tax: number;
  fees: number;
  currency: string;
  connectedAccountId?: string;
  platformFeeBps: number;
}): string {
  const digest = createHash('sha256')
    .update([i.base, i.tip, i.tax, i.fees, i.currency, i.connectedAccountId ?? '', i.platformFeeBps].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `checkout_${i.ticketId}_${i.method}_${digest}`;
}

describe('StripeGateway', () => {
  it('creates a destination-charge intent with platform fee on non-tip amount and tip kept on platform', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk_test_x' });
    const input = {
      operatorId: 'goldstar',
      ticketId: 't1',
      base: 1500,
      tip: 300,
      tax: 105,
      fees: 0,
      currency: 'USD',
      method: 'web' as const,
      capture: 'automatic' as const,
      connectedAccountId: 'acct_B',
      platformFeeBps: 500,
      metadata: { a: '1' },
    };
    const out = await gw.createCheckout(input);
    expect(out.clientSecret).toMatch(/^pi_.*_secret_/);
    expect(out.providerRef).toMatch(/^pi_/);
    const call = fake.calls.paymentIntentsCreate[0]!;
    expect(call.params).toMatchObject({
      amount: 1905,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      capture_method: 'automatic',
      transfer_data: { destination: 'acct_B' },
      application_fee_amount: 300 + Math.round(1605 * 0.05),
      metadata: { a: '1', operatorId: 'goldstar', ticketId: 't1', base: '1500', tip: '300', tax: '105', fees: '0', applicationFee: String(300 + Math.round(1605 * 0.05)) },
    });
    expect(call.options.idempotencyKey).toBe(idempotencyKeyFor(input));
  });

  it('without connected account: no transfer_data, no application fee, no applicationFee metadata (Ruling AW)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.createCheckout({
      operatorId: 'goldstar',
      ticketId: 't1',
      base: 1500,
      tip: 0,
      tax: 0,
      fees: 0,
      currency: 'USD',
      method: 'in_app',
      capture: 'manual',
      platformFeeBps: 0,
      metadata: {},
    });
    expect(fake.calls.paymentIntentsCreate[0]!.params).not.toHaveProperty('transfer_data');
    expect(fake.calls.paymentIntentsCreate[0]!.params.capture_method).toBe('manual');
    const params = fake.calls.paymentIntentsCreate[0]!.params as { metadata: Record<string, string> };
    expect(params.metadata).not.toHaveProperty('applicationFee');
  });

  it('in_app with customer returns ephemeral key', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const out = await gw.createCheckout({
      operatorId: 'g',
      ticketId: 't',
      base: 100,
      tip: 0,
      tax: 0,
      fees: 0,
      currency: 'USD',
      method: 'in_app',
      capture: 'automatic',
      platformFeeBps: 0,
      metadata: {},
      customerRef: 'cus_1',
    });
    expect(out.ephemeralKey).toBe('ek_secret');
    expect(out.customerId).toBe('cus_1');
  });

  it('updateTip: connected account gets a recomputed application fee that keeps the tip on the platform; non-connected gets none', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.updateTip({ providerRef: 'pi_1', base: 1500, tip: 400, tax: 105, fees: 0, platformFeeBps: 500, connectedAccountId: 'acct_B' });
    const connectedCall = fake.calls.update[0] as { id: string; params: Record<string, unknown> };
    expect(connectedCall.id).toBe('pi_1');
    expect(connectedCall.params).toMatchObject({
      amount: 2005,
      application_fee_amount: 400 + Math.round(1605 * 0.05),
      metadata: { tip: '400' },
    });

    await gw.updateTip({ providerRef: 'pi_2', base: 1500, tip: 400, tax: 105, fees: 0, platformFeeBps: 500 });
    const unconnectedCall = fake.calls.update[1] as { id: string; params: Record<string, unknown> };
    expect(unconnectedCall.params).not.toHaveProperty('application_fee_amount');
    expect(unconnectedCall.params.amount).toBe(2005);
  });

  it('capture: partial capture defaults final_capture to true, can be told it is not final, and a full capture omits amount fields entirely', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.capture({ providerRef: 'pi_1', amount: 500 });
    expect(fake.calls.capture[0]).toEqual({ id: 'pi_1', params: { amount_to_capture: 500, final_capture: true } });

    await gw.capture({ providerRef: 'pi_2', amount: 500, final: false });
    expect(fake.calls.capture[1]).toEqual({ id: 'pi_2', params: { amount_to_capture: 500, final_capture: false } });

    await gw.capture({ providerRef: 'pi_3' });
    expect(fake.calls.capture[2]).toEqual({ id: 'pi_3', params: {} });
  });

  // M2 (final review): a redelivered dispatch-capture invocation can retry an already-captured
  // intent — Stripe rejects the second `capture` call with `payment_intent_unexpected_state`.
  // `capture` now retrieves and checks: a genuinely `succeeded` intent means the capture already
  // landed, so this resolves as a no-op instead of throwing, mirroring `cancelAuthorization`'s own
  // retrieve-guard shape.
  it('capture: payment_intent_unexpected_state + a retrieved succeeded status resolves as a no-op (already captured)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextCaptureError = Object.assign(new Error('The PaymentIntent could not be captured'), { code: 'payment_intent_unexpected_state' });
    fake.nextRetrieveStatus = 'succeeded';
    await expect(gw.capture({ providerRef: 'pi_1', amount: 5750 })).resolves.toBeUndefined();
  });

  it('capture: payment_intent_unexpected_state with any OTHER retrieved status rethrows the original Stripe error (a real surprise, not an idempotent replay)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextCaptureError = Object.assign(new Error('The PaymentIntent could not be captured'), { code: 'payment_intent_unexpected_state' });
    fake.nextRetrieveStatus = 'canceled';
    await expect(gw.capture({ providerRef: 'pi_1', amount: 5750 })).rejects.toThrow('The PaymentIntent could not be captured');
  });

  it('capture rethrows a genuine transient error untouched (network/5xx/rate-limit) — no retrieve involved', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextCaptureError = Object.assign(new Error('rate limited'), { code: 'rate_limit_error' });
    await expect(gw.capture({ providerRef: 'pi_1', amount: 5750 })).rejects.toThrow('rate limited');
  });

  it('cancelIntent swallows only Stripe\'s payment_intent_unexpected_state code and rethrows everything else', async () => {
    const swallowed = new FakeStripe();
    const swallowedGw = new StripeGateway(swallowed, { publishableKey: 'pk' });
    swallowed.nextCancelError = Object.assign(new Error('The PaymentIntent could not be canceled'), { code: 'payment_intent_unexpected_state' });
    await expect(swallowedGw.cancelIntent({ providerRef: 'pi_1', reason: 'duplicate' })).resolves.toBeUndefined();

    const rethrown = new FakeStripe();
    const rethrownGw = new StripeGateway(rethrown, { publishableKey: 'pk' });
    rethrown.nextCancelError = Object.assign(new Error('network blip'), { code: 'api_connection_error' });
    await expect(rethrownGw.cancelIntent({ providerRef: 'pi_1', reason: 'duplicate' })).rejects.toThrow('network blip');
  });

  // F2 (final review): `payment_intent_unexpected_state` is Stripe's generic "already past a
  // cancellable state" code — it's raised both for a genuinely benign cancel race AND for an
  // intent that already SUCCEEDED. Blindly swallowing it (the pre-F2 behavior above) let a caller
  // proceed to mint a second intent against an already-charged card. `cancelIntent` now retrieves
  // the intent on that specific error and only swallows when the real status is NOT one of the
  // "already paid" statuses.
  it('F2: cancelIntent retrieves the intent on payment_intent_unexpected_state — throws payment_already_paid for an already-succeeded intent, still swallows a genuinely-cancellable one', async () => {
    const paid = new FakeStripe();
    const paidGw = new StripeGateway(paid, { publishableKey: 'pk' });
    paid.nextCancelError = Object.assign(new Error('The PaymentIntent could not be canceled'), { code: 'payment_intent_unexpected_state' });
    paid.nextRetrieveStatus = 'succeeded';
    await expect(paidGw.cancelIntent({ providerRef: 'pi_1', reason: 'duplicate' })).rejects.toMatchObject({ code: 'payment_already_paid' });

    const processing = new FakeStripe();
    const processingGw = new StripeGateway(processing, { publishableKey: 'pk' });
    processing.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    processing.nextRetrieveStatus = 'processing';
    await expect(processingGw.cancelIntent({ providerRef: 'pi_2', reason: 'duplicate' })).rejects.toMatchObject({ code: 'payment_already_paid' });

    const capturable = new FakeStripe();
    const capturableGw = new StripeGateway(capturable, { publishableKey: 'pk' });
    capturable.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    capturable.nextRetrieveStatus = 'requires_capture';
    await expect(capturableGw.cancelIntent({ providerRef: 'pi_3', reason: 'duplicate' })).rejects.toMatchObject({ code: 'payment_already_paid' });

    // A genuinely-cancellable race (e.g. already canceled from another tab) stays swallowed.
    const alreadyCanceled = new FakeStripe();
    const alreadyCanceledGw = new StripeGateway(alreadyCanceled, { publishableKey: 'pk' });
    alreadyCanceled.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    alreadyCanceled.nextRetrieveStatus = 'canceled';
    await expect(alreadyCanceledGw.cancelIntent({ providerRef: 'pi_4', reason: 'duplicate' })).resolves.toBeUndefined();
  });

  // Plan 5 T2: cancelAuthorization is the deliberate counterpart to cancelIntent for voiding a job's
  // manual-capture authorization — see its own JSDoc for the full F2-conflict writeup.
  it('cancelAuthorization: a normal cancel of a requires_capture intent just succeeds — no retrieve, no error (the routine job-cancellation path)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await expect(gw.cancelAuthorization({ providerRef: 'pi_1', reason: 'requested_by_customer' })).resolves.toBeUndefined();
    expect(fake.calls.cancel).toHaveLength(1);
  });

  it("cancelAuthorization: unlike cancelIntent, requires_capture is NOT treated as already-paid — it rethrows Stripe's own error instead of throwing payment_already_paid", async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    fake.nextRetrieveStatus = 'requires_capture';
    await expect(gw.cancelAuthorization({ providerRef: 'pi_1', reason: 'requested_by_customer' })).rejects.toThrow('cannot cancel');
  });

  it('cancelAuthorization: succeeded or processing are genuinely already-paid — throws payment_already_paid; already-canceled is an idempotent no-op', async () => {
    const succeeded = new FakeStripe();
    const succeededGw = new StripeGateway(succeeded, { publishableKey: 'pk' });
    succeeded.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    succeeded.nextRetrieveStatus = 'succeeded';
    await expect(succeededGw.cancelAuthorization({ providerRef: 'pi_1', reason: 'requested_by_customer' })).rejects.toMatchObject({ code: 'payment_already_paid' });

    const processing = new FakeStripe();
    const processingGw = new StripeGateway(processing, { publishableKey: 'pk' });
    processing.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    processing.nextRetrieveStatus = 'processing';
    await expect(processingGw.cancelAuthorization({ providerRef: 'pi_2', reason: 'requested_by_customer' })).rejects.toMatchObject({ code: 'payment_already_paid' });

    const canceled = new FakeStripe();
    const canceledGw = new StripeGateway(canceled, { publishableKey: 'pk' });
    canceled.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    canceled.nextRetrieveStatus = 'canceled';
    await expect(canceledGw.cancelAuthorization({ providerRef: 'pi_3', reason: 'requested_by_customer' })).resolves.toBeUndefined();
  });

  it('cancelAuthorization rethrows any error code other than payment_intent_unexpected_state', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextCancelError = Object.assign(new Error('network blip'), { code: 'api_connection_error' });
    await expect(gw.cancelAuthorization({ providerRef: 'pi_1', reason: 'requested_by_customer' })).rejects.toThrow('network blip');
  });

  it('refund: passes through a recognized Stripe reason, falls back to requested_by_customer for free text, keeps the original text in metadata', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.refund({ providerRef: 'pi_1', reason: 'fraudulent' });
    expect(fake.calls.refunds[0]!.params).toMatchObject({ reason: 'fraudulent', metadata: { reason: 'fraudulent' } });

    await gw.refund({ providerRef: 'pi_2', reason: 'guest changed their mind' });
    expect(fake.calls.refunds[1]!.params).toMatchObject({ reason: 'requested_by_customer', metadata: { reason: 'guest changed their mind' } });
  });

  it('refund: forwards idempotencyKey as a RequestOptions when given, omits it entirely when not (Ruling W)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.refund({ providerRef: 'pi_1', reason: 'requested_by_customer', idempotencyKey: 'refund_t1_pi_1_full' });
    expect(fake.calls.refunds[0]!.options).toMatchObject({ idempotencyKey: 'refund_t1_pi_1_full' });

    await gw.refund({ providerRef: 'pi_2', reason: 'requested_by_customer' });
    expect(fake.calls.refunds[1]!.options).not.toHaveProperty('idempotencyKey');
  });

  it('refund: reverseTransfer:true passes reverse_transfer:true + refund_application_fee:false; omitted entirely when falsy/absent (Ruling AI, finding 2)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.refund({ providerRef: 'pi_1', reason: 'requested_by_customer', reverseTransfer: true });
    expect(fake.calls.refunds[0]!.params).toMatchObject({ reverse_transfer: true, refund_application_fee: false });

    await gw.refund({ providerRef: 'pi_2', reason: 'requested_by_customer' });
    expect(fake.calls.refunds[1]!.params).not.toHaveProperty('reverse_transfer');
    expect(fake.calls.refunds[1]!.params).not.toHaveProperty('refund_application_fee');

    await gw.refund({ providerRef: 'pi_3', reason: 'requested_by_customer', reverseTransfer: false });
    expect(fake.calls.refunds[2]!.params).not.toHaveProperty('reverse_transfer');
  });

  it('ensureCustomer: an existing id passes through without calling Stripe; a missing id creates one', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const existing = await gw.ensureCustomer({ guestUid: 'g1', existing: 'cus_existing' });
    expect(existing).toEqual({ customerId: 'cus_existing' });

    const created = await gw.ensureCustomer({ guestUid: 'g2', phone: '+15555550100' });
    expect(created.customerId).toBe('cus_new');
  });

  it('ensureTerminalLocation: builds the address params and forwards stripeAccount as a request option', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const result = await gw.ensureTerminalLocation({
      operatorId: 'g',
      venueName: 'Downtown Garage',
      address: { line1: '1 Main St', city: 'Indianapolis', region: 'IN', postalCode: '46204', country: 'US' },
      stripeAccount: 'acct_venue',
    });
    expect(result.locationRef).toBe('tml_new');
    const call = fake.calls.locationsCreate[0]!;
    expect(call.params).toMatchObject({
      display_name: 'Downtown Garage',
      address: { line1: '1 Main St', city: 'Indianapolis', state: 'IN', postal_code: '46204', country: 'US' },
    });
    expect(call.options).toEqual({ stripeAccount: 'acct_venue' });
  });

  it('connectOnboardingLink: operator kind requests the card_payments capability; an accountId provided skips account creation', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.connectOnboardingLink({ operatorId: 'g', kind: 'operator', refreshUrl: 'https://x/r', returnUrl: 'https://x/ok' });
    expect(fake.calls.accountsCreate[0]!.params.capabilities).toMatchObject({
      transfers: { requested: true },
      card_payments: { requested: true },
    });

    const link = await gw.connectOnboardingLink({
      operatorId: 'g',
      kind: 'worker',
      accountId: 'acct_existing',
      refreshUrl: 'https://x/r',
      returnUrl: 'https://x/ok',
    });
    expect(link.accountId).toBe('acct_existing');
    expect(fake.calls.accountsCreate.length).toBe(1);
  });

  it('getAccountStatus: maps charges_enabled/payouts_enabled/requirements.currently_due through, and a null/absent currently_due maps to an empty array', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextAccountStatus = { charges_enabled: false, payouts_enabled: true, requirements: { currently_due: ['individual.id_number'] } };
    expect(await gw.getAccountStatus({ accountId: 'acct_1' })).toEqual({
      chargesEnabled: false,
      payoutsEnabled: true,
      requirementsDue: ['individual.id_number'],
    });
    expect(fake.calls.accountsRetrieve).toEqual(['acct_1']);

    fake.nextAccountStatus = { charges_enabled: true, payouts_enabled: true, requirements: { currently_due: null } };
    expect((await gw.getAccountStatus({ accountId: 'acct_2' })).requirementsDue).toEqual([]);
  });

  it('refund, terminal token, connect link, transfer', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    expect((await gw.refund({ providerRef: 'pi_1', amount: 500, reason: 'requested_by_customer' })).refundRef).toMatch(/^re_/);
    expect((await gw.createTerminalConnectionToken({ operatorId: 'g', locationRef: 'tml_1' })).secret).toBe('pst_secret');
    const link = await gw.connectOnboardingLink({ operatorId: 'g', kind: 'worker', refreshUrl: 'https://x/r', returnUrl: 'https://x/ok' });
    expect(link.accountId).toMatch(/^acct_/);
    expect(fake.calls.accountsCreate[0]!.params.type).toBe('express');
    const tr = await gw.transfer({ amount: 300, currency: 'USD', destinationAccountId: 'acct_W', idempotencyKey: 'payout_1', metadata: { uid: 'u1' } });
    expect(tr.transferRef).toMatch(/^tr_/);
    expect(fake.calls.transfers[0]!.options.idempotencyKey).toBe('payout_1');
  });

  it('parseWebhook verifies signature via constructEvent and maps events', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const events = await gw.parseWebhook({ rawBody: Buffer.from('{}'), signature: 'sig', secret: 'whsec' });
    expect(fake.calls.constructEvent[0]).toEqual({ sig: 'sig', secret: 'whsec' });
    expect(events[0]).toMatchObject({ kind: 'payment_succeeded', providerRef: 'pi_evt', eventId: 'evt_1', amount: 1905, tip: 300 });
  });

  it('parseWebhook extracts applicationFee from metadata and destinationAccountId from transfer_data.destination for a connected charge (Ruling AW, finding 17)', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextEvent = {
      id: 'evt_conn',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_conn',
          amount: 1905,
          amount_received: 1905,
          currency: 'usd',
          latest_charge: 'ch_conn',
          metadata: { operatorId: 'goldstar', ticketId: 't1', base: '1500', tip: '300', tax: '105', fees: '0', applicationFee: '380' },
          transfer_data: { destination: 'acct_B', amount: 1525 },
        },
      },
    };
    const events = await gw.parseWebhook({ rawBody: Buffer.from('{}'), signature: 'sig', secret: 'whsec' });
    expect(events[0]).toMatchObject({ applicationFee: 380, destinationAccountId: 'acct_B' });
  });

  it('parseWebhook omits applicationFee/destinationAccountId entirely for a non-connected charge', async () => {
    const fake = new FakeStripe(); // default nextEvent has transfer_data: null and no applicationFee metadata key
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const events = await gw.parseWebhook({ rawBody: Buffer.from('{}'), signature: 'sig', secret: 'whsec' });
    expect(events[0]).not.toHaveProperty('applicationFee');
    expect(events[0]).not.toHaveProperty('destinationAccountId');
  });

  it('ensureCustomer passes a deterministic per-guest idempotency key so two concurrent callers converge on one Stripe customer', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.ensureCustomer({ guestUid: 'g9', phone: '+15555550100' });
    await gw.ensureCustomer({ guestUid: 'g9', phone: '+15555550100' });
    expect(fake.calls.customersCreate).toHaveLength(2);
    // Both calls carry the SAME key (a stand-in for "Stripe would have deduped these to one customer
    // server-side, since the fake doesn't itself model idempotency-key caching") — not derived from
    // phone/anything randomized per call.
    expect(fake.calls.customersCreate[0]!.options).toMatchObject({ idempotencyKey: 'guest_customer_g9' });
    expect(fake.calls.customersCreate[1]!.options).toMatchObject({ idempotencyKey: 'guest_customer_g9' });
    // A different guest gets a distinct key — never collides with another guest's customer creation.
    await gw.ensureCustomer({ guestUid: 'g10' });
    expect(fake.calls.customersCreate[2]!.options).toMatchObject({ idempotencyKey: 'guest_customer_g10' });
  });

  it('listPaymentMethods filters to card-typed methods and maps brand/last4/exp fields', async () => {
    const fake = new FakeStripe();
    fake.nextPaymentMethods = [
      { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
      { id: 'pm_no_card' }, // defensively excluded — the SDK types `card` as optional even under type:'card'
    ];
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const methods = await gw.listPaymentMethods({ customerId: 'cus_1' });
    expect(fake.calls.paymentMethodsList[0]!.params).toMatchObject({ customer: 'cus_1', type: 'card' });
    expect(methods).toEqual([{ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }]);
  });

  it('retrievePaymentMethod extracts a string or object customer id, and omits it when null', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    fake.nextRetrievedPaymentMethod = { id: 'pm_1', customer: 'cus_string' };
    expect(await gw.retrievePaymentMethod({ id: 'pm_1' })).toEqual({ id: 'pm_1', customerId: 'cus_string' });
    fake.nextRetrievedPaymentMethod = { id: 'pm_2', customer: null };
    expect(await gw.retrievePaymentMethod({ id: 'pm_2' })).toEqual({ id: 'pm_2' });
    expect(fake.calls.paymentMethodsRetrieve).toEqual(['pm_1', 'pm_2']);
  });

  it('detachPaymentMethod calls through to Stripe detach', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await gw.detachPaymentMethod({ id: 'pm_1' });
    expect(fake.calls.paymentMethodsDetach).toEqual(['pm_1']);
  });

  it('createSetupIntent bundles a SetupIntent client secret with a scoped ephemeral key and the publishable key', async () => {
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk_live' });
    const out = await gw.createSetupIntent({ customerId: 'cus_1' });
    expect(fake.calls.setupIntentsCreate[0]!.params).toMatchObject({ customer: 'cus_1', payment_method_types: ['card'], usage: 'off_session' });
    expect(out).toEqual({ clientSecret: 'seti_1_secret_abc', ephemeralKey: 'ek_secret', publishableKey: 'pk_live' });
  });
});
