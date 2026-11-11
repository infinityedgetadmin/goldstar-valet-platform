import type { CallableParsedInput, CallableOutput, Operator, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { canAccessVenue } from '../../lib/venueAccess.js';
import { getGateway } from './registry.js';

export async function terminalConnectionTokenHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'terminalConnectionToken'>): Promise<CallableOutput<'terminalConnectionToken'>> {
  const c = requireOperator(caller);
  if (!(await canAccessVenue(deps, c, input.venueId))) throw err('permission_denied');
  const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator;
  await requireActiveOperator(deps, c.operatorId, op); // Ruling C-2 — zero extra read, op already fetched above
  if (!op.features.tapToPay) throw err('failed_precondition', 'tap to pay disabled');
  const vref = deps.db.doc(P.venue(c.operatorId, input.venueId));
  const venue = (await vref.get()).data() as Venue;
  const gw = getGateway(deps, op);
  // TODO: read-then-write race — two concurrent first-time terminal-token requests for the same venue
  // can both read stripeLocationId as unset, each create a distinct Stripe Terminal location, and the
  // second write here wins, orphaning the first. Not wrapped in a Firestore transaction; low-frequency
  // path (once per venue, not a hot path) so left as a known gap rather than fixed this round.
  let locationId = venue.stripeLocationId;
  if (!locationId) {
    // Ruling AP (1d final review, finding 9): Terminal objects (location + connection token) both
    // live on the PLATFORM account under this plan's destination-charge model — connectionTokens.create
    // (stripe.adapter.ts) never forwards `stripeAccount`, so a location created ON the connected
    // account was invisible to the platform-account token, and the resulting Stripe error left
    // `venues.stripeLocationId` durably poisoned with an id the platform account could never use.
    // Never forward stripeAccount here; keep both calls consistently on the platform account.
    locationId = (
      await gw.ensureTerminalLocation({
        operatorId: c.operatorId,
        venueName: venue.name,
        address: venue.address,
      })
    ).locationRef;
    await vref.update({ stripeLocationId: locationId });
  }
  const { secret } = await gw.createTerminalConnectionToken({ operatorId: c.operatorId, locationRef: locationId });
  return { secret, locationId };
}

export const terminalConnectionToken = defineCallable('terminalConnectionToken', { secrets: ['STRIPE_SECRET_KEY'] }, terminalConnectionTokenHandler);
