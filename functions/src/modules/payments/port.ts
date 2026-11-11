export interface CheckoutInput {
  operatorId: string;
  ticketId: string;
  base: number;
  tip: number;
  tax: number;
  fees: number;
  currency: string;
  method: 'web' | 'in_app' | 'tap_to_pay' | 'reader';
  capture: 'automatic' | 'manual';
  connectedAccountId?: string;
  platformFeeBps: number;
  customerRef?: string;
  metadata: Record<string, string>;
}

export interface CheckoutResult {
  clientSecret: string;
  providerRef: string;
  publishableKey: string;
  customerId?: string;
  ephemeralKey?: string;
}

export type PaymentEvent = {
  kind: 'payment_succeeded' | 'payment_authorized' | 'payment_failed' | 'refunded' | 'account_updated';
  eventId: string;
  providerRef: string;
  amount: number;
  tip: number;
  base: number;
  tax: number;
  fees: number;
  currency: string;
  operatorId?: string;
  ticketId?: string;
  chargeRef?: string;
  failureMessage?: string;
  refundRef?: string;
  refundAmount?: number;
  // Ruling AW (1d final review, finding 17): the platform's cut of a connected-account charge, for
  // payout reconstruction after a `platformFeeBps` change. Sourced from the intent/charge's own
  // `application_fee_amount` (mirrored into checkout metadata at creation for dashboard visibility),
  // never trusted from metadata alone.
  applicationFee?: number;
  // The connected account the charge transferred to, when this was a destination charge — read
  // structurally off `transfer_data.destination`, not reconstructed from metadata.
  destinationAccountId?: string;
  // kind 'account_updated' only (Plan 8 T1): the Connect account whose capability state changed.
  // amount/tip/base/tax/fees are 0 for this kind — no money moves in the event itself.
  accountId?: string;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  requirementsDue?: string[];
};

export interface PaymentGateway {
  createCheckout(i: CheckoutInput): Promise<CheckoutResult>;
  capture(i: { providerRef: string; amount?: number; final?: boolean }): Promise<void>;
  updateTip(i: {
    providerRef: string;
    base: number;
    tip: number;
    tax: number;
    fees: number;
    platformFeeBps: number;
    connectedAccountId?: string;
  }): Promise<void>;
  refund(i: { providerRef: string; amount?: number; reason: string; idempotencyKey?: string; reverseTransfer?: boolean }): Promise<{ refundRef: string }>;
  // uncaptured/unconfirmed intents (re-priced checkouts, voided authorizations of an intent that
  // never reached requires_capture — e.g. a still-pending/failed checkout being replaced)
  cancelIntent(i: { providerRef: string; reason: 'duplicate' | 'abandoned' | 'requested_by_customer' }): Promise<void>;
  // Plan 5 T2: voids a MANUAL-CAPTURE intent that IS at requires_capture (a job's authorized-but-
  // uncaptured payment being cancelled before completion) — deliberately distinct from cancelIntent:
  // cancelIntent's F2 guard treats requires_capture as "already paid" (correct for ITS callers, which
  // only ever cancel a pre-confirmation checkout intent that should never legitimately reach
  // requires_capture) and would throw payment_already_paid on a legitimate job-cancellation void. See
  // stripe.adapter.ts's cancelAuthorization for the full contrast.
  cancelAuthorization(i: { providerRef: string; reason: 'duplicate' | 'abandoned' | 'requested_by_customer' }): Promise<void>;
  createTerminalConnectionToken(i: { operatorId: string; locationRef?: string }): Promise<{ secret: string }>;
  ensureTerminalLocation(i: {
    operatorId: string;
    venueName: string;
    address: { line1: string; city: string; region: string; postalCode: string; country: string };
    stripeAccount?: string;
  }): Promise<{ locationRef: string }>;
  connectOnboardingLink(i: {
    operatorId: string;
    kind: 'operator' | 'worker';
    accountId?: string;
    refreshUrl: string;
    returnUrl: string;
    email?: string;
  }): Promise<{ url: string; accountId: string }>;
  transfer(i: {
    amount: number;
    currency: string;
    destinationAccountId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<{ transferRef: string }>;
  ensureCustomer(i: { guestUid: string; phone?: string; existing?: string }): Promise<{ customerId: string }>;
  parseWebhook(i: { rawBody: Buffer; signature: string; secret: string }): Promise<PaymentEvent[]>;
  // Task 6 (connectAccountStatus): Stripe's own `charges_enabled`/`payouts_enabled`/
  // `requirements.currently_due` for a Connect account — read-only, no money movement.
  getAccountStatus(i: { accountId: string }): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: string[] }>;
  // Plan 6 (guest account): the guest's saved cards. Server-verified against the installed `stripe`
  // SDK's `PaymentMethodListParams`/`PaymentMethod` shapes (node_modules/stripe/types/
  // PaymentMethodsResource.d.ts, PaymentMethods.d.ts — not memory, per this repo's Context7 rule) —
  // `type: 'card'` narrows to the guest-facing "saved cards" list the callable contract promises;
  // methods with no `card` sub-object (shouldn't occur given the type filter, but the SDK types it as
  // optional) are dropped rather than surfaced with fabricated brand/last4/exp values.
  listPaymentMethods(i: { customerId: string }): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number }[]>;
  // Read-only lookup used to verify a PaymentMethod id the CALLER supplied actually belongs to
  // their own Stripe customer before any mutating call touches it (guestDetachPaymentMethod) — never
  // trust an id's ownership from client input alone (the 4b cross-tenant-oracle lesson). `customerId`
  // is omitted when Stripe reports no attached customer (a detached/free-floating PaymentMethod).
  retrievePaymentMethod(i: { id: string }): Promise<{ id: string; customerId?: string }>;
  detachPaymentMethod(i: { id: string }): Promise<void>;
  // Bundles a SetupIntent + a scoped ephemeral key for the guest app's PaymentSheet "add a card" (setup
  // mode) flow — mirrors createCheckout's own ephemeralKeys.create call for the `in_app` method rather
  // than inventing a second convention for the same client-SDK requirement.
  createSetupIntent(i: { customerId: string }): Promise<{ clientSecret: string; ephemeralKey: string; publishableKey: string }>;
}
