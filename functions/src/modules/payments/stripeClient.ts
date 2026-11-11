import Stripe from 'stripe';

// Pinned to the API version this installed stripe SDK's typings target
// (node_modules/stripe/types/apiVersion.d.ts -> ApiVersion). Bump only by
// upgrading the `stripe` dependency, never by hand-editing this literal.
export const API_VERSION = '2025-10-29.clover' satisfies Stripe.LatestApiVersion;

export type StripeLike = Pick<
  Stripe,
  'paymentIntents' | 'refunds' | 'terminal' | 'accounts' | 'accountLinks' | 'transfers' | 'customers' | 'ephemeralKeys' | 'webhooks' | 'paymentMethods' | 'setupIntents'
>;

let cached: Stripe | null = null;

export function stripeClient(secretKey: string): StripeLike {
  if (!cached) cached = new Stripe(secretKey, { apiVersion: API_VERSION, typescript: true });
  return cached;
}
