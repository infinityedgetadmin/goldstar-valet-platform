import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import type { CheckoutInput, CheckoutResult, PaymentEvent, PaymentGateway } from './port.js';
import { API_VERSION } from './stripeClient.js';
import { err } from '../../lib/errors.js';

// Platform's cut of a checkout: the tip always stays with the platform in full (never shared with
// the connected account), plus a bps cut of the non-tip amount (base + tax + fees). Shared between
// createCheckout (initial intent) and updateTip (tip revised after the intent already exists) so
// the two can't drift — a bug here previously left updateTip recomputing `amount` but never
// re-deriving `application_fee_amount`, silently sending the operator's connected account the
// revised tip instead of keeping it on the platform.
function applicationFee(nonTip: number, tip: number, bps: number): number {
  return tip + Math.round((nonTip * bps) / 10_000);
}

// Deterministic per-checkout idempotency key: stable across retries of the *same* checkout (same
// ticket/method/amounts/currency/connected-account/fee-bps), but distinct once any of those inputs
// changes (e.g. a re-priced checkout after a tip edit), so Stripe won't replay a stale intent.
function checkoutIdempotencyKey(i: CheckoutInput): string {
  const digest = createHash('sha256')
    .update([i.base, i.tip, i.tax, i.fees, i.currency, i.connectedAccountId ?? '', i.platformFeeBps].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `checkout_${i.ticketId}_${i.method}_${digest}`;
}

const STRIPE_REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;
type StripeRefundReason = (typeof STRIPE_REFUND_REASONS)[number];
function isStripeRefundReason(r: string): r is StripeRefundReason {
  return (STRIPE_REFUND_REASONS as readonly string[]).includes(r);
}

// F2 (final review): PaymentIntent statuses that mean the card has already been charged (capture
// may still be pending for `requires_capture`, but the guest has authorized/paid) — used by
// `cancelIntent` below to tell a genuinely-cancellable intent apart from one Stripe just refused to
// cancel because it already succeeded.
const ALREADY_PAID_INTENT_STATUSES = new Set(['succeeded', 'processing', 'requires_capture']);

// Narrow structural surface over the Stripe SDK: only the methods this adapter calls, with
// simplified return shapes. Deliberately not `StripeLike` (Pick<Stripe, ...> from stripeClient.ts)
// — that type carries the SDK's full response shapes (e.g. `Stripe.Response<Stripe.PaymentIntent>`
// with dozens of required fields), which the test fake (functions/test/fakes/stripe.ts) does not
// and should not reproduce. This interface is the real client's structural subtype (the live
// `stripeClient()` return value satisfies it) and the fake's structural supertype (the fake
// satisfies it directly, no cast needed at the test call site).
export interface StripeClientLike {
  paymentIntents: {
    create: (p: Stripe.PaymentIntentCreateParams, o: Stripe.RequestOptions) => Promise<{ id: string; client_secret: string | null }>;
    cancel: (id: string, p: Stripe.PaymentIntentCancelParams) => Promise<unknown>;
    capture: (id: string, p: Stripe.PaymentIntentCaptureParams) => Promise<unknown>;
    update: (id: string, p: Stripe.PaymentIntentUpdateParams) => Promise<unknown>;
    // F2 (final review): `cancelIntent` below retrieves the intent when its cancel attempt fails
    // with `payment_intent_unexpected_state`, to tell an already-succeeded intent apart from a
    // genuinely-cancellable one. Only `status` is read.
    retrieve: (id: string) => Promise<{ status: string }>;
  };
  refunds: { create: (p: Stripe.RefundCreateParams, o?: Stripe.RequestOptions) => Promise<{ id: string }> };
  terminal: {
    connectionTokens: { create: (p?: Stripe.Terminal.ConnectionTokenCreateParams) => Promise<{ secret: string }> };
    locations: { create: (p: Stripe.Terminal.LocationCreateParams, o?: Stripe.RequestOptions) => Promise<{ id: string }> };
  };
  accounts: {
    create: (p: Stripe.AccountCreateParams) => Promise<{ id: string }>;
    // Task 6 (connectAccountStatus): only the three fields the adapter reads —
    // `requirements` is optional on the real `Stripe.Account` (absent when Stripe has nothing to
    // ask for), and `requirements.currently_due` is `string[] | null` (verified against the
    // installed `stripe` package's own `types/Accounts.d.ts`, not assumed from memory).
    retrieve: (id: string) => Promise<{ charges_enabled: boolean; payouts_enabled: boolean; requirements?: { currently_due?: string[] | null } }>;
  };
  accountLinks: { create: (p: Stripe.AccountLinkCreateParams) => Promise<{ url: string }> };
  transfers: { create: (p: Stripe.TransferCreateParams, o: Stripe.RequestOptions) => Promise<{ id: string }> };
  // `options` widened to optional (was previously omitted entirely) so ensureCustomer below can pass
  // a deterministic idempotencyKey — verified against the installed SDK's CustomersResource.create
  // overload accepting `(params?, options?)` (node_modules/stripe/types/CustomersResource.d.ts).
  customers: { create: (p: Stripe.CustomerCreateParams, o?: Stripe.RequestOptions) => Promise<{ id: string }> };
  ephemeralKeys: { create: (p: Stripe.EphemeralKeyCreateParams, o: Stripe.RequestOptions) => Promise<{ secret?: string }> };
  // Plan 6 (guest account) — verified against the installed SDK's PaymentMethodsResource/
  // SetupIntentsResource .d.ts files, not memory. `paymentMethods.list`'s JSDoc in the installed
  // package now frames the bare `/v1/payment_methods` endpoint as "for Treasury flows" and points at
  // a dedicated customer-scoped list API instead — but `PaymentMethodListParams` still accepts a
  // `customer` filter directly, which is exactly the shape task-4-brief.md's spec calls for
  // (`paymentMethods.list({customer, type:'card'})`); using it as specified rather than switching to
  // an undocumented-here alternative.
  paymentMethods: {
    list: (p: Stripe.PaymentMethodListParams) => Promise<{ data: Array<{ id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } }> }>;
    retrieve: (id: string) => Promise<{ id: string; customer: string | { id: string } | null }>;
    detach: (id: string) => Promise<unknown>;
  };
  setupIntents: { create: (p: Stripe.SetupIntentCreateParams) => Promise<{ client_secret: string | null }> };
  webhooks: { constructEvent: (raw: Buffer, sig: string, secret: string) => unknown };
}

export class StripeGateway implements PaymentGateway {
  constructor(
    private readonly s: StripeClientLike,
    private readonly opts: { publishableKey: string },
  ) {}

  async createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
    const total = i.base + i.tip + i.tax + i.fees;
    const nonTip = i.base + i.tax + i.fees;
    // Ruling AW: computed once, mirrored into metadata (in addition to the real
    // `application_fee_amount` field below) so the platform's cut is visible on the charge/PI in the
    // Stripe dashboard and round-trips through parseWebhook via one plain metadata read, rather than
    // every event-kind branch needing its own cast into Stripe.Charge/PaymentIntent's typed field.
    const fee = i.connectedAccountId ? applicationFee(nonTip, i.tip, i.platformFeeBps) : undefined;
    const params: Stripe.PaymentIntentCreateParams = {
      amount: total,
      currency: i.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      capture_method: i.capture,
      metadata: {
        ...i.metadata,
        operatorId: i.operatorId,
        ticketId: i.ticketId,
        base: String(i.base),
        tip: String(i.tip),
        tax: String(i.tax),
        fees: String(i.fees),
        ...(fee !== undefined ? { applicationFee: String(fee) } : {}),
      },
    };
    if (i.connectedAccountId) {
      params.transfer_data = { destination: i.connectedAccountId };
      // `fee` is `number | undefined` at its declaration site — re-narrowing `i.connectedAccountId`
      // here doesn't carry over to `fee`'s type (exactOptionalPropertyTypes rejects the union), so
      // recompute rather than assign the outer const directly. Same inputs, same value.
      params.application_fee_amount = applicationFee(nonTip, i.tip, i.platformFeeBps);
    }
    if (i.customerRef) params.customer = i.customerRef;
    if (i.method === 'tap_to_pay' || i.method === 'reader') {
      params.payment_method_types = ['card_present'];
      delete params.automatic_payment_methods;
    }
    const pi = await this.s.paymentIntents.create(params, { idempotencyKey: checkoutIdempotencyKey(i) });
    const out: CheckoutResult = { clientSecret: pi.client_secret ?? '', providerRef: pi.id, publishableKey: this.opts.publishableKey };
    if (i.customerRef && i.method === 'in_app') {
      const ek = await this.s.ephemeralKeys.create({ customer: i.customerRef }, { apiVersion: API_VERSION });
      out.customerId = i.customerRef;
      out.ephemeralKey = ek.secret ?? '';
    }
    return out;
  }

  async capture(i: { providerRef: string; amount?: number; final?: boolean }): Promise<void> {
    // `final` only matters when partially capturing (Stripe's multicapture): omitting amount_to_capture
    // captures the full authorized amount and final_capture is meaningless there, so it's left out.
    try {
      await this.s.paymentIntents.capture(
        i.providerRef,
        i.amount !== undefined ? { amount_to_capture: i.amount, final_capture: i.final ?? true } : {},
      );
    } catch (e) {
      if ((e as { code?: string }).code !== 'payment_intent_unexpected_state') throw e;
      // M2 (final review): a redelivered `onJobWritten` capture invocation (the dispatch trigger's
      // own retry:true redelivery after THIS SAME invocation crashed post-capture, or any other
      // duplicate capture attempt) hits this generic "unexpected state" code when Stripe refuses a
      // second capture on an intent that already succeeded. Retrieve and check: if it's genuinely
      // `succeeded`, the capture already landed — treat this call as a no-op success, exactly the
      // `cancelAuthorization` retrieve-guard shape above. Any other unexpected state is a real
      // surprise here (there is no legitimate reason a manual-capture intent sitting at, say,
      // `canceled` or `requires_payment_method` would reach this call) and must propagate.
      const intent = await this.s.paymentIntents.retrieve(i.providerRef);
      if (intent.status !== 'succeeded') throw e;
    }
  }

  async updateTip(i: {
    providerRef: string;
    base: number;
    tip: number;
    tax: number;
    fees: number;
    platformFeeBps: number;
    connectedAccountId?: string;
  }): Promise<void> {
    const params: Stripe.PaymentIntentUpdateParams = { amount: i.base + i.tip + i.tax + i.fees, metadata: { tip: String(i.tip) } };
    if (i.connectedAccountId) params.application_fee_amount = applicationFee(i.base + i.tax + i.fees, i.tip, i.platformFeeBps);
    await this.s.paymentIntents.update(i.providerRef, params);
  }

  async cancelIntent(i: { providerRef: string; reason: 'duplicate' | 'abandoned' | 'requested_by_customer' }): Promise<void> {
    try {
      await this.s.paymentIntents.cancel(i.providerRef, { cancellation_reason: i.reason });
    } catch (e) {
      // Swallow only Stripe's specific "already past a cancellable state" error code — anything
      // else (network errors, auth errors, a genuinely-missing intent) must propagate rather than
      // be silently absorbed by a loose message-substring match.
      if ((e as { code?: string }).code !== 'payment_intent_unexpected_state') throw e;
      // F2 (final review): `payment_intent_unexpected_state` is Stripe's generic "already past a
      // cancellable state" error — that covers a genuinely benign race (e.g. the guest cancelled
      // from another tab) but ALSO an intent that already SUCCEEDED. Blindly swallowing let
      // runCheckout (checkout.ts) fall through and mint a SECOND intent whenever a webhook lagged
      // behind the guest re-submitting (checkout.ts's re-price/re-checkout path calls cancelIntent
      // on the ticket's `lastIntentId` before creating a new one) — a genuine double-charge window,
      // not just a UI race. Retrieve the intent and check its real status: if it's actually paid
      // (succeeded/processing/requires_capture — capture pending, but the card has already been
      // charged), surface `payment_already_paid` instead of letting the caller proceed to a new
      // intent. Any other post-cancellable status (canceled, requires_payment_method after a
      // decline, etc.) is the genuinely-cancellable race and stays swallowed, unchanged.
      const intent = await this.s.paymentIntents.retrieve(i.providerRef);
      if (ALREADY_PAID_INTENT_STATUSES.has(intent.status)) throw err('payment_already_paid');
    }
  }

  /**
   * Plan 5 T2 (pre-flight CRITICAL CONFLICT flag): jobs (drive_home/passenger_ride) authorize at
   * confirm via `capture:'manual'` — the intent legitimately sits at `requires_capture` from
   * confirmation until the job either completes (captured) or is cancelled (must be VOIDED, not
   * charged). `cancelIntent` above cannot be reused for that void: its F2 guard puts
   * `requires_capture` in `ALREADY_PAID_INTENT_STATUSES` and throws `payment_already_paid` — correct
   * for cancelIntent's own callers (checkout.ts's re-price/re-checkout path, which only ever cancels
   * a PRE-CONFIRMATION intent that should never legitimately be sitting at requires_capture — reaching
   * it there really does mean the card was already authorized behind the caller's back), but wrong
   * here: requires_capture is the EXPECTED, routine starting state for a job cancellation, not an
   * error condition.
   *
   * This method is the deliberate difference: its OWN "already paid, can't void" set is
   * `{succeeded, processing}` — `requires_capture` deliberately excluded (it's the EXPECTED, routine
   * starting state for a job cancellation here, not evidence of a race) — whereas `cancelIntent`'s
   * `ALREADY_PAID_INTENT_STATUSES` includes all three. `processing` stays in this method's own
   * already-paid set: it means a capture is CURRENTLY in flight (e.g. a concurrent job-completion
   * capture racing this cancellation) — genuinely too late to void, same as `succeeded`. `refund.ts`'s
   * `refundRequestedHandler` calls this instead of `cancelIntent` for its `claimed.status ===
   * 'authorized'` branch.
   */
  async cancelAuthorization(i: { providerRef: string; reason: 'duplicate' | 'abandoned' | 'requested_by_customer' }): Promise<void> {
    try {
      await this.s.paymentIntents.cancel(i.providerRef, { cancellation_reason: i.reason });
    } catch (e) {
      if ((e as { code?: string }).code !== 'payment_intent_unexpected_state') throw e;
      const intent = await this.s.paymentIntents.retrieve(i.providerRef);
      if (intent.status === 'canceled') return; // already void (a concurrent cancel/webhook got there first) — idempotent no-op
      if (intent.status === 'succeeded' || intent.status === 'processing') throw err('payment_already_paid'); // genuinely captured (or capturing right now) — nothing to void, caller must refund instead
      throw e; // any other unexpected state (notably requires_capture itself) is a real surprise here — surface it rather than silently swallow
    }
  }

  async refund(i: { providerRef: string; amount?: number; reason: string; idempotencyKey?: string; reverseTransfer?: boolean }): Promise<{ refundRef: string }> {
    // Stripe's `reason` is a closed enum; pass the caller's reason through only when it's literally
    // one of Stripe's three values, otherwise fall back to 'requested_by_customer' — the original
    // free-text reason is preserved either way in metadata.reason, never dropped.
    const reason: StripeRefundReason = isStripeRefundReason(i.reason) ? i.reason : 'requested_by_customer';
    const r = await this.s.refunds.create(
      {
        payment_intent: i.providerRef,
        ...(i.amount !== undefined ? { amount: i.amount } : {}),
        reason,
        // Ruling AI (1d final review, finding 2): destination-charge refunds default to repaying the
        // customer out of the PLATFORM balance while the connected account keeps its full transfer —
        // conditional (Stripe 400s if passed on a non-transfer charge) on the caller having confirmed
        // this WAS a destination charge. refund_application_fee:false is explicit (not Stripe's
        // default) — the fee retained on a full refund is exactly what offsets reverse_transfer's
        // pull from the platform balance, netting the platform to 0; a proportional partial reverses
        // proportionally by Stripe's own accounting, same reasoning.
        ...(i.reverseTransfer ? { reverse_transfer: true, refund_application_fee: false } : {}),
        metadata: { reason: i.reason },
      },
      i.idempotencyKey !== undefined ? { idempotencyKey: i.idempotencyKey } : undefined,
    );
    return { refundRef: r.id };
  }

  async createTerminalConnectionToken(i: { operatorId: string; locationRef?: string }): Promise<{ secret: string }> {
    const t = await this.s.terminal.connectionTokens.create(i.locationRef ? { location: i.locationRef } : {});
    return { secret: t.secret };
  }

  async ensureTerminalLocation(i: {
    operatorId: string;
    venueName: string;
    address: { line1: string; city: string; region: string; postalCode: string; country: string };
    stripeAccount?: string;
  }): Promise<{ locationRef: string }> {
    const loc = await this.s.terminal.locations.create(
      {
        display_name: i.venueName,
        address: { line1: i.address.line1, city: i.address.city, state: i.address.region, postal_code: i.address.postalCode, country: i.address.country },
      },
      i.stripeAccount ? { stripeAccount: i.stripeAccount } : undefined,
    );
    return { locationRef: loc.id };
  }

  async connectOnboardingLink(i: {
    operatorId: string;
    kind: 'operator' | 'worker';
    accountId?: string;
    refreshUrl: string;
    returnUrl: string;
    email?: string;
  }): Promise<{ url: string; accountId: string }> {
    const accountId =
      i.accountId ??
      (
        await this.s.accounts.create({
          type: 'express',
          ...(i.email ? { email: i.email } : {}),
          capabilities: { transfers: { requested: true }, ...(i.kind === 'operator' ? { card_payments: { requested: true } } : {}) },
          metadata: { operatorId: i.operatorId, kind: i.kind },
        })
      ).id;
    const link = await this.s.accountLinks.create({ account: accountId, refresh_url: i.refreshUrl, return_url: i.returnUrl, type: 'account_onboarding' });
    return { url: link.url, accountId };
  }

  async getAccountStatus(i: { accountId: string }): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: string[] }> {
    const a = await this.s.accounts.retrieve(i.accountId);
    return { chargesEnabled: a.charges_enabled, payoutsEnabled: a.payouts_enabled, requirementsDue: a.requirements?.currently_due ?? [] };
  }

  async transfer(i: {
    amount: number;
    currency: string;
    destinationAccountId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<{ transferRef: string }> {
    const t = await this.s.transfers.create(
      { amount: i.amount, currency: i.currency.toLowerCase(), destination: i.destinationAccountId, metadata: i.metadata },
      { idempotencyKey: i.idempotencyKey },
    );
    return { transferRef: t.id };
  }

  /**
   * Plan 6 (guest account, guestSetupIntent): a deterministic per-guest idempotency key — NOT
   * randomized per call — so two concurrent callers who both observe `guests/{uid}` with no
   * `stripeCustomerId` yet (the exact race guestSetupIntent's own doc, and this checkout.ts call
   * site's existing race, are both exposed to) resolve to the SAME Stripe customer object instead of
   * minting two. Stripe caches an idempotent request's response server-side for 24h and replays it
   * verbatim for any repeat with the same key, regardless of which of the two racing invocations
   * "wins" the actual HTTP round trip — no Firestore-side transaction/lock needed to get a single
   * customer out of this. checkout.ts's pre-existing `ensureCustomer` call site (guestCheckoutHandler)
   * benefits from the same fix for free; unchanged call shape, so nothing else there moves.
   */
  async ensureCustomer(i: { guestUid: string; phone?: string; existing?: string }): Promise<{ customerId: string }> {
    if (i.existing) return { customerId: i.existing };
    const c = await this.s.customers.create({ metadata: { guestUid: i.guestUid }, ...(i.phone ? { phone: i.phone } : {}) }, { idempotencyKey: `guest_customer_${i.guestUid}` });
    return { customerId: c.id };
  }

  /** Plan 6 (guest account, guestListPaymentMethods): `type: 'card'` per task-4-brief.md's spec —
   * see StripeClientLike.paymentMethods' own comment on why the bare list endpoint (not the
   * Treasury-flavored one its JSDoc now points elsewhere for) is still the right call here. */
  async listPaymentMethods(i: { customerId: string }): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number }[]> {
    const res = await this.s.paymentMethods.list({ customer: i.customerId, type: 'card' });
    return res.data.filter((pm) => pm.card !== undefined).map((pm) => ({ id: pm.id, brand: pm.card!.brand, last4: pm.card!.last4, expMonth: pm.card!.exp_month, expYear: pm.card!.exp_year }));
  }

  async retrievePaymentMethod(i: { id: string }): Promise<{ id: string; customerId?: string }> {
    const pm = await this.s.paymentMethods.retrieve(i.id);
    const customerId = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id;
    return { id: pm.id, ...(customerId !== undefined ? { customerId } : {}) };
  }

  async detachPaymentMethod(i: { id: string }): Promise<void> {
    await this.s.paymentMethods.detach(i.id);
  }

  async createSetupIntent(i: { customerId: string }): Promise<{ clientSecret: string; ephemeralKey: string; publishableKey: string }> {
    const si = await this.s.setupIntents.create({ customer: i.customerId, payment_method_types: ['card'], usage: 'off_session' });
    const ek = await this.s.ephemeralKeys.create({ customer: i.customerId }, { apiVersion: API_VERSION });
    return { clientSecret: si.client_secret ?? '', ephemeralKey: ek.secret ?? '', publishableKey: this.opts.publishableKey };
  }

  // Not `async`: Stripe's `webhooks.constructEvent` is synchronous (throws on bad signature rather
  // than rejecting), so there is no `await` in this body. The port still promises `Promise<...>` —
  // wrap the computed result instead of marking the method async with no await in it.
  parseWebhook(i: { rawBody: Buffer; signature: string; secret: string }): Promise<PaymentEvent[]> {
    const ev = this.s.webhooks.constructEvent(i.rawBody, i.signature, i.secret) as Stripe.Event;
    // Plan 8 T1: account.updated carries a Stripe.Account — handled BEFORE the intent/charge
    // derivation below, whose `o.currency`/metadata reads would throw on an Account object. No
    // money moves in this event: the amount fields are structural zeros.
    if (ev.type === 'account.updated') {
      const acct = ev.data.object;
      return Promise.resolve([
        {
          kind: 'account_updated',
          eventId: ev.id,
          providerRef: acct.id,
          accountId: acct.id,
          payoutsEnabled: acct.payouts_enabled,
          chargesEnabled: acct.charges_enabled,
          requirementsDue: acct.requirements?.currently_due ?? [],
          amount: 0,
          tip: 0,
          base: 0,
          tax: 0,
          fees: 0,
          currency: 'USD',
        },
      ]);
    }
    const o = ev.data.object as Stripe.PaymentIntent | Stripe.Charge;
    const md = o.metadata as Record<string, string>;
    const n = (k: string) => Number(md[k] ?? 0);
    // Ruling AW: applicationFee comes from checkout's mirrored metadata (undefined for non-connected
    // charges, so platformFee is simply omitted from the tx row rather than written as 0);
    // destinationAccountId is read structurally off the real `transfer_data.destination` field
    // (present on both PaymentIntent and Charge in the destination-charge model) rather than trusted
    // from metadata — it's the actual charge's destination, not a copy that could drift.
    const destination = o.transfer_data?.destination;
    const destinationAccountId = typeof destination === 'string' ? destination : undefined;
    // md's values are `string | undefined` under noUncheckedIndexedAccess (Record index access), so
    // operatorId/ticketId must be spread in conditionally rather than assigned directly — an
    // explicit `undefined` on an optional field is rejected under exactOptionalPropertyTypes.
    const base = {
      eventId: ev.id,
      base: n('base'),
      tip: n('tip'),
      tax: n('tax'),
      fees: n('fees'),
      ...(md.operatorId !== undefined ? { operatorId: md.operatorId } : {}),
      ...(md.ticketId !== undefined ? { ticketId: md.ticketId } : {}),
      ...(md.applicationFee !== undefined ? { applicationFee: Number(md.applicationFee) } : {}),
      ...(destinationAccountId !== undefined ? { destinationAccountId } : {}),
      currency: o.currency.toUpperCase(),
    };
    switch (ev.type) {
      case 'payment_intent.succeeded': {
        const pi = o as Stripe.PaymentIntent;
        const chargeRef = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
        return Promise.resolve([
          {
            kind: 'payment_succeeded',
            providerRef: pi.id,
            amount: pi.amount_received,
            ...(chargeRef !== undefined ? { chargeRef } : {}),
            ...base,
          },
        ]);
      }
      // NOTE: Stripe re-fires `amount_capturable_updated` on every partial capture, not just the
      // initial authorization — a consumer treating every occurrence here as "newly authorized"
      // will double-process partial-capture flows. Re-fire dedup / idempotent consumption is not
      // handled in this adapter; it's Plan 8's job (the webhook processing layer above this port).
      case 'payment_intent.amount_capturable_updated': {
        const pi = o as Stripe.PaymentIntent;
        return Promise.resolve([{ kind: 'payment_authorized', providerRef: pi.id, amount: pi.amount_capturable, ...base }]);
      }
      case 'payment_intent.payment_failed': {
        const pi = o as Stripe.PaymentIntent;
        const failureMessage = pi.last_payment_error?.message;
        return Promise.resolve([
          { kind: 'payment_failed', providerRef: pi.id, amount: pi.amount, ...(failureMessage !== undefined ? { failureMessage } : {}), ...base },
        ]);
      }
      case 'charge.refunded': {
        const ch = o as Stripe.Charge;
        return Promise.resolve([
          {
            kind: 'refunded',
            providerRef: typeof ch.payment_intent === 'string' ? ch.payment_intent : '',
            amount: ch.amount,
            refundAmount: ch.amount_refunded,
            chargeRef: ch.id,
            ...base,
          },
        ]);
      }
      default:
        return Promise.resolve([]);
    }
  }
}
