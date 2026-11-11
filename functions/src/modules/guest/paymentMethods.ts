import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { getPlatformGateway } from '../payments/registry.js';
import { rateLimit } from './rateLimit.js';

/**
 * Task 7 legitimate-use checks (M1/M4), one per callable:
 *
 * - `guestListPaymentMethods` is a pure, cheap read — the payment-methods screen plausibly calls
 *   it on every mount/focus, and a guest navigating back and forth to it a few times in one
 *   session is normal. 30/60s (0.5/s sustained) comfortably covers repeated screen visits while
 *   still bounding a scraping loop.
 * - `guestDetachPaymentMethod` is a mutation a guest calls rarely — removing one saved card, or
 *   cleaning up a couple of old ones in one sitting. 10/600s is generous above that.
 * - `guestSetupIntent` mints real Stripe resources (a customer + ephemeral key + SetupIntent) —
 *   real Stripe-side cost. A guest opening "add a card", abandoning, and reopening it a few times
 *   is normal; 10/600s matches the same tier as detach for the same reason (occasional, not
 *   sustained, legitimate use), tighter than the read-only list.
 */
const LIST_MAX_PER_WINDOW = 30;
const LIST_WINDOW_SEC = 60;
const DETACH_MAX_PER_WINDOW = 10;
const DETACH_WINDOW_SEC = 600;
const SETUP_INTENT_MAX_PER_WINDOW = 10;
const SETUP_INTENT_WINDOW_SEC = 600;

// Plan 6 (guest account): these three callables operate on the CALLER's own `guests/{uid}` doc —
// resolved from `caller.uid` via `requireRole`, never from a client-supplied id/token. This is the
// same "resolve identity from the verified caller, never from input" rule the 4b cross-tenant-oracle
// finding established for staff-scoped callables, applied here to the guest side.
//
// Ruling (task-platform-report.md): guest-account ops are NOT gated by `requireActiveOperator` — there
// is no Operator in scope at all (a guest's saved cards/Stripe customer are operator-agnostic, see
// registry.ts's `getPlatformGateway` comment), and even where one guest ticket happens to sit under a
// suspended operator, the guest must still be able to manage their own payment methods/account. This
// mirrors the P4a guest-checkout carve-out (checkout.ts's `runCheckout` comment) — deliberately never
// gated on operator status.

async function requireGuestCustomer(deps: Deps, uid: string): Promise<string | undefined> {
  const g = (await deps.db.doc(P.guest(uid)).get()).data() as { stripeCustomerId?: string } | undefined;
  return g?.stripeCustomerId;
}

export async function guestListPaymentMethodsHandler(
  deps: Deps,
  caller: Caller | null,
  _input: CallableParsedInput<'guestListPaymentMethods'>,
): Promise<CallableOutput<'guestListPaymentMethods'>> {
  void _input;
  const c = requireRole(caller, ['guest']);
  await rateLimit(deps, `guestListPaymentMethods:${c.uid}`, LIST_MAX_PER_WINDOW, LIST_WINDOW_SEC);
  const customerId = await requireGuestCustomer(deps, c.uid);
  if (!customerId) return { methods: [] }; // no Stripe customer yet — nothing saved, no Stripe call needed
  const methods = await getPlatformGateway(deps).listPaymentMethods({ customerId });
  return { methods };
}

export async function guestDetachPaymentMethodHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'guestDetachPaymentMethod'>,
): Promise<CallableOutput<'guestDetachPaymentMethod'>> {
  const c = requireRole(caller, ['guest']);
  await rateLimit(deps, `guestDetachPaymentMethod:${c.uid}`, DETACH_MAX_PER_WINDOW, DETACH_WINDOW_SEC);
  const customerId = await requireGuestCustomer(deps, c.uid);
  // No Stripe customer on file at all → the caller cannot possibly own ANY payment method id.
  // `permission_denied` (not `not_found`) — same oracle-avoidance reasoning as the mismatch check
  // below: a nonexistent id and a real-but-not-mine id must look identical to the caller.
  if (!customerId) throw err('permission_denied');
  const gw = getPlatformGateway(deps);
  let owner: string | undefined;
  try {
    owner = (await gw.retrievePaymentMethod({ id: input.id })).customerId;
  } catch {
    // A fabricated/garbage id throws (Stripe's resource_missing) rather than returning — normalize
    // to the same permission_denied a real-but-foreign id gets below, so neither response tells the
    // caller whether the id exists at all (the 4b cross-tenant-oracle lesson, applied to existence
    // rather than just ownership).
    throw err('permission_denied');
  }
  if (owner !== customerId) throw err('permission_denied');
  await gw.detachPaymentMethod({ id: input.id });
  await audit(deps, { actorUid: c.uid, action: 'guest.detachPaymentMethod', target: input.id });
  return { ok: true };
}

export async function guestSetupIntentHandler(
  deps: Deps,
  caller: Caller | null,
  _input: CallableParsedInput<'guestSetupIntent'>,
): Promise<CallableOutput<'guestSetupIntent'>> {
  void _input;
  const c = requireRole(caller, ['guest']);
  await rateLimit(deps, `guestSetupIntent:${c.uid}`, SETUP_INTENT_MAX_PER_WINDOW, SETUP_INTENT_WINDOW_SEC);
  const gRef = deps.db.doc(P.guest(c.uid));
  const g = (await gRef.get()).data() as { stripeCustomerId?: string } | undefined;
  const gw = getPlatformGateway(deps);
  // Mirrors checkout.ts's guestCheckoutHandler ensureCustomer call exactly (brief: "mirror
  // established patterns"). ensureCustomer's own deterministic idempotencyKey (stripe.adapter.ts)
  // is what actually prevents two concurrent calls from minting two Stripe customers — both resolve
  // to the same customerId, so the Firestore write below is safe even if both branches run it.
  const { customerId } = await gw.ensureCustomer({
    guestUid: c.uid,
    ...(c.phone !== undefined ? { phone: c.phone } : {}),
    ...(g?.stripeCustomerId !== undefined ? { existing: g.stripeCustomerId } : {}),
  });
  if (!g?.stripeCustomerId) await gRef.set({ stripeCustomerId: customerId, updatedAt: deps.now() }, { merge: true });
  const { clientSecret, ephemeralKey, publishableKey } = await gw.createSetupIntent({ customerId });
  await audit(deps, { actorUid: c.uid, action: 'guest.setupIntent', target: customerId });
  return { clientSecret, customerId, ephemeralKey, publishableKey };
}

export const guestListPaymentMethods = defineCallable('guestListPaymentMethods', { secrets: ['STRIPE_SECRET_KEY'] }, guestListPaymentMethodsHandler);
export const guestDetachPaymentMethod = defineCallable('guestDetachPaymentMethod', { secrets: ['STRIPE_SECRET_KEY'] }, guestDetachPaymentMethodHandler);
export const guestSetupIntent = defineCallable('guestSetupIntent', { secrets: ['STRIPE_SECRET_KEY'] }, guestSetupIntentHandler);
