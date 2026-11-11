import { FieldValue } from 'firebase-admin/firestore';
import type { CallableParsedInput, CallableOutput, Ticket } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue } from '../../lib/venueAccess.js';
import { refundRequestedHandler } from './refund.js';

// Lead/admin partial or full refund (spec §7.1).
export async function staffRefundHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'staffRefund'>): Promise<CallableOutput<'staffRefund'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'lead'].includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId); // Ruling C-2 — one added read; this handler doesn't otherwise fetch the operator
  const ref = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const t = (await ref.get()).data() as Ticket | undefined;
  if (!t?.payment?.lastIntentId) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  if (!['paid', 'authorized'].includes(t.payment.status)) throw err('failed_precondition', 'nothing to refund');
  if (input.amount !== undefined && input.amount > t.payment.total) throw err('invalid_argument', 'amount exceeds total');
  // Ruling AU (finding 14): an 'authorized' ticket has no captured charge to partially refund —
  // refund.ts's authorized branch always voids the FULL authorization via cancelIntent, silently
  // ignoring `amount`. A partial request there must fail honestly rather than surprise-void the whole
  // hold; capture first, then request a partial refund of the captured charge.
  if (t.payment.status === 'authorized' && input.amount !== undefined && input.amount < t.payment.total) throw err('invalid_argument', 'partial refund requires capture');
  // Ruling AH (finding 1): refundRequestId/refundAmount/refundReason persisted in the SAME write that
  // sets refundRequested:true — the Firestore update trigger (onPaymentRefundRequested) fires
  // concurrently with the explicit refundRequestedHandler call below; both read this exact write, so
  // neither can race an amount-less/reason-less claim into a full refund.
  // Ruling AX (finding N1, belt-and-braces at the producer): refund.ts now clears refundAmount on
  // every attempt-cycle's terminal outcome, but this producer must not depend on that alone — an
  // amount-less (full refund) request here explicitly DELETES any stale payment.refundAmount left on
  // the doc rather than omitting the key, so a request for the FULL remaining balance can never
  // silently inherit an EARLIER partial request's amount. payment.refundReason is unconditionally
  // overwritten with the current request's reason on every call (never conditionally omitted), so it
  // can't go stale via this producer the same way.
  await ref.update({
    'payment.refundRequested': true,
    'payment.refundRequestId': deps.newId(),
    'payment.refundAmount': input.amount !== undefined ? input.amount : FieldValue.delete(),
    'payment.refundReason': input.reason,
  });
  // Ruling AQ (finding 10): key the response on the handler's outcome, never on a possibly-stale
  // `lastRefundRef` left over from a prior refund on this same ticket (AK now allows repeat partial
  // refunds, so a stale ref is a real, not just theoretical, risk).
  const outcome = await refundRequestedHandler(deps, { operatorId: c.operatorId, ticketId: input.ticketId });
  if (outcome !== 'refunded' && outcome !== 'voided') throw err('provider_unavailable', 'refund pending retry');
  const after = (await ref.get()).data() as Ticket;
  const refundRef = after.payment?.lastRefundRef;
  if (!refundRef) throw err('provider_unavailable', 'refund pending retry');
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'payment.staffRefund', target: input.ticketId, after: { amount: input.amount ?? 'full', reason: input.reason } });
  return { refundRef };
}

export const staffRefund = defineCallable('staffRefund', { secrets: ['STRIPE_SECRET_KEY'] }, staffRefundHandler);
