import type { CallableParsedInput, CallableOutput, Ticket } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { resolveToken } from '../guest/token.js';
import { rateLimit } from '../guest/rateLimit.js';
import { runCheckout } from '../payments/checkout.js';

/** Same shape as `guestConfirmDriveHome`, minus the terms-acceptance step (rides have none). */
export async function guestConfirmRideHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestConfirmRide'>): Promise<CallableOutput<'guestConfirmRide'>> {
  const { operatorId, ticketRef, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  if (ticket.jobType !== 'passenger_ride') throw err('invalid_argument', 'not a passenger_ride job');
  // L3 (Plan 6 final wave): a VENUE-billed ride must never be confirmed-and-charged through the
  // guest path. `runCheckout` below hardcodes `billTo: 'guest'`, so without this a guest-token
  // holder confirming a `billTo: 'venue'` ride is charged for work the venue is simultaneously
  // being invoiced for — the guest pays and the venue is billed for the same trip.
  //
  // Live as of Plan 7 T1 (`venueHostRequest` kind:'ride' creates venue-billed rides). Checked
  // BEFORE the quoted->confirmed transition below, so a non-guest-billed ride is rejected without
  // being mutated at all.
  //
  // Exclusion-shaped on purpose (Plan 6 re-review one-liner): `!== 'guest'` rather than
  // `=== 'venue'` — `payment.billTo`'s enum already carries 'room' and `pmsPostRoomCharge` is
  // declared-but-unimplemented, so the next billing party added to rides is guarded here
  // automatically instead of needing this line edited again. This callable charges the GUEST;
  // only guest-billed work may pass.
  if (ticket.ride && ticket.ride.billTo !== 'guest') throw err('failed_precondition', 'venue_billed_ride');

  let merged: Ticket = ticket;
  if (ticket.status === 'quoted') {
    const quote = ticket.ride?.quote;
    if (!quote?.expiresAt || quote.expiresAt < deps.now()) throw err('failed_precondition', 'quote_expired');
    // H1(a): no canTransition() role check here on purpose — see confirmDriveHome.ts for the full
    // rationale. quoted->confirmed no longer lists 'guest'/'venue_user' in RIDE_RULES
    // (src/state/ride.ts); this callable's real authorization is resolveToken() + the status
    // branch above, not that role array.
    await ticketRef.update({ status: 'confirmed' });
    merged = { ...ticket, status: 'confirmed' };
  } else if (ticket.status !== 'confirmed') {
    throw err('ticket_invalid_transition');
  }
  return runCheckout(deps, operatorId, merged, { kind: 'none' }, caller?.roles.includes('guest') ? 'in_app' : 'web', caller?.uid ?? 'guest');
}

export const guestConfirmRide = defineCallable('guestConfirmRide', { allowAnonymous: true, secrets: ['STRIPE_SECRET_KEY'] }, guestConfirmRideHandler);
