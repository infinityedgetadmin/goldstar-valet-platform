import type { CallableParsedInput, CallableOutput, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { requireVenueUser } from '../venue/hostRequest.js';
import { getPos } from './registry.js';

/**
 * `posFindCheck` (Plan 7 Task 3): the host types a table number (or re-checks a known ref) and
 * gets the matching open checks back. Read-only against the POS; no money moves and nothing is
 * written, so this is the one POS callable with no idempotency surface. Venue-claim gate per
 * §9.1 (the shared `requireVenueUser`); suspension-gated like every staff-scoped ACT/inspect on
 * a venue's own data.
 */
export async function posFindCheckHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'posFindCheck'>,
): Promise<CallableOutput<'posFindCheck'>> {
  const c = requireVenueUser(caller, input.venueId);
  await requireActiveOperator(deps, c.operatorId);
  const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');
  const pos = await getPos(deps, c.operatorId, venue);
  const { checks } = await pos.findCheck({ table: input.table, checkRef: input.checkRef });
  return { checks };
}

export const posFindCheck = defineCallable('posFindCheck', {}, posFindCheckHandler);
