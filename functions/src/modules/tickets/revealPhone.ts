import type { CallableParsedInput, CallableOutput, Ticket } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue } from '../../lib/venueAccess.js';

/**
 * Admin+ reveal of a guest's full E.164 phone from the ticket detail page, gated and audited
 * (task-4-brief). Deliberately admin+ only (owner/admin/platform_admin — the exact set
 * `auditQuery` gates on), NOT lead — the ticket explorer/detail page itself is lead-visible via
 * `ticketsSearch`, but exposing the un-masked number is scoped tighter, matching the brief's
 * "admin can reveal" language over the explorer's broader lead access.
 *
 * `requireActiveOperator` is called unconditionally (no `auditQuery`-style platform_admin
 * exemption): unlike a pure audit-log read, this action exposes a guest's PII on a suspended
 * operator's ticket — closer in kind to the "actual money callables" Ruling C-2 keeps gated for
 * every caller, so it follows THAT default rather than auditQuery's narrow, explicitly-disclosed
 * carve-out. Judgment call — flag if the controller intended the same platform_admin exemption
 * auditQuery gets.
 */
export async function ticketsRevealPhoneHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'ticketsRevealPhone'>): Promise<CallableOutput<'ticketsRevealPhone'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'platform_admin'].includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);
  const ref = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const t = (await ref.get()).data() as Ticket | undefined;
  if (!t) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  // Plan 2b's sentinel `'0000'` phoneLast4 (QR-only guest, no phone collected) is written with NO
  // `guest.phoneE164` at all (ticket.ts's own comment on `guest.phoneLast4`) — the mobile check-in
  // flow never sets it for that path, so there is nothing to reveal. Both checks land the same
  // not_found-class error; `phoneE164` missing is the authoritative signal (a real guest could in
  // principle share the sentinel's last-4 digits by coincidence — display-only collision, per that
  // same comment), so it's checked first rather than trusting phoneLast4 alone.
  if (!t.guest.phoneE164 || t.guest.phoneLast4 === '0000') throw err('not_found', 'no phone on file for this ticket');
  // Ruling: the whole point of this callable is the audit trail — actor + ticket, never the
  // number itself (house rule: never log the revealed value). `reason` is the caller's stated
  // justification, safe to log; `phoneE164` never appears in `before`/`after`.
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'ticket.revealPhone', target: input.ticketId, after: { reason: input.reason } });
  return { phoneE164: t.guest.phoneE164 };
}

export const ticketsRevealPhone = defineCallable('ticketsRevealPhone', {}, ticketsRevealPhoneHandler);
