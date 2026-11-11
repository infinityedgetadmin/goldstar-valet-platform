import type { DRIVE_HOME_STATUSES, RIDE_STATUSES, VALET_STATUSES } from '../../src/domain/status';
import type { DamageReport, Photo } from '../../src/schemas/damage';
import type { KeyTag } from '../../src/schemas/keyTag';
import type { LiveLocation } from '../../src/schemas/liveLocation';
import type { CustodyEvent, PaymentState, Ticket } from '../../src/schemas/ticket';
import type { Transaction } from '../../src/schemas/transaction';
import { FLEET, GUEST_NAME, GUEST_PHONE, GUEST_UID, OP, SHIFTS, USERS, V_EVENT, V_HOTEL, V1 } from './constants';
import type { DemoClock } from './context';
import { demoSha256, demoToken, demoUuid } from './context';
import { demoPhoto } from './photos';
import type { DemoStorageObject, SeedDoc } from './types';

type ValetStatus = (typeof VALET_STATUSES)[number];
type DriveHomeStatus = (typeof DRIVE_HOME_STATUSES)[number];
type RideStatus = (typeof RIDE_STATUSES)[number];
type CustodyAction = CustodyEvent['action'];

const DEVICE = 'demo-device';
const CURRENCY = 'USD';
/** Tax rates mirror places.ts venue rates (basis points). */
const TAX_BPS: Record<string, number> = { [V1]: 700, [V_HOTEL]: 900, [V_EVENT]: 700 };
const BASE_PRICE: Record<string, number> = { [V1]: 1500, [V_HOTEL]: 4800, [V_EVENT]: 2000 };

interface Vehicle {
  plate: string;
  state: string;
  make: string;
  model: string;
  color: string;
}

const VEHICLES: readonly Vehicle[] = [
  { plate: 'GSV101', state: 'IN', make: 'Chevrolet', model: 'Corvette', color: 'White' },
  { plate: 'IND442', state: 'IN', make: 'Porsche', model: '911', color: 'Black' },
  { plate: 'LMB777', state: 'IN', make: 'Lamborghini', model: 'Urus', color: 'Purple' },
  { plate: 'FRR488', state: 'IL', make: 'Ferrari', model: '488 Spider', color: 'Red' },
  { plate: 'BNT120', state: 'IN', make: 'Bentley', model: 'Continental GT', color: 'Black' },
  { plate: 'TSL900', state: 'IN', make: 'Tesla', model: 'Model S', color: 'Silver' },
  { plate: 'RNG550', state: 'OH', make: 'Land Rover', model: 'Range Rover', color: 'Grey' },
  { plate: 'MBZ300', state: 'IN', make: 'Mercedes-Benz', model: 'S 580', color: 'Navy' },
  { plate: 'AUD812', state: 'IN', make: 'Audi', model: 'RS 7', color: 'Grey' },
  { plate: 'LEX350', state: 'KY', make: 'Lexus', model: 'RX 350', color: 'Pearl' },
  { plate: 'CAD210', state: 'IN', make: 'Cadillac', model: 'Escalade', color: 'Black' },
  { plate: 'BMW540', state: 'IN', make: 'BMW', model: '540i', color: 'Blue' },
  { plate: 'TOY330', state: 'IN', make: 'Toyota', model: 'Camry', color: 'Silver' },
  { plate: 'HND880', state: 'IN', make: 'Honda', model: 'Accord', color: 'White' },
  { plate: 'JEP451', state: 'IN', make: 'Jeep', model: 'Grand Cherokee', color: 'Green' },
  { plate: 'MSR220', state: 'IN', make: 'Maserati', model: 'Ghibli', color: 'White' },
];

/** Colors for repeat laps through VEHICLES; none is a base vehicle's color, so a repeat car never
 * looks like its first-lap twin. */
const LAP_COLORS = ['Midnight Blue', 'Graphite', 'Champagne', 'Crimson', 'Forest Green'] as const;

const GUEST_NAMES = [
  'Olivia Bennett', 'Ethan Clarke', 'Sophia Martinez', 'Noah Patel', 'Ava Thompson', 'Liam Johnson',
  'Mia Robinson', 'Lucas Nguyen', 'Isabella King', 'Mason Wright', 'Charlotte Hayes', 'James Foster',
  'Amelia Russell', 'Benjamin Cole', 'Harper Lane', 'Elijah Price',
] as const;

/** Builder state: deterministic id/token counters plus everything emitted so far. */
class TicketBuilder {
  private idSeq = 0x1000;
  private tokenSeq = 100;
  private photoSeq = 0;
  private keyTagSeq = 3; // base seed: k1 free (Maestro check-in), k2 on the Ford
  private nameSeq = 0;
  private vehicleSeq = 0;
  readonly docs: SeedDoc[] = [];
  readonly storage: DemoStorageObject[] = [];
  readonly expected: Record<string, string> = {};

  constructor(readonly clock: DemoClock) {}

  id(): string {
    return demoUuid(this.idSeq++);
  }
  token(): string {
    return demoToken(this.tokenSeq++);
  }
  /** The first lap through VEHICLES hands them out as listed (demo walkthroughs search for those
   * plates). Each later lap keeps the make and model but gives the car its own plate and a color
   * no base vehicle uses, so no two tickets ever show the same car. */
  vehicle(): Vehicle {
    const n = this.vehicleSeq++;
    const index = n % VEHICLES.length;
    const lap = Math.floor(n / VEHICLES.length);
    const v = VEHICLES[index];
    if (!v) throw new Error('VEHICLES is empty');
    if (lap === 0) return v;
    const color = LAP_COLORS[(index + lap) % LAP_COLORS.length] ?? v.color;
    const digits = (Number(v.plate.slice(3)) + 101 * lap) % 1000;
    return { ...v, plate: `${v.plate.slice(0, 3)}${String(digits).padStart(3, '0')}`, color };
  }
  guest(over: Partial<Ticket['guest']> = {}): Ticket['guest'] {
    const name = GUEST_NAMES[this.nameSeq % GUEST_NAMES.length] ?? 'Guest';
    const last4 = String(4100 + this.nameSeq++).slice(-4);
    return { phoneE164: `+1317555${last4}`, phoneLast4: last4, name, consentSms: true, ...over };
  }

  /** Assigns the next St. Elmo key tag (k3, k4, ...) to an active ticket. */
  stElmoKeyTag(ticketId: string, lastCustodyEventId: string | undefined): string {
    const n = this.keyTagSeq++;
    const tag: KeyTag = {
      id: `k${n}`,
      operatorId: OP,
      value: `GS-V1-${String(n).padStart(4, '0')}`,
      venueId: V1,
      status: 'assigned',
      currentTicketId: ticketId,
      ...(lastCustodyEventId ? { lastCustodyEventId } : {}),
    };
    this.docs.push({ kind: 'keyTag', path: `operators/${OP}/keyTags/${tag.id}`, data: tag });
    return tag.id;
  }

  /** Writes custody events for `steps` and returns the last event id (ticket.lastCustodyEventId). */
  custody(ticketId: string, actor: string, steps: ReadonlyArray<readonly [CustodyAction, string]>, zoneId?: string): string | undefined {
    let last: string | undefined;
    for (const [action, at] of steps) {
      const ev: CustodyEvent = { id: this.id(), actorUid: actor, action, at, deviceId: DEVICE, ...(zoneId && action === 'parked' ? { zoneId } : {}) };
      this.docs.push({ kind: 'custodyEvent', path: `operators/${OP}/tickets/${ticketId}/custodyEvents/${ev.id}`, data: ev });
      last = ev.id;
    }
    return last;
  }

  /** A damage report with `count` real photos, uploaded to Storage under the ticket's folder. */
  damageReport(ticket: { id: string; vehicle: Vehicle }, phase: DamageReport['phase'], actor: string, at: string, count: number, marks: DamageReport['diagramMarks'] = []): string {
    const reportId = this.id();
    const report: DamageReport = {
      id: reportId,
      operatorId: OP,
      ticketId: ticket.id,
      vehicleSnapshot: { plate: ticket.vehicle.plate, make: ticket.vehicle.make, model: ticket.vehicle.model, color: ticket.vehicle.color },
      phase,
      diagramMarks: marks,
      notes: marks.length ? 'Pre-existing marks noted with the guest at the curb.' : 'No visible damage.',
      createdBy: actor,
      createdAt: at,
      // Set directly: the server-side drive-home gate (onJobWritten) reads photoCount, and the
      // onPhotoCreated trigger that would otherwise maintain it may not be running.
      photoCount: count,
    };
    this.docs.push({ kind: 'damageReport', path: `operators/${OP}/damageReports/${reportId}`, data: report });
    const stages: Photo['stage'][] = ['wide', 'wide', 'medium', 'close'];
    for (let i = 0; i < count; i++) {
      const asset = demoPhoto(this.photoSeq);
      const photoId = this.id();
      const storagePath = `operators/${OP}/tickets/${ticket.id}/photos/${photoId}.jpg`;
      const photo: Photo = {
        id: photoId,
        storagePath,
        stage: stages[i % stages.length] ?? 'wide',
        at,
        actorUid: actor,
        deviceId: DEVICE,
        bytes: asset.bytes,
        width: asset.width,
        height: asset.height,
        sha256: demoSha256(0x5000 + this.photoSeq++),
      };
      this.docs.push({ kind: 'photo', path: `operators/${OP}/damageReports/${reportId}/photos/${photoId}`, data: photo });
      this.storage.push({ path: storagePath, source: asset.file, contentType: 'image/jpeg' });
    }
    return reportId;
  }

  transaction(t: Pick<Ticket, 'id' | 'venueId'>, p: PaymentState, over: Partial<Transaction> & Pick<Transaction, 'provider' | 'kind' | 'status'>): void {
    const tx: Transaction = {
      id: `tx-${t.id.slice(-8)}-${over.kind}`,
      operatorId: OP,
      venueId: t.venueId,
      ticketId: t.id,
      providerRef: `${over.provider === 'stripe' ? 'pi' : over.provider}_demo_${t.id.slice(-8)}`,
      base: p.base,
      tip: p.tip,
      tax: p.tax,
      fees: p.fees,
      total: p.total,
      currency: CURRENCY,
      method: p.method ?? 'web',
      at: p.paidAt ?? this.clock.now.toISOString(),
      refunds: [],
      ...(over.provider === 'stripe' ? { platformFee: Math.round(p.total * 0.015), destinationAccountId: 'acct_demo_goldstar' } : {}),
      ...over,
    };
    this.docs.push({ kind: 'transaction', path: `operators/${OP}/transactions/${tx.id}`, data: tx });
  }

  ticket(t: Ticket): void {
    const path = `operators/${OP}/tickets/${t.id}`;
    this.docs.push({ kind: 'ticket', path, data: t });
    this.expected[path] = t.status;
  }
}

function payment(venueId: string, status: PaymentState['status'], opts: { tip?: number; method?: PaymentState['method']; billTo?: PaymentState['billTo']; paidAt?: string; base?: number } = {}): PaymentState {
  const base = opts.base ?? BASE_PRICE[venueId] ?? 1500;
  const tax = Math.round((base * (TAX_BPS[venueId] ?? 0)) / 10_000);
  const tip = opts.tip ?? 0;
  return {
    status,
    base,
    tip,
    tax,
    fees: 0,
    total: base + tax + tip,
    currency: CURRENCY,
    billTo: opts.billTo ?? 'guest',
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.paidAt ? { paidAt: opts.paidAt, capturedAt: opts.paidAt } : {}),
  };
}

const NO_FLAGS: Ticket['flags'] = { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false };

/** Times for a valet ticket that reached `status`, ending `ageMin` minutes ago. */
function valetTimes(clock: DemoClock, status: ValetStatus, checkedInMinAgo: number, requestedMinAgo: number): Ticket['times'] {
  const t: Ticket['times'] = { checkedInAt: clock.minutesAgo(checkedInMinAgo) };
  const order: ValetStatus[] = ['requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered', 'closed'];
  const reached = (s: ValetStatus): boolean => status !== 'checked_in' && status !== 'cancelled' && order.indexOf(status) >= order.indexOf(s);
  if (reached('requested')) t.requestedAt = clock.minutesAgo(requestedMinAgo);
  if (reached('claimed')) t.claimedAt = clock.minutesAgo(Math.max(requestedMinAgo - 1, 0));
  if (reached('staged')) t.stagedAt = clock.minutesAgo(Math.max(requestedMinAgo - 4, 0));
  if (reached('ready')) t.readyAt = clock.minutesAgo(Math.max(requestedMinAgo - 5, 0));
  if (reached('delivered')) t.deliveredAt = clock.minutesAgo(Math.max(requestedMinAgo - 7, 0));
  if (reached('closed')) t.closedAt = clock.minutesAgo(Math.max(requestedMinAgo - 8, 0));
  if (status === 'cancelled') t.cancelledAt = clock.minutesAgo(Math.max(requestedMinAgo, 0));
  return t;
}

/** Custody actions a valet ticket has accumulated by `status`. */
function valetCustody(status: ValetStatus): CustodyAction[] {
  const steps: CustodyAction[] = ['checked_in', 'keys_stored', 'parked'];
  if (['claimed', 'retrieving', 'staged', 'ready', 'delivered', 'closed'].includes(status)) steps.push('keys_taken');
  if (['retrieving', 'staged', 'ready', 'delivered', 'closed'].includes(status)) steps.push('retrieved');
  if (['staged', 'ready', 'delivered', 'closed'].includes(status)) steps.push('staged');
  if (['delivered', 'closed'].includes(status)) steps.push('delivered', 'keys_returned');
  return steps;
}

interface ValetSpec {
  venueId: string;
  status: ValetStatus;
  checkedInMinAgo: number;
  requestedMinAgo?: number;
  zoneId: string;
  spotLabel?: string;
  flags?: Partial<Ticket['flags']>;
  guest?: Partial<Ticket['guest']>;
  payment?: PaymentState;
  attendant?: string;
  claimedBy?: string;
  checkInPhotos?: boolean;
  source?: Ticket['source'];
  cancelReason?: string;
  hostRequest?: Ticket['hostRequest'];
  shiftId?: string;
  keyTag?: boolean;
}

function addValet(b: TicketBuilder, spec: ValetSpec): Ticket {
  const id = b.id();
  const vehicle = b.vehicle();
  const requestedMinAgo = spec.requestedMinAgo ?? Math.max(spec.checkedInMinAgo - 60, 1);
  const times = valetTimes(b.clock, spec.status, spec.checkedInMinAgo, requestedMinAgo);
  const actor = spec.attendant ?? USERS.att1;
  const custodySteps = valetCustody(spec.status).map((action, i) => [action, b.clock.minutesAgo(Math.max(spec.checkedInMinAgo - i * 2, 0))] as const);
  const lastCustodyEventId = spec.status === 'cancelled' ? undefined : b.custody(id, actor, custodySteps, spec.zoneId);
  const active = !['delivered', 'closed', 'cancelled'].includes(spec.status);
  const keyTagId = spec.venueId === V1 && active && spec.keyTag !== false ? b.stElmoKeyTag(id, lastCustodyEventId) : undefined;
  const damageReportIds = spec.checkInPhotos
    ? [
        b.damageReport({ id, vehicle }, 'check_in', actor, times.checkedInAt, 4, [
          { panel: 'front_bumper', x: 0.32, y: 0.71, kind: 'scratch', preExisting: true, note: 'Light scuff, driver side' },
          { panel: 'rear_left_door', x: 0.58, y: 0.44, kind: 'dent', preExisting: true },
        ]),
      ]
    : [];
  const claimedBy = spec.claimedBy ?? (times.claimedAt ? actor : undefined);
  const ticket: Ticket = {
    id,
    operatorId: OP,
    venueId: spec.venueId,
    ...(spec.shiftId ? { shiftId: spec.shiftId } : {}),
    jobType: 'valet',
    status: spec.status,
    source: spec.source ?? 'staff',
    guest: b.guest(spec.guest),
    vehicle,
    ...(keyTagId ? { keyTagId } : {}),
    zoneId: spec.zoneId,
    ...(spec.spotLabel ? { spotLabel: spec.spotLabel } : {}),
    ...(lastCustodyEventId ? { lastCustodyEventId } : {}),
    flags: { ...NO_FLAGS, ...(spec.checkInPhotos ? {} : { photosSkipped: true, photosSkippedReason: 'Guest in a hurry; walk-around done verbally.' }), ...spec.flags },
    attendants: {
      checkedInBy: actor,
      ...(claimedBy ? { claimedBy } : {}),
      ...(times.deliveredAt ? { deliveredBy: claimedBy ?? actor } : {}),
    },
    times,
    damageReportIds,
    incidentIds: [],
    guestToken: b.token(),
    ...(spec.hostRequest ? { hostRequest: spec.hostRequest } : {}),
    ...(spec.cancelReason ? { cancelReason: spec.cancelReason } : {}),
    payment: spec.payment ?? payment(spec.venueId, 'none'),
    pmsChargeSeq: 0,
    metrics: times.deliveredAt && times.requestedAt ? { retrievalSec: 360 + (b.clock.now.getUTCMinutes() % 5) * 30, readyToDeliverSec: 90 } : {},
  };
  b.ticket(ticket);
  return ticket;
}

interface JobSpec<S extends string> {
  status: S;
  ageMin: number;
  primary?: string;
  chase?: string;
  guest?: Partial<Ticket['guest']>;
  payment?: PaymentState;
  cancelReason?: string;
}

const DESTINATIONS = [
  { address: '1100 N Delaware St, Indianapolis, IN 46202', geo: { lat: 39.7817, lng: -86.1548 } },
  { address: '5250 E 82nd St, Indianapolis, IN 46250', geo: { lat: 39.9055, lng: -86.0711 } },
  { address: '700 W Main St, Carmel, IN 46032', geo: { lat: 39.9784, lng: -86.1415 } },
  { address: '9800 Allisonville Rd, Fishers, IN 46038', geo: { lat: 39.9286, lng: -86.0357 } },
] as const;

function quote(amount: number, clock: DemoClock): NonNullable<NonNullable<Ticket['driveHome']>['quote']> {
  return {
    base: 2500,
    distanceMeters: 14_500,
    durationSec: 1_380,
    amount,
    breakdown: [
      { label: 'Base fare', amount: 2500 },
      { label: 'Distance (9.0 mi)', amount: 2250 },
      { label: 'Time (23 min)', amount: amount - 4750 },
    ],
    expiresAt: clock.minutesAgo(-30),
  };
}

const CHASE_BY_STATUS: Record<DriveHomeStatus, NonNullable<Ticket['driveHome']>['chase']['status']> = {
  requested: 'pending',
  quoted: 'pending',
  confirmed: 'pending',
  assigned: 'pending',
  en_route_to_guest: 'following',
  pre_drive_inspection: 'following',
  in_transit: 'following',
  arrived: 'returning_driver',
  completed: 'done',
  closed: 'done',
  cancelled: 'pending',
};

const DRIVE_HOME_ORDER: DriveHomeStatus[] = ['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'completed', 'closed'];

function jobTimes(clock: DemoClock, order: readonly string[], status: string, ageMin: number): Ticket['times'] {
  const idx = order.indexOf(status);
  const at = (step: number): string => clock.minutesAgo(Math.max(ageMin - step * 6, 0));
  const t: Ticket['times'] = { checkedInAt: clock.minutesAgo(ageMin + 30) };
  const reached = (s: string): boolean => idx >= 0 && idx >= order.indexOf(s);
  if (reached('confirmed')) t.requestedAt = at(0);
  if (reached('assigned')) t.assignedAt = at(1);
  if (reached('en_route_to_guest') || reached('en_route_to_pickup')) t.enRouteAt = at(2);
  if (reached('pre_drive_inspection')) t.inspectionAt = at(3);
  if (reached('in_transit')) t.inTransitAt = at(4);
  if (reached('arrived')) t.arrivedAt = at(5);
  if (reached('completed')) t.completedAt = at(6);
  if (reached('closed')) t.closedAt = at(7);
  if (status === 'cancelled') t.cancelledAt = at(1);
  return t;
}

function addDriveHome(b: TicketBuilder, spec: JobSpec<DriveHomeStatus>, index: number): Ticket {
  const id = b.id();
  const vehicle = b.vehicle();
  const status = spec.status;
  const primary = spec.primary ?? USERS.primary1;
  const chase = spec.chase ?? USERS.chase1;
  const times = jobTimes(b.clock, DRIVE_HOME_ORDER, status, spec.ageMin);
  const staffed = ['assigned', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'completed', 'closed'].includes(status);
  const damageReportIds: string[] = [];
  // The server reverts in_transit / completed without a qualifying (>= 4 photo) report, so the
  // reports exist BEFORE the ticket in write order (they're pushed first here).
  if (['in_transit', 'arrived', 'completed', 'closed'].includes(status)) {
    damageReportIds.push(b.damageReport({ id, vehicle }, 'pre_drive', primary, times.inspectionAt ?? b.clock.now.toISOString(), 4));
  }
  if (['completed', 'closed'].includes(status)) {
    damageReportIds.push(b.damageReport({ id, vehicle }, 'post_drive', primary, times.arrivedAt ?? b.clock.now.toISOString(), 4));
  }
  const destination = DESTINATIONS[index % DESTINATIONS.length] ?? DESTINATIONS[0];
  const amount = 6200 + index * 350;
  const paid = ['completed', 'closed'].includes(status);
  const ticket: Ticket = {
    id,
    operatorId: OP,
    venueId: V1,
    jobType: 'drive_home',
    status,
    source: 'guest_web',
    guest: b.guest(spec.guest),
    vehicle,
    flags: NO_FLAGS,
    attendants: staffed ? { primaryDriverUid: primary, chaseDriverUid: chase, chaseVehicleId: FLEET.chaseSedan } : {},
    times,
    damageReportIds,
    incidentIds: [],
    guestToken: b.token(),
    driveHome: {
      destination: { address: destination.address, geo: { ...destination.geo } },
      ...(status !== 'requested' ? { quote: quote(amount, b.clock) } : {}),
      ...(DRIVE_HOME_ORDER.indexOf(status) >= DRIVE_HOME_ORDER.indexOf('confirmed') ? { termsAcceptedAt: times.requestedAt ?? times.checkedInAt, termsVersion: '2026-08' } : {}),
      ...(['en_route_to_guest', 'pre_drive_inspection', 'in_transit'].includes(status) ? { etaAt: b.clock.minutesAgo(-14) } : {}),
      chase: { status: CHASE_BY_STATUS[status] },
    },
    ...(spec.cancelReason ? { cancelReason: spec.cancelReason } : {}),
    payment: spec.payment ?? payment(V1, paid ? 'paid' : DRIVE_HOME_ORDER.indexOf(status) >= DRIVE_HOME_ORDER.indexOf('confirmed') ? 'authorized' : 'none', { base: amount, method: 'web', ...(paid ? { paidAt: times.completedAt ?? b.clock.now.toISOString(), tip: 1200 } : {}) }),
    pmsChargeSeq: 0,
    metrics: paid ? { tripSec: 1_420, tripMeters: 14_500 } : {},
  };
  b.ticket(ticket);
  if (paid) b.transaction(ticket, ticket.payment ?? payment(V1, 'paid'), { provider: 'stripe', kind: 'charge', status: 'succeeded', method: 'web' });
  if (['en_route_to_guest', 'in_transit'].includes(status)) addLiveLocation(b, primary, ticket, destination.geo);
  return ticket;
}

const RIDE_ORDER: RideStatus[] = ['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_pickup', 'arrived_pickup', 'in_transit', 'arrived', 'completed', 'closed'];

function addRide(b: TicketBuilder, spec: JobSpec<RideStatus>, index: number, venueId: string): Ticket {
  const id = b.id();
  const status = spec.status;
  const primary = spec.primary ?? USERS.driver1;
  const times = jobTimes(b.clock, RIDE_ORDER, status, spec.ageMin);
  const staffed = RIDE_ORDER.indexOf(status) >= RIDE_ORDER.indexOf('assigned') && status !== 'cancelled';
  const accessible = index === 1;
  const dropoff = DESTINATIONS[(index + 2) % DESTINATIONS.length] ?? DESTINATIONS[0];
  const amount = 2400 + index * 300;
  const billTo: PaymentState['billTo'] = venueId === V_HOTEL ? 'room' : 'guest';
  const paid = ['completed', 'closed'].includes(status);
  const fleetVehicleId = accessible ? FLEET.rideVan : FLEET.rideSedan;
  const ticket: Ticket = {
    id,
    operatorId: OP,
    venueId,
    jobType: 'passenger_ride',
    status,
    source: 'host_portal',
    guest: b.guest(spec.guest),
    vehicle: staffed ? { fleetVehicleId, make: accessible ? 'Toyota' : 'Lincoln', model: accessible ? 'Sienna (ramp)' : 'Navigator', color: 'Black' } : {},
    flags: { ...NO_FLAGS, accessibleVehicle: accessible },
    attendants: staffed ? { primaryDriverUid: primary } : {},
    times,
    damageReportIds: [],
    incidentIds: [],
    guestToken: b.token(),
    ride: {
      pickup: { venueId, geo: venueId === V_HOTEL ? { lat: 39.7669, lng: -86.1586 } : { lat: 39.765, lng: -86.158 } },
      dropoff: { address: dropoff.address, geo: { ...dropoff.geo } },
      passengers: accessible ? 2 : 3,
      accessible,
      ...(status !== 'requested' ? { quote: quote(amount + 4750, b.clock) } : {}),
      billTo,
      ...(['en_route_to_pickup', 'in_transit'].includes(status) ? { etaAt: b.clock.minutesAgo(-9) } : {}),
    },
    ...(spec.cancelReason ? { cancelReason: spec.cancelReason } : {}),
    payment: payment(venueId, paid ? (billTo === 'room' ? 'room_charged' : 'paid') : 'none', { base: amount, billTo, ...(paid ? { method: billTo === 'room' ? 'pms' : 'web', paidAt: times.completedAt ?? b.clock.now.toISOString() } : {}) }),
    pmsChargeSeq: paid && billTo === 'room' ? 1 : 0,
    metrics: paid ? { tripSec: 1_080, tripMeters: 9_800 } : {},
  };
  b.ticket(ticket);
  if (['en_route_to_pickup', 'in_transit'].includes(status)) addLiveLocation(b, primary, ticket, dropoff.geo);
  return ticket;
}

function addLiveLocation(b: TicketBuilder, uid: string, t: Ticket, toward: { lat: number; lng: number }): void {
  // liveLocations is one document per driver (operators/{op}/liveLocations/{uid}); a driver
  // with several active demo jobs shows on the map at their first one.
  if (b.docs.some((d) => d.kind === 'liveLocation' && d.path.endsWith(`/${uid}`))) return;
  const loc: LiveLocation = {
    ticketId: t.id,
    // A point a little way from the venue toward the destination, so the live map shows motion.
    geo: { lat: 39.765 + (toward.lat - 39.765) * 0.35, lng: -86.158 + (toward.lng + 86.158) * 0.35 },
    heading: 35,
    speed: 13.4,
    at: b.clock.minutesAgo(0.5),
    expiresAt: b.clock.minutesAgo(-10),
  };
  b.docs.push({ kind: 'liveLocation', path: `operators/${OP}/liveLocations/${uid}`, data: loc });
}

export interface TicketOutput {
  docs: SeedDoc[];
  storage: DemoStorageObject[];
  expectedTicketStatuses: Record<string, string>;
  /** Ids other builders reference (incidents, claims, validations, host requests). */
  refs: {
    claimTicketIds: string[];
    incidentTicketId: string;
    validationTicketId: string;
    hostMatchedTicketId: string;
    guestActiveTicketId: string;
    guestActiveToken: string;
  };
}

export function buildTickets(clock: DemoClock): TicketOutput {
  const b = new TicketBuilder(clock);
  const shift = SHIFTS.stElmoToday;

  // ---- St. Elmo: one ticket in every valet status, plus a realistic parked lot. ----
  addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 95, zoneId: 'A', spotLabel: 'A12', checkInPhotos: true, shiftId: shift });
  addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 70, zoneId: 'VIP', spotLabel: 'VIP2', flags: { vip: true }, shiftId: shift });
  addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 52, zoneId: 'B', spotLabel: 'B07', shiftId: shift });
  addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 31, zoneId: 'A', spotLabel: 'A19', flags: { inAndOut: true }, shiftId: shift });
  addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 12, zoneId: 'B', spotLabel: 'B11', checkInPhotos: true, shiftId: shift });
  // Requested at three SLA levels: 2 min (ok), 5 min (warn), 9 min (over, needs assistance).
  addValet(b, { venueId: V1, status: 'requested', checkedInMinAgo: 110, requestedMinAgo: 2, zoneId: 'A', spotLabel: 'A03', source: 'guest_web', shiftId: shift });
  addValet(b, { venueId: V1, status: 'requested', checkedInMinAgo: 88, requestedMinAgo: 5, zoneId: 'B', spotLabel: 'B02', shiftId: shift });
  addValet(b, { venueId: V1, status: 'requested', checkedInMinAgo: 140, requestedMinAgo: 9, zoneId: 'A', spotLabel: 'A21', flags: { assistance: true }, source: 'guest_app', shiftId: shift });
  addValet(b, { venueId: V1, status: 'claimed', checkedInMinAgo: 75, requestedMinAgo: 4, zoneId: 'A', claimedBy: USERS.att2, attendant: USERS.att2, shiftId: shift });
  addValet(b, { venueId: V1, status: 'retrieving', checkedInMinAgo: 66, requestedMinAgo: 6, zoneId: 'B', shiftId: shift });
  // Guest opened web checkout from the ticket link but hasn't finished paying: payment 'pending'.
  addValet(b, { venueId: V1, status: 'staged', checkedInMinAgo: 101, requestedMinAgo: 7, zoneId: 'A', payment: payment(V1, 'pending', { tip: 300, method: 'web' }), shiftId: shift });
  const readyPaid = addValet(b, { venueId: V1, status: 'ready', checkedInMinAgo: 120, requestedMinAgo: 8, zoneId: 'VIP', flags: { vip: true }, payment: payment(V1, 'paid', { tip: 500, method: 'web', paidAt: clock.minutesAgo(6) }), shiftId: shift });
  b.transaction(readyPaid, readyPaid.payment ?? payment(V1, 'paid'), { provider: 'stripe', kind: 'charge', status: 'succeeded', method: 'web', at: clock.minutesAgo(6) });
  addValet(b, { venueId: V1, status: 'ready', checkedInMinAgo: 98, requestedMinAgo: 6, zoneId: 'A', shiftId: shift });
  const delivered = addValet(b, { venueId: V1, status: 'delivered', checkedInMinAgo: 130, requestedMinAgo: 14, zoneId: 'A', payment: payment(V1, 'paid', { tip: 300, method: 'tap_to_pay', paidAt: clock.minutesAgo(5) }), shiftId: shift });
  b.transaction(delivered, delivered.payment ?? payment(V1, 'paid'), { provider: 'stripe', kind: 'charge', status: 'succeeded', method: 'tap_to_pay', at: clock.minutesAgo(5) });
  addValet(b, { venueId: V1, status: 'cancelled', checkedInMinAgo: 45, requestedMinAgo: 40, zoneId: 'B', cancelReason: 'Guest left with a second key.', keyTag: false, shiftId: shift });

  // Host-stand request matched to a ticket (venue portal "Requests" + dashboard detail).
  const hostMatched = addValet(b, {
    venueId: V1,
    status: 'requested',
    checkedInMinAgo: 80,
    requestedMinAgo: 3,
    zoneId: 'A',
    source: 'host_portal',
    hostRequest: { table: '14', requestedBy: USERS.venue1, note: 'Guest finishing dessert' },
    shiftId: shift,
  });

  // Closed history: last 7 days, mixed methods and tips. Feeds activity, receipts, payments search.
  const closedIds: string[] = [];
  const methods: NonNullable<PaymentState['method']>[] = ['web', 'in_app', 'tap_to_pay', 'web', 'reader', 'in_app', 'web', 'tap_to_pay'];
  for (let i = 0; i < 8; i++) {
    const daysAgo = i % 7;
    const minutesAgo = daysAgo * 1440 + 180 + i * 37;
    const method = methods[i] ?? 'web';
    const tip = [300, 500, 0, 400, 600, 300, 500, 200][i] ?? 0;
    const t = addValet(b, { venueId: V1, status: 'closed', checkedInMinAgo: minutesAgo + 150, requestedMinAgo: minutesAgo + 10, zoneId: 'A', payment: payment(V1, 'paid', { tip, method, paidAt: clock.minutesAgo(minutesAgo) }) });
    b.transaction(t, t.payment ?? payment(V1, 'paid'), { provider: 'stripe', kind: 'charge', status: 'succeeded', method, at: clock.minutesAgo(minutesAgo) });
    closedIds.push(t.id);
  }
  // A refunded charge (guest complaint) and a failed card.
  const refunded = addValet(b, { venueId: V1, status: 'closed', checkedInMinAgo: 2 * 1440 + 200, requestedMinAgo: 2 * 1440 + 30, zoneId: 'B', payment: { ...payment(V1, 'refunded', { tip: 300, method: 'web', paidAt: clock.daysAgo(2) }), refundAmount: 1905, refundReason: 'Wait time over 20 minutes' } });
  b.transaction(refunded, refunded.payment ?? payment(V1, 'refunded'), {
    provider: 'stripe',
    kind: 'charge',
    status: 'refunded',
    method: 'web',
    at: clock.daysAgo(2),
    refunds: [{ refundRef: 're_demo_wait', amount: 1905, at: clock.daysAgo(2, -45), reason: 'Wait time over 20 minutes' }],
  });
  const failed = addValet(b, { venueId: V1, status: 'closed', checkedInMinAgo: 3 * 1440 + 90, requestedMinAgo: 3 * 1440 + 20, zoneId: 'A', payment: payment(V1, 'failed', { method: 'web' }) });
  b.transaction(failed, failed.payment ?? payment(V1, 'failed'), { provider: 'stripe', kind: 'charge', status: 'failed', method: 'web', at: clock.daysAgo(3), failureMessage: 'Your card was declined.' });

  // ---- The Meridian Hotel: overnight guests (room numbers), room charges, a request. ----
  const hotelShift = SHIFTS.hotelToday;
  // Rooms 1204 / 817 / 1530 are the reservations the emulator's demo PMS mock knows
  // (functions/src/modules/pms/demo.adapter.ts), so room lookup and charge-to-room work live.
  // 1530 is set up there to refuse charges, which demos the "no post" fallback.
  addValet(b, { venueId: V_HOTEL, status: 'checked_in', checkedInMinAgo: 20 * 60, zoneId: 'G1', spotLabel: 'G1-14', guest: { name: 'Avery Collins', room: '1204', reservationRef: 'demo_res_1204' }, attendant: USERS.att3, shiftId: hotelShift });
  addValet(b, { venueId: V_HOTEL, status: 'checked_in', checkedInMinAgo: 15 * 60, zoneId: 'G2', spotLabel: 'G2-03', guest: { name: 'Jordan Patel', room: '817', reservationRef: 'demo_res_0817' }, attendant: USERS.att3, flags: { vip: true }, shiftId: hotelShift });
  addValet(b, { venueId: V_HOTEL, status: 'checked_in', checkedInMinAgo: 40, zoneId: 'G1', spotLabel: 'G1-22', guest: { name: 'Morgan Reyes', room: '1530', reservationRef: 'demo_res_1530' }, attendant: USERS.att2, checkInPhotos: true, shiftId: hotelShift });
  addValet(b, { venueId: V_HOTEL, status: 'requested', checkedInMinAgo: 26 * 60, requestedMinAgo: 3, zoneId: 'G2', guest: { room: '1210' }, attendant: USERS.att3, source: 'pms', shiftId: hotelShift });
  for (let i = 0; i < 2; i++) {
    const t = addValet(b, {
      venueId: V_HOTEL,
      status: 'closed',
      checkedInMinAgo: (i + 1) * 1440 + 900,
      requestedMinAgo: (i + 1) * 1440 + 20,
      zoneId: 'G1',
      guest: { room: i === 0 ? '1104' : '802' },
      attendant: USERS.att3,
      payment: { ...payment(V_HOTEL, 'room_charged', { tip: 1000, method: 'pms', billTo: 'room', paidAt: clock.daysAgo(i + 1) }), pmsPostingRef: `OPERA-${7731 + i}` },
    });
    b.transaction(t, t.payment ?? payment(V_HOTEL, 'room_charged'), { provider: 'pms', kind: 'room_charge', status: 'succeeded', method: 'pms', at: clock.daysAgo(i + 1) });
  }

  // ---- Fountain Square Event Hall: an event in progress and venue-billed history. ----
  addValet(b, { venueId: V_EVENT, status: 'checked_in', checkedInMinAgo: 35, zoneId: 'E', attendant: USERS.lead1 });
  addValet(b, { venueId: V_EVENT, status: 'checked_in', checkedInMinAgo: 28, zoneId: 'E', attendant: USERS.lead1 });
  addValet(b, { venueId: V_EVENT, status: 'checked_in', checkedInMinAgo: 22, zoneId: 'E', attendant: USERS.lead1, flags: { accessibleVehicle: true } });
  for (let i = 0; i < 2; i++) {
    const t = addValet(b, {
      venueId: V_EVENT,
      status: 'closed',
      checkedInMinAgo: (i + 4) * 1440 + 300,
      requestedMinAgo: (i + 4) * 1440 + 20,
      zoneId: 'E',
      attendant: USERS.lead1,
      payment: payment(V_EVENT, 'venue_billed', { method: 'invoice', billTo: 'venue', paidAt: clock.daysAgo(i + 4) }),
    });
    b.transaction(t, t.payment ?? payment(V_EVENT, 'venue_billed'), { provider: 'invoice', kind: 'venue_invoice', status: 'pending', method: 'invoice', at: clock.daysAgo(i + 4) });
  }

  // ---- Drive-home: one job in every status. ----
  const dhStatuses: DriveHomeStatus[] = ['requested', 'quoted', 'confirmed', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'completed', 'closed', 'cancelled'];
  dhStatuses.forEach((status, i) => {
    addDriveHome(b, {
      status,
      ageMin: 20 + i * 9,
      primary: i % 2 === 0 ? USERS.primary1 : USERS.driver1,
      ...(status === 'cancelled' ? { cancelReason: 'Guest got a ride from a friend.' } : {}),
    }, i);
  });
  // (`assigned` is the base seed's drive-home job, re-timed by the writer.)

  // ---- Passenger rides: one in every status, from St. Elmo and the hotel. ----
  RIDE_ORDER.concat(['cancelled']).forEach((status, i) => {
    addRide(b, { status, ageMin: 15 + i * 8, ...(status === 'cancelled' ? { cancelReason: 'Reservation moved.' } : {}) }, i, i % 3 === 0 ? V_HOTEL : V1);
  });

  // ---- The phone guest's own tickets (guest app home + activity). ----
  const guestLink = { uid: GUEST_UID, phoneE164: GUEST_PHONE, phoneLast4: GUEST_PHONE.slice(-4), name: GUEST_NAME };
  const guestActive = addValet(b, { venueId: V1, status: 'checked_in', checkedInMinAgo: 48, zoneId: 'VIP', spotLabel: 'VIP1', guest: guestLink, source: 'guest_app', flags: { vip: true }, checkInPhotos: true, shiftId: shift });
  for (let i = 0; i < 3; i++) {
    const t = addValet(b, {
      venueId: i === 1 ? V_HOTEL : V1,
      status: 'closed',
      checkedInMinAgo: (i + 1) * 9 * 1440,
      requestedMinAgo: (i + 1) * 9 * 1440 - 140,
      zoneId: i === 1 ? 'G1' : 'A',
      guest: guestLink,
      source: 'guest_app',
      payment: payment(i === 1 ? V_HOTEL : V1, 'paid', { tip: 500, method: 'in_app', paidAt: clock.daysAgo((i + 1) * 9, -150) }),
    });
    b.transaction(t, t.payment ?? payment(V1, 'paid'), { provider: 'stripe', kind: 'charge', status: 'succeeded', method: 'in_app', at: clock.daysAgo((i + 1) * 9, -150) });
  }
  addDriveHome(b, { status: 'quoted', ageMin: 6, guest: guestLink }, 3);

  return {
    docs: b.docs,
    storage: b.storage,
    expectedTicketStatuses: b.expected,
    refs: {
      claimTicketIds: closedIds.slice(0, 5),
      incidentTicketId: readyPaid.id,
      validationTicketId: closedIds[5] ?? readyPaid.id,
      hostMatchedTicketId: hostMatched.id,
      guestActiveTicketId: guestActive.id,
      guestActiveToken: guestActive.guestToken,
    },
  };
}
