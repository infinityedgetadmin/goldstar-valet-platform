import { computeTripQuote, type Operator, type Quote, type Ticket, type Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import type { MapsProvider } from '../maps/port.js';
import { getMaps } from '../maps/registry.js';

const QUOTE_TTL_MS = 15 * 60_000;

/**
 * Plan 5 T1: server-side trip quote for a job ticket (drive_home or passenger_ride). Routes from the
 * VENUE (per task-1-brief.md's literal contract — the fleet/driver's operational base, not the ride's
 * own pickup point) to the job's destination (`driveHome.destination` / `ride.dropoff`), prices via
 * `computeTripQuote` against the venue's trip rates for that job type, and stamps a 15-minute
 * expiry — `guestConfirmDriveHome`/`guestConfirmRide` reject a confirm against an expired quote
 * (`failed_precondition('quote_expired')`); `dispatchQuote` re-quotes.
 *
 * `op` is accepted (not read) to match the brief's `quoteJob(deps, op, venue, ticket)` contract and
 * every call site's shape — reserved for a future per-operator maps/rates override that doesn't exist
 * yet (rates come from `venue.rates`, not anything operator-level, today).
 */
export async function quoteJob(deps: Deps, op: Operator, venue: Venue, ticket: Ticket, maps: MapsProvider = getMaps(deps)): Promise<{ quote: Quote; route: string }> {
  void op;
  const destGeo = ticket.jobType === 'drive_home' ? ticket.driveHome?.destination.geo : ticket.jobType === 'passenger_ride' ? ticket.ride?.dropoff.geo : undefined;
  if (!destGeo) throw err('invalid_argument', 'job ticket is missing a destination');
  const rates = ticket.jobType === 'drive_home' ? venue.rates.driveHome : ticket.jobType === 'passenger_ride' ? venue.rates.passengerRide : undefined;
  if (!rates) throw err('invalid_argument', 'not a trip job');
  const route = await maps.route({ from: venue.geo, to: destGeo });
  const priced = computeTripQuote({ rates, distanceMeters: route.distanceMeters, durationSec: route.durationSec });
  const expiresAt = new Date(Date.parse(deps.now()) + QUOTE_TTL_MS).toISOString();
  return { quote: { ...priced, expiresAt }, route: route.polyline };
}
