import { canTransition, MANAGER_ROLES, type CallableParsedInput, type CallableOutput, type FleetVehicle, type Operator, type PlatformErrorCode, type Ticket, type Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { canAccessVenue } from '../../lib/venueAccess.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { isDriverEligible } from './eligibility.js';
import { quoteJob } from './quote.js';

const ASSIGN_ROLES = [...MANAGER_ROLES, 'platform_admin'] as const;

function mapMissingRequirement(requirement?: string): PlatformErrorCode {
  return requirement === 'eligible_drivers' || requirement === 'eligible_driver_and_vehicle' ? 'driver_not_eligible' : 'ticket_invalid_transition';
}

async function pushAssignedDriver(deps: Deps, operatorId: string, ticketId: string, uid: string, role: 'primary' | 'chase'): Promise<void> {
  const docId = `dispatch_assigned_${ticketId}_${uid}`;
  await deps.db
    .doc(`pushEvents/${docId}`)
    .create({ id: docId, operatorId, ticketId, kind: 'dispatch.assigned', data: { ticketId, role }, toUid: uid, status: 'queued', createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

/**
 * lead/admin/owner/platform_admin. `requireActiveOperator` runs UNCONDITIONALLY — unlike several
 * read-mostly staff callables' `if (!c.roles.includes('platform_admin')) await requireActiveOperator(...)`
 * exemption (`analyticsSummary`, `auditQuery`, `integrations/*`: read-only/inspection, no money or
 * operational state movement), dispatching drivers is an ACT that moves real operational state (and,
 * transitively, an authorization on the guest's card) — an assumed platform_admin session gets no
 * special pass here, matching the same "still gated even for an assumed platform_admin" rule those
 * comments describe for money-moving callables.
 *
 * Eligibility is read from the STORED snapshot (`users.eligibility`, via `isDriverEligible`) and fed
 * into the SAME `@goldstar/platform` state-machine `canTransition` check `firestore.rules` re-derives
 * independently for the client-driven equivalent (mobile never self-assigns — this callable is the
 * only path to `assigned` — but staying consistent with the rules' own eligibility semantics avoids
 * this ever silently drifting from what a direct client write would be allowed to do).
 */
export async function dispatchAssignHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'dispatchAssign'>): Promise<CallableOutput<'dispatchAssign'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => (ASSIGN_ROLES as readonly string[]).includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);
  const ref = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const t = (await ref.get()).data() as Ticket | undefined;
  if (!t) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  if (t.jobType === 'valet') throw err('invalid_argument', 'not a job ticket');

  const isDriveHome = t.jobType === 'drive_home';
  if (isDriveHome) {
    if (!input.chaseDriverUid) throw err('invalid_argument', 'chaseDriverUid required for drive_home');
    if (input.chaseDriverUid === input.primaryDriverUid) throw err('invalid_argument', 'primary and chase driver must be different');
  } else if (!input.fleetVehicleId) {
    throw err('invalid_argument', 'fleetVehicleId required for passenger_ride');
  }

  const primaryField = isDriveHome ? 'driveHome' : 'passengerRide';
  const [primaryEligible, chaseEligible, fleetVehicle] = await Promise.all([
    isDriverEligible(deps, c.operatorId, input.primaryDriverUid, primaryField),
    isDriveHome && input.chaseDriverUid ? isDriverEligible(deps, c.operatorId, input.chaseDriverUid, 'driveHome') : Promise.resolve(true),
    input.fleetVehicleId ? (deps.db.doc(P.fleetVehicle(c.operatorId, input.fleetVehicleId)).get().then((s) => s.data() as FleetVehicle | undefined)) : Promise.resolve(undefined),
  ]);

  const wantsAccessible = !isDriveHome && t.ride?.accessible === true;
  // A chase fleet vehicle is optional for drive_home (the primary driver takes the guest's own car;
  // the chase vehicle just needs to exist and be available WHEN one is supplied) — a passenger_ride
  // vehicle is mandatory (already enforced above) and additionally accessible when the ride requires it.
  const hasFleetVehicle = isDriveHome
    ? !input.fleetVehicleId || fleetVehicle?.status === 'available'
    : !!fleetVehicle && fleetVehicle.status === 'available' && (!wantsAccessible || fleetVehicle.accessible);

  // Fix round 1 (Major #1): `DRIVE_HOME_RULES`'s `confirmed->assigned` requires clause
  // (`src/state/driveHome.ts`) only reads `ctx.primaryEligible`/`chaseEligible` — unlike
  // `RIDE_RULES`'s equivalent, it never consults `ctx.hasFleetVehicle`, so the value computed above
  // is silently IGNORED by `canTransition` below: an already-`in_use` chase vehicle would sail
  // straight through, get double-booked, and — once one of the two jobs completes/cancels —
  // `onJobWritten`'s fleet-release logic would mark it `available` while the OTHER job may still be
  // mid-trip with it. `firestore.rules`' own `transitionRequirements()` has no independent
  // fleet-vehicle check for drive_home either. Enforced explicitly here instead — localized to this
  // callable, the ONLY path to `assigned` for a job (2c-T1 carry: mobile never self-assigns) — rather
  // than widening the shared `@goldstar/platform` state machine every consumer (mobile, dashboard,
  // web, and firestore.rules' own generated transition table) depends on. Same least-blast-radius
  // reasoning `firestore.rules` itself follows for staying under its expression-evaluation cap: fix
  // at the one call site that actually needs it, not by rippling a change through a shared surface.
  if (isDriveHome && input.fleetVehicleId && fleetVehicle?.status !== 'available') {
    throw err('failed_precondition', 'chase vehicle not available');
  }

  // H1(b) (task-6-security-fix.md, corrected per controller ruling): the guest's card must be
  // authorized/paid before dispatch commits a driver/vehicle to the job — UNLESS nobody's card was
  // ever going to be charged in the first place. NOT enforced in firestore.rules'
  // transitionRequirements() (see that rule's own comment) — every formulation tried there
  // measurably tipped tickets/update over the ~1000-expression ceiling; this callable is the only
  // enforcement point. `t.payment` isn't read by `canTransition`/the shared @goldstar/platform state
  // machine at all — same least-blast-radius reason as the chase-vehicle check just above.
  //
  // Conditional on who's paying, not a blanket "every job needs a card": a passenger_ride with
  // `ride.billTo === 'venue'` has no guest card to authorize by design (the venue is invoiced) — the
  // obligation is established structurally by billTo plus the ticket's own always-present venueId
  // (`ticketBaseSchema.venueId` is required, non-empty), not by any payment.status value. Gating
  // that case on payment would make Plan 7 T1's venue-billed rides permanently undispatchable the
  // moment that flow exists, even though nothing fails today (runCheckout currently hardcodes
  // `billTo: 'guest'` unconditionally, so `ride.billTo` isn't actually consulted by checkout yet —
  // this guard is written for the flow Plan 7 T1 is about to build, not one that runs today).
  // drive_home has no billTo field at all (src/schemas/ticket.ts's driveHomeDetailsSchema) — there's
  // no venue-billing concept for a job that's fundamentally "drive the guest's OWN car home", so it
  // falls unconditionally into the payment-required branch, same as before this correction.
  //
  // Ruling W (v0.4.2): `ride.billTo` now also carries 'room' — the guest's hotel folio is the
  // obligation, so like 'venue' no card authorization is required before dispatch (without this, a
  // room-charged ride is permanently undispatchable: the exact over-broad-gate failure H1(b)
  // already fixed once for venue-billed work). Written as the EXCLUSION `!== 'guest'` rather than
  // enumerating 'venue' | 'room' — the same Ruling-AH-pinned shape confirmRide.ts uses, and for the
  // same reason: any future non-guest payer means "someone other than the guest's card owns the
  // obligation", which is precisely the condition under which this gate must stand down.
  const isThirdPartyBilledRide = !isDriveHome && !!t.ride && t.ride.billTo !== 'guest';
  if (!isThirdPartyBilledRide && t.payment?.status !== 'authorized' && t.payment?.status !== 'paid') {
    throw err('ticket_invalid_transition', 'payment_not_authorized');
  }

  const r = canTransition({ jobType: t.jobType, from: t.status, to: 'assigned', roles: c.roles, ctx: { primaryEligible, chaseEligible, hasFleetVehicle } });
  if (!r.ok) {
    if (r.reason === 'missing_requirement') throw err(mapMissingRequirement(r.requirement), r.requirement);
    throw err('ticket_invalid_transition', r.reason);
  }

  const now = deps.now();
  const patch: Record<string, unknown> = { status: 'assigned', 'times.assignedAt': now, 'attendants.primaryDriverUid': input.primaryDriverUid };
  if (isDriveHome) {
    patch['attendants.chaseDriverUid'] = input.chaseDriverUid;
    patch['driveHome.chase.status'] = 'pending';
    if (input.fleetVehicleId) patch['attendants.chaseVehicleId'] = input.fleetVehicleId;
  } else {
    patch['vehicle.fleetVehicleId'] = input.fleetVehicleId;
  }
  await ref.update(patch);
  if (input.fleetVehicleId) {
    await deps.db.doc(P.fleetVehicle(c.operatorId, input.fleetVehicleId)).update({ status: 'in_use', currentDriverUid: isDriveHome ? input.chaseDriverUid : input.primaryDriverUid });
  }

  const merged: Ticket = {
    ...t,
    status: 'assigned',
    times: { ...t.times, assignedAt: now },
    attendants: {
      ...t.attendants,
      primaryDriverUid: input.primaryDriverUid,
      ...(isDriveHome ? { chaseDriverUid: input.chaseDriverUid, ...(input.fleetVehicleId ? { chaseVehicleId: input.fleetVehicleId } : {}) } : {}),
    },
    ...(isDriveHome ? { driveHome: { ...t.driveHome!, chase: { status: 'pending' as const } } } : { vehicle: { ...t.vehicle, fleetVehicleId: input.fleetVehicleId } }),
  };
  // Refreshes the projection (which now derives `driver` from `attendants.primaryDriverUid`, so no
  // separate projection write is needed here) and fires the driveHomeAssigned/rideAssigned SMS.
  await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: t.id, before: t, after: merged });

  await pushAssignedDriver(deps, c.operatorId, t.id, input.primaryDriverUid, 'primary');
  if (isDriveHome && input.chaseDriverUid) await pushAssignedDriver(deps, c.operatorId, t.id, input.chaseDriverUid, 'chase');

  await audit(deps, {
    operatorId: c.operatorId,
    actorUid: c.uid,
    action: 'dispatch.assign',
    target: t.id,
    after: { primaryDriverUid: input.primaryDriverUid, ...(input.chaseDriverUid ? { chaseDriverUid: input.chaseDriverUid } : {}), ...(input.fleetVehicleId ? { fleetVehicleId: input.fleetVehicleId } : {}) },
  });
  return { ok: true };
}

export const dispatchAssign = defineCallable('dispatchAssign', {}, dispatchAssignHandler);

/** Re-quotes a job whose quote has expired (still `status:'quoted'`, guest hasn't confirmed yet). */
export async function dispatchQuoteHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'dispatchQuote'>): Promise<CallableOutput<'dispatchQuote'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => (ASSIGN_ROLES as readonly string[]).includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);
  const ref = deps.db.doc(P.ticket(c.operatorId, input.ticketId));
  const t = (await ref.get()).data() as Ticket | undefined;
  if (!t) throw err('not_found');
  if (!(await canAccessVenue(deps, c, t.venueId))) throw err('permission_denied');
  if (t.jobType === 'valet') throw err('invalid_argument', 'not a job ticket');
  if (t.status !== 'quoted') throw err('ticket_invalid_transition');

  const [opSnap, venueSnap] = await Promise.all([deps.db.doc(P.operator(c.operatorId)).get(), deps.db.doc(P.venue(c.operatorId, t.venueId)).get()]);
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue;
  const { quote, route } = await quoteJob(deps, op, venue, t);
  const isDriveHome = t.jobType === 'drive_home';
  const field = isDriveHome ? 'driveHome' : 'ride';
  await ref.update({ [`${field}.quote`]: quote, [`${field}.route`]: route });
  const merged: Ticket = isDriveHome ? { ...t, driveHome: { ...t.driveHome!, quote, route } } : { ...t, ride: { ...t.ride!, quote, route } };
  await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: t.id, before: t, after: merged });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'dispatch.quote', target: t.id, after: { quote } });
  return { quote };
}

export const dispatchQuote = defineCallable('dispatchQuote', { secrets: ['MAPBOX_SERVER_TOKEN'] }, dispatchQuoteHandler);
