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
 * Resolves the caller's active VALET ticket (via `token`), then creates a NEW `drive_home` job
 * ticket linked to it (`parentTicketId`) with its OWN `guestToken` ("jobToken" — every subsequent
 * guest call for this job uses that, not the parent's `token`). Quotes it in the SAME call before the
 * first Firestore write, so the job ticket is created ALREADY at `status:'quoted'` with
 * `driveHome.quote`/`route` populated — never observably 'requested'-with-no-quote for even a moment
 * (a deliberate simplification vs. a literal two-write requested→quoted sequence: `quoteJob` only
 * needs the destination the client just supplied, not a persisted ticket, so there is nothing to gain
 * from persisting the intermediate state).
 */
export async function guestRequestDriveHomeHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'guestRequestDriveHome'>,
): Promise<CallableOutput<'guestRequestDriveHome'>> {
  const { operatorId, ticket: parent } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  if (parent.jobType !== 'valet') throw err('failed_precondition', 'not a valet ticket');
  const [opSnap, venueSnap] = await Promise.all([deps.db.doc(P.operator(operatorId)).get(), deps.db.doc(P.venue(operatorId, parent.venueId)).get()]);
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue;
  if (!op.features.driveHome) throw err('failed_precondition', 'drive_home not enabled for this operator');

  if (!canTransition({ jobType: 'drive_home', from: null, to: 'requested', roles: ['guest'] }).ok) throw err('ticket_invalid_transition');
  if (!canTransition({ jobType: 'drive_home', from: 'requested', to: 'quoted', roles: ['platform_admin'] }).ok) throw err('ticket_invalid_transition');

  const now = deps.now();
  const jobBase: Ticket = {
    id: deps.newId(),
    operatorId,
    venueId: parent.venueId,
    parentTicketId: parent.id,
    jobType: 'drive_home',
    status: 'requested',
    source: caller?.roles.includes('guest') ? 'guest_app' : 'guest_web',
    guest: parent.guest,
    vehicle: {},
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: {},
    times: { checkedInAt: now, requestedAt: now },
    damageReportIds: [],
    incidentIds: [],
    guestToken: secretToken(),
    driveHome: { destination: input.destination, chase: { status: 'pending' } },
  };
  const { quote, route } = await quoteJob(deps, op, venue, jobBase);
  const job: Ticket = { ...jobBase, status: 'quoted', driveHome: { ...jobBase.driveHome!, quote, route } };

  await deps.db.doc(P.ticket(operatorId, job.id)).set(job);
  await ticketWrittenHandler(deps, { operatorId, ticketId: job.id, before: null, after: job });
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.requestDriveHome', target: job.id, after: { parentTicketId: parent.id } });
  return { quote, jobToken: job.guestToken };
}

export const guestRequestDriveHome = defineCallable('guestRequestDriveHome', { allowAnonymous: true, secrets: ['MAPBOX_SERVER_TOKEN'] }, guestRequestDriveHomeHandler);
