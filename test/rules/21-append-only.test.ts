import { describe, it } from 'vitest';
import { collection, deleteDoc, doc, getDocs, setDoc, updateDoc, collectionGroup, query, where, writeBatch } from 'firebase/firestore';
import { ADMIN, ATT, ATT_V2, DRIVER, EID, NOW, OP, TID, V1, V2, assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant } from './helpers';
const T = `operators/${OP}/tickets/${TID}`;
describe('custody events', () => {
  it('create-only by venue staff as self with uuid id; no update/delete; readable by staff and via collection group for self', async () => {
    await seedTenant(); await seed(async (db) => setDoc(doc(db, T), baseTicket()));
    const ev = { id: EID, actorUid: 'att1', action: 'keys_stored', at: NOW, deviceId: 'd1', zoneId: 'A' };
    await assertSucceeds(setDoc(doc(ATT(), `${T}/custodyEvents/${EID}`), ev));
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/${EID}`), { ...ev, action: 'moved' }));
    await assertFails(updateDoc(doc(ADMIN(), `${T}/custodyEvents/${EID}`), { note: 'x' }));
    await assertFails(deleteDoc(doc(ADMIN(), `${T}/custodyEvents/${EID}`)));
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde2`), { ...ev, id: '01912345-7abc-7def-8123-456789abcde2', actorUid: 'lead1' }));
    await assertFails(setDoc(doc(ATT_V2(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde3`), { ...ev, id: '01912345-7abc-7def-8123-456789abcde3', actorUid: 'att2' }));
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde4`), { ...ev, id: '01912345-7abc-7def-8123-456789abcde4', action: 'teleport' }));
    await assertSucceeds(getDocs(collection(ATT(), `${T}/custodyEvents`)));
    await assertSucceeds(getDocs(query(collectionGroup(ATT(), 'custodyEvents'), where('actorUid', '==', 'att1'))));
    await assertFails(getDocs(query(collectionGroup(ATT(), 'custodyEvents'), where('actorUid', '==', 'lead1'))));
  });
  it('rejects eventId/id mismatch, non-ISO at, and missing deviceId (Ruling L)', async () => {
    await seedTenant(); await seed(async (db) => setDoc(doc(db, T), baseTicket()));
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde5`), { id: '01912345-7abc-7def-8123-456789abcde6', actorUid: 'att1', action: 'keys_stored', at: NOW, deviceId: 'd1' }));   // id != doc id
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde7`), { id: '01912345-7abc-7def-8123-456789abcde7', actorUid: 'att1', action: 'keys_stored', at: '2026-08-23', deviceId: 'd1' }));   // non-ISO at
    await assertFails(setDoc(doc(ATT(), `${T}/custodyEvents/01912345-7abc-7def-8123-456789abcde8`), { id: '01912345-7abc-7def-8123-456789abcde8', actorUid: 'att1', action: 'keys_stored', at: NOW }));   // missing deviceId
  });
  it('multi-venue attendant reads and creates custody events at a claimed venue that is not their first-listed one (Ruling N)', async () => {
    await seedTenant(); await seed(async (db) => setDoc(doc(db, T), baseTicket()));   // ticket is at V1
    const MULTI = () => ctx('multi', { operatorId: OP, roles: ['attendant'], venueIds: [V2, V1] });   // v2 listed first, ticket at v1
    await assertSucceeds(getDocs(collection(MULTI(), `${T}/custodyEvents`)));
    const multiEventId = '01912345-7abc-7def-8123-456789abcd10';
    await assertSucceeds(setDoc(doc(MULTI(), `${T}/custodyEvents/${multiEventId}`), { id: multiEventId, actorUid: 'multi', action: 'keys_stored', at: NOW, deviceId: 'd1' }));
  });
});
describe('damage reports + photos', () => {
  it('report create/update by venue staff; photos create-only by self with size/type invariants', async () => {
    await seedTenant(); await seed(async (db) => setDoc(doc(db, T), baseTicket()));
    const R = `operators/${OP}/damageReports/${EID}`;
    const report = { id: EID, operatorId: OP, ticketId: TID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [], notes: '', createdBy: 'att1', createdAt: NOW };
    await assertSucceeds(setDoc(doc(ATT(), R), report));
    await assertFails(setDoc(doc(ATT_V2(), `operators/${OP}/damageReports/01912345-7abc-7def-8123-456789abcde5`), { ...report, id: '01912345-7abc-7def-8123-456789abcde5' }));
    await assertSucceeds(updateDoc(doc(ATT(), R), { notes: 'scratch on door', diagramMarks: [{ panel: 'front_left_door', x: 0.5, y: 0.5, kind: 'scratch', preExisting: true }] }));
    await assertFails(updateDoc(doc(ATT(), R), { ticketId: '01912345-7abc-7def-8123-456789abcde9' }));
    await assertFails(updateDoc(doc(ATT(), R), { photoCount: 3 })); // Functions-only
    const P = `${R}/photos/01912345-7abc-7def-8123-456789abcde6`;
    const photo = { id: '01912345-7abc-7def-8123-456789abcde6', storagePath: `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`, stage: 'wide', at: NOW, actorUid: 'att1', deviceId: 'd1', bytes: 120000, width: 1600, height: 1200, sha256: 'a'.repeat(64) };
    await assertSucceeds(setDoc(doc(ATT(), P), photo));
    await assertFails(updateDoc(doc(ADMIN(), P), { stage: 'close' }));
    await assertFails(deleteDoc(doc(ADMIN(), P)));
    await assertFails(setDoc(doc(ATT(), `${R}/photos/01912345-7abc-7def-8123-456789abcde7`), { ...photo, id: '01912345-7abc-7def-8123-456789abcde7', storagePath: 'operators/valetb/x.jpg' }));
    await assertFails(setDoc(doc(ATT(), `${R}/photos/01912345-7abc-7def-8123-456789abcde8`), { ...photo, id: '01912345-7abc-7def-8123-456789abcde8', bytes: 99_000_000 }));
  });
  it('create in the SAME batch as its own ticket (Ruling J: getAfter, not get, for the venue lookup)', async () => {
    // The mobile check-in commit (Plan 2b) writes the ticket and its damage report in one atomic
    // batch — at the point the damageReports/create rule evaluates, the ticket doc does not exist
    // in already-committed state, only in this batch's post-write state. `get()` can't see that;
    // `getAfter()` can.
    await seedTenant();
    const attDb = ATT();
    const b = writeBatch(attDb);
    const reportId = '01912345-7abc-7def-8123-456789abcd12';
    b.set(doc(attDb, T), baseTicket());
    b.set(doc(attDb, `operators/${OP}/damageReports/${reportId}`), { id: reportId, operatorId: OP, ticketId: TID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [], notes: '', createdBy: 'att1', createdAt: NOW });
    await assertSucceeds(b.commit());
  });
});
describe('incidents, validations, hostRequests, liveLocations', () => {
  it('incidents create by staff, full update by managers, non-photos update by the reporter denied (photos-only carve-out is Ruling U, tested separately below); validations by venue_user/admin; hostRequests by venue_user; liveLocations by driver on own doc', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(ATT(), `operators/${OP}/incidents/${EID}`), { id: EID, operatorId: OP, venueId: 'v1', type: 'damage', description: 'x', photos: [], reportedBy: 'att1', at: NOW, status: 'open', witnesses: [] }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/incidents/${EID}`), { status: 'resolved' }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/incidents/${EID}`), { status: 'resolved' }));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/validations/val1`), { id: 'val1', venueId: 'v1', code: 'ABCD', type: 'full', issuedBy: 'att1', issuedAt: NOW }));
    await assertSucceeds(setDoc(doc(ADMIN(), `operators/${OP}/validations/val1`), { id: 'val1', venueId: 'v1', code: 'ABCD', type: 'full', issuedBy: 'adm1', issuedAt: NOW }));
    await assertFails(updateDoc(doc(ATT_V2(), `operators/${OP}/validations/val1`), { redeemedTicketId: TID }));   // other venue cannot redeem
    // Ruling P (Plan 7 T1): the same-venue staff redemption that used to assertSucceeds here is
    // now DENIED — redemption is Functions-only (see 53-p-validation-redemption-lock.test.ts for
    // the dedicated suite). The client write bypassed the shared transactional guard and left a
    // half-redeemed state.
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/validations/val1`), { redeemedTicketId: TID }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/validations/val1`), { redeemedTicketId: '01912345-7abc-7def-8123-456789abcd02' }));
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ jobType: 'drive_home', status: 'in_transit', attendants: { primaryDriverUid: 'drv1', chaseDriverUid: 'drv2' } })));
    await assertSucceeds(setDoc(doc(DRIVER(), `operators/${OP}/liveLocations/drv1`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/liveLocations/att1`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));   // not on the job
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/liveLocations/lead1`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
  });
  it('incidents: reporter photos-only append-only carve-out (Ruling U) — the outbox uploader appends its own incident photos even though it is not a manager', async () => {
    await seedTenant();
    const I = `operators/${OP}/incidents/${EID}`;
    const OTHER_ID = '01912345-7abc-7def-8123-456789abcd20';
    const O = `operators/${OP}/incidents/${OTHER_ID}`;
    const incident = { id: EID, operatorId: OP, venueId: V1, type: 'damage', description: 'x', photos: [], reportedBy: 'att1', at: NOW, status: 'open', witnesses: [] };
    await seed(async (db) => {
      await setDoc(doc(db, I), incident);
      await setDoc(doc(db, O), { ...incident, id: OTHER_ID, reportedBy: 'att2' }); // reported by someone else
    });
    // reporter appends a photo to their own incident: allow (size 0 -> 1)
    await assertSucceeds(updateDoc(doc(ATT(), I), { photos: [`operators/${OP}/incidents/${EID}/p1.jpg`] }));
    // reporter smuggling a non-photos field alongside a legitimate-looking append: deny (onlyChanged(['photos']) fails)
    await assertFails(updateDoc(doc(ATT(), I), { photos: [`operators/${OP}/incidents/${EID}/p1.jpg`, `operators/${OP}/incidents/${EID}/p2.jpg`], status: 'reviewing' }));
    // reporter replaces with a same-size array (not a strict grow): deny
    await assertFails(updateDoc(doc(ATT(), I), { photos: [`operators/${OP}/incidents/${EID}/p2.jpg`] }));
    // reporter shrinks the array: deny
    await assertFails(updateDoc(doc(ATT(), I), { photos: [] }));
    // reporter of a DIFFERENT incident cannot append here — not resource.data.reportedBy
    await assertFails(updateDoc(doc(ATT_V2(), I), { photos: [`operators/${OP}/incidents/${EID}/p3.jpg`, `operators/${OP}/incidents/${EID}/p4.jpg`] }));
    // att1 IS a reporter (of I above) but not of OTHER_ID (reported by att2) — a valid append there is still denied
    await assertFails(updateDoc(doc(ATT(), O), { photos: [`operators/${OP}/incidents/${OTHER_ID}/p1.jpg`] }));
    // manager full update still works untouched by the new carve-out
    await assertSucceeds(updateDoc(doc(ADMIN(), I), { status: 'resolved' }));
  });
});
