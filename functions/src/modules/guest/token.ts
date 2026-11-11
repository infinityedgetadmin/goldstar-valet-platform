import { TERMINAL_STATUSES, type Ticket } from '@goldstar/platform';
import type { DocumentReference } from 'firebase-admin/firestore';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';

/**
 * Ruling AG: `allowTerminal` exists so `guestSurvey` can REUSE this function instead of hand-
 * copying it minus one check — a hand-copy of a security-relevant resolver silently stops
 * matching the moment the original gains a check (the projection hand-mirror lesson). The
 * DEFAULT is the strict behavior: terminal tickets throw `ticket_closed`, and the parameter can
 * only ever LOOSEN that deliberately, at a call site that says why. Every ACT callable
 * (request/pay/cancel/confirm) uses the default.
 */
export async function resolveToken(
  deps: Deps,
  token: string,
  opts: { allowTerminal?: boolean } = {},
): Promise<{ operatorId: string; ticketRef: DocumentReference; ticket: Ticket }> {
  const proj = (await deps.db.doc(P.guestTicket(token)).get()).data() as { operatorId: string; ticketId: string; expiresAt: string } | undefined;
  if (!proj || proj.expiresAt < deps.now()) throw err('guest_token_expired');
  const ticketRef = deps.db.doc(P.ticket(proj.operatorId, proj.ticketId));
  const ticket = (await ticketRef.get()).data() as Ticket | undefined;
  if (!ticket || ticket.guestToken !== token) throw err('guest_token_expired');
  if (!opts.allowTerminal && TERMINAL_STATUSES.includes(ticket.status)) throw err('ticket_closed');
  return { operatorId: proj.operatorId, ticketRef, ticket };
}

// Static-checkout venue token → operator/venue resolution. Same "resolve before writing anything"
// shape as resolveToken above, but the projection is `venuePublic/{venueToken}` (Functions-written,
// publicly readable — venue signage QR) instead of the per-ticket `guestTickets/{token}`. Never echo
// projection data back to the caller on failure — an unknown token must be indistinguishable from a
// not-yet-provisioned one (no venue enumeration).
export async function resolveVenueToken(deps: Deps, venueToken: string): Promise<{ operatorId: string; venueId: string }> {
  const proj = (await deps.db.doc(P.venuePublic(venueToken)).get()).data() as { operatorId: string; venueId: string } | undefined;
  if (!proj) throw err('not_found');
  return { operatorId: proj.operatorId, venueId: proj.venueId };
}
