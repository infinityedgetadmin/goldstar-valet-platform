import type { Operator } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import type { PaymentGateway } from './port.js';
import { StripeGateway } from './stripe.adapter.js';
import { stripeClient } from './stripeClient.js';

/**
 * Plan 6 (guest account): the platform's single Stripe secret key (STRIPE_SECRET_KEY) is shared
 * across every operator — `getGateway` below only ever branches on `op.modules.payments.provider` to
 * pick a class, never on a per-operator credential (confirmed by `checkout.ts`'s `getGateway(deps,
 * op)` call sites and this function's own body). A guest's saved-card/Customer identity is
 * deliberately operator-agnostic — the same `guests/{uid}.stripeCustomerId` is reused as
 * `customerRef` across ANY operator's checkout (see checkout.ts's guestCheckoutHandler) — so the 5
 * guest-account callables (guestListPaymentMethods/guestDetachPaymentMethod/guestSetupIntent/
 * guestDeleteAccount/guestEmailReceipt) have no Operator doc to hand `getGateway` in the first place.
 * Exported directly rather than duplicating the `new StripeGateway(stripeClient(...), {...})`
 * construction at each of those call sites; `getGateway` itself now delegates to this for the
 * 'stripe' case so the two stay a single source of truth.
 */
export function getPlatformGateway(deps: Deps): PaymentGateway {
  // stripeClient() returns `StripeLike` (Pick<Stripe, ...>); it satisfies the adapter's
  // narrower `StripeClientLike` port surface structurally, no cast needed.
  return new StripeGateway(stripeClient(deps.secrets.get('STRIPE_SECRET_KEY')), {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  });
}

export function getGateway(deps: Deps, op: Operator): PaymentGateway {
  // Widened to `string`: `PAYMENT_PROVIDERS` (src/schemas/operator.ts) currently has a single
  // member, so the field's literal type is just `'stripe'` and a switch over it is tautological
  // to the type checker. Widening keeps this registry a real dispatch point as providers are
  // added, instead of eslint's `no-unnecessary-condition` flagging the only-case-that-exists today.
  const provider: string = op.modules.payments.provider;
  switch (provider) {
    case 'stripe':
      return getPlatformGateway(deps);
    default:
      throw err('provider_unavailable', `payments provider ${provider}`);
  }
}
