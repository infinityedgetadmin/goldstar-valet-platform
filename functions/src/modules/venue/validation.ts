import { randomInt } from 'node:crypto';
import { computeValetPrice, type CallableParsedInput, type CallableOutput, type Ticket, type Validation, type Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue } from '../../lib/venueAccess.js';
import { VALIDATION_TTL_MS } from './policy.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — codes are read aloud at a stand
const CODE_LENGTH = 6;
const CODE_MINT_ATTEMPTS = 5;

// Ruling AE's 24h expiry — defined in policy.ts alongside Ruling AF's ETA grace so the venue
// portal's time policies sit together; re-exported here for module-surface stability.
export { VALIDATION_TTL_MS } from './policy.js';

function mintCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  return out;
}

/** Payment states that mean the ticket's money already moved — too late to change its price.
 * Exported (Plan 7 T3): posAddValetCharge applies the same already-moved guard. */
export const PAID_STATUSES = ['paid', 'authorized', 'room_charged', 'venue_billed', 'refunded'];

/**
 * Ruling O: the redemption amount is computed AT REDEMPTION, never pinned at issue — for hourly
 * rate models the base GROWS between issue and redemption, so a "full" validation issued at 18:00
 * must cover what is actually owed at 21:00. `partial` is the only type whose amount is fixed at
 * issue. `full` and `comp` both discount the full current base (who eats the cost — the venue
 * invoiced vs. the operator comping — is billing ATTRIBUTION owned by the invoicing rollup, not
 * pricing); `rate` discounts down TO the alternate rate: max(0, currentBase − altItem.amount).
 * `computeValetPrice`'s own clamp (validation ≤ base) makes any over-shoot safe downstream.
 * Exported for its own unit tests.
 */
export function redemptionAmount(validation: Pick<Validation, 'type' | 'amount' | 'rateId'>, venue: Venue, ticket: Ticket, now: string): { amount: number; base: number } {
  const { base } = computeValetPrice({ rates: venue.rates.valet, checkedInAt: new Date(ticket.times.checkedInAt), at: new Date(now) });
  switch (validation.type) {
    case 'partial': {
      if (validation.amount === undefined) throw err('failed_precondition', 'partial validation has no amount');
      return { amount: validation.amount, base };
    }
    case 'rate': {
      const item = venue.rates.valet.items.find((i) => i.id === validation.rateId);
      // The alternate rate was edited away since issue — fail honestly rather than guess a price.
      if (!item) throw err('failed_precondition', 'rate no longer available');
      return { amount: Math.max(0, base - item.amount), base };
    }
    case 'full':
    case 'comp':
      return { amount: base, base };
  }
}

export interface RedeemValidationArgs {
  operatorId: string;
  validationId: string;
  ticketId: string;
  actorUid: string;
  /** Audit trail only — which surface redeemed it ('staff' stand entry, 'issue' immediate-apply, 'pos' Task 3). */
  source: 'staff' | 'issue' | 'pos';
  /**
   * Extra fields merged into the validation doc IN THE SAME transaction that redeems it (T3
   * review H1): posApplyValidation claims its POS push (`posPush {checkRef, status:'pending',
   * at}`) atomically with the redemption, so there is no redeemed-but-unclaimed instant for a
   * concurrent duplicate call to slip a second discount through. Still ONE guard (Ruling F) —
   * callers extend this write; they never get a second redemption path.
   */
  /* T2/T3 fix round L1: typed to EXACTLY the one claim this exists for, not Record<string,
   * unknown> — the compiler now stops a future caller from smuggling guard-owned fields
   * (`redeemedTicketId`, `redemption`) through this parameter into the guard's own transaction. */
  extraValidationFields?: { posPush?: { checkRef: string; status: 'pending'; at: string } };
}

/**
 * THE shared redemption guard (Ruling F, binding): `staffApplyValidation` (here) and
 * `posApplyValidation` (Task 3) are mutually exclusive terminal states for one validation code,
 * so both MUST redeem through this one function rather than reimplementing the guard. Two locks,
 * both inside one transaction:
 *
 * 1. `validation.redeemedTicketId` is READ AND SET in the same transaction — a concurrent
 *    redemption's committed write makes this transaction's read stale, Firestore retries it, and
 *    the retry sees `redeemedTicketId` set and rejects. Exactly one concurrent caller wins.
 * 2. `processedEvents/val_{validationId}` is `tx.create`d — belt to the transaction's braces, and
 *    the durable cross-surface marker Task 3's POS path shares.
 *
 * Writes, atomically: `validation.redeemedTicketId` + the Ruling S `redemption {amount, base, at}`
 * group (amount AND the base it was derived from — a bare amount can't be reconstructed once
 * rates change, and invoicing needs the basis), and the ticket's `payment.validationId`/
 * `payment.validationAmount` (the exact fields `priceTicket` consumes on the next checkout; on a
 * pre-checkout ticket with no `payment` map yet, the dotted update creates a partial map —
 * `runCheckout` reads it with `?.` and carries both fields into the real payment it writes).
 *
 * The ticket must be open (non-terminal) and its money not already moved — a validation applied
 * after payment would silently never discount anything.
 */
export async function redeemValidation(deps: Deps, args: RedeemValidationArgs): Promise<{ validationAmount: number }> {
  const validationRef = deps.db.doc(P.validation(args.operatorId, args.validationId));
  const markerRef = deps.db.doc(`processedEvents/val_${args.validationId}`);

  const result = await deps.db.runTransaction(async (tx) => {
    const vSnap = await tx.get(validationRef);
    const validation = vSnap.data() as Validation | undefined;
    if (!validation) throw err('not_found', 'validation');
    if (validation.redeemedTicketId) throw err('failed_precondition', 'validation already redeemed');
    if (validation.expiresAt && validation.expiresAt < deps.now()) throw err('failed_precondition', 'validation expired');

    const ticketRef = deps.db.doc(P.ticket(args.operatorId, args.ticketId));
    const tSnap = await tx.get(ticketRef);
    const ticket = tSnap.data() as Ticket | undefined;
    if (!ticket) throw err('not_found', 'ticket');
    if (ticket.venueId !== validation.venueId) throw err('failed_precondition', 'validation is for a different venue');
    if (ticket.jobType !== 'valet') throw err('failed_precondition', 'validations apply to valet tickets');
    if (ticket.status === 'closed' || ticket.status === 'cancelled') throw err('ticket_closed');
    if (ticket.payment && PAID_STATUSES.includes(ticket.payment.status)) throw err('payment_already_paid');

    const venueSnap = await tx.get(deps.db.doc(P.venue(args.operatorId, validation.venueId)));
    const venue = venueSnap.data() as Venue | undefined;
    if (!venue) throw err('not_found', 'venue');

    const { amount, base } = redemptionAmount(validation, venue, ticket, deps.now());

    tx.create(markerRef, { at: deps.now(), ticketId: args.ticketId, source: args.source });
    tx.update(validationRef, { ...(args.extraValidationFields ?? {}), redeemedTicketId: args.ticketId, redemption: { amount, base, at: deps.now() } });
    tx.update(ticketRef, { 'payment.validationId': args.validationId, 'payment.validationAmount': amount });
    return { validationAmount: amount };
  });

  await audit(deps, { operatorId: args.operatorId, actorUid: args.actorUid, action: 'venue.applyValidation', target: args.validationId, after: { ticketId: args.ticketId, amount: result.validationAmount, source: args.source } });
  return result;
}

/**
 * `venueIssueValidation` (Plan 7 Task 1): mints a 6-char code for the venue. Role gate mirrors
 * `firestore.rules`' validations `create` branch exactly — venue_user/lead scoped to their own
 * claimed venue, or an operator admin/owner for any venue of theirs. Per-type input rules are
 * strict (a stray `amount` on a non-partial, or a stray `rateId` on a non-rate, is rejected
 * rather than silently ignored — this is money configuration, not a suggestion).
 *
 * The code is minted inside the create transaction: `tx.get` of the `validationsByCode`-shaped
 * lookup plus the `tx.create` makes code-uniqueness-per-venue serializable — a colliding
 * concurrent issue retries and re-mints rather than ever creating a duplicate code.
 */
export async function venueIssueValidationHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'venueIssueValidation'>,
): Promise<CallableOutput<'venueIssueValidation'>> {
  const c = requireOperator(caller);
  const isAdmin = c.roles.some((r) => r === 'owner' || r === 'admin');
  const isScopedIssuer = c.roles.some((r) => r === 'venue_user' || r === 'lead') && c.venueIds.includes(input.venueId);
  if (!isAdmin && !isScopedIssuer) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);

  const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');

  if (input.type === 'partial') {
    if (!venue.rates.validations.allowPartial) throw err('failed_precondition', 'partial validations not enabled for this venue');
    if (input.amount === undefined) throw err('invalid_argument', 'amount required for a partial validation');
    if (input.amount > venue.rates.validations.maxAmount) throw err('invalid_argument', 'amount exceeds the venue maximum');
  } else if (input.amount !== undefined) {
    throw err('invalid_argument', 'amount is only valid for a partial validation');
  }
  if (input.type === 'rate') {
    if (!input.rateId) throw err('invalid_argument', 'rateId required for a rate validation');
    if (!venue.rates.valet.items.some((i) => i.id === input.rateId)) throw err('invalid_argument', 'unknown rateId');
  } else if (input.rateId !== undefined) {
    throw err('invalid_argument', 'rateId is only valid for a rate validation');
  }

  const id = deps.newId();
  const code = await deps.db.runTransaction(async (tx) => {
    for (let attempt = 0; attempt < CODE_MINT_ATTEMPTS; attempt++) {
      const candidate = mintCode();
      const clash = await tx.get(
        deps.db.collection(`operators/${c.operatorId}/validations`).where('venueId', '==', input.venueId).where('code', '==', candidate).limit(1),
      );
      if (!clash.empty) continue;
      tx.create(deps.db.doc(P.validation(c.operatorId, id)), {
        id,
        operatorId: c.operatorId,
        venueId: input.venueId,
        code: candidate,
        type: input.type,
        ...(input.type === 'partial' ? { amount: input.amount } : {}),
        ...(input.type === 'rate' ? { rateId: input.rateId } : {}),
        issuedBy: c.uid,
        issuedAt: deps.now(),
        expiresAt: new Date(Date.parse(deps.now()) + VALIDATION_TTL_MS).toISOString(),
      });
      return candidate;
    }
    throw err('internal', 'could not mint a unique code');
  });

  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.issueValidation', target: id, after: { venueId: input.venueId, type: input.type, ...(input.amount !== undefined ? { amount: input.amount } : {}) } });

  // Optional immediate apply (brief: "optional ticketId applies immediately"). Deliberately AFTER
  // the create commits, through the SAME shared guard the stand uses: if the apply fails (wrong
  // venue, ticket already paid, ...), the error propagates but the validation itself stands and
  // is redeemable at the stand by code — a retry surface, not a dangling half-state.
  if (input.ticketId) {
    await redeemValidation(deps, { operatorId: c.operatorId, validationId: id, ticketId: input.ticketId, actorUid: c.uid, source: 'issue' });
  }

  return { code };
}

/**
 * `staffApplyValidation` (Plan 7 Task 1): the attendant types the guest's code at the stand.
 * Staff-scoped (owner/admin/lead/attendant/driver — `staffOf` mirror) with `canAccessVenue`
 * venue scoping on the TICKET's venue; the code is then looked up within that same venue
 * (`validationsByCode`-shaped equality pair), so a code from another venue reads as `not_found` —
 * the same non-oracle a fabricated code gets.
 */
export async function staffApplyValidationHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'staffApplyValidation'>,
): Promise<CallableOutput<'staffApplyValidation'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'lead', 'attendant', 'driver'].includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);

  const ticket = (await deps.db.doc(P.ticket(c.operatorId, input.ticketId)).get()).data() as Ticket | undefined;
  if (!ticket) throw err('not_found');
  if (!(await canAccessVenue(deps, c, ticket.venueId))) throw err('permission_denied');

  const match = await deps.db
    .collection(`operators/${c.operatorId}/validations`)
    .where('venueId', '==', ticket.venueId)
    .where('code', '==', input.code)
    .limit(1)
    .get();
  const validation = match.docs[0]?.data() as Validation | undefined;
  if (!validation) throw err('not_found', 'validation');

  const { validationAmount } = await redeemValidation(deps, {
    operatorId: c.operatorId,
    validationId: validation.id,
    ticketId: input.ticketId,
    actorUid: c.uid,
    source: 'staff',
  });
  return { validationAmount };
}

export const venueIssueValidation = defineCallable('venueIssueValidation', {}, venueIssueValidationHandler);
export const staffApplyValidation = defineCallable('staffApplyValidation', {}, staffApplyValidationHandler);
