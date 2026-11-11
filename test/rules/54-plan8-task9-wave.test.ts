import { describe, it } from 'vitest';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, ATT, EID, GUEST, LEAD, NOW, OP, TID, V1, V2, VENUE_USER, assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant } from './helpers';

// Plan 8 Task 9 — the rules wave that carry #14's tickets/update decomposition made room for.
// One describe per item; every assertFails here is paired with an assertSucceeds control on the
// SAME statement, so a deny cannot be mistaken for the interpreter's expression ceiling (which
// fails BOTH ways). Items: D2 (#13), D3 (#12), #44, #57, #40, #19, H1(b).

const T = `operators/${OP}/tickets/${TID}`;
const seedTicket = (over: Record<string, unknown> = {}) => seed(async (db) => setDoc(doc(db, T), baseTicket(over)));

// A lead whose claims scope them to ONE venue. helpers' LEAD() holds both venues, which is exactly
// the case D2 must keep working; this is the case it must stop.
const LEAD_V1_ONLY = () => ctx('lead1', { operatorId: OP, roles: ['lead'], venueIds: [V1] });

describe('D2 (carry #13): a lead may only transition tickets at venues in their own venueIds', () => {
  it('lead scoped to v1 cannot claim a v2 ticket; a lead holding v2 and an admin still can', async () => {
    await seedTenant();
    await seedTicket({ venueId: V2, status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    const claim = (uid: string) => ({ status: 'claimed', 'attendants.claimedBy': uid, 'times.claimedAt': NOW });
    await assertFails(updateDoc(doc(LEAD_V1_ONLY(), T), claim('att2')));
    // Controls on the identical statement: venueMatch() admits a lead who holds v2, and admins via
    // its own isAdmin() arm — proving the deny above is venue scope, not the ceiling.
    await assertSucceeds(updateDoc(doc(LEAD(), T), claim('att2')));
  });
  it('admin (no venueIds at all) still transitions any venue — venueMatch admits isAdmin()', async () => {
    await seedTenant();
    await seedTicket({ venueId: V2, status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    await assertSucceeds(updateDoc(doc(ADMIN(), T), { status: 'claimed', 'attendants.claimedBy': 'att2', 'times.claimedAt': NOW }));
  });
  it('branch 1 now matches branch 2: the same v1-only lead cannot reassign a v2 ticket either', async () => {
    await seedTenant();
    await seedTicket({ venueId: V2 });
    await assertFails(updateDoc(doc(LEAD_V1_ONLY(), T), { 'attendants.claimedBy': 'att2' }));
    await assertSucceeds(updateDoc(doc(LEAD(), T), { 'attendants.claimedBy': 'att2' }));
  });
});

describe('D3 (carry #12): no NEW guest drive_home/ride under a suspended operator — but a parked car is never stranded', () => {
  const guestDriveHome = () =>
    baseTicket({
      jobType: 'drive_home', status: 'requested', source: 'guest_app', attendants: {},
      guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
      driveHome: { destination: { address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }, chase: { status: 'pending' } },
    });
  const suspend = () => seed(async (db) => updateDoc(doc(db, `operators/${OP}`), { status: 'suspended' }));

  it('guest create is denied once the operator is suspended; the identical create succeeds while active', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(GUEST(), T), guestDriveHome()));
    // A SECOND id for the suspended half: seedTenant() re-seeds the tenant but does not delete doc
    // T, and a setDoc onto an existing doc is an UPDATE — which the guest is allowed to no-op
    // through branch 3. Reusing T here silently turned the create-denial into a passing update.
    await suspend();
    await assertFails(setDoc(doc(GUEST(), `operators/${OP}/tickets/${EID}`), { ...guestDriveHome(), id: EID }));
  });
  it('scope pin: a guest whose car is ALREADY parked can still request it under a suspended operator', async () => {
    await seedTenant();
    await seedTicket(); // valet, checked_in, guest phone +13175550123
    await suspend();
    // Branch 3 (guest update) deliberately never consults operator status — suspension is a
    // billing matter between the platform and the operator and must not strand a vehicle.
    await assertSucceeds(updateDoc(doc(GUEST(), T), { status: 'requested', 'times.requestedAt': NOW }));
  });
  it('a missing status field reads as active (same idiom as inOperator): guest create allowed', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}`), { id: OP, name: 'Goldstar', slug: OP }, { merge: false }));
    await assertSucceeds(setDoc(doc(GUEST(), T), guestDriveHome()));
  });
});

describe('#44: the operator-wide metrics rollup is no longer readable by venue_user', () => {
  const M = `operators/${OP}/metrics/daily/days/2026-08-01`;
  it('venue_user denied; lead (manager) and platform still read', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, M), { day: '2026-08-01', operator: { tickets: 5 }, venues: { [V1]: { tickets: 2 }, [V2]: { tickets: 3 } } }));
    await assertFails(getDoc(doc(VENUE_USER(), M)));
    await assertSucceeds(getDoc(doc(LEAD(), M)));
  });
});

describe('#57: a damage photo\'s storagePath is bound to its report\'s ticketId', () => {
  const RID = '01912345-7abc-7def-8123-456789abcde5';
  const R = `operators/${OP}/damageReports/${RID}`;
  const OTHER_TID = '01912345-7abc-7def-8123-456789abcd99';
  const PID = '01912345-7abc-7def-8123-456789abcde6';
  const photo = (ticketId: string) => ({
    id: PID, storagePath: `operators/${OP}/tickets/${ticketId}/photos/${PID}.jpg`, stage: 'wide', at: NOW,
    actorUid: 'att1', deviceId: 'd1', bytes: 120000, width: 1600, height: 1200, sha256: 'a'.repeat(64),
  });
  const seedReport = () => seed(async (db) => setDoc(doc(db, R), { id: RID, operatorId: OP, ticketId: TID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [], notes: '', createdBy: 'att1', createdAt: NOW }));

  it('a path filed under a DIFFERENT ticket is denied; the report\'s own ticket succeeds', async () => {
    await seedTenant(); await seedTicket(); await seedReport();
    await assertFails(setDoc(doc(ATT(), `${R}/photos/${PID}`), photo(OTHER_TID)));
    await assertSucceeds(setDoc(doc(ATT(), `${R}/photos/${PID}`), photo(TID)));
  });
});

describe('#40: venue_user cannot enumerate the operator\'s venues, but still gets its own by id', () => {
  it('list denied for venue_user; get of a held venue still succeeds; lead list still succeeds', async () => {
    await seedTenant();
    await assertFails(getDocs(collection(VENUE_USER(), `operators/${OP}/venues`)));
    await assertSucceeds(getDoc(doc(VENUE_USER(), `operators/${OP}/venues/${V1}`)));
    await assertSucceeds(getDocs(collection(LEAD(), `operators/${OP}/venues`)));
  });
});

describe('#19: ticket.shiftId is gone — branch 2 no longer accepts it as a co-edit', () => {
  it('writing shiftId is denied; an ordinary branch-2 edit on the same ticket still succeeds', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(updateDoc(doc(ATT(), T), { shiftId: 's1' }));
    await assertSucceeds(updateDoc(doc(ATT(), T), { spotLabel: 'A-12' }));
  });
});

describe('H1(b) rules half: confirmed->assigned requires an authorized/paid payment, with assign.ts\'s billTo carve-out', () => {
  const assignDriveHome = { status: 'assigned', 'attendants.primaryDriverUid': 'drv1', 'attendants.chaseDriverUid': 'drv2', 'times.assignedAt': NOW };
  const paid = { status: 'paid', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest' };
  const ride = (billTo: string) => ({
    jobType: 'passenger_ride', status: 'confirmed', attendants: {},
    vehicle: { plate: 'FLEET1', state: 'IN', make: 'Ford', model: 'Transit', color: 'White', fleetVehicleId: 'fleet1' },
    ride: { pickup: { geo: { lat: 39.76, lng: -86.16 } }, dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } }, passengers: 1, accessible: false, billTo, quote: { base: 1000, distanceMeters: 1609, durationSec: 120, amount: 1500, breakdown: [] } },
  });
  const assignRide = { status: 'assigned', 'attendants.primaryDriverUid': 'drv1', 'times.assignedAt': NOW };

  it('drive_home: no payment map at all -> denied; payment paid -> the identical write succeeds', async () => {
    await seedTenant();
    await seedTicket({ jobType: 'drive_home', status: 'confirmed', attendants: {} });
    await assertFails(updateDoc(doc(LEAD(), T), assignDriveHome));
    await seedTenant();
    await seedTicket({ jobType: 'drive_home', status: 'confirmed', attendants: {}, payment: paid });
    await assertSucceeds(updateDoc(doc(LEAD(), T), assignDriveHome));
  });
  it('drive_home: payment present but still pending -> denied', async () => {
    await seedTenant();
    await seedTicket({ jobType: 'drive_home', status: 'confirmed', attendants: {}, payment: { ...paid, status: 'pending' } });
    await assertFails(updateDoc(doc(LEAD(), T), assignDriveHome));
  });
  it('passenger_ride billed to the guest with no payment -> denied (same rule, no carve-out)', async () => {
    await seedTenant();
    await seedTicket(ride('guest'));
    await assertFails(updateDoc(doc(LEAD(), T), assignRide));
  });
  it('passenger_ride billed to the venue or a room has no guest card by design -> dispatchable with no payment', async () => {
    await seedTenant();
    await seedTicket(ride('venue'));
    await assertSucceeds(updateDoc(doc(LEAD(), T), assignRide));
    await seedTenant();
    await seedTicket(ride('room'));
    await assertSucceeds(updateDoc(doc(LEAD(), T), assignRide));
  });
});
