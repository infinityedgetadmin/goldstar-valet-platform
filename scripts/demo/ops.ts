import type { AuditLogEntry } from '../../src/schemas/auditLogEntry';
import type { Claim } from '../../src/schemas/claim';
import type { FleetVehicle } from '../../src/schemas/fleetVehicle';
import type { HostRequest } from '../../src/schemas/hostRequest';
import type { Incident } from '../../src/schemas/incident';
import type { Integration } from '../../src/schemas/integration';
import type { Invoice } from '../../src/schemas/invoice';
import type { PayoutAllocation, PayoutBatch } from '../../src/schemas/payoutBatch';
import type { ClockEvent, Shift } from '../../src/schemas/shift';
import type { Validation } from '../../src/schemas/validation';
import { FLEET, OP, SHIFTS, USERS, V_EVENT, V_HOTEL, V1 } from './constants';
import type { DemoClock } from './context';
import { demoSha256, demoUuid } from './context';
import { demoPhoto } from './photos';
import type { TicketOutput } from './tickets';
import type { DemoStorageObject, SeedDoc } from './types';

const DEVICE = 'demo-device';

function shifts(clock: DemoClock): SeedDoc[] {
  const docs: SeedDoc[] = [];
  const shift = (id: string, venueId: string, daysAgo: number, startHour: number, endHour: number, status: Shift['status'], crew: Array<[string, Shift['assignments'][number]['role']]>, over: Partial<Shift> = {}): Shift => ({
    id,
    operatorId: OP,
    venueId,
    date: clock.localDay(daysAgo),
    startsAt: clock.localTime(daysAgo, startHour),
    endsAt: clock.localTime(daysAgo, endHour),
    leadUid: USERS.lead1,
    status,
    assignments: crew.map(([uid, role]) => ({ uid, role, startsAt: clock.localTime(daysAgo, startHour), endsAt: clock.localTime(daysAgo, endHour), confirmed: true })),
    notes: '',
    assignedUids: crew.map(([uid]) => uid),
    source: { provider: 'internal' },
    ...over,
  });

  // Today at St. Elmo: open, full crew. Wide hours so "today" is true whatever time the demo runs.
  docs.push({
    kind: 'shift',
    path: `operators/${OP}/shifts/${SHIFTS.stElmoToday}`,
    data: shift(SHIFTS.stElmoToday, V1, 0, 0, 23, 'open', [
      [USERS.lead1, 'lead'],
      [USERS.att1, 'attendant'],
      [USERS.att2, 'attendant'],
      [USERS.primary1, 'driver'],
      [USERS.chase1, 'driver'],
      [USERS.driver1, 'driver'],
    ], { notes: 'Private dining room booked 7-10pm. Keep VIP row clear.' }),
  });
  docs.push({ kind: 'shift', path: `operators/${OP}/shifts/${SHIFTS.hotelToday}`, data: shift(SHIFTS.hotelToday, V_HOTEL, 0, 0, 23, 'open', [[USERS.att3, 'attendant'], [USERS.att2, 'attendant']]) });
  // Yesterday: closed with a computed tip pool (shift screen "Tip pool allocations").
  docs.push({
    kind: 'shift',
    path: `operators/${OP}/shifts/${SHIFTS.stElmoYesterday}`,
    data: shift(SHIFTS.stElmoYesterday, V1, 1, 16, 23, 'closed', [[USERS.lead1, 'lead'], [USERS.att1, 'attendant'], [USERS.att2, 'attendant']], {
      tipPool: {
        total: 41_200,
        hoursByUid: { [USERS.lead1]: 7, [USERS.att1]: 7, [USERS.att2]: 6.5 },
        allocations: [
          { uid: USERS.lead1, amount: 14_000 },
          { uid: USERS.att1, amount: 14_000 },
          { uid: USERS.att2, amount: 13_200 },
        ],
      },
    }),
  });
  // Upcoming (venue portal "Staffing", dashboard calendar).
  docs.push({ kind: 'shift', path: `operators/${OP}/shifts/${SHIFTS.stElmoTomorrow}`, data: shift(SHIFTS.stElmoTomorrow, V1, -1, 16, 23, 'planned', [[USERS.lead1, 'lead'], [USERS.att1, 'attendant'], [USERS.att3, 'attendant']]) });
  docs.push({ kind: 'shift', path: `operators/${OP}/shifts/${SHIFTS.eventSaturday}`, data: shift(SHIFTS.eventSaturday, V_EVENT, -3, 17, 23, 'planned', [[USERS.lead1, 'lead'], [USERS.att2, 'attendant'], [USERS.invited1, 'attendant']], { notes: 'Gala, 400 guests expected.' }) });

  // Clock events: att1 in and on break, att2 clocked in, lead in. Shift tab shows each state.
  const clockSeq = { n: 0x7000 };
  const clockEvent = (shiftId: string, uid: string, type: ClockEvent['type'], minutesAgo: number): void => {
    const ev: ClockEvent = { id: demoUuid(clockSeq.n++), uid, type, at: clock.minutesAgo(minutesAgo), deviceId: DEVICE };
    docs.push({ kind: 'clockEvent', path: `operators/${OP}/shifts/${shiftId}/clockEvents/${ev.id}`, data: ev });
  };
  clockEvent(SHIFTS.stElmoToday, USERS.lead1, 'in', 240);
  clockEvent(SHIFTS.stElmoToday, USERS.att1, 'in', 230);
  clockEvent(SHIFTS.stElmoToday, USERS.att1, 'break_start', 120);
  clockEvent(SHIFTS.stElmoToday, USERS.att1, 'break_end', 90);
  clockEvent(SHIFTS.stElmoToday, USERS.att2, 'in', 180);
  clockEvent(SHIFTS.stElmoToday, USERS.att2, 'break_start', 25);
  clockEvent(SHIFTS.stElmoYesterday, USERS.att1, 'in', 1440 + 420);
  clockEvent(SHIFTS.stElmoYesterday, USERS.att1, 'out', 1440);
  return docs;
}

function fleet(): SeedDoc[] {
  const v = (id: string, over: Omit<FleetVehicle, 'id' | 'operatorId'>): SeedDoc => ({ kind: 'fleetVehicle', path: `operators/${OP}/fleetVehicles/${id}`, data: { id, operatorId: OP, ...over } });
  return [
    v(FLEET.chaseSedan, { plate: 'GSC201', state: 'IN', make: 'Toyota', model: 'Corolla', color: 'White', capacity: 4, accessible: false, status: 'in_use', currentDriverUid: USERS.chase1, notes: 'Chase car, St. Elmo.' }),
    v(FLEET.chaseSuv, { plate: 'GSC202', state: 'IN', make: 'Honda', model: 'CR-V', color: 'Grey', capacity: 4, accessible: false, status: 'available' }),
    v(FLEET.rideSedan, { plate: 'GSR301', state: 'IN', make: 'Lincoln', model: 'Navigator', color: 'Black', capacity: 6, accessible: false, status: 'in_use', currentDriverUid: USERS.driver1 }),
    v(FLEET.rideVan, { plate: 'GSR302', state: 'IN', make: 'Toyota', model: 'Sienna (ramp)', color: 'Black', capacity: 5, accessible: true, status: 'available' }),
    v(FLEET.maintenance, { plate: 'GSR303', state: 'IN', make: 'Cadillac', model: 'XT6', color: 'Black', capacity: 6, accessible: false, status: 'maintenance', notes: 'Tire replacement, back Thursday.' }),
    v(FLEET.retired, { plate: 'GSR199', state: 'IN', make: 'Chrysler', model: 'Pacifica', color: 'Silver', capacity: 6, accessible: false, status: 'retired' }),
  ];
}

function incidents(clock: DemoClock, refs: TicketOutput['refs']): { docs: SeedDoc[]; storage: DemoStorageObject[] } {
  const docs: SeedDoc[] = [];
  const storage: DemoStorageObject[] = [];
  const specs: Array<Omit<Incident, 'operatorId' | 'photos' | 'witnesses'> & { photoCount: number; witnesses?: Incident['witnesses'] }> = [
    { id: demoUuid(0x8001), venueId: V1, ticketId: refs.incidentTicketId, type: 'damage', description: 'Guest reported a scuff on the rear bumper at pickup. Check-in photos show it was pre-existing; walked the guest through them.', reportedBy: USERS.att1, at: clock.minutesAgo(35), status: 'open', photoCount: 2 },
    { id: demoUuid(0x8002), venueId: V1, type: 'near_miss', description: 'Pedestrian stepped out between staged cars on Illinois St. No contact. Added a cone line along the curb.', reportedBy: USERS.lead1, at: clock.daysAgo(1, 120), status: 'reviewing', assignedTo: USERS.admin1, photoCount: 1, witnesses: [{ name: 'Marcus Reed', contact: 'lead1@goldstar.example.com' }] },
    { id: demoUuid(0x8003), venueId: V_HOTEL, type: 'property', description: 'Garage level 2 gate arm stuck open for 20 minutes; hotel engineering reset it.', reportedBy: USERS.att3, at: clock.daysAgo(4), status: 'resolved', assignedTo: USERS.admin1, photoCount: 1 },
  ];
  specs.forEach((s, i) => {
    const { photoCount, witnesses, ...rest } = s;
    const photos: string[] = [];
    for (let p = 0; p < photoCount; p++) {
      const asset = demoPhoto(i * 2 + p + 3);
      const path = `operators/${OP}/incidents/${s.id}/photo-${p + 1}.jpg`;
      photos.push(path);
      storage.push({ path, source: asset.file, contentType: 'image/jpeg' });
    }
    const incident: Incident = { ...rest, operatorId: OP, photos, witnesses: witnesses ?? [] };
    docs.push({ kind: 'incident', path: `operators/${OP}/incidents/${s.id}`, data: incident });
  });
  return { docs, storage };
}

function claims(clock: DemoClock, refs: TicketOutput['refs']): SeedDoc[] {
  const statuses: Claim['status'][] = ['intake', 'under_review', 'accepted', 'denied', 'settled'];
  const descriptions = [
    'Guest says the passenger mirror was folded and scratched after pickup.',
    'Curb rash on the front right wheel reported by email the next morning.',
    'Rear bumper scuff confirmed on the garage camera at 9:42pm.',
    'Dent on the driver door. Check-in photos show it was already there.',
    'Windshield chip from gravel in Lot A; reimbursed repair.',
  ];
  return statuses.map((status, i) => {
    const id = demoUuid(0x9001 + i);
    const decided = status === 'accepted' || status === 'denied' || status === 'settled';
    const claim: Claim = {
      id,
      operatorId: OP,
      ticketId: refs.claimTicketIds[i] ?? refs.incidentTicketId,
      status,
      reportedAt: clock.daysAgo(i + 1),
      description: descriptions[i] ?? 'Damage claim.',
      allegedDamage: [{ panel: (['front_right_door', 'wheels', 'rear_bumper', 'front_left_door', 'windshield'] as const)[i] ?? 'other', kind: (['scratch', 'scuff', 'scuff', 'dent', 'chip'] as const)[i] ?? 'other', description: descriptions[i] ?? '' }],
      guestContact: { name: ['Olivia Bennett', 'Ethan Clarke', 'Sophia Martinez', 'Noah Patel', 'Ava Thompson'][i] ?? 'Guest', email: `guest${i + 1}@example.com` },
      ...(decided
        ? {
            adjudication: {
              notes: status === 'denied' ? 'Pre-existing per check-in photos and diagram.' : 'Approved after reviewing custody timeline and photos.',
              decidedBy: USERS.owner1,
              decidedAt: clock.daysAgo(i),
              ...(status === 'denied' ? {} : { amount: [0, 0, 42_000, 0, 18_500][i] ?? 0 }),
            },
          }
        : {}),
      ...(status !== 'intake'
        ? { evidenceBundle: { pdfPath: `operators/${OP}/claims/${id}/evidence.pdf`, zipPath: `operators/${OP}/claims/${id}/evidence.zip`, generatedAt: clock.daysAgo(i), sha256: demoSha256(0xa000 + i) } }
        : {}),
      ...(status === 'settled' ? { insurer: { carrier: 'Hartford Garagekeepers', claimNumber: 'HGK-2026-11873', submittedAt: clock.daysAgo(3) } } : {}),
      createdBy: USERS.admin1,
      createdAt: clock.daysAgo(i + 1),
    };
    return { kind: 'claim', path: `operators/${OP}/claims/${id}`, data: claim };
  });
}

function validations(clock: DemoClock, refs: TicketOutput['refs']): SeedDoc[] {
  const v = (id: string, over: Omit<Validation, 'id' | 'operatorId' | 'issuedBy'>): SeedDoc => ({ kind: 'validation', path: `operators/${OP}/validations/${id}`, data: { id, operatorId: OP, issuedBy: USERS.venue1, ...over } });
  return [
    v('val-full', { venueId: V1, code: 'STE100', type: 'full', issuedAt: clock.minutesAgo(50), expiresAt: clock.daysAgo(-1) }),
    v('val-partial', { venueId: V1, code: 'STE500', type: 'partial', amount: 500, issuedAt: clock.minutesAgo(30), expiresAt: clock.daysAgo(-1) }),
    v('val-comp', { venueId: V_HOTEL, code: 'MER777', type: 'comp', issuedAt: clock.daysAgo(1), expiresAt: clock.daysAgo(-2) }),
    v('val-rate', { venueId: V_EVENT, code: 'FSQ020', type: 'rate', rateId: 'event', issuedAt: clock.daysAgo(2) }),
    v('val-redeemed', { venueId: V1, code: 'STE250', type: 'partial', amount: 750, issuedAt: clock.daysAgo(3), redeemedTicketId: refs.validationTicketId, redemption: { amount: 750, base: 1500, at: clock.daysAgo(3, -60) } }),
  ];
}

function hostRequests(clock: DemoClock, refs: TicketOutput['refs']): SeedDoc[] {
  const r = (id: string, over: Omit<HostRequest, 'id' | 'operatorId' | 'vip'> & { vip?: boolean }): SeedDoc => ({ kind: 'hostRequest', path: `operators/${OP}/hostRequests/${id}`, data: { id, operatorId: OP, vip: false, ...over } });
  return [
    // Table 14 matches the demo POS mock's open check (functions/src/modules/pos/demo.adapter.ts).
    r('hr-matched', { venueId: V1, kind: 'car', table: '14', phoneLast4: '4116', at: clock.minutesAgo(3), by: USERS.venue1, ticketId: refs.hostMatchedTicketId, status: 'matched' }),
    r('hr-open', { venueId: V1, kind: 'car', table: '12', name: 'Hayes party', at: clock.minutesAgo(1), by: USERS.venue1, status: 'open', vip: true }),
    r('hr-unmatched', { venueId: V1, kind: 'car', table: '21', phoneLast4: '0000', at: clock.minutesAgo(18), by: USERS.venue1, status: 'unmatched', note: 'No ticket under that phone' }),
    r('hr-prearrival', { venueId: V1, kind: 'pre_arrival', name: 'Foster, party of 6', eta: clock.minutesAgo(-25), partySize: 6, vip: true, at: clock.minutesAgo(40), by: USERS.venue1, status: 'open', note: 'Anniversary dinner, black Escalade' }),
    r('hr-ride', { venueId: V_HOTEL, kind: 'ride', name: 'Room 817', partySize: 2, at: clock.minutesAgo(12), by: USERS.hotel1, status: 'open', note: 'To the airport, two bags' }),
    r('hr-dismissed', { venueId: V1, kind: 'car', table: '8', at: clock.daysAgo(1, 30), by: USERS.venue1, status: 'dismissed' }),
  ];
}

function invoices(clock: DemoClock): SeedDoc[] {
  const inv = (id: string, venueId: string, monthsAgo: number, status: Invoice['status'], lines: Invoice['lines']): SeedDoc => {
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const data: Invoice = {
      id,
      operatorId: OP,
      venueId,
      period: clock.localMonth(monthsAgo),
      lines,
      subtotal,
      tax: 0,
      total: subtotal,
      currency: 'USD',
      status,
      createdAt: clock.daysAgo(monthsAgo * 30 + 2),
      ...(status !== 'draft' ? { sentAt: clock.daysAgo(monthsAgo * 30 + 1), pdfPath: `operators/${OP}/invoices/${id}.pdf` } : {}),
      ...(status === 'paid' ? { paidAt: clock.daysAgo(monthsAgo * 30 - 10) } : {}),
    };
    return { kind: 'invoice', path: `operators/${OP}/invoices/${id}`, data };
  };
  return [
    inv('inv-v1-current', V1, 0, 'draft', [{ label: 'Valet tickets (month to date)', quantity: 612, unitAmount: 250, amount: 153_000 }]),
    inv('inv-v1-last', V1, 1, 'sent', [{ label: 'Valet tickets', quantity: 1_844, unitAmount: 250, amount: 461_000 }]),
    inv('inv-v1-prior', V1, 2, 'paid', [{ label: 'Valet tickets', quantity: 1_702, unitAmount: 250, amount: 425_500 }]),
    inv('inv-hotel-last', V_HOTEL, 1, 'paid', [{ label: 'Revenue share (20%)', quantity: 1, unitAmount: 1_284_000, amount: 1_284_000 }]),
    inv('inv-event-last', V_EVENT, 1, 'sent', [{ label: 'Monthly retainer', quantity: 1, unitAmount: 180_000, amount: 180_000 }, { label: 'Gala event surcharge', quantity: 1, unitAmount: 45_000, amount: 45_000 }]),
    inv('inv-event-void', V_EVENT, 2, 'void', [{ label: 'Duplicate retainer (voided)', quantity: 1, unitAmount: 180_000, amount: 180_000 }]),
  ];
}

function payouts(clock: DemoClock): SeedDoc[] {
  const docs: SeedDoc[] = [];
  const batch = (id: string, daysAgo: number, status: PayoutBatch['status'], allocations: PayoutBatch['allocations']): void => {
    const data: PayoutBatch = { id, operatorId: OP, period: clock.localDay(daysAgo), totalTips: allocations.reduce((s, a) => s + a.amount, 0), currency: 'USD', allocations, createdAt: clock.daysAgo(daysAgo, -60), status };
    docs.push({ kind: 'payoutBatch', path: `operators/${OP}/payoutBatches/${id}`, data });
  };
  batch('pb-completed', 2, 'completed', [
    { uid: USERS.att1, amount: 11_800, transferRef: 'tr_demo_a1', status: 'paid' },
    { uid: USERS.lead1, amount: 12_400, transferRef: 'tr_demo_l1', status: 'paid' },
  ]);
  batch('pb-partial', 1, 'partial', [
    { uid: USERS.att1, amount: 14_000, transferRef: 'tr_demo_a2', status: 'paid' },
    { uid: USERS.att2, amount: 13_200, status: 'failed', lastError: 'Connected account onboarding incomplete' },
  ]);
  batch('pb-pending', 0, 'pending', [{ uid: USERS.att1, amount: 9_600, status: 'pending' }]);
  batch('pb-failed', 5, 'failed', [{ uid: USERS.att3, amount: 7_400, status: 'failed', lastError: 'Connected account restricted: verification required' }]);

  // att1's own ledger (staff app Payouts screen): paid, pending and failed rows.
  const ledger: Array<[string, number, PayoutAllocation['status'], number, string | undefined]> = [
    ['po-1', 11_800, 'paid', 2, 'pb-completed'],
    ['po-2', 14_000, 'paid', 1, 'pb-partial'],
    ['po-3', 9_600, 'pending', 0, 'pb-pending'],
  ];
  for (const [id, amount, status, daysAgo, batchId] of ledger) {
    const data: PayoutAllocation = {
      id,
      shiftId: daysAgo === 1 ? SHIFTS.stElmoYesterday : SHIFTS.stElmoToday,
      amount,
      currency: 'USD',
      status,
      ...(batchId ? { batchId } : {}),
      ...(status === 'paid' ? { transferRef: `tr_demo_${id}`, paidAt: clock.daysAgo(daysAgo, -90) } : {}),
      createdAt: clock.daysAgo(daysAgo),
    };
    docs.push({ kind: 'payoutAllocation', path: `operators/${OP}/users/${USERS.att1}/payouts/${id}`, data });
  }
  const failed: PayoutAllocation = { id: 'po-att2-1', shiftId: SHIFTS.stElmoYesterday, amount: 13_200, currency: 'USD', status: 'failed', batchId: 'pb-partial', createdAt: clock.daysAgo(1) };
  docs.push({ kind: 'payoutAllocation', path: `operators/${OP}/users/${USERS.att2}/payouts/${failed.id}`, data: failed });
  return docs;
}

function integrations(clock: DemoClock): SeedDoc[] {
  const i = (provider: string, over: Partial<Integration>): SeedDoc => ({
    kind: 'integration',
    path: `operators/${OP}/integrations/${provider}`,
    data: { provider, status: 'active', config: {}, lastSyncAt: clock.minutesAgo(12), health: { ok: true }, ...over },
  });
  return [
    i('stripe', { config: { connectedAccountId: 'acct_demo_goldstar', platformFeeBps: 150 } }),
    i('twilio', { config: { messagingServiceSid: 'MG_demo' }, secretRef: 'operators/goldstar/twilio' }),
    i('internal', { config: {} }),
    i('plate_recognizer', { config: { region: 'us' }, secretRef: 'operators/goldstar/plate_recognizer' }),
    i('opera_cloud', { config: { hotelId: 'DEMO-MERIDIAN', gatewayUrl: 'https://opera.demo.invalid/ohip', chargeCode: 'VALET', noPostBehavior: 'fallback_card' } }),
    i('toast', { config: { restaurantGuid: 'demo-toast-st-elmo' } }),
    i('mapbox', { config: {} }),
    i('csv', { status: 'configured', config: {}, health: { ok: true, message: 'Exports run nightly at 2am.' } }),
    i('quickbooks_online', {
      status: 'error',
      config: { realmId: '9341452810283', incomeAccountId: '84' },
      lastError: 'Refresh token expired. Reconnect QuickBooks to resume syncing.',
      lastErrorAt: clock.daysAgo(1),
      health: { ok: false, message: 'Reconnect required', errors: ['invalid_grant'] },
    }),
    i('when_i_work', { status: 'disabled', config: { locationId: 'demo-loc', venueMap: {} }, health: { ok: true, message: 'Disabled by owner' } }),
  ];
}

function audit(clock: DemoClock): SeedDoc[] {
  const entries: Array<[string, string, string, number, unknown, unknown]> = [
    [USERS.owner1, 'venue.update', `venues/${V1}`, 30, { zones: 1 }, { zones: 3 }],
    [USERS.admin1, 'claim.decide', 'claims/accepted', 120, { status: 'under_review' }, { status: 'accepted' }],
    [USERS.owner1, 'staff.invite', `users/${USERS.invited1}`, 1440, null, { roles: ['attendant'] }],
    [USERS.admin1, 'staff.suspend', `users/${USERS.suspended1}`, 2 * 1440, { status: 'active' }, { status: 'suspended' }],
    [USERS.lead1, 'ticket.cancel', 'tickets/cancelled', 40, { status: 'requested' }, { status: 'cancelled' }],
    [USERS.owner1, 'integrations.set_secret', 'integrations/twilio', 3 * 1440, null, { secretRef: 'set' }],
    ['system', 'dispatch.assign', 'tickets/drive-home', 25, { status: 'confirmed' }, { status: 'assigned' }],
  ];
  const docs: SeedDoc[] = entries.map(([actorUid, action, target, minutesAgo, before, after], n) => {
    const data: AuditLogEntry = { id: `audit-${n + 1}`, operatorId: OP, actorUid, action, target, before, after, at: clock.minutesAgo(minutesAgo), requestId: `req-demo-${n + 1}` };
    return { kind: 'auditLogEntry', path: `operators/${OP}/auditLog/${data.id}`, data };
  });
  const platformEntry: AuditLogEntry = { id: 'audit-platform-1', actorUid: USERS.platform1, action: 'operator.suspend', target: 'operators/circlecity', before: { status: 'active' }, after: { status: 'suspended' }, at: clock.daysAgo(6), requestId: 'req-demo-platform-1' };
  docs.push({ kind: 'auditLogEntry', path: `platform/auditLog/entries/${platformEntry.id}`, data: platformEntry });
  return docs;
}

export function buildOps(clock: DemoClock, refs: TicketOutput['refs']): { docs: SeedDoc[]; storage: DemoStorageObject[] } {
  const incidentOut = incidents(clock, refs);
  return {
    docs: [
      ...shifts(clock),
      ...fleet(),
      ...incidentOut.docs,
      ...claims(clock, refs),
      ...validations(clock, refs),
      ...hostRequests(clock, refs),
      ...invoices(clock),
      ...payouts(clock),
      ...integrations(clock),
      ...audit(clock),
    ],
    storage: incidentOut.storage,
  };
}
