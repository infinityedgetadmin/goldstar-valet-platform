import { randomUUID } from 'node:crypto';
import { TERMINAL_STATUSES, type FleetVehicle, type GuestTicket, type LiveLocation, type Operator, type Ticket, type User, type Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

export function vehicleSummary(v: Ticket['vehicle']): string {
  return [v.color, v.make, v.model].filter(Boolean).join(' ') || 'Your vehicle';
}

/**
 * Plan 5 T2 (4b-F3 carry, WITH TEETH): `buildProjection` is called from a full-overwrite `.set()`
 * (`ticket.handler.ts`'s `writeAndPropagateProjection`) on EVERY ticket write, so any field that
 * needs to survive a rebuild triggered by an UNRELATED change (a valet status edit on the parent, a
 * job's own later status change, etc.) must be freshly DERIVED here every time, never carried forward
 * from a prior write the caller doesn't have in hand. `linkedJobs` and `driver` are both such fields
 * — see `deriveLinkedJobs`/`deriveDriverInfo` below, which the caller computes and passes in via
 * `extra`. `buildProjection` itself stays a pure, synchronous shape-assembly function (no `Deps`),
 * matching its pre-existing signature/testability; only the async derivation moved out.
 */
export function buildProjection(
  op: Operator,
  venue: Venue,
  t: Ticket,
  now: string,
  extra: { linkedJobs?: GuestTicket['linkedJobs']; driver?: GuestTicket['driver']; logoUrl?: string } = {},
): GuestTicket {
  const pay = t.payment ?? { status: 'none' as const, base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: op.currency, billTo: 'guest' as const };
  const closed = t.status === 'closed' || t.status === 'cancelled';
  const closedAt = t.times.closedAt ?? t.times.cancelledAt ?? now;
  return {
    operatorId: op.id,
    ticketId: t.id,
    venueName: venue.brandingOverride?.displayName ?? venue.name,
    jobType: t.jobType,
    status: t.status,
    branding: {
      displayName: op.branding.displayName,
      primaryColor: op.branding.primaryColor,
      accentColor: op.branding.accentColor,
      ...(extra.logoUrl ? { logoUrl: extra.logoUrl } : {}),
      ...(op.branding.supportPhone ? { supportPhone: op.branding.supportPhone } : {}),
    },
    vehicleSummary: vehicleSummary(t.vehicle),
    times: {
      checkedInAt: t.times.checkedInAt,
      ...(t.times.requestedAt ? { requestedAt: t.times.requestedAt } : {}),
      ...(t.times.readyAt ? { readyAt: t.times.readyAt } : {}),
      ...(t.times.deliveredAt ? { deliveredAt: t.times.deliveredAt } : {}),
    },
    payment: { status: pay.status, base: pay.base, tip: pay.tip, tax: pay.tax, fees: pay.fees, total: pay.total, currency: pay.currency, tipPresets: op.modules.payments.tipPresets },
    linkedJobs: extra.linkedJobs ?? [],
    ...(extra.driver ? { driver: extra.driver } : {}),
    // v0.3.9 (fix round 1, Critical #2 — pre-flight carry, actually implemented this time): the
    // job's OWN quote/destination display, so a guest who closes the tab between seeing the quote
    // and tapping confirm can resume into the SAME quote/terms/confirm screen via `jobToken` rather
    // than a dead-end tracking view. Read straight off `t.driveHome`/`t.ride` (no extra fetch —
    // unlike linkedJobs/driver, nothing here needs a DB read) whenever a quote has been computed,
    // i.e. from 'quoted' onward for the lifetime of the ticket; a valet ticket has neither field.
    ...(t.jobType === 'drive_home' && t.driveHome?.quote
      ? { driveHome: { quote: t.driveHome.quote, destination: t.driveHome.destination, ...(t.driveHome.termsAcceptedAt ? { termsAcceptedAt: t.driveHome.termsAcceptedAt } : {}) } }
      : {}),
    ...(t.jobType === 'passenger_ride' && t.ride?.quote
      ? { ride: { quote: t.ride.quote, dropoff: t.ride.dropoff, passengers: t.ride.passengers } }
      : {}),
    features: { driveHome: op.features.driveHome, passengerRides: op.features.passengerRides },
    expiresAt: closed ? new Date(Date.parse(closedAt) + 86_400_000).toISOString() : new Date(Date.parse(now) + 7 * 86_400_000).toISOString(),
    updatedAt: now,
  };
}

/**
 * Derives `linkedJobs` by querying CURRENT child tickets (`parentTicketId == ticketId`) rather than
 * carrying forward whatever a prior write recorded — this is what survives a parent-ticket rebuild
 * triggered by an unrelated change (4b-F3 carry's regression case). Only ACTIVE (non-terminal) jobs
 * are listed — a cancelled/closed linked job stops showing on the guest's ticket page. A ticket that
 * is ITSELF a job (`parentTicketId` set) never has children of its own in this design (jobs don't
 * spawn sub-jobs) — callers skip this query entirely for those, so the common valet-ticket-write path
 * pays for exactly one extra read (this query), and a job-ticket write pays for zero.
 */
export async function deriveLinkedJobs(deps: Deps, operatorId: string, ticketId: string): Promise<GuestTicket['linkedJobs']> {
  const snap = await deps.db.collection(`operators/${operatorId}/tickets`).where('parentTicketId', '==', ticketId).get();
  return snap.docs
    .map((d) => d.data() as Ticket)
    .filter((c) => !TERMINAL_STATUSES.includes(c.status))
    .map((c) => ({ ticketId: c.id, jobType: c.jobType, status: c.status, token: c.guestToken }));
}

/**
 * Mints (or reuses) a `firebaseStorageDownloadTokens` metadata token on the driver's avatar object
 * and constructs the public download URL directly, rather than calling the Admin SDK's own
 * `getDownloadURL(file)` helper — that helper goes through the Firebase Storage REST proxy, which
 * evaluates `storage.rules` against `request.auth`; an Admin SDK service-account request carries no
 * Firebase Auth token, and `avatar.jpg` is staff-only-read (`storage.rules`), so `getDownloadURL()`
 * would be denied here exactly the way `claims/bundle.ts`'s own comment documents for its
 * admin-locked evidence paths. Minting the token directly via `setMetadata` (same mechanism
 * bundle.ts uses) and building the URL ourselves sidesteps that: the token itself is the credential
 * for this ONE object, independent of `storage.rules`, which is exactly why this is safe to hand to
 * an anonymous guest reading their own job's projection — the raw object stays staff-locked, but this
 * one pre-signed link is not.
 *
 * Never throws: an avatar that's missing, unreadable, or fails to sign degrades to no `photoUrl`
 * (the schema field is optional) rather than failing the whole projection rebuild.
 */
async function signedAvatarUrl(deps: Deps, avatarPath: string): Promise<string | undefined> {
  try {
    const file = deps.storage.bucket().file(avatarPath);
    const [meta] = await file.getMetadata();
    const existing = (meta.metadata as Record<string, string> | undefined)?.firebaseStorageDownloadTokens;
    const token = existing?.split(',')[0] || randomUUID();
    if (!existing) await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    return `https://firebasestorage.googleapis.com/v0/b/${file.bucket.name}/o/${encodeURIComponent(avatarPath)}?alt=media&token=${token}`;
  } catch {
    return undefined;
  }
}

/**
 * Derives the job's assigned-driver public info for the guest projection — `firstName`/`photoUrl`/
 * `vehicle`/`etaAt`/`geo`. Freshly derived on every projection rebuild (same "survives an unrelated
 * rebuild" reasoning as `deriveLinkedJobs`) rather than written once at assignment time: a plain
 * merge-write from the assignment step would race the NEXT full-overwrite rebuild (any later status
 * change on the same job) and lose the field, since `buildProjection`'s caller always `.set()`s the
 * whole document. Deriving it here instead means the assignment step needs no projection write of
 * its own at all — the very next `ticketWrittenHandler` call (which the assignment already triggers)
 * picks it up automatically. Returns `undefined` for a valet ticket, an unassigned/terminal job, or a
 * primary driver whose user doc is missing.
 */
export async function deriveDriverInfo(deps: Deps, operatorId: string, t: Ticket): Promise<GuestTicket['driver'] | undefined> {
  if (t.jobType === 'valet') return undefined;
  const uid = t.attendants.primaryDriverUid;
  if (!uid || TERMINAL_STATUSES.includes(t.status)) return undefined;
  const userSnap = await deps.db.doc(P.user(operatorId, uid)).get();
  if (!userSnap.exists) return undefined;
  const u = userSnap.data() as User;
  const firstName = u.displayName.trim().split(/\s+/)[0] || u.displayName;
  const photoUrl = u.avatarPath ? await signedAvatarUrl(deps, u.avatarPath) : undefined;
  let vehicle: string | undefined;
  if (t.jobType === 'passenger_ride' && t.vehicle.fleetVehicleId) {
    const fvSnap = await deps.db.doc(P.fleetVehicle(operatorId, t.vehicle.fleetVehicleId)).get();
    if (fvSnap.exists) {
      const fv = fvSnap.data() as FleetVehicle;
      vehicle = [fv.color, fv.make, fv.model].filter(Boolean).join(' ') || undefined;
    }
  }
  const etaAt = t.jobType === 'drive_home' ? t.driveHome?.etaAt : t.ride?.etaAt;
  // liveLocations is also read here (not left to etaRefresh's own targeted merge-write alone) for the
  // SAME reason etaAt/photoUrl are derived here: a full-overwrite rebuild triggered by ANY OTHER
  // status change between two etaRefresh ticks would otherwise silently drop `geo` for up to one
  // 60s cycle. Expired entries (past their TTL) are treated as absent, not stale-but-shown.
  const locSnap = await deps.db.doc(P.liveLocation(operatorId, uid)).get();
  const loc = locSnap.exists ? (locSnap.data() as LiveLocation) : undefined;
  const geo = loc && loc.expiresAt > deps.now() ? loc.geo : undefined;
  return { firstName, ...(photoUrl ? { photoUrl } : {}), ...(vehicle ? { vehicle } : {}), ...(etaAt ? { etaAt } : {}), ...(geo ? { geo } : {}) };
}
