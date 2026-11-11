import type { CallableParsedInput, CallableOutput, Operator, Ticket, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { pricedForSettlement, type SettlementAmounts } from '../payments/pricing.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { requireVenueUser } from '../venue/hostRequest.js';
import { PAID_STATUSES } from '../venue/validation.js';
import { getPos } from './registry.js';
import { PROVIDER_CLAIM_TTL_MS } from '../../lib/providerClaim.js';

/**
 * `posAddValetCharge` (Plan 7 Task 3): puts the guest's valet total on their restaurant check as
 * a line item, and settles the valet ticket on our side.
 *
 * Ticket-side effects follow the original brief's own decision line, expressible 1:1 in the
 * shipped enums (disclosed in task-3-report.md): POS-added charges are **`billTo: 'guest'`,
 * collected by the restaurant** — the guest pays their dinner bill, the restaurant remits per
 * its own agreement — so the ticket's payment becomes `{ status: 'paid', method: 'pos',
 * billTo: 'guest' }` with the SERVER-priced amounts (`priceTicket` at now — which also consumes
 * any validation already redeemed onto this ticket via `payment.validationAmount`), plus a
 * `transactions` row `{ kind: 'charge', provider: 'pos', method: 'pos', status: 'succeeded' }`
 * whose `providerRef` is the opaque checkRef.
 *
 * Idempotency & crash ordering (the add-selection call is NOT idempotent at Toast):
 * `processedEvents/posCharge_{ticketId}` is a CLAIM taken inside a transaction BEFORE the POS
 * call — the sibling of fix-round M1's re-claim, applied here instead of accepting the
 * check-then-act residual a third time. The transaction also RE-READS the ticket, so the money
 * gates run against the state as it IS, not the pre-read snapshot (Task 4's snapshot-vs-now
 * class). Two concurrent calls (the double-tap): one creates the `pending` claim, the loser gets
 * 'charge in progress' — no duplicated line item. States: `pending` fresh → refuse; `pending`
 * stale or `failed` → transactional re-claim (the retry may name a different check — a failed
 * attempt put no verified item on any check); `posted` → complete the Firestore side WITHOUT
 * re-posting, bound to the MARKER's checkRef (a retry naming a different check is rejected —
 * the money landed on the marker's check, and completing would write providerRef for a check
 * the item never touched) and to the marker's FROZEN amounts (hourly valet bases grow — a late
 * retry must settle at what was POSTED, not a re-price; see pricing.ts's pricedForSettlement).
 * The residual narrows to genuine response loss: the POS call succeeded but we recorded
 * `failed` — a retry re-posts, staff-visible and venue-voidable at the POS, chosen over the
 * inverse ordering whose failure (ticket marked paid, charge never on the check) is invisible
 * and unrecoverable.
 *
 * CONFIG NOTE (with the adapter's constraints): our priced total INCLUDES our valet tax; the
 * venue's Toast item should be configured non-taxed or the guest is taxed twice. Operator-facing
 * setup docs, not just here.
 */
interface PosChargeMarker {
  status: 'pending' | 'failed' | 'posted';
  at: string;
  checkRef: string;
  ticketId: string;
  /** Frozen at post time — see the doc-block and pricing.ts's pricedForSettlement. */
  priced?: SettlementAmounts;
}

export async function posAddValetChargeHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'posAddValetCharge'>,
): Promise<CallableOutput<'posAddValetCharge'>> {
  const c = requireVenueUser(caller, input.venueId);
  await requireActiveOperator(deps, c.operatorId);

  const [opSnap, venueSnap, ticketSnap] = await Promise.all([
    deps.db.doc(P.operator(c.operatorId)).get(),
    deps.db.doc(P.venue(c.operatorId, input.venueId)).get(),
    deps.db.doc(P.ticket(c.operatorId, input.ticketId)).get(),
  ]);
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');
  const ticket = ticketSnap.data() as Ticket | undefined;
  if (!ticket) throw err('not_found', 'ticket');
  if (ticket.venueId !== input.venueId) throw err('failed_precondition', 'ticket is at a different venue');
  if (ticket.jobType !== 'valet') throw err('failed_precondition', 'only valet tickets can be added to a check');
  if (ticket.status === 'closed' || ticket.status === 'cancelled') throw err('ticket_closed');
  if (ticket.payment && PAID_STATUSES.includes(ticket.payment.status)) throw err('payment_already_paid');

  const ticketRef = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const markerRef = deps.db.doc(`processedEvents/posCharge_${input.ticketId}`);
  const claim = await deps.db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ticketRef)).data() as Ticket | undefined;
    if (!fresh) throw err('not_found', 'ticket');
    // Live money gates (the pre-read versions above are fast-fail only, not authoritative).
    if (fresh.status === 'closed' || fresh.status === 'cancelled') throw err('ticket_closed');
    if (fresh.payment && PAID_STATUSES.includes(fresh.payment.status)) throw err('payment_already_paid');
    const marker = (await tx.get(markerRef)).data() as PosChargeMarker | undefined;
    if (marker) {
      if (marker.status === 'posted') {
        if (marker.checkRef !== input.checkRef) {
          throw err('failed_precondition', 'charge already completed against a different check');
        }
        return { kind: 'posted' as const, fresh, marker };
      }
      if (marker.status === 'pending' && Date.parse(marker.at) > Date.parse(deps.now()) - PROVIDER_CLAIM_TTL_MS) {
        throw err('failed_precondition', 'charge in progress');
      }
      tx.update(markerRef, { status: 'pending', at: deps.now(), checkRef: input.checkRef });
      return { kind: 'claimed' as const, fresh };
    }
    tx.create(markerRef, { status: 'pending', at: deps.now(), checkRef: input.checkRef, ticketId: input.ticketId });
    return { kind: 'claimed' as const, fresh };
  });

  const fresh = claim.fresh;
  let priced: SettlementAmounts;
  if (claim.kind === 'posted') {
    priced = claim.marker.priced ?? pricedForSettlement(op, venue, fresh, deps.now());
  } else {
    priced = pricedForSettlement(op, venue, fresh, deps.now());
    const pos = await getPos(deps, c.operatorId, venue);
    try {
      await pos.addCharge({ checkRef: input.checkRef, item: { name: 'Valet parking', amount: priced.total } });
    } catch (e) {
      await markerRef.update({ status: 'failed', at: deps.now() });
      throw e;
    }
    await markerRef.update({ status: 'posted', priced });
  }

  const payment = {
    status: 'paid',
    base: priced.base,
    tip: 0,
    tax: priced.tax,
    fees: priced.fees,
    total: priced.total,
    currency: priced.currency,
    billTo: 'guest',
    method: 'pos',
    paidAt: deps.now(),
    ...(priced.validationId !== undefined ? { validationId: priced.validationId, validationAmount: priced.validationAmount } : {}),
  };
  await ticketRef.update({ payment });
  const txId = `pos_${input.ticketId}`;
  await deps.db
    .doc(P.tx(c.operatorId, txId))
    .create({
      id: txId,
      operatorId: c.operatorId,
      venueId: input.venueId,
      ticketId: input.ticketId,
      provider: 'pos',
      providerRef: input.checkRef,
      kind: 'charge',
      status: 'succeeded',
      base: priced.base,
      tip: 0,
      tax: priced.tax,
      fees: priced.fees,
      total: priced.total,
      currency: priced.currency,
      method: 'pos',
      at: deps.now(),
      refunds: [],
    })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e; // retry after a crash — the row already exists
    });
  await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: input.ticketId, before: fresh, after: { ...fresh, payment } });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'pos.addValetCharge', target: input.ticketId, after: { checkRef: input.checkRef, total: priced.total } });
  return { ok: true };
}

export const posAddValetCharge = defineCallable('posAddValetCharge', {}, posAddValetChargeHandler);
