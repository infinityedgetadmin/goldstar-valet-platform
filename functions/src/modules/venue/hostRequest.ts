import { canTransition, secretToken, type CallableParsedInput, type CallableOutput, type Ticket, type Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { venueTopicFor } from '../notifications/topics.js';
import { audit } from '../../lib/audit.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { quoteJob } from '../dispatch/quote.js';
import { ETA_PAST_GRACE_MS } from './policy.js';

/**
 * Verifies the caller may act for `venueId` (Plan 7 T1, the T1b gap-5 ruling verbatim): the
 * callable boundary is the enforcement point — the portal always SENDS a claim-derived venue id,
 * but that is a convenience, never a control. Requires the `venue_user` role AND membership of
 * `venueId` in the caller's `venueIds` claim; `permission_denied` either way, with no distinction
 * between "not your venue" and "not a venue_user" (no oracle on which check failed).
 *
 * Deliberately venue_user-only — operator managers act through the operator dashboard's own
 * surfaces (which carry their own venue scoping via `canAccessVenue`), not the host portal's
 * callables, and an assumed platform_admin token carries an empty `venueIds` by design
 * (identity/assume.ts) so it fails membership here regardless.
 *
 * Exported (Plan 7 T3): the POS callables are the same host-portal surface with the same §9.1
 * acceptance criterion, so they share THIS gate rather than a re-derivation.
 */
export function requireVenueUser(caller: Caller | null, venueId: string): Caller & { operatorId: string } {
  const c = requireOperator(caller);
  if (!c.roles.includes('venue_user') || !c.venueIds.includes(venueId)) throw err('permission_denied');
  return c;
}

/** One calendar day — the roll-forward step in `etaToInstant`. Deliberately its OWN constant
 * and NOT `VALIDATION_TTL_MS` (policy.ts): that a validation lives 24h and that "next
 * occurrence of a wall-clock time" is a day later are unrelated facts that happen to share a
 * number; conflating them would couple a money policy to calendar arithmetic (T1 re-review,
 * Ruling AL Low-1). */
const ONE_DAY_MS = 24 * 3600_000;

/** The pre-arrival topic every staff device at a venue subscribes to (task brief: "pushes topic
 * `venue_{op}_{venueId}`"). */
// Plan 8 Task 12 (carry #15): topic names come from notifications/topics.ts — `venue_{pushSlug}`,
// never the guessable `venue_{op}_{venueId}` this used to compose by hand.

async function queuePush(deps: Deps, id: string, event: Record<string, unknown>): Promise<void> {
  // .create + code-6 swallow — the same redelivery-safe enqueue every pushEvents producer uses
  // (dispatch/assign.ts's pushAssignedDriver): a retried call for the same id is a no-op, never a
  // reset of an in-flight event.
  await deps.db
    .doc(`pushEvents/${id}`)
    .create({ id, status: 'queued', createdAt: deps.now(), ...event })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

interface HostRequestDocInput {
  kind: 'car' | 'pre_arrival' | 'ride';
  status: 'open' | 'matched' | 'unmatched';
  ticketId?: string | undefined;
  table?: string | undefined;
  phoneLast4?: string | undefined;
  name?: string | undefined;
  eta?: string | undefined;
  partySize?: number | undefined;
  vip?: boolean | undefined;
  note?: string | undefined;
}

async function createHostRequestDoc(deps: Deps, operatorId: string, venueId: string, by: string, input: HostRequestDocInput): Promise<string> {
  const id = deps.newId();
  const { kind, status, ticketId, table, phoneLast4, name, eta, partySize, vip, note } = input;
  await deps.db.doc(P.hostRequest(operatorId, id)).create({
    id,
    operatorId,
    venueId,
    kind,
    status,
    at: deps.now(),
    by,
    vip: vip ?? false,
    ...(ticketId !== undefined ? { ticketId } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(phoneLast4 !== undefined ? { phoneLast4 } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(eta !== undefined ? { eta } : {}),
    ...(partySize !== undefined ? { partySize } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  return id;
}

/** Resolves the guest phone the host typed into a last-4 for ticket matching. */
function phoneLast4From(input: { phoneLast4?: string | undefined; phoneE164?: string | undefined }): string | undefined {
  if (input.phoneLast4) return input.phoneLast4;
  if (input.phoneE164) return input.phoneE164.slice(-4);
  return undefined;
}

/** Milliseconds between a UTC instant and the same wall-clock reading in `timeZone` — the
 * standard Intl round-trip (no tz library in this runtime). */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

/**
 * Ruling AD: `hostRequests.eta` must be an ISO INSTANT, never a bare local-time string — a bare
 * "19:30" is ambiguous the moment anything reads it from another timezone (operator dashboard,
 * multi-venue operators, hour-bucketed rollups). The host types venue-local "HH:mm"; this anchors
 * it to the venue's IANA timezone on the venue-local CURRENT date, and a reading that already
 * passed rolls to the NEXT occurrence (a host typing 12:15am at 11:50pm means tomorrow). Display
 * stays local (the push payload formats it back through the same timezone). Exported for its own
 * unit tests. Returns undefined for input that isn't HH:mm — the caller rejects that as
 * invalid_argument rather than storing an unparseable string.
 *
 * Ruling AF — the past-reading rule, and why it is a WINDOW rather than an unconditional roll:
 * a reading up to `ETA_PAST_GRACE_MS` (30 min) past venue-local now clamps to NOW ("about now"
 * — a mistype, a slowly-filled form, a host who glanced at the clock before the guest called);
 * anything further past rolls to the next occurrence (12:15am typed at 11:50pm means tomorrow;
 * 2pm typed at 8pm means tomorrow's lunch). The asymmetry that justifies the window: rolling a
 * just-passed time parks the card 24h out where TONIGHT'S stand never sees it — a silent,
 * undiagnosable failure in front of a guest — while clamping merely surfaces the card minutes
 * early. See policy.ts for the full rationale; a future reader must not "simplify" the window
 * away.
 */
export function etaToInstant(eta: string, timeZone: string, nowIso: string): string | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(eta.trim());
  if (!m) return undefined;
  const nowMs = Date.parse(nowIso);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateParts = Object.fromEntries(dtf.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const wallAsUtc = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day), Number(m[1]), Number(m[2]));
  // local wall time -> instant: two-pass fixed point over the zone offset. THE SECOND PASS IS
  // LOAD-BEARING (Ruling AL): across a DST transition the offset AT the guessed instant differs
  // from the offset at the naive wall reading, and a single-pass version is exactly one hour
  // wrong — the "RULING AL: DST" unit test constructs the straddling case that proves it. Do
  // not "simplify" this to one pass.
  let instant = wallAsUtc - tzOffsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - tzOffsetMs(instant, timeZone);
  // Ruling AF: within the grace window, "just passed" means "about now"; beyond it, tomorrow.
  if (instant < nowMs - ETA_PAST_GRACE_MS) instant += ONE_DAY_MS;
  else if (instant < nowMs) instant = nowMs;
  return new Date(instant).toISOString();
}

/** Venue-local short time for push copy (e.g. "7:30 PM") — display stays local per Ruling AD. */
function etaDisplayLocal(instantIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, timeStyle: 'short' }).format(new Date(instantIso));
}

/**
 * `venueHostRequest` (Plan 7 Task 1, platform half). Three kinds:
 *
 * - `car`: find the guest's active `checked_in` valet ticket at the venue by phone last-4
 *   (+ optional name to narrow) and transition it to `requested` with the ticket's `hostRequest`
 *   block set. Exactly ONE match transitions; zero matches — or MORE than one after narrowing —
 *   create an `unmatched` `hostRequests` doc instead and notify the stand: with several same-last-4
 *   candidates, guessing requests the WRONG guest's car, and the stand (who can see plates and
 *   faces) is the right place to disambiguate. The response's `ticketId` presence is what the
 *   dashboard's matched/unmatched copy branches on.
 * - `pre_arrival`: create an open `hostRequests` doc and push topic `venue_{op}_{venueId}`.
 * - `ride` (Ruling Q): create a venue-billed `passenger_ride` ticket — see the block below.
 */
export async function venueHostRequestHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'venueHostRequest'>,
): Promise<CallableOutput<'venueHostRequest'>> {
  const c = requireVenueUser(caller, input.venueId);
  const op = await requireActiveOperator(deps, c.operatorId); // staff-scoped venue callable — suspension-gated like every other staff ACT

  if (input.kind === 'car') {
    const last4 = phoneLast4From(input);
    if (!last4) throw err('invalid_argument', 'phoneLast4 or phoneE164 required for a car request');

    // Equality-only query (venueId + status), phone narrowed in memory: the pair is served by
    // Firestore's single-field index merging with no composite (and no registry entry) needed,
    // and a venue's concurrently-parked population is small. Matching on the query instead of
    // scanning all tickets keeps this O(cars on the stand).
    const snap = await deps.db
      .collection(`operators/${c.operatorId}/tickets`)
      .where('venueId', '==', input.venueId)
      .where('status', '==', 'checked_in')
      .get();
    let candidates = snap.docs.map((d) => d.data() as Ticket).filter((t) => t.jobType === 'valet' && t.guest.phoneLast4 === last4);
    if (candidates.length > 1 && input.name) {
      const needle = input.name.trim().toLowerCase();
      const narrowed = candidates.filter((t) => (t.guest.name ?? '').trim().toLowerCase() === needle);
      if (narrowed.length > 0) candidates = narrowed;
    }

    if (candidates.length === 1) {
      const ticket = candidates[0]!;
      if (!canTransition({ jobType: 'valet', from: 'checked_in', to: 'requested', roles: ['venue_user'] }).ok) throw err('ticket_invalid_transition');
      const now = deps.now();
      const hostRequestBlock = {
        requestedBy: c.uid,
        ...(input.table !== undefined ? { table: input.table } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      await deps.db.doc(P.ticket(c.operatorId, ticket.id)).update({ status: 'requested', 'times.requestedAt': now, hostRequest: hostRequestBlock });
      const after = { ...ticket, status: 'requested', times: { ...ticket.times, requestedAt: now }, hostRequest: hostRequestBlock } as unknown as Ticket;
      await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: ticket.id, before: ticket, after });
      const hostRequestId = await createHostRequestDoc(deps, c.operatorId, input.venueId, c.uid, {
        kind: 'car',
        status: 'matched',
        ticketId: ticket.id,
        ...(input.table !== undefined ? { table: input.table } : {}),
        phoneLast4: last4,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.hostRequest', target: hostRequestId, after: { kind: 'car', matched: true, ticketId: ticket.id } });
      return { hostRequestId, ticketId: ticket.id };
    }

    // Zero or ambiguous — the stand resolves it. The topic push is what backs the dashboard's
    // "the valet stand has been notified" copy; `venue.request`'s existing copyFor entry fits.
    const hostRequestId = await createHostRequestDoc(deps, c.operatorId, input.venueId, c.uid, {
      kind: 'car',
      status: 'unmatched',
      ...(input.table !== undefined ? { table: input.table } : {}),
      phoneLast4: last4,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    const carTopic = await venueTopicFor(deps, c.operatorId, input.venueId);
    if (carTopic) {
      await queuePush(deps, `venue_car_${hostRequestId}`, {
        operatorId: c.operatorId,
        ticketId: '',
        kind: 'venue.request',
        data: { venueId: input.venueId },
        toTopic: carTopic,
      });
    } else {
      console.warn('venueHostRequest: venue has no pushSlug yet — staff topic push skipped', { operatorId: c.operatorId, venueId: input.venueId });
    }
    await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.hostRequest', target: hostRequestId, after: { kind: 'car', matched: false, candidates: candidates.length } });
    return { hostRequestId };
  }

  if (input.kind === 'pre_arrival') {
    if (!input.name) throw err('invalid_argument', 'name required for a pre-arrival');
    const preArrivalLast4 = phoneLast4From(input);
    // Ruling AD: eta is stored as an ISO instant anchored to the VENUE's timezone (falling back
    // to the operator's — `venueSchema.timezone` is optional, `operatorSchema.timezone` is not).
    let etaInstant: string | undefined;
    let etaLocal: string | undefined;
    if (input.eta !== undefined) {
      const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
      if (!venue) throw err('not_found', 'venue');
      const timeZone = venue.timezone ?? op.timezone;
      etaInstant = etaToInstant(input.eta, timeZone, deps.now());
      if (etaInstant === undefined) throw err('invalid_argument', 'eta must be HH:mm');
      etaLocal = etaDisplayLocal(etaInstant, timeZone);
    }
    const hostRequestId = await createHostRequestDoc(deps, c.operatorId, input.venueId, c.uid, {
      kind: 'pre_arrival',
      status: 'open',
      name: input.name,
      ...(etaInstant !== undefined ? { eta: etaInstant } : {}),
      ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
      ...(input.vip !== undefined ? { vip: input.vip } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(preArrivalLast4 !== undefined ? { phoneLast4: preArrivalLast4 } : {}),
    });
    const preTopic = await venueTopicFor(deps, c.operatorId, input.venueId);
    if (preTopic) {
      await queuePush(deps, `venue_prearrival_${hostRequestId}`, {
        operatorId: c.operatorId,
        ticketId: '',
        kind: 'venue.pre_arrival',
        data: {
          venueId: input.venueId,
          name: input.name,
          ...(etaLocal !== undefined ? { eta: etaLocal } : {}),
          ...(input.partySize !== undefined ? { partySize: String(input.partySize) } : {}),
          ...(input.vip ? { vip: '1' } : {}),
        },
        toTopic: preTopic,
      });
    } else {
      console.warn('venueHostRequest: venue has no pushSlug yet — pre-arrival topic push skipped', { operatorId: c.operatorId, venueId: input.venueId });
    }
    await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.hostRequest', target: hostRequestId, after: { kind: 'pre_arrival' } });
    return { hostRequestId };
  }

  // kind === 'ride' — Ruling Q.
  //
  // Ruling R: `dropoff`/`passengers`/`accessible` are optional ON THE INPUT SCHEMA (the other two
  // kinds don't use them) and required HERE — all three, no defaults. A defaulted `passengers: 1`
  // invents a party size that drives vehicle assignment; `accessible: false` is not a neutral
  // default, it is the field that decides whether a wheelchair-accessible vehicle is dispatched.
  // The system must never assert what nobody said inside a ticket that commits a vehicle.
  const missing = (['dropoff', 'passengers', 'accessible'] as const).filter((k) => input[k] === undefined);
  if (missing.length > 0) throw err('invalid_argument', `${missing.join(', ')} required for a ride request`);
  const { dropoff, passengers, accessible } = input as typeof input & { dropoff: NonNullable<typeof input.dropoff>; passengers: number; accessible: boolean };

  const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');
  if (!op.features.passengerRides) throw err('failed_precondition', 'passenger rides not enabled for this operator');

  // Mirror the state machine where a real actor exists (requestDriveHome's own discipline):
  if (!canTransition({ jobType: 'passenger_ride', from: null, to: 'requested', roles: ['venue_user'] }).ok) throw err('ticket_invalid_transition');
  if (!canTransition({ jobType: 'passenger_ride', from: 'requested', to: 'quoted', roles: ['platform_admin'] }).ok) throw err('ticket_invalid_transition');

  const now = deps.now();
  const jobBase: Ticket = {
    id: deps.newId(),
    operatorId: c.operatorId,
    venueId: input.venueId,
    jobType: 'passenger_ride',
    status: 'requested',
    source: 'host_portal',
    // `phoneLast4` is required on `ticketBaseSchema.guest`; a host may not have the guest's
    // phone — '0000' is the schema-valid, documented display-only sentinel (Ruling Q precedent,
    // see guest/deleteAccount.ts's DELETED_PHONE_SENTINEL comment trail).
    guest: {
      phoneLast4: phoneLast4From(input) ?? '0000',
      consentSms: false,
      ...(input.name !== undefined ? { name: input.name } : {}),
    },
    vehicle: {},
    flags: { assistance: false, accessibleVehicle: accessible, photosSkipped: false, vip: input.vip ?? false },
    attendants: {},
    times: { checkedInAt: now, requestedAt: now },
    damageReportIds: [],
    incidentIds: [],
    guestToken: secretToken(),
    ride: {
      pickup: { geo: venue.geo, address: `${venue.address.line1}, ${venue.address.city}` },
      dropoff,
      passengers,
      accessible,
      billTo: 'venue',
    },
  } as unknown as Ticket;

  const { quote, route } = await quoteJob(deps, op, venue, jobBase);

  // quoted→confirmed happens server-side in this same call, deliberately WITHOUT a role-based
  // canTransition() mirror — the H1(a) doctrine, verbatim from confirmDriveHome.ts/confirmRide.ts:
  // that transition's role list no longer names any actor this flow has (the security fix removed
  // guest and venue_user so no CLIENT write can reach 'confirmed'), and this callable's
  // authorization was never a role mirror anyway — it is requireVenueUser() above plus this
  // explicit create→quote→confirm flow. Venue-billed work has no card to authorize between quote
  // and confirm (guestConfirmRide REJECTS billTo:'venue' for exactly that reason — this arm is
  // the only path), the venue accepts its contracted rates by policy (Ruling T: the operator's
  // real sign-off is dispatchAssign, whose payment gate is billTo-aware), and the quote is
  // persisted on `ride.quote` for the invoicing rollup. One write at 'confirmed' — the same
  // "never observably in an intermediate state" simplification requestDriveHome.ts documents for
  // its own create-at-quoted write; 'requested'/'quoted' have no observers here either.
  const job: Ticket = { ...jobBase, status: 'confirmed', ride: { ...jobBase.ride!, quote, route } };
  await deps.db.doc(P.ticket(c.operatorId, job.id)).set(job);
  await ticketWrittenHandler(deps, { operatorId: c.operatorId, ticketId: job.id, before: null, after: job });

  const hostRequestId = await createHostRequestDoc(deps, c.operatorId, input.venueId, c.uid, {
    kind: 'ride',
    status: 'matched',
    ticketId: job.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.vip !== undefined ? { vip: input.vip } : {}),
  });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'venue.hostRequest', target: hostRequestId, after: { kind: 'ride', ticketId: job.id, passengers, accessible } });
  return { hostRequestId, ticketId: job.id };
}

export const venueHostRequest = defineCallable('venueHostRequest', { secrets: ['MAPBOX_SERVER_TOKEN'] }, venueHostRequestHandler);
