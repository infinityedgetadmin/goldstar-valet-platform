import { canTransition, secretToken, type CallableParsedInput, type CallableOutput, type Operator, type Ticket, type Venue } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { resolveToken } from '../guest/token.js';
import { rateLimit } from '../guest/rateLimit.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { quoteJob } from './quote.js';

/**
 * Same shape as `guestRequestDriveHome`, for `passenger_ride`. P3-T4 carry: the guest-supplied
 * `pickup` payload has no reliable `venueId` (guest_web/app never has operator context beyond the
 * token) — `venueId` is ALWAYS derived server-side from the parent valet ticket's own `venueId`,
 * overriding whatever (if anything) the client sent, never trusted from the input. `pickup.geo` IS
 * trusted from the client (the actual curbside/pickup point the guest chose via the maps
 * autocomplete/retrieve flow) — only `venueId` is the gap this carry closes.
 *
 * Guest-initiated rides are always `billTo:'guest'` — a venue-billed ride (`billTo:'venue'`, no
 * checkout) is a DIFFERENT creation path from the venue portal (Plan 7), out of scope here.
 */
export async function guestRequestRideHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestRequestRide'>): Promise<CallableOutput<'guestRequestRide'>> {
  const { operatorId, ticket: parent } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  if (parent.jobType !== 'valet') throw err('failed_precondition', 'not a valet ticket');
  const [opSnap, venueSnap] = await Promise.all([deps.db.doc(P.operator(operatorId)).get(), deps.db.doc(P.venue(operatorId, parent.venueId)).get()]);
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue;
  if (!op.features.passengerRides) throw err('failed_precondition', 'passenger_rides not enabled for this operator');

  if (!canTransition({ jobType: 'passenger_ride', from: null, to: 'requested', roles: ['guest'] }).ok) throw err('ticket_invalid_transition');
  if (!canTransition({ jobType: 'passenger_ride', from: 'requested', to: 'quoted', roles: ['platform_admin'] }).ok) throw err('ticket_invalid_transition');

  const now = deps.now();
  const jobBase: Ticket = {
    id: deps.newId(),
    operatorId,
    venueId: parent.venueId,
    parentTicketId: parent.id,
    jobType: 'passenger_ride',
    status: 'requested',
    source: caller?.roles.includes('guest') ? 'guest_app' : 'guest_web',
    guest: parent.guest,
    vehicle: {},
    flags: { assistance: false, accessibleVehicle: input.accessible, photosSkipped: false, vip: false },
    attendants: {},
    times: { checkedInAt: now, requestedAt: now },
    damageReportIds: [],
    incidentIds: [],
    guestToken: secretToken(),
    ride: { pickup: { ...input.pickup, venueId: parent.venueId }, dropoff: input.dropoff, passengers: input.passengers, accessible: input.accessible, billTo: 'guest' },
  };
  const { quote, route } = await quoteJob(deps, op, venue, jobBase);
  const job: Ticket = { ...jobBase, status: 'quoted', ride: { ...jobBase.ride!, quote, route } };

  await deps.db.doc(P.ticket(operatorId, job.id)).set(job);
  await ticketWrittenHandler(deps, { operatorId, ticketId: job.id, before: null, after: job });
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.requestRide', target: job.id, after: { parentTicketId: parent.id } });
  return { quote, jobToken: job.guestToken };
}

export const guestRequestRide = defineCallable('guestRequestRide', { allowAnonymous: true, secrets: ['MAPBOX_SERVER_TOKEN'] }, guestRequestRideHandler);
