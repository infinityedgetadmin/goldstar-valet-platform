import { canTransition, type CallableParsedInput, type CallableOutput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from './rateLimit.js';
import { resolveToken } from './token.js';

export async function requestVehicleHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestRequestVehicle'>): Promise<CallableOutput<'guestRequestVehicle'>> {
  const { operatorId, ticketRef, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  if (ticket.status !== 'checked_in') return { status: ticket.status }; // already requested or beyond → idempotent
  const r = canTransition({ jobType: ticket.jobType, from: ticket.status, to: 'requested', roles: ['guest'] });
  if (!r.ok) throw err('ticket_invalid_transition');
  await ticketRef.update({ status: 'requested', 'times.requestedAt': deps.now() });
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.requestVehicle', target: ticket.id, ...(caller?.ip ? { ip: caller.ip } : {}) });
  return { status: 'requested' };
}

export const guestRequestVehicle = defineCallable('guestRequestVehicle', { allowAnonymous: true }, requestVehicleHandler);
