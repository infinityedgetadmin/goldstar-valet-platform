import { FieldValue } from 'firebase-admin/firestore';
import { CHARGE_LABELS, MANAGER_ROLES, type CallableParsedInput, type CallableOutput, type Operator, type Ticket, type Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue, requireVenueUserOrStaff } from '../../lib/venueAccess.js';
import { pricedForSettlement, type SettlementAmounts } from '../payments/pricing.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { PAID_STATUSES } from '../venue/validation.js';
import { getPms } from './registry.js';
import { PROVIDER_CLAIM_TTL_MS } from '../../lib/providerClaim.js';

// Shared claim-takeover TTL — canonical rationale in lib/providerClaim.ts.

/** Charge-claim marker (`processedEvents/pmsCharge_{ticketId}_{seq}`) — see the handler comment. */
interface ChargeMarker {
  status: 'pending' | 'failed' | 'posted';
  at: string;
  ticketId: string;
  seq: number;
  reservationRef: string;
  room: string;
  postingRef?: string;
  /**
   * The amounts ACTUALLY POSTED to the folio, frozen at post time. The crash-retry completion
   * path must write these — never re-price: hourly valet bases GROW, so a late retry re-pricing
   * at retry time would put a ledger total on the ticket that differs from what the folio was
   * charged. (Found by the "is every gate reading state as it is now, or as it was?" audit — this
   * is the inverse case: the ledger must read the money as it WAS when it moved.)
   */
  priced?: SettlementAmounts;
}

/**
 * `pmsPostRoomCharge` (Plan 7 Task 2): puts the ticket's SERVER-priced total on the guest's hotel
 * folio and settles the ticket on our side (`payment.status: 'room_charged'`, `billTo: 'room'`,
 * `pmsPostingRef`). Any job type: payment-level room billing is the same mechanism valet already
 * uses; Ruling W's `ride.billTo: 'room'` additionally lets a room-billed RIDE dispatch, and its
 * folio posting lands here too. A `ride.billTo: 'venue'` ticket is REJECTED — the venue is being
 * invoiced for it (T5); room-charging it as well would collect twice.
 *
 * §9.1, ticket-derived: the input carries no venueId — the TICKET's venueId (always present,
 * server-written) is the venue this call is scoped to, and the caller must hold it (dual gate:
 * hotel portal venue_user or operator staff, same as pmsLookup).
 *
 * The charge write also persists `guest.reservationRef`/`guest.room` on the ticket (T2 addition
 * 1): nothing client-side can (narrow venue_user rules branch, staffOf-gated reservationRef
 * branch, rules expression ceiling), and without it a disputed room charge could not be traced
 * to the reservation the money went to.
 *
 * GENERATIONS (Ruling BB): every deterministic id carries the ticket's `pmsChargeSeq` (absent =
 * 0, uniform `_0` suffix from the start): claim marker `pmsCharge_{ticketId}_{seq}`, reverse
 * marker `pmsReverse_{ticketId}_{seq}`, transaction row `pms_{ticketId}_{seq}`, PMS
 * `referenceId` `{ticketId}_{seq}`. Ruling BA's reversal increments the counter, so a
 * post-reversal re-charge is generation N+1 — its ids cannot collide with the reversed
 * generation's, its transaction row is never swallowed as a "crash retry" of the old one, and a
 * crash retry WITHIN a generation still hits its own generation's ids deterministically.
 *
 * FIRST-CALL CLAIM (sibling of fix-round M1, closed here rather than accepted a third time):
 * the claim marker is now taken INSIDE a transaction that also RE-READS the ticket — the money
 * gates run against the ticket as it IS, not as it was at the pre-read (Task 4's
 * snapshot-vs-now class). Two concurrent first calls: one creates the `pending` claim, the
 * loser's transaction retry reads it fresh and gets 'charge in progress' — no double folio
 * posting from a double-tap. States: `pending` fresh → refuse; `pending` stale (crash) or
 * `failed` → transactional re-claim (the retry MAY name a different reservation — a failed
 * attempt moved no verified money, and binding a correction to the failed attempt's reservation
 * would wedge the host; the settled-money binding applies only to `posted`); `posted` → complete
 * the Firestore side from the MARKER's reservation and FROZEN amounts (M2 + the pricing note on
 * ChargeMarker), rejecting a retry that names a different reservation
 * ('already_charged_other_reservation', Ruling AY — the copy says the charge SUCCEEDED).
 *
 * noPost is re-verified SERVER-SIDE per call (never trusted from an earlier pmsLookup): `block`
 * → failed_precondition('no_post', reason 'no_post'); `fallback_card` → `{ fallback: 'card' }`.
 * Both release the claim — no charge was attempted at the provider, so there is nothing for the
 * claim to guard. A postCharge FAILURE marks the claim `failed` (immediately retryable, like
 * M1's failed state); the residual response-lost window (charge landed, we recorded `failed`)
 * re-posts on retry — folio-visible and hotel-reversible, the same accepted class as before,
 * now narrowed to genuine response loss. BA review N2, for the future adapter author: when that
 * retry names a DIFFERENT reservation, recovery spans TWO folios (the lost posting on the
 * original, the completed one on the new) and both postings share one referenceId across
 * different reservations — behavior under a dedupe-by-reference provider is unpredictable, so a
 * live adapter must not assume referenceId dedupe saves it here.
 */
export async function pmsPostRoomChargeHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'pmsPostRoomCharge'>,
): Promise<CallableOutput<'pmsPostRoomCharge'>> {
  const pre = requireOperator(caller);
  await requireActiveOperator(deps, pre.operatorId);

  const [opSnap, ticketSnap] = await Promise.all([
    deps.db.doc(P.operator(pre.operatorId)).get(),
    deps.db.doc(P.ticket(pre.operatorId, input.ticketId)).get(),
  ]);
  const op = opSnap.data() as Operator;
  const preTicket = ticketSnap.data() as Ticket | undefined;
  if (!preTicket) throw err('not_found', 'ticket');
  const c = await requireVenueUserOrStaff(deps, caller, preTicket.venueId);

  const venue = (await deps.db.doc(P.venue(c.operatorId, preTicket.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');
  const pmsConfig = venue.pms;
  if (!pmsConfig) throw err('failed_precondition', 'pms not configured for this venue');

  // Fast-fail gates on the pre-read (immutable facts + friendly early errors). The MONEY gates
  // re-run inside the claim transaction below against a fresh read — these are not authoritative.
  if (preTicket.status === 'closed' || preTicket.status === 'cancelled') throw err('ticket_closed');
  if (preTicket.payment && PAID_STATUSES.includes(preTicket.payment.status)) throw err('payment_already_paid');
  if (preTicket.ride?.billTo === 'venue') throw err('failed_precondition', 'venue_billed_ride');
  // priceTicket prices job tickets from their quote and throws a BARE Error when it's missing —
  // pre-empt that with a sanitized, actionable code (the job simply isn't ready to settle yet).
  if (preTicket.jobType !== 'valet' && !(preTicket.jobType === 'drive_home' ? preTicket.driveHome?.quote : preTicket.ride?.quote)) {
    throw err('failed_precondition', 'job not yet quoted');
  }

  const ticketRef = deps.db.doc(P.ticket(c.operatorId, input.ticketId));

  // Claim transaction: fresh ticket read → live money gates → claim state machine on the
  // CURRENT generation's marker. All reads precede the one write, per Firestore tx rules.
  const claim = await deps.db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ticketRef)).data() as Ticket | undefined;
    if (!fresh) throw err('not_found', 'ticket');
    if (fresh.status === 'closed' || fresh.status === 'cancelled') throw err('ticket_closed');
    if (fresh.payment && PAID_STATUSES.includes(fresh.payment.status)) throw err('payment_already_paid');
    const seq = fresh.pmsChargeSeq ?? 0;
    const markerRef = deps.db.doc(`processedEvents/pmsCharge_${input.ticketId}_${seq}`);
    const marker = (await tx.get(markerRef)).data() as ChargeMarker | undefined;
    if (marker) {
      if (marker.status === 'posted') {
        // M2: the money moved to the MARKER's reservation — a retry naming another is rejected
        // with copy that reads as SUCCESS-elsewhere, never as a failed charge.
        if (marker.reservationRef !== input.reservationRef || marker.room !== input.room) {
          throw err('failed_precondition', 'charge already completed against a different reservation', { reason: 'already_charged_other_reservation' });
        }
        return { kind: 'posted' as const, fresh, seq, marker };
      }
      if (marker.status === 'pending' && Date.parse(marker.at) > Date.parse(deps.now()) - PROVIDER_CLAIM_TTL_MS) {
        throw err('failed_precondition', 'charge in progress');
      }
      // stale pending (crash) or failed → transactional re-claim; the retry's reservation wins
      // (no verified money moved — see the handler comment).
      tx.update(markerRef, { status: 'pending', at: deps.now(), reservationRef: input.reservationRef, room: input.room });
      return { kind: 'claimed' as const, fresh, seq, markerRef };
    }
    const create: ChargeMarker = { status: 'pending', at: deps.now(), ticketId: input.ticketId, seq, reservationRef: input.reservationRef, room: input.room };
    tx.create(markerRef, create);
    return { kind: 'claimed' as const, fresh, seq, markerRef };
  });

  const { fresh, seq } = claim;
  const txId = `pms_${input.ticketId}_${seq}`;

  let postingRef: string;
  let priced: SettlementAmounts;
  if (claim.kind === 'posted') {
    postingRef = claim.marker.postingRef!;
    // FROZEN amounts from post time (see ChargeMarker.priced). Absent only for a marker written
    // by a pre-freeze build — none shipped, but re-pricing is the only possible fallback there.
    priced = claim.marker.priced ?? pricedForSettlement(op, venue, fresh, deps.now());
  } else {
    const markerRef = claim.markerRef;
    priced = pricedForSettlement(op, venue, fresh, deps.now());
    const pms = await getPms(deps, c.operatorId, venue);
    let reservationNoPost: boolean;
    try {
      const { reservations } = await pms.lookupReservation({ room: input.room });
      const reservation = reservations.find((r) => r.reservationRef === input.reservationRef);
      if (!reservation) {
        await markerRef.delete(); // no charge attempted — nothing for the claim to guard
        throw err('not_found', 'reservation');
      }
      reservationNoPost = reservation.noPost;
    } catch (e) {
      if ((e as { code?: string }).code === 'not_found') throw e; // claim already released above
      await markerRef.update({ status: 'failed', at: deps.now() }); // lookup itself failed — retryable
      throw e;
    }
    if (reservationNoPost) {
      // Both noPost branches release the claim — no charge was attempted at the provider.
      await markerRef.delete();
      if (pmsConfig.noPostBehavior === 'block') throw err('failed_precondition', 'no_post', { reason: 'no_post' });
      return { fallback: 'card' };
    }
    try {
      ({ postingRef } = await pms.postCharge({
        reservationRef: input.reservationRef,
        amount: priced.total,
        currency: priced.currency,
        chargeCode: pmsConfig.chargeCode,
        description: CHARGE_LABELS[fresh.jobType],
        referenceId: `${input.ticketId}_${seq}`,
      }));
    } catch (e) {
      await markerRef.update({ status: 'failed', at: deps.now() });
      throw e;
    }
    await markerRef.update({ status: 'posted', postingRef, priced });
  }

  const payment = {
    status: 'room_charged',
    base: priced.base,
    tip: 0,
    tax: priced.tax,
    fees: priced.fees,
    total: priced.total,
    currency: priced.currency,
    billTo: 'room',
    method: 'pms',
    pmsPostingRef: postingRef,
    paidAt: deps.now(),
    ...(priced.validationId !== undefined ? { validationId: priced.validationId, validationAmount: priced.validationAmount } : {}),
  };
  await ticketRef.update({ payment, 'guest.reservationRef': input.reservationRef, 'guest.room': input.room });
  await deps.db
    .doc(P.tx(c.operatorId, txId))
    .create({
      id: txId,
      operatorId: c.operatorId,
      venueId: fresh.venueId,
      ticketId: input.ticketId,
      provider: 'pms',
      providerRef: postingRef,
      kind: 'room_charge',
      status: 'succeeded',
      base: priced.base,
      tip: 0,
      tax: priced.tax,
      fees: priced.fees,
      total: priced.total,
      currency: priced.currency,
      method: 'pms',
      at: deps.now(),
      refunds: [],
    })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e; // same-generation crash retry — the row already exists
    });
  await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: input.ticketId, before: fresh, after: { ...fresh, payment, guest: { ...fresh.guest, reservationRef: input.reservationRef, room: input.room } } });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'pms.postRoomCharge', target: input.ticketId, after: { reservationRef: input.reservationRef, room: input.room, postingRef, total: priced.total, seq } });
  return { postingRef };
}

export const pmsPostRoomCharge = defineCallable('pmsPostRoomCharge', {}, pmsPostRoomChargeHandler);

/**
 * `staffReverseRoomCharge` (Plan 7 Task 2): reverses a posted room charge on cancel/refund.
 * Manager roles only (owner/admin/lead — the same gate as `staffRefund`; reversing money is never
 * an attendant or venue-host action), scoped by `canAccessVenue` against the ticket's venue.
 *
 * RULING BA: reversal genuinely UNDOES — one transaction resets `payment` to ABSENT (not
 * `'refunded'` with stale figures: a payment object carrying amounts that no longer apply is
 * the assert-something-untrue class; the history lives in the transaction row's `refunds` and
 * the audit log), increments `pmsChargeSeq` (Ruling BB — the next charge is generation N+1),
 * and deletes BOTH of this generation's markers (the charge claim exists to stop double-charging
 * a reservation that, once reversed, has no charge to duplicate; the reverse marker's dedupe job
 * ends the instant the reversal completes atomically here). A reversed ticket is chargeable
 * again — the wrong-guest-on-first-call case now has a correction path. The CARD path is
 * untouched: `'refunded'` in PAID_STATUSES remains correct there.
 *
 * The transaction RE-READS the ticket and gates on the state as it IS (Task 4's snapshot-vs-now
 * class): a concurrent reversal that already reset payment makes this one a no-op — never a
 * double increment or a duplicate refunds entry. Provider idempotency per referenceId (L2 port
 * contract, `rev_{ticketId}_{seq}`) covers the both-called-the-provider interleave.
 *
 * Crash windows: provider reversed + marker written, then crash → retry skips the provider
 * (marker), completes the transaction. Provider reversed, marker NOT written, crash → retry
 * re-calls the provider, which no-ops for the same referenceId (L2). After full completion the
 * 'nothing to reverse' gate fires first (payment is absent) — the deleted markers are never
 * consulted again.
 */
export async function staffReverseRoomChargeHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'staffReverseRoomCharge'>,
): Promise<CallableOutput<'staffReverseRoomCharge'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => (MANAGER_ROLES as readonly string[]).includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);

  const ticketRef = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const ticket = (await ticketRef.get()).data() as Ticket | undefined;
  if (!ticket) throw err('not_found', 'ticket');
  if (!(await canAccessVenue(deps, c, ticket.venueId))) throw err('permission_denied');
  const postingRef = ticket.payment?.pmsPostingRef;
  if (ticket.payment?.status !== 'room_charged' || !postingRef) throw err('failed_precondition', 'nothing to reverse');
  const seq = ticket.pmsChargeSeq ?? 0;

  const txRef = deps.db.doc(P.tx(c.operatorId, `pms_${input.ticketId}_${seq}`));
  // The charge path writes payment before the transaction row; a crash in that window leaves
  // payment saying room_charged with no row to mark refunded. Rare, and self-healing — re-running
  // pmsPostRoomCharge completes the row from its marker — so fail with instructions, not silently.
  if (!(await txRef.get()).exists) throw err('failed_precondition', 'charge record incomplete — retry pmsPostRoomCharge first');

  const venue = (await deps.db.doc(P.venue(c.operatorId, ticket.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');

  const reverseMarkerRef = deps.db.doc(`processedEvents/pmsReverse_${input.ticketId}_${seq}`);
  const markerSnap = await reverseMarkerRef.get();
  let reversedAt: string;
  if (markerSnap.exists) {
    reversedAt = (markerSnap.data() as { at: string }).at;
  } else {
    const pms = await getPms(deps, c.operatorId, venue);
    await pms.reverseCharge({ postingRef, referenceId: `rev_${input.ticketId}_${seq}` });
    reversedAt = deps.now();
    // BA review N1: a concurrent reversal's LOSER can land here after the winner's transaction
    // already deleted this marker, re-creating it for a closed generation — a harmless orphan
    // (seq is monotonic; nothing ever consults a past generation's reverse marker again).
    await reverseMarkerRef.create({ at: reversedAt, ticketId: input.ticketId, seq, postingRef, reason: input.reason }).catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
  }

  const refundRef = `pmsrev_${input.ticketId}_${seq}`;
  const chargeMarkerRef = deps.db.doc(`processedEvents/pmsCharge_${input.ticketId}_${seq}`);
  const applied = await deps.db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ticketRef)).data() as Ticket | undefined;
    const freshPay = fresh?.payment;
    // Live gate (Task 4's class): a concurrent reversal that already reset payment — or a
    // generation that already moved on — makes this transaction a clean no-op.
    if (!fresh || freshPay?.status !== 'room_charged' || freshPay.pmsPostingRef !== postingRef || (fresh.pmsChargeSeq ?? 0) !== seq) {
      return false;
    }
    tx.update(ticketRef, { payment: FieldValue.delete(), pmsChargeSeq: seq + 1 });
    tx.delete(chargeMarkerRef);
    tx.delete(reverseMarkerRef);
    tx.update(txRef, {
      status: 'refunded',
      refunds: FieldValue.arrayUnion({ refundRef, amount: freshPay.total, at: reversedAt, reason: input.reason }),
    });
    return true;
  });

  if (applied) {
    const after: Ticket = { ...ticket, pmsChargeSeq: seq + 1 };
    delete after.payment;
    await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: input.ticketId, before: ticket, after });
    await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'pms.reverseRoomCharge', target: input.ticketId, after: { postingRef, reason: input.reason, seq } });
  }
  // !applied: a concurrent reversal won and did the projection/audit itself — this call's
  // provider interaction was the L2 no-op; returning ok is truthful (the reversal happened).
  return { ok: true };
}

export const staffReverseRoomCharge = defineCallable('staffReverseRoomCharge', {}, staffReverseRoomChargeHandler);
