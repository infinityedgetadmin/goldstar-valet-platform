import type { CallableParsedInput, CallableOutput, Operator, Ticket, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { resolveToken } from '../guest/token.js';
import { rateLimit } from '../guest/rateLimit.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { canAccessVenue } from '../../lib/venueAccess.js';
import { priceTicket } from './pricing.js';
import { getGateway } from './registry.js';

// Exported so guest/staticCheckout.ts (Plan 3 T5) can create-then-checkout in one flow without
// duplicating the pricing/gateway/duplicate-intent-cancellation logic below.
//
// `preloadedOperator` (Ruling C-2): optional — staffCheckoutHandler below already fetches the
// Operator to pass through requireActiveOperator()'s suspension gate before calling this, and passes
// it here too so this doesn't fetch it a second time (zero-extra-read for the staff path). The two
// guest call sites (guestCheckoutHandler, guest/staticCheckout.ts) never pass it — unaffected,
// unchanged, and deliberately NOT gated (guests must stay able to pay/retrieve a parked car
// regardless of the operator's status — controller ruling, ledgered).
export async function runCheckout(
  deps: Deps,
  operatorId: string,
  ticket: Ticket,
  tip: CallableParsedInput<'guestCreateCheckout'>['tip'],
  method: 'web' | 'in_app' | 'tap_to_pay' | 'reader',
  actorUid: string,
  customerRef?: string,
  preloadedOperator?: Operator,
): Promise<CallableOutput<'guestCreateCheckout'>> {
  if (ticket.payment && ['paid', 'authorized', 'room_charged', 'venue_billed'].includes(ticket.payment.status)) throw err('payment_already_paid');
  const op = preloadedOperator ?? ((await deps.db.doc(P.operator(operatorId)).get()).data() as Operator);
  const venue = (await deps.db.doc(P.venue(operatorId, ticket.venueId)).get()).data() as Venue;
  const priced = priceTicket(op, venue, ticket, tip, deps.now());
  const gw = getGateway(deps, op);
  // Re-priced checkout (e.g. tip changed) or a re-checkout after a decline: never leave two
  // confirmable intents outstanding. Ruling AO (finding 8): a 'failed' intent is still
  // requires_payment_method — confirmable from the guest's still-open tab — so 'failed' must be
  // cancelled here too, not just 'pending'; otherwise the guest's stale tab and the new checkout can
  // both be paid, producing two charge rows for one ticket.
  if (ticket.payment?.lastIntentId && ['pending', 'failed'].includes(ticket.payment.status)) {
    await gw.cancelIntent({ providerRef: ticket.payment.lastIntentId, reason: 'duplicate' });
  }
  const res = await gw.createCheckout({
    operatorId,
    ticketId: ticket.id,
    base: priced.base,
    tip: priced.tip,
    tax: priced.tax,
    fees: priced.fees,
    currency: priced.currency,
    method,
    capture: priced.capture,
    ...(op.modules.payments.connectedAccountId !== undefined ? { connectedAccountId: op.modules.payments.connectedAccountId } : {}),
    platformFeeBps: op.modules.payments.platformFeeBps,
    ...(customerRef !== undefined ? { customerRef } : {}),
    metadata: { venueId: ticket.venueId, method },
  });
  const ref = deps.db.doc(P.ticket(operatorId, ticket.id));
  const payment = {
    status: 'pending',
    base: priced.base,
    tip: priced.tip,
    tax: priced.tax,
    fees: priced.fees,
    total: priced.total,
    currency: priced.currency,
    billTo: 'guest',
    lastIntentId: res.providerRef,
    ...(ticket.payment?.validationId !== undefined ? { validationId: ticket.payment.validationId, validationAmount: ticket.payment.validationAmount } : {}),
    method,
  };
  await ref.update({ payment });
  const after = { ...ticket, payment } as unknown as Record<string, unknown>;
  await ticketWrittenHandler(deps, { operatorId, ticketId: ticket.id, before: ticket, after });
  await audit(deps, { operatorId, actorUid, action: 'payment.createCheckout', target: ticket.id, after: { total: priced.total, tip: priced.tip, method } });
  return { clientSecret: res.clientSecret, publishableKey: res.publishableKey, total: priced.total, tip: priced.tip, ...(res.customerId !== undefined ? { customerId: res.customerId } : {}), ...(res.ephemeralKey !== undefined ? { ephemeralKey: res.ephemeralKey } : {}) };
}

export async function guestCheckoutHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestCreateCheckout'>): Promise<CallableOutput<'guestCreateCheckout'>> {
  // resolveToken before rateLimit (1c Ruling M pattern): a fabricated/expired token must fail on
  // guest_token_expired without ever writing a rateLimits doc — zero residue for junk tokens.
  const { operatorId, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `checkout:${input.token}`, 10, 60);
  let customerRef: string | undefined;
  if (caller?.roles.includes('guest')) {
    const g = (await deps.db.doc(P.guest(caller.uid)).get()).data() as { stripeCustomerId?: string } | undefined;
    const op = (await deps.db.doc(P.operator(operatorId)).get()).data() as Operator;
    const { customerId } = await getGateway(deps, op).ensureCustomer({
      guestUid: caller.uid,
      ...(caller.phone !== undefined ? { phone: caller.phone } : {}),
      ...(g?.stripeCustomerId !== undefined ? { existing: g.stripeCustomerId } : {}),
    });
    if (!g?.stripeCustomerId) await deps.db.doc(P.guest(caller.uid)).set({ stripeCustomerId: customerId }, { merge: true });
    customerRef = customerId;
  }
  return runCheckout(deps, operatorId, ticket, input.tip, caller?.roles.includes('guest') ? 'in_app' : 'web', caller?.uid ?? 'guest', customerRef);
}

export async function staffCheckoutHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'staffCreateCheckout'>): Promise<CallableOutput<'staffCreateCheckout'>> {
  const c = requireOperator(caller);
  // Ruling C-2: fetched here (not left to runCheckout's own fetch) so requireActiveOperator can gate
  // on it before any ticket/venue work, then handed through to runCheckout as preloadedOperator so it
  // isn't fetched a second time — net zero extra reads for this call.
  const op = await requireActiveOperator(deps, c.operatorId);
  const t = (await deps.db.doc(P.ticket(c.operatorId, input.ticketId)).get()).data() as Ticket | undefined;
  if (!t) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  return runCheckout(deps, c.operatorId, t, input.tip, input.method, c.uid, undefined, op);
}

export const guestCreateCheckout = defineCallable('guestCreateCheckout', { allowAnonymous: true, secrets: ['STRIPE_SECRET_KEY'] }, guestCheckoutHandler);
export const staffCreateCheckout = defineCallable('staffCreateCheckout', { secrets: ['STRIPE_SECRET_KEY'] }, staffCheckoutHandler);
