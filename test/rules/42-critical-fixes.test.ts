import { describe, it } from 'vitest';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, OP, OWNER, PLATFORM, TID, V1, anon, assertFails, assertSucceeds, seed, seedTenant } from './helpers';

// Final whole-branch review (2026-08-23-01b): the 2 Critical findings, fixed first per the review's
// recommended fix order — the token-enumeration hole (finding 1) and the owner-writable platform
// revenue share (finding 2).

describe('guestTickets: get-only, list denied (Ruling T)', () => {
  it('anyone with the exact token can get; nobody — anon, guest, staff, platform admin — can list the collection', async () => {
    await seed(async (db) => setDoc(doc(db, 'guestTickets/tok-abc123'), { operatorId: OP, ticketId: TID, venueName: 'St. Elmo', jobType: 'valet', status: 'checked_in' }));
    await assertSucceeds(getDoc(doc(anon(), 'guestTickets/tok-abc123')));
    await assertFails(getDocs(collection(anon(), 'guestTickets')));
    await assertFails(getDocs(collection(PLATFORM(), 'guestTickets')));
    await assertFails(setDoc(doc(PLATFORM(), 'guestTickets/tok-abc123'), { operatorId: OP }));
  });
});

describe('venuePublic: get-only, list denied (Ruling T)', () => {
  it('a known token gets; the collection cannot be listed by anyone', async () => {
    await seed(async (db) => setDoc(doc(db, 'venuePublic/tok999'), { operatorId: OP, venueId: V1, displayName: 'St. Elmo' }));
    await assertSucceeds(getDoc(doc(anon(), 'venuePublic/tok999')));
    await assertFails(getDocs(collection(anon(), 'venuePublic')));
    await assertFails(getDocs(collection(PLATFORM(), 'venuePublic')));
  });
});

describe('operators: platformFeeBps/provider/chargeModel are owner-locked (Ruling U)', () => {
  it('owner cannot rewrite the platform revenue-share fields; platform admin can; other modules fields stay owner-writable', async () => {
    await seedTenant();
    await seed(async (db) => updateDoc(doc(db, `operators/${OP}`), {
      modules: { payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 250, connectedAccountId: 'acct_1', tipPresets: [18, 20, 25], tipPolicy: 'deliverer' } },
    }));
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}`), { 'modules.payments.platformFeeBps': 0 }));
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}`), { 'modules.payments.provider': 'other' }));
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}`), { 'modules.payments.chargeModel': 'direct' }));
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}`), { 'modules.payments.connectedAccountId': 'acct_stolen' }));
    await assertSucceeds(updateDoc(doc(PLATFORM(), `operators/${OP}`), { 'modules.payments.platformFeeBps': 300 }));
    // owner may still edit their own legitimately-theirs fields in the same map
    await assertSucceeds(updateDoc(doc(OWNER(), `operators/${OP}`), { 'modules.payments.tipPresets': [15, 18, 20], 'modules.payments.tipPolicy': 'shift_pool' }));
  });
});
