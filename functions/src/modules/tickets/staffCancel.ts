import { canTransition, type CallableParsedInput, type CallableOutput, type Ticket } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue } from '../../lib/venueAccess.js';

export async function staffCancelHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'staffCancelTicket'>): Promise<CallableOutput<'staffCancelTicket'>> {
  const c = requireOperator(caller);
  // Coarse role gate before the ticket fetch: an unprivileged staff member gets permission_denied
  // without ever learning whether the ticket exists (auth-before-existence, matching assume.ts).
  if (!c.roles.some((r) => ['owner', 'admin', 'lead'].includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId); // Ruling C-2 — one added read; this handler doesn't otherwise fetch the operator
  const ref = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const t = (await ref.get()).data() as Ticket | undefined;
  if (!t) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  const r = canTransition({ jobType: t.jobType, from: t.status, to: 'cancelled', roles: c.roles, ctx: { cancelReason: input.reason } });
  if (!r.ok) throw err('ticket_invalid_transition', r.reason);
  const patch: Record<string, unknown> = { status: 'cancelled', cancelReason: input.reason, 'times.cancelledAt': deps.now() };
  // Ruling AH (1d final review, finding 1): refundRequestId minted in the SAME write as
  // refundRequested:true — full refund at the default reason; written together with `status` here (not
  // left to the ticket-write trigger) so this single update is what the claim transaction reads.
  if (t.payment && ['paid', 'authorized'].includes(t.payment.status)) {
    patch['payment.refundRequested'] = true;
    patch['payment.refundRequestId'] = deps.newId();
  }
  await ref.update(patch);
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'ticket.cancel', target: t.id, before: { status: t.status }, after: { reason: input.reason } });
  return { ok: true };
}

export const staffCancelTicket = defineCallable('staffCancelTicket', {}, staffCancelHandler);
