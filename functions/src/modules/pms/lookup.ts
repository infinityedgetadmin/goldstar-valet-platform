import type { CallableParsedInput, CallableOutput, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { requireVenueUserOrStaff } from '../../lib/venueAccess.js';
import { getPms } from './registry.js';

/**
 * `pmsLookup` (Plan 7 Task 2): find a hotel reservation by guest name and/or room, from the hotel
 * portal's lookup dialog OR the staff app's "Charge to room" sheet — hence the dual
 * `requireVenueUserOrStaff` gate (§9.1 against `input.venueId`; see venueAccess.ts for why this
 * surface, unlike POS, admits operator staff). Read-only against the PMS; nothing is written.
 *
 * At least one filter is REQUIRED even though the contract marks both optional: a filterless call
 * would dump the hotel's entire reservation list — guest PII with no operational need.
 *
 * The response maps ONLY the contract fields (reservationRef/guestName/room/noPost) — the port's
 * arrival/departure never leave the server under 0.4.x (see port.ts).
 */
export async function pmsLookupHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'pmsLookup'>,
): Promise<CallableOutput<'pmsLookup'>> {
  const c = await requireVenueUserOrStaff(deps, caller, input.venueId);
  await requireActiveOperator(deps, c.operatorId);
  if (input.name === undefined && input.room === undefined) throw err('invalid_argument', 'name or room required');
  const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');
  const pms = await getPms(deps, c.operatorId, venue);
  const { reservations } = await pms.lookupReservation({ name: input.name, room: input.room });
  return { reservations: reservations.map(({ reservationRef, guestName, room, noPost }) => ({ reservationRef, guestName, room, noPost })) };
}

export const pmsLookup = defineCallable('pmsLookup', {}, pmsLookupHandler);
