import { describe, it } from 'vitest';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { ADMIN, ATT, ATT_V2, DRIVER, EID, GUEST, LEAD, NOW, OP, OTHER_OP, PLATFORM, TID, TOKEN, V1, VENUE_USER, anon, assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant } from './helpers';
const T = `operators/${OP}/tickets/${TID}`;
async function seedTicket(over: Record<string, unknown> = {}) { await seed(async (db) => setDoc(doc(db, T), baseTicket(over))); }
describe('ticket create', () => {
  it('attendant at the venue creates a valet ticket with client id = doc id, no server fields', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(ATT(), T), baseTicket()));
    await assertFails(setDoc(doc(ATT_V2(), T), baseTicket()));               // wrong venue
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/tickets/not-uuid`), baseTicket({ id: 'not-uuid' })));
    await assertFails(setDoc(doc(ATT(), T), baseTicket({ payment: { status: 'paid' } })));
    await assertFails(setDoc(doc(ATT(), T), baseTicket({ status: 'ready' })));   // must start checked_in
    await assertFails(setDoc(doc(ATT(), T), baseTicket({ operatorId: 'valetb' })));
    await assertFails(setDoc(doc(ATT(), T), baseTicket({ guestToken: 'short' })));
    await assertFails(setDoc(doc(VENUE_USER(), T), baseTicket()));
    await assertFails(setDoc(doc(OTHER_OP(), T), baseTicket()));
  });
  it('only owner/admin/lead/attendant may create a checked_in valet ticket — bare driver and venue_user denied (Ruling V/finding 13)', async () => {
    await seedTenant();
    const bareDriver = ctx('drvonly', { operatorId: OP, roles: ['driver'], venueIds: [V1] });
    await assertFails(setDoc(doc(bareDriver, T), baseTicket({ attendants: { checkedInBy: 'drvonly' } })));
    await assertFails(setDoc(doc(VENUE_USER(), T), baseTicket({ source: 'host_portal' })));   // host_portal venue_user still cannot create a valet (checked_in) ticket
    const EID3 = '01912345-7abc-7def-8123-456789abcd31';
    await assertSucceeds(setDoc(doc(VENUE_USER(), `operators/${OP}/tickets/${EID3}`), baseTicket({ id: EID3, jobType: 'drive_home', status: 'requested', source: 'host_portal', attendants: {}, driveHome: { destination: { address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }, chase: { status: 'pending' } } })));   // host_portal venue_user CAN originate a non-valet request
  });
  it('drive_home/ride tickets start at requested and may be created by guests of that phone', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(GUEST(), T), baseTicket({ jobType: 'drive_home', status: 'requested', source: 'guest_app', attendants: {}, guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, driveHome: { destination: { address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }, chase: { status: 'pending' } } })));
    await assertFails(setDoc(doc(GUEST('+19999999999'), `operators/${OP}/tickets/${EID}`), baseTicket({ id: EID, jobType: 'drive_home', status: 'requested', source: 'guest_app', attendants: {}, guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } })));
  });
  it('guest.uid is constrained to the creator at create (Ruling M)', async () => {
    await seedTenant();
    const EID2 = '01912345-7abc-7def-8123-456789abcd20';
    await assertFails(setDoc(doc(GUEST(), T), baseTicket({ jobType: 'drive_home', status: 'requested', source: 'guest_app', attendants: {}, guest: { uid: 'someone-else', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, driveHome: { destination: { address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }, chase: { status: 'pending' } } })));   // third-party uid planted; doc T stays absent
    await assertSucceeds(setDoc(doc(GUEST(), `operators/${OP}/tickets/${EID}`), baseTicket({ id: EID, jobType: 'drive_home', status: 'requested', source: 'guest_app', attendants: {}, guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, driveHome: { destination: { address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }, chase: { status: 'pending' } } })));   // own uid, distinct doc id
    await assertSucceeds(setDoc(doc(ATT(), `operators/${OP}/tickets/${EID2}`), baseTicket({ id: EID2 })));   // staff-created: guest.uid absent, unaffected; distinct doc id
  });
});
describe('ticket read', () => {
  it('venue staff, managers, platform admin read; other venue/operator denied; guest by phone or uid', async () => {
    await seedTenant(); await seedTicket();
    await assertSucceeds(getDoc(doc(ATT(), T)));
    await assertFails(getDoc(doc(ATT_V2(), T)));
    await assertSucceeds(getDoc(doc(LEAD(), T)));
    await assertSucceeds(getDoc(doc(PLATFORM(), T)));
    await assertFails(getDoc(doc(OTHER_OP(), T)));
    await assertFails(getDoc(doc(anon(), T)));
    await assertSucceeds(getDoc(doc(GUEST('+13175550123'), T)));
    await assertFails(getDoc(doc(GUEST('+19999999999'), T)));
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/tickets`), where('venueId', '==', V1), where('status', 'in', ['requested', 'claimed']))));
    await assertFails(getDocs(collection(ATT(), `operators/${OP}/tickets`)));
  });
});
describe('ticket transitions', () => {
  it('follows the state machine and role table', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(updateDoc(doc(ATT(), T), { status: 'ready' }));                             // skip
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'requested', 'times.requestedAt': NOW }));
    await assertFails(updateDoc(doc(VENUE_USER(), T), { status: 'claimed' }));
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW }));
    await assertFails(updateDoc(doc(ATT_V2(), T), { status: 'retrieving' }));                    // wrong venue
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'retrieving' }));                    // claimant
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'ready', 'times.readyAt': NOW }));
    await assertFails(updateDoc(doc(ATT(), T), { status: 'delivered', 'times.deliveredAt': NOW, 'attendants.deliveredBy': 'att1' })); // needs keys_returned event in same batch
    // stale id replay: an existing event cannot be reused
    await seed(async (db) => setDoc(doc(db, `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcd00`), { id: '01912345-7abc-7def-8123-456789abcd00', actorUid: 'att1', action: 'keys_returned', at: NOW, deviceId: 'd1' }));
    await assertFails(updateDoc(doc(ATT(), T), { status: 'delivered', 'times.deliveredAt': NOW, 'attendants.deliveredBy': 'att1', lastCustodyEventId: '01912345-7abc-7def-8123-456789abcd00' }));
    // wrong action in batch
    const attDb1 = ATT(); const bad = writeBatch(attDb1); const badId = '01912345-7abc-7def-8123-456789abcd01';
    bad.set(doc(attDb1, `${T}/custodyEvents/${badId}`), { id: badId, actorUid: 'att1', action: 'note', at: NOW, deviceId: 'd1' });
    bad.update(doc(attDb1, T), { status: 'delivered', 'times.deliveredAt': NOW, 'attendants.deliveredBy': 'att1', lastCustodyEventId: badId });
    await assertFails(bad.commit());
    const attDb2 = ATT(); const b = writeBatch(attDb2);
    b.set(doc(attDb2, `${T}/custodyEvents/${EID}`), { id: EID, actorUid: 'att1', action: 'keys_returned', at: NOW, deviceId: 'd1' });
    b.update(doc(attDb2, T), { status: 'delivered', 'times.deliveredAt': NOW, 'attendants.deliveredBy': 'att1', lastCustodyEventId: EID });
    await assertSucceeds(b.commit());
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'closed', 'times.closedAt': NOW }));
    await assertFails(updateDoc(doc(ADMIN(), T), { status: 'requested' }));                     // terminal
  });
  it('non-claimant attendant cannot advance; lead can; cancel needs manager + reason', async () => {
    await seedTenant(); await seedTicket({ status: 'claimed', attendants: { checkedInBy: 'att1', claimedBy: 'drv1' } });
    await assertFails(updateDoc(doc(ATT(), T), { status: 'retrieving' }));
    await assertSucceeds(updateDoc(doc(DRIVER(), T), { status: 'retrieving' }));
    await assertSucceeds(updateDoc(doc(LEAD(), T), { status: 'ready', 'times.readyAt': NOW }));
    await assertFails(updateDoc(doc(ATT(), T), { status: 'cancelled', cancelReason: 'x', 'times.cancelledAt': NOW }));
    await assertFails(updateDoc(doc(LEAD(), T), { status: 'cancelled', 'times.cancelledAt': NOW }));
    await assertSucceeds(updateDoc(doc(LEAD(), T), { status: 'cancelled', cancelReason: 'guest left', 'times.cancelledAt': NOW }));
  });
  it('server-only and immutable fields are rejected from clients', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(updateDoc(doc(ADMIN(), T), { 'payment.status': 'paid' }));
    // v0.4.4 Ruling BB: pmsChargeSeq is the room-charge generation counter — a client reset to 0
    // would point the next charge at a reversed generation's ids, letting money move with its
    // transaction-row create swallowed as a "crash retry" (no ledger entry). Functions-only.
    await assertFails(updateDoc(doc(ADMIN(), T), { pmsChargeSeq: 0 }));
    await assertFails(updateDoc(doc(ADMIN(), T), { metrics: { retrievalSec: 1 } }));
    await assertFails(updateDoc(doc(ADMIN(), T), { guestToken: 'ZzZzZzZzZzZzZzZzZzZzZz' }));
    await assertFails(updateDoc(doc(ADMIN(), T), { jobType: 'drive_home' }));
    await assertFails(updateDoc(doc(ADMIN(), T), { venueId: 'v2' }));
    await assertSucceeds(updateDoc(doc(ATT(), T), { 'vehicle.color': 'Red', spotLabel: 'A-12', zoneId: 'A' }));
    // nested maps: staff may edit guest name/consent but never phone or uid; quotes are server-only even when nested
    await assertSucceeds(updateDoc(doc(ATT(), T), { 'guest.name': 'Sam', 'guest.consentSms': false }));
    await assertFails(updateDoc(doc(ATT(), T), { 'guest.phoneE164': '+19999999999' }));
    await assertFails(updateDoc(doc(ATT(), T), { 'guest.uid': 'attacker' }));
    await assertFails(updateDoc(doc(ADMIN(), T), { driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 1 } }, quote: { base: 1, distanceMeters: 1, durationSec: 1, amount: 1, breakdown: [] }, chase: { status: 'pending' } } }));
    await assertFails(updateDoc(doc(ATT(), T), { 'attendants.claimedBy': 'att1' }));   // reassignment is manager-only
    await assertSucceeds(updateDoc(doc(LEAD(), T), { 'attendants.claimedBy': 'att1' }));
  });
  it('claim race: second claimer is rejected once the first landed', async () => {
    await seedTenant(); await seedTicket({ status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    await assertSucceeds(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW }));
    await assertFails(updateDoc(doc(DRIVER(), T), { status: 'claimed', 'attendants.claimedBy': 'drv1', 'times.claimedAt': NOW }));
  });
  it('list queries: guests must filter by their uid/phone; staff by a venue they belong to', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(getDocs(collection(GUEST(), `operators/${OP}/tickets`)));                                                      // unconstrained guest list = cross-tenant leak
    await assertSucceeds(getDocs(query(collection(GUEST(), `operators/${OP}/tickets`), where('guest.phoneE164', '==', '+13175550123'))));
    await assertFails(getDocs(query(collection(GUEST('+19999999999'), `operators/${OP}/tickets`), where('guest.phoneE164', '==', '+13175550123'))));
    await assertFails(getDocs(query(collection(ATT_V2(), `operators/${OP}/tickets`), where('venueId', '==', V1))));              // other venue
    await assertSucceeds(getDocs(query(collection(LEAD(), `operators/${OP}/tickets`), where('status', '==', 'checked_in'))));      // managers may list operator-wide
  });
  it('guest may only request / cancel / flag assistance on own ticket', async () => {
    await seedTenant(); await seedTicket();
    await assertSucceeds(updateDoc(doc(GUEST(), T), { status: 'requested', 'times.requestedAt': NOW }));
    await assertSucceeds(updateDoc(doc(GUEST(), T), { 'flags.assistance': true }));   // nested flag edit allowed via subOnly
    await assertFails(updateDoc(doc(GUEST(), T), { 'flags.vip': true }));
    await assertFails(updateDoc(doc(GUEST(), T), { status: 'claimed' }));
    await assertFails(updateDoc(doc(GUEST(), T), { 'vehicle.plate': 'XYZ' }));
  });
  it('drive_home assignment requires eligible drivers (checked via user docs)', async () => {
    await seedTenant();
    // M3 (Plan 6 final wave) — corrected: H1(b)'s payment gate is NOT enforced at the rules
    // boundary. `dispatchAssignHandler` (functions/src/modules/dispatch/assign.ts) is its SOLE
    // enforcement point; four rules formulations were tried and every one tipped the tickets update
    // rule over the interpreter's ~1000-expression ceiling (see 022c424). The fixture carries
    // `payment` only because a real confirmed job has it (set by guestConfirmDriveHome's checkout
    // step) — nothing here reads it. The assertFails cases below fail for the SAME eligibility
    // reasons they always did. Do not "simplify" assign.ts's check on the belief that rules
    // duplicate it: they do not, and deleting it removes the only thing enforcing payment.
    await seedTicket({ jobType: 'drive_home', status: 'confirmed', attendants: {}, payment: { status: 'authorized', base: 2500, tip: 0, tax: 0, fees: 0, total: 5750, currency: 'USD', billTo: 'guest' } });
    await assertFails(updateDoc(doc(LEAD(), T), { status: 'assigned', 'attendants.primaryDriverUid': 'att1', 'attendants.chaseDriverUid': 'drv1', 'times.assignedAt': NOW })); // att1 not eligible
    await assertFails(updateDoc(doc(LEAD(), T), { status: 'assigned', 'attendants.primaryDriverUid': 'drv1', 'attendants.chaseDriverUid': 'att1', 'times.assignedAt': NOW })); // chase not eligible
    await assertFails(updateDoc(doc(LEAD(), T), { status: 'assigned', 'attendants.primaryDriverUid': 'drv1', 'attendants.chaseDriverUid': 'drv1', 'times.assignedAt': NOW })); // same person cannot chase themselves
    await assertSucceeds(updateDoc(doc(LEAD(), T), { status: 'assigned', 'attendants.primaryDriverUid': 'drv1', 'attendants.chaseDriverUid': 'drv2', 'times.assignedAt': NOW }));
  });
  it('drive_home arrived→completed requires at least 2 damage report ids already on the ticket (Ruling Z / finding 8)', async () => {
    await seedTenant();
    await seedTicket({ jobType: 'drive_home', status: 'arrived', attendants: { primaryDriverUid: 'drv1', chaseDriverUid: 'drv2' }, damageReportIds: ['r1'] });
    await assertFails(updateDoc(doc(DRIVER(), T), { status: 'completed', 'times.completedAt': NOW }));   // only 1 post-drive report
    await seed(async (db) => updateDoc(doc(db, T), { damageReportIds: ['r1', 'r2'] }));
    await assertSucceeds(updateDoc(doc(DRIVER(), T), { status: 'completed', 'times.completedAt': NOW }));
  });
  it('status transition rejects unrelated co-edits — metric gaming, provenance rewrite, evidence unlinking (Ruling V)', async () => {
    await seedTenant(); await seedTicket({ status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    // co-edit: backdating an unrelated times.* key while transitioning to claimed
    await assertFails(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW, 'times.requestedAt': '2020-01-01T00:00:00.000Z' }));
    // co-edit: rewriting damageReportIds (evidence unlinking) mid-transition
    await assertFails(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW, damageReportIds: ['fake'] }));
    // co-edit: rewriting vehicle mid-transition
    await assertFails(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW, 'vehicle.plate': 'HACKED' }));
    // co-edit: smuggling keyTagId onto a status-transition write
    await assertFails(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'times.claimedAt': NOW, keyTagId: 'stolen' }));
    // non-manager touching an attendants key outside the transition's required set
    await assertFails(updateDoc(doc(ATT(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'attendants.deliveredBy': 'att1', 'times.claimedAt': NOW }));
    // a manager may still touch attendants beyond the required set during a transition (reassignment stays manager-only, but this proves the bypass)
    await assertSucceeds(updateDoc(doc(LEAD(), T), { status: 'claimed', 'attendants.claimedBy': 'att1', 'attendants.deliveredBy': 'placeholder', 'times.claimedAt': NOW }));
  });
  it('guest transition rejects times co-edits beyond requestedAt/cancelledAt (Ruling V)', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(updateDoc(doc(GUEST(), T), { status: 'requested', 'times.requestedAt': NOW, 'times.checkedInAt': '2020-01-01T00:00:00.000Z' }));
  });
  it('non-status staff edits cannot touch keyTagId or lastCustodyEventId directly — only via coupled batch paths (Ruling V/finding 13)', async () => {
    await seedTenant(); await seedTicket();
    await assertFails(updateDoc(doc(ATT(), T), { keyTagId: 'k2' }));
    await assertFails(updateDoc(doc(ATT(), T), { lastCustodyEventId: 'fabricated' }));
    await assertFails(updateDoc(doc(LEAD(), T), { keyTagId: 'k2' }));   // even managers must go through the coupled path
  });
});
