import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import type { LiveLocation, Ticket } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import type { MapsProvider } from '../maps/port.js';
import { getMaps } from '../maps/registry.js';

const MAPBOX_SERVER_TOKEN = defineSecret('MAPBOX_SERVER_TOKEN');

/**
 * Scans every in-transit job (drive_home post-pre_drive_inspection, or passenger_ride
 * post-arrived_pickup — both use the SAME `'in_transit'` status, unambiguous since valet never
 * reaches it), routes from the primary driver's last `liveLocations` point to the job's destination,
 * and updates BOTH the ticket doc (`driveHome.etaAt`/`ride.etaAt` — read by `deriveDriverInfo` on the
 * next full projection rebuild) AND the projection directly via targeted dotted-path `.update()`
 * (`driver.etaAt`/`driver.geo`) — NOT a nested-object merge-write, which would REPLACE the whole
 * `driver` map and drop `firstName`/`photoUrl`/`vehicle`. The direct projection touch is what
 * actually surfaces these updates to the guest within this scan's own cadence: a ticket write that
 * only changes `driveHome`/`ride` fields does NOT retrigger a projection rebuild on its own
 * (`onTicketWritten.ts`'s `shouldProcessTicketWrite` only reacts to `status`/`times`/`payment`/
 * `vehicle`), by design — so without this direct write, ETA/geo would only refresh whenever some
 * OTHER status-changing event happened to rebuild the projection.
 */
export async function etaRefreshHandler(deps: Deps, maps: MapsProvider = getMaps(deps)): Promise<{ updated: number; skipped: number }> {
  const snap = await deps.db.collectionGroup('tickets').where('status', '==', 'in_transit').get();
  let updated = 0;
  let skipped = 0;
  for (const d of snap.docs) {
    const t = d.data() as Ticket;
    if (t.jobType === 'valet') continue; // defensive — 'in_transit' is not a valet status, but a collectionGroup scan trusts nothing
    const isDriveHome = t.jobType === 'drive_home';
    const destGeo = isDriveHome ? t.driveHome?.destination.geo : t.ride?.dropoff.geo;
    const primaryUid = t.attendants.primaryDriverUid;
    if (!destGeo || !primaryUid) {
      skipped++;
      continue;
    }
    const locSnap = await deps.db.doc(P.liveLocation(t.operatorId, primaryUid)).get();
    const loc = locSnap.exists ? (locSnap.data() as LiveLocation) : undefined;
    if (!loc || loc.expiresAt <= deps.now()) {
      skipped++;
      continue;
    }
    try {
      const route = await maps.route({ from: loc.geo, to: destGeo });
      const etaAt = new Date(Date.parse(deps.now()) + route.durationSec * 1000).toISOString();
      const field = isDriveHome ? 'driveHome' : 'ride';
      await d.ref.update({ [`${field}.etaAt`]: etaAt });
      await deps.db.doc(P.guestTicket(t.guestToken)).update({ 'driver.etaAt': etaAt, 'driver.geo': loc.geo, updatedAt: deps.now() });
      updated++;
    } catch {
      // One job's route failure (maps outage, malformed geo) must not block the ETA refresh for
      // every other in-transit job in this sweep.
      skipped++;
    }
  }
  return { updated, skipped };
}

export const etaRefresh = onSchedule({ schedule: 'every 1 minutes', secrets: [MAPBOX_SERVER_TOKEN] }, async () => {
  await etaRefreshHandler(makeDeps());
});
