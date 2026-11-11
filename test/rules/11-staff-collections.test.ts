import { describe, it } from 'vitest';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, deleteDoc, writeBatch, deleteField } from 'firebase/firestore';
import { ADMIN, ATT, ATT_V2, EID, GUEST, LEAD, NOW, OP, OWNER, OTHER_OP, PLATFORM, TID, V1, V2, VENUE_USER, anon, assertFails, assertSucceeds, baseTicket, seed, seedTenant } from './helpers';
describe('users', () => {
  it('self-read; admin reads all; roles/eligibility only by admin+; self may edit displayName/fcmTokens/credentials', async () => {
    await seedTenant();
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/users/att1`)));
    await assertFails(getDoc(doc(ATT(), `operators/${OP}/users/lead1`)));
    await assertSucceeds(getDoc(doc(LEAD(), `operators/${OP}/users/att1`)));
    await assertSucceeds(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { displayName: 'Ana R', fcmTokens: ['t1'] }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { roles: ['owner'] }));
    await assertSucceeds(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { 'credentials.documents': [{ kind: 'license', storagePath: `operators/${OP}/users/att1/credentials/license.pdf`, uploadedAt: NOW }] }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { 'credentials.backgroundCheck': { status: 'approved', at: NOW } }));   // self-approval
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { 'credentials.licenseExpiresAt': '2099-01-01T00:00:00.000Z' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/users/att1`), { roles: ['owner'] }));        // admin cannot promote to owner
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}/users/att1`), { roles: ['platform_admin'] })); // nobody grants platform_admin
    await assertSucceeds(updateDoc(doc(OWNER(), `operators/${OP}/users/att1`), { roles: ['owner'] }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/users/att1`), { eligibility: { driveHome: true, passengerRide: true, reasons: [] } }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/users/att1`), { roles: ['attendant', 'driver'], venueIds: [V1, 'v2'] }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/users/att1`), { eligibility: { driveHome: true, passengerRide: true, reasons: [] } })); // Functions-only
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/users/att1`), { stripeConnectAccountId: 'acct_x' })); // Functions-only
    await assertFails(deleteDoc(doc(OWNER(), `operators/${OP}/users/att1`)));
  });
});
describe('shifts and clock events', () => {
  it('staff read shifts at their venues; admin/lead write; clock events create-only by self', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/shifts/s1`), { id: 's1', operatorId: OP, venueId: V1, date: '2026-08-23', startsAt: NOW, endsAt: NOW, status: 'planned', assignments: [{ uid: 'att1', role: 'attendant', startsAt: NOW, endsAt: NOW, confirmed: false }], source: { provider: 'internal' }, notes: '' }));
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/shifts/s1`)));
    await assertFails(getDoc(doc(ATT_V2(), `operators/${OP}/shifts/s1`)));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/shifts/s1`), { notes: 'x' }));
    await assertSucceeds(updateDoc(doc(LEAD(), `operators/${OP}/shifts/s1`), { status: 'open' }));
    await assertFails(updateDoc(doc(LEAD(), `operators/${OP}/shifts/s1`), { source: { provider: 'ical' } })); // provider-owned
    const ev = { id: EID, uid: 'att1', type: 'in', at: NOW, deviceId: 'd1' };
    await assertSucceeds(setDoc(doc(ATT(), `operators/${OP}/shifts/s1/clockEvents/${EID}`), ev));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/shifts/s1/clockEvents/${EID}`), { ...ev, type: 'out' })); // no overwrite
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/shifts/s1/clockEvents/01912345-7abc-7def-8123-456789abcde1`), { ...ev, uid: 'lead1' })); // not self
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/shifts/s1/clockEvents/not-a-uuid`), ev));
    await assertFails(deleteDoc(doc(ADMIN(), `operators/${OP}/shifts/s1/clockEvents/${EID}`)));
  });
});
describe('keyTags', () => {
  it('venue staff read; assignment only in a batch with the referencing ticket and a keys_stored custody event; admin creates', async () => {
    await seedTenant();
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/keyTags`), where('venueId', '==', V1))));
    await assertFails(getDocs(collection(ATT(), `operators/${OP}/keyTags`)));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/keyTags/k1`), { status: 'assigned', currentTicketId: TID }));   // no ticket/custody in batch
    const attDb = ATT(); const b = writeBatch(attDb); const evId = '01912345-7abc-7def-8123-456789abcde9';
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}`), baseTicket({ keyTagId: 'k1', lastCustodyEventId: evId }));
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}/custodyEvents/${evId}`), { id: evId, actorUid: 'att1', action: 'keys_stored', at: NOW, deviceId: 'd1' });
    b.update(doc(attDb, `operators/${OP}/keyTags/k1`), { status: 'assigned', currentTicketId: TID, lastCustodyEventId: evId });
    await assertSucceeds(b.commit());
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/keyTags/k1`), { value: 'changed' }));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/keyTags/k1`), { status: 'available', currentTicketId: deleteField() }));   // release needs terminal ticket + keys_returned
    await assertSucceeds(setDoc(doc(ADMIN(), `operators/${OP}/keyTags/k2`), { id: 'k2', operatorId: OP, value: 'GS-V1-0002', venueId: V1, status: 'available' }));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/keyTags/k3`), { id: 'k3', operatorId: OP, value: 'GS-V1-0003', venueId: V1, status: 'available' }));
  });
});
describe('top-level: platform, guests, invitations, marketing', () => {
  it('platform/config readable by signed-in, writable by platform admin', async () => {
    await seed(async (db) => setDoc(doc(db, 'platform/config'), { tipPresets: [18, 20, 25] }));
    await assertSucceeds(getDoc(doc(ATT(), 'platform/config')));
    await assertFails(getDoc(doc(anon(), 'platform/config')));
    await assertFails(updateDoc(doc(OWNER(), 'platform/config'), { x: 1 }));
    await assertSucceeds(updateDoc(doc(PLATFORM(), 'platform/config'), { x: 1 }));
  });
  it('guests read/write only their own doc (uid match) and never stripeCustomerId', async () => {
    await seed(async (db) => setDoc(doc(db, 'guests/g1'), { phoneE164: '+13175550123', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } }));
    await assertSucceeds(getDoc(doc(GUEST(), 'guests/g1')));
    await assertFails(getDoc(doc(GUEST(), 'guests/g2')));
    await assertSucceeds(updateDoc(doc(GUEST(), 'guests/g1'), { name: 'Sam', savedVehicles: [{ plate: 'ABC123' }] }));
    await assertFails(updateDoc(doc(GUEST(), 'guests/g1'), { stripeCustomerId: 'cus_x' }));
    await assertFails(updateDoc(doc(GUEST(), 'guests/g1'), { phoneE164: '+10000000000' }));
  });
  // M1 (Plan 6 final wave): `deletedAt`/`deletedPhoneHash` are Functions-only markers. They were
  // client-writable on BOTH create and update, so a guest could pre-set `deletedAt` and
  // `guestDeleteAccount` — which short-circuits on `g.deletedAt !== undefined`
  // (functions/src/modules/guest/deleteAccount.ts) — would skip anonymization entirely: Auth user
  // deleted, PII intact, and an audit row claiming the deletion completed. Both directions are
  // asserted because they are separate guards in the rule and a fix to one does not imply the other.
  it('M1: guests cannot set deletedAt/deletedPhoneHash on create or update (pre-setting them would make guestDeleteAccount skip anonymization)', async () => {
    // CREATE — the guard is `!('deletedAt' in request.resource.data)`, so a create carrying either
    // field must be rejected outright; the phone must match the claim for the create to get as
    // far as the new guards.
    const fresh = { phoneE164: '+13175550123', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } };
    await assertFails(setDoc(doc(GUEST(), 'guests/g1'), { ...fresh, deletedAt: NOW }));
    await assertFails(setDoc(doc(GUEST(), 'guests/g1'), { ...fresh, deletedPhoneHash: 'deadbeef' }));
    // ...and the same create WITHOUT those fields still succeeds, so the test proves the new guards
    // are what reject it rather than something unrelated about the fixture.
    await assertSucceeds(setDoc(doc(GUEST(), 'guests/g1'), fresh));

    // UPDATE — the guard is `unchanged([... 'deletedAt', 'deletedPhoneHash'])`.
    await assertFails(updateDoc(doc(GUEST(), 'guests/g1'), { deletedAt: NOW }));
    await assertFails(updateDoc(doc(GUEST(), 'guests/g1'), { deletedPhoneHash: 'deadbeef' }));
  });
  it('invitations are Functions-only; marketing collections allow anonymous create only', async () => {
    await assertFails(setDoc(doc(PLATFORM(), 'invitations/i1'), { email: 'x@y.z' }));
    await assertSucceeds(setDoc(doc(anon(), 'contactMessages/m1'), { name: 'A', email: 'a@b.c', message: 'hi', timestamp: NOW }));
    await assertFails(getDoc(doc(anon(), 'contactMessages/m1')));
    await assertSucceeds(setDoc(doc(anon(), 'newsletterSubscriptions/n1'), { email: 'a@b.c', timestamp: NOW }));
    await assertFails(updateDoc(doc(anon(), 'newsletterSubscriptions/n1'), { email: 'z@b.c' }));
  });
});

// ---------- Fix round 1: rulings G, H, I ----------
describe('keyTags: admin edits (Ruling G)', () => {
  it('admin may re-venue/re-value/retire but never sets assigned or touches custody fields', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/keyTags/k9`), { id: 'k9', operatorId: OP, value: 'GS-V1-0009', venueId: V1, status: 'available' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/keyTags/k9`), { status: 'assigned', currentTicketId: 'x' }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/keyTags/k9`), { venueId: V2, updatedAt: NOW }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/keyTags/k9`), { status: 'retired' }));
    // Ruling J scopes the staff lost/retired branch to onlyChanged(['status']), so this can no longer
    // slip through that branch now that the tag is already retired (it used to, before Ruling J).
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/keyTags/k9`), { lastCustodyEventId: 'fabricated' }));
  });
});
describe('keyTags: manager lost/retired is status-only (Ruling J)', () => {
  it('a manager may mark a tag lost/retired but never rewrite custody fields outside the coupled batch path', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/keyTags/k10`), { id: 'k10', operatorId: OP, value: 'GS-V1-0010', venueId: V1, status: 'available' }));
    await assertSucceeds(updateDoc(doc(LEAD(), `operators/${OP}/keyTags/k10`), { status: 'lost' }));
    await assertFails(updateDoc(doc(LEAD(), `operators/${OP}/keyTags/k10`), { lastCustodyEventId: 'fabricated2' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/keyTags/k10`), { lastCustodyEventId: 'fabricated2' }));
  });
});
describe('shifts: venue-scoped get (Ruling H)', () => {
  it('venue_user reads shifts at their own venue only, via inVenue — no bare role bypass', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/shifts/s1`), { id: 's1', operatorId: OP, venueId: V1, date: '2026-08-23', startsAt: NOW, endsAt: NOW, status: 'planned', assignments: [], assignedUids: ['att1'], source: { provider: 'internal' }, notes: '' });
      await setDoc(doc(db, `operators/${OP}/shifts/s2`), { id: 's2', operatorId: OP, venueId: V2, date: '2026-08-23', startsAt: NOW, endsAt: NOW, status: 'planned', assignments: [], assignedUids: ['att2'], source: { provider: 'internal' }, notes: '' });
    });
    await assertSucceeds(getDoc(doc(VENUE_USER(), `operators/${OP}/shifts/s1`)));
    await assertFails(getDoc(doc(VENUE_USER(), `operators/${OP}/shifts/s2`)));
  });
});
describe('shifts: constrained list for non-managers (Ruling I)', () => {
  it('non-managers must query by own venue or own assignment; unconstrained list requires a manager', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/shifts/s1`), { id: 's1', operatorId: OP, venueId: V1, date: '2026-08-23', startsAt: NOW, endsAt: NOW, status: 'planned', assignments: [], assignedUids: ['att1'], source: { provider: 'internal' }, notes: '' }));
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/shifts`), where('venueId', '==', V1))));
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/shifts`), where('assignedUids', 'array-contains', 'att1'))));
    await assertFails(getDocs(collection(ATT(), `operators/${OP}/shifts`)));
    await assertSucceeds(getDocs(collection(LEAD(), `operators/${OP}/shifts`)));
  });
});
