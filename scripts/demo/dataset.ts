import { demoClock } from './context';
import { buildMetrics } from './metrics';
import { buildOps } from './ops';
import { buildPeople } from './people';
import { buildPlaces } from './places';
import { buildTickets } from './tickets';
import type { DemoDataset, SeedDoc, SeedDocKind } from './types';

/**
 * Write order. Triggers fire as documents land in the emulator, so:
 * - venues before tickets (onVenueWritten projects /venuePublic; ticket triggers read the venue),
 * - fleet before tickets (assignment checks read the vehicle),
 * - damage reports + photos BEFORE tickets: onJobWritten reverts a drive-home ticket that reaches
 *   in_transit/completed without a qualifying (>= 4 photo) pre-/post-drive report,
 * - tickets before custody events, transactions, incidents and claims that point at them.
 */
const WRITE_ORDER: readonly SeedDocKind[] = [
  'operator',
  'venue',
  'user',
  'invitation',
  'guest',
  'fleetVehicle',
  'shift',
  'clockEvent',
  'integration',
  'damageReport',
  'photo',
  'keyTag',
  'ticket',
  'custodyEvent',
  'transaction',
  'liveLocation',
  'incident',
  'claim',
  'validation',
  'hostRequest',
  'invoice',
  'payoutBatch',
  'payoutAllocation',
  'auditLogEntry',
  'metricsDaily',
  'metricsForecast',
];

export function orderForWrite(docs: SeedDoc[]): SeedDoc[] {
  const rank = (d: SeedDoc): number => WRITE_ORDER.indexOf(d.kind);
  // Stable sort keeps each builder's own ordering within a kind.
  return docs.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map(({ d }) => d);
}

export function buildDemoDataset(now: Date): DemoDataset & { refs: ReturnType<typeof buildTickets>['refs'] } {
  const clock = demoClock(now);
  const people = buildPeople(clock);
  const tickets = buildTickets(clock);
  const ops = buildOps(clock, tickets.refs);
  const docs = [...buildPlaces(clock), ...people.docs, ...tickets.docs, ...ops.docs, ...buildMetrics(clock)];
  return {
    docs: orderForWrite(docs),
    authUsers: people.authUsers,
    storage: [...tickets.storage, ...ops.storage],
    expectedTicketStatuses: tickets.expectedTicketStatuses,
    refs: tickets.refs,
  };
}

export { WRITE_ORDER };
