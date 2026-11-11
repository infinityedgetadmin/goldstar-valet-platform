import { type CallableParsedInput, type CallableOutput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from './rateLimit.js';
import { resolveToken } from './token.js';

/**
 * `guestSurvey` (Plan 7 Task 1, Ruling C: the handler belongs here, not Plan 8 — the contract,
 * `surveys` schema, SMS template and Functions-only rule all already exist).
 *
 * One survey per ticket, idempotent: the doc id IS the ticket id, written with `.create()` — a
 * duplicate submit (double-tap, client retry) hits ALREADY_EXISTS and returns `ok: true` as a
 * no-op rather than overwriting the first response or erroring at a guest. Not gated on operator
 * suspension — guest callables never are (the parked-car carve-out doctrine).
 */
export async function guestSurveyHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'guestSurvey'>,
): Promise<CallableOutput<'guestSurvey'>> {
  // Ruling AG: `allowTerminal` — the ONE token consumer that legitimately needs a terminal
  // ticket. The survey link arrives with the receipt BECAUSE the ticket closed; the guest rates
  // the visit precisely once it's delivered/closed, which is exactly backwards from every other
  // consumer (request/pay/cancel act on an OPEN ticket). Reusing `resolveToken` with a deliberate
  // loosening flag — rather than the hand-copy this replaced — means any future check the
  // resolver gains applies here automatically (the projection hand-mirror lesson).
  const { operatorId, ticket } = await resolveToken(deps, input.token, { allowTerminal: true });
  await rateLimit(deps, `survey:${input.token}`, 5, 60);

  await deps.db
    .doc(P.survey(ticket.id))
    .create({
      id: ticket.id,
      operatorId,
      venueId: ticket.venueId,
      ticketId: ticket.id,
      score: input.score,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      at: deps.now(),
    })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });

  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.survey', target: ticket.id, after: { score: input.score } });
  return { ok: true };
}

export const guestSurvey = defineCallable('guestSurvey', { allowAnonymous: true }, guestSurveyHandler);
