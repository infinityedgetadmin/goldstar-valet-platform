import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { rejectOversized } from '../../lib/requestSize.js';
import { StripeGateway } from './stripe.adapter.js';
import { stripeClient } from './stripeClient.js';
import { applyPaymentEvent } from './applyEvent.js';
import type { PaymentEvent, PaymentGateway } from './port.js';

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

/** The slice of an incoming request the handler reads. Structural so tests pass plain objects. */
export interface WebhookRequest {
  get(header: string): string | undefined;
  rawBody: Buffer;
}
/** The slice of the response the handler drives — Express's chainable `status().send()/json()`. */
export interface WebhookResponse {
  status(code: number): WebhookResponse;
  send(body: string): void;
  json(body: unknown): void;
}
export interface WebhookContext {
  deps: Deps;
  gw: Pick<PaymentGateway, 'parseWebhook'>;
  secret: string;
  /** Seam for the transport tests (N4). Defaults to the real applier. */
  apply?: (deps: Deps, ev: PaymentEvent) => Promise<unknown>;
}

/**
 * Plan 8 Task 3 (#7): the transport, separated from its trigger so it can be exercised with a
 * scripted gateway and a fake request/response — the previous shape (secrets + Admin SDK
 * constructed inline in the trigger body) had no tests at all; every one of the 29 tests in
 * webhook.test.ts drove applyPaymentEvent directly.
 *
 * FAILURE POSTURE (audit note N4, decided here): events are applied IN ORDER and a throw on any
 * one of them answers 400 WITHOUT rolling back the ones before it. That is deliberate and safe,
 * not an oversight: every event is idempotent per event.id (applyPaymentEvent claims
 * processedEvents/stripe_{eventId} inside its own transaction), so Stripe's redelivery of the same
 * payload finds the applied events as 'duplicate' and resumes at the one that failed. A batch-
 * atomic alternative would need a cross-event transaction whose only effect is to make redelivery
 * re-do work already done. Pinned by "N4" in webhook.test.ts.
 */
export async function handleStripeWebhook(ctx: WebhookContext, req: WebhookRequest, res: WebhookResponse): Promise<void> {
  const sig = req.get('stripe-signature');
  if (!sig) {
    res.status(400).send('missing signature');
    return;
  }
  const apply = ctx.apply ?? applyPaymentEvent;
  try {
    const events = await ctx.gw.parseWebhook({ rawBody: req.rawBody, signature: sig, secret: ctx.secret });
    for (const ev of events) await apply(ctx.deps, ev);
    res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe webhook', (e as Error).message);
    res.status(400).send('invalid');
  }
}

export const stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  if (rejectOversized(req, res)) return; // Plan 8 Task 16: ≤1 MiB before any signature work
  const gw = new StripeGateway(stripeClient(STRIPE_SECRET_KEY.value()), { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '' });
  await handleStripeWebhook({ deps: makeDeps(), gw, secret: STRIPE_WEBHOOK_SECRET.value() }, req, res);
});
