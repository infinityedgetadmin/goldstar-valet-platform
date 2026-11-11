import type Stripe from 'stripe';

// Method parameters are typed against the real Stripe SDK params (matching
// `StripeClientLike` in stripe.adapter.ts) so this fake is a genuine structural
// substitute for the adapter's port, not just something duck-typed enough to run
// at test time. Captured-call storage stays loosely `Record<string, unknown>`
// for easy assertion in tests; casting *into* that loose shape at push-time is
// safe (we know the runtime value is a plain params object) even though a typed
// Stripe params interface (no index signature) isn't directly assignable to
// `Record<string, unknown>`.
export class FakeStripe {
  calls = {
    paymentIntentsCreate: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    capture: [] as unknown[],
    cancel: [] as unknown[],
    update: [] as unknown[],
    refunds: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    accountsCreate: [] as { params: Record<string, unknown> }[],
    accountLinks: [] as { params: Record<string, unknown> }[],
    accountsRetrieve: [] as string[],
    locationsCreate: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    transfers: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    constructEvent: [] as unknown[],
    customersCreate: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    paymentMethodsList: [] as { params: Record<string, unknown> }[],
    paymentMethodsRetrieve: [] as string[],
    paymentMethodsDetach: [] as string[],
    setupIntentsCreate: [] as { params: Record<string, unknown> }[],
  };

  // Set by a test to make the next `paymentIntents.cancel` call throw — used to exercise
  // cancelIntent's error-code-specific swallow (Ruling N).
  nextCancelError: unknown = null;

  // M2 (final review): set by a test to make the next `paymentIntents.capture` call throw — used
  // to exercise `capture`'s own payment_intent_unexpected_state retrieve-guard (mirroring
  // cancelIntent/cancelAuthorization above) and genuine transient-failure propagation.
  nextCaptureError: unknown = null;

  // F2 (final review): the status `paymentIntents.retrieve` reports back — read by
  // `cancelIntent`'s F2 guard when `cancel` throws `payment_intent_unexpected_state`, to tell an
  // already-succeeded intent apart from a genuinely-cancellable one. Defaults to `'canceled'`
  // (a benign, already-cancellable-race status) so existing tests that never touch this field see
  // the pre-F2 swallow-and-proceed behavior unchanged.
  nextRetrieveStatus = 'canceled';

  // Task 6 (connectAccountStatus): configurable response for `accounts.retrieve` — defaults to a
  // fully-onboarded account so existing tests that never touch this field see a "connected and
  // ready" status; a test exercising the requirements-due/not-yet-enabled path overrides it.
  nextAccountStatus: { charges_enabled: boolean; payouts_enabled: boolean; requirements?: { currently_due?: string[] | null } } = {
    charges_enabled: true,
    payouts_enabled: true,
    requirements: { currently_due: [] },
  };

  nextEvent: Record<string, unknown> = {
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_evt',
        amount: 1905,
        amount_received: 1905,
        currency: 'usd',
        latest_charge: 'ch_1',
        metadata: { operatorId: 'goldstar', ticketId: 't1', base: '1500', tip: '300', tax: '105', fees: '0' },
        transfer_data: null,
      },
    },
  };

  paymentIntents = {
    create: async (params: Stripe.PaymentIntentCreateParams, options: Stripe.RequestOptions) => {
      this.calls.paymentIntentsCreate.push({ params: params as unknown as Record<string, unknown>, options: options as unknown as Record<string, unknown> });
      return { id: 'pi_123', client_secret: 'pi_123_secret_abc', status: 'requires_payment_method' };
    },
    cancel: async (id: string, p: Stripe.PaymentIntentCancelParams) => {
      this.calls.cancel.push({ id, p });
      if (this.nextCancelError) throw this.nextCancelError;
      return { id, status: 'canceled' };
    },
    capture: async (id: string, params: Stripe.PaymentIntentCaptureParams) => {
      this.calls.capture.push({ id, params });
      if (this.nextCaptureError) throw this.nextCaptureError;
      return { id, status: 'succeeded' };
    },
    retrieve: async (id: string) => ({ id, amount: 1905, metadata: {}, status: this.nextRetrieveStatus }),
    update: async (id: string, params: Stripe.PaymentIntentUpdateParams) => {
      this.calls.update.push({ id, params: params as unknown as Record<string, unknown> });
      return { id, ...params };
    },
  };

  refunds = {
    create: async (params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions) => {
      this.calls.refunds.push({ params: params as unknown as Record<string, unknown>, options: (options ?? {}) as unknown as Record<string, unknown> });
      return { id: 're_1', status: 'succeeded' };
    },
  };

  terminal = {
    connectionTokens: { create: async () => ({ secret: 'pst_secret' }) },
    locations: {
      create: async (p: Stripe.Terminal.LocationCreateParams, o?: Stripe.RequestOptions) => {
        this.calls.locationsCreate.push({ params: p as unknown as Record<string, unknown>, options: (o ?? {}) as unknown as Record<string, unknown> });
        return { id: 'tml_new', ...p };
      },
    },
  };

  accounts = {
    create: async (params: Stripe.AccountCreateParams) => {
      this.calls.accountsCreate.push({ params: params as unknown as Record<string, unknown> });
      return { id: 'acct_new' };
    },
    retrieve: async (id: string) => {
      this.calls.accountsRetrieve.push(id);
      return this.nextAccountStatus;
    },
  };

  accountLinks = {
    create: async (p: Stripe.AccountLinkCreateParams) => {
      this.calls.accountLinks.push({ params: p as unknown as Record<string, unknown> });
      return { url: `https://connect.stripe.com/setup/${p.account}` };
    },
  };

  transfers = {
    create: async (params: Stripe.TransferCreateParams, options: Stripe.RequestOptions) => {
      this.calls.transfers.push({ params: params as unknown as Record<string, unknown>, options: options as unknown as Record<string, unknown> });
      return { id: 'tr_1' };
    },
  };

  customers = {
    create: async (p: Stripe.CustomerCreateParams, o?: Stripe.RequestOptions) => {
      this.calls.customersCreate.push({ params: p as unknown as Record<string, unknown>, options: (o ?? {}) as unknown as Record<string, unknown> });
      return { id: 'cus_new', ...p };
    },
  };

  ephemeralKeys = { create: async () => ({ secret: 'ek_secret' }) };

  // Plan 6 (guest account): configurable list/retrieve responses — defaults to a single visa card
  // owned by 'cus_existing' so an unconfigured test still gets a plausible, non-empty result.
  nextPaymentMethods: Array<{ id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } }> = [
    { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
  ];
  nextRetrievedPaymentMethod: { id: string; customer: string | null } = { id: 'pm_1', customer: 'cus_existing' };

  paymentMethods = {
    list: async (p: Stripe.PaymentMethodListParams) => {
      this.calls.paymentMethodsList.push({ params: p as unknown as Record<string, unknown> });
      return { data: this.nextPaymentMethods };
    },
    retrieve: async (id: string) => {
      this.calls.paymentMethodsRetrieve.push(id);
      return this.nextRetrievedPaymentMethod;
    },
    detach: async (id: string) => {
      this.calls.paymentMethodsDetach.push(id);
      return {};
    },
  };

  setupIntents = {
    create: async (p: Stripe.SetupIntentCreateParams) => {
      this.calls.setupIntentsCreate.push({ params: p as unknown as Record<string, unknown> });
      return { id: 'seti_1', client_secret: 'seti_1_secret_abc' };
    },
  };

  webhooks = {
    constructEvent: (_raw: Buffer, sig: string, secret: string) => {
      this.calls.constructEvent.push({ sig, secret });
      return this.nextEvent;
    },
  };
}
