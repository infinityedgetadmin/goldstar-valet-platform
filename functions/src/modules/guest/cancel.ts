import { canTransition, type CallableParsedInput, type CallableOutput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from './rateLimit.js';
import { resolveToken } from './token.js';

export async function cancelHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestCancel'>): Promise<CallableOutput<'guestCancel'>> {
  const { operatorId, ticketRef, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  const r = canTransition({ jobType: ticket.jobType, from: ticket.status, to: 'cancelled', roles: ['guest'], ctx: { cancelReason: input.reason } });
  if (!r.ok) throw err('ticket_invalid_transition');
  await ticketRef.update({ status: 'cancelled', cancelReason: input.reason, 'times.cancelledAt': deps.now() });
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.cancel', target: ticket.id, after: { reason: input.reason } });
  return { ok: true };
}

export const guestCancel = defineCallable('guestCancel', { allowAnonymous: true }, cancelHandler);
