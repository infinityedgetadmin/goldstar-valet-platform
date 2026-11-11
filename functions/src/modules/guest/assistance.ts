import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from './rateLimit.js';
import { resolveToken } from './token.js';

export async function assistanceHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'guestFlagAssistance'>): Promise<CallableOutput<'guestFlagAssistance'>> {
  const { operatorId, ticketRef, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  await ticketRef.update({ 'flags.assistance': input.assistance });
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.flagAssistance', target: ticket.id, after: { assistance: input.assistance } });
  return { ok: true };
}

export const guestFlagAssistance = defineCallable('guestFlagAssistance', { allowAnonymous: true }, assistanceHandler);
