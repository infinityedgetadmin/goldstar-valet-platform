import { describe, it } from 'vitest';
import { collection, collectionGroup, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import {
  ADMIN, ATT, GUEST, LEAD, NOW, OP, OWNER, PLATFORM, TID, V1, V2,
  anon, assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant,
} from './helpers';
import { env } from './setup';

// Storage rules have no Firestore-doc-shaped write path, so seeding an object for a read assertion
// must bypass Storage rules directly (mirrors 30-storage.test.ts's local seedStorage()).
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const st = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, { claimsVersion: 1, ...claims }).storage();
async function seedStorage(path: string, contentType: string, bytes: Uint8Array = jpeg) {
  await env.withSecurityRulesDisabled(async (c) => { await uploadBytes(ref(c.storage(), path), bytes, { contentType }); });
}

describe('venuePublic projection', () => {
  it('readable anonymously; unwritable by anyone, including the operator owner', async () => {
    await seed(async (db) => setDoc(doc(db, 'venuePublic/tok123'), { operatorId: OP, venueId: V1, displayName: 'St. Elmo' }));
    await assertSucceeds(getDoc(doc(anon(), 'venuePublic/tok123')));
    await assertFails(setDoc(doc(OWNER(), 'venuePublic/tok123'), { operatorId: OP, venueId: V1, displayName: 'Hacked' }));
    await assertFails(setDoc(doc(PLATFORM(), 'venuePublic/tok123'), { operatorId: OP, venueId: V1, displayName: 'Hacked' }));
  });
});

describe('telemetry', () => {
  it('self-write with exactly the allowed keys; other uid denied; extra key denied; never client-readable', async () => {
    await seedTenant();
    const good = { operatorId: OP, day: '2026-08-23', photosUploaded: 3, photosNeedsAttention: 0, writesPending: 0, appVersion: '1.0.0', platform: 'ios', updatedAt: NOW };
    await assertSucceeds(setDoc(doc(ATT(), 'telemetry/att1'), good));
    await assertSucceeds(updateDoc(doc(ATT(), 'telemetry/att1'), { photosUploaded: 4, updatedAt: NOW }));
    await assertFails(setDoc(doc(ATT(), 'telemetry/att2'), good)); // not self
    await assertFails(setDoc(doc(ATT(), 'telemetry/att1'), { ...good, extra: 'nope' })); // key outside the allow-list
    await assertFails(getDoc(doc(ATT(), 'telemetry/att1'))); // never readable, even by self
    await assertFails(getDoc(doc(PLATFORM(), 'telemetry/att1')));
  });
});

describe('guest ticket history across operators (collection-group list)', () => {
  it('succeeds with where(guest.uid==uid) or where(guest.phoneE164== the caller\'s own verified phone claim, Ruling X); unconstrained or wrong-phone queries are denied', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } })));
    await assertSucceeds(getDocs(query(collectionGroup(GUEST(), 'tickets'), where('guest.uid', '==', 'g1'))));
    await assertFails(getDocs(collectionGroup(GUEST(), 'tickets'))); // unconstrained — rules are not filters
    // Ruling X: guestByPhone is a registered query for web-created tickets that have no guest.uid yet —
    // the CG match now has a phone-claim branch, so this succeeds when the caller's own verified phone
    // claim matches the filter (previously denied outright; the old assertion is superseded by finding 5).
    await assertSucceeds(getDocs(query(collectionGroup(GUEST('+13175550123'), 'tickets'), where('guest.phoneE164', '==', '+13175550123'))));
    await assertFails(getDocs(query(collectionGroup(GUEST('+19999999999'), 'tickets'), where('guest.phoneE164', '==', '+13175550123')))); // wrong phone claim denied
  });
});

describe('resumes (goldstar-web careers upload)', () => {
  it('anonymous create of a small PDF succeeds; oversized/wrong-type denied; unreadable by anyone including an owner', async () => {
    await assertSucceeds(uploadBytes(ref(env.unauthenticatedContext().storage(), 'resumes/r1.pdf'), pdf, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), 'resumes/r2.exe'), pdf, { contentType: 'application/x-msdownload' }));
    await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), 'resumes/r3.pdf'), new Uint8Array(10 * 1024 * 1024 + 1), { contentType: 'application/pdf' })); // over the 10MB cap
    await seedStorage('resumes/r1.pdf', 'application/pdf', pdf);
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), 'resumes/r1.pdf')));
    await assertFails(getBytes(ref(st('own1', { operatorId: OP, roles: ['owner'] }), 'resumes/r1.pdf')));
  });
});

// Ticket-photo write by venue staff succeeding, and by an other-venue attendant (ATT_V2) failing, is
// already covered by the "ticket photos" case in 30-storage.test.ts (Task 5's inVenueOfTicket check,
// with the att2/V2-vs-V1 cross-venue assertion) — not duplicated here.

describe('metrics/forecast', () => {
  it('read by manager; denied to attendant; unwritable by clients', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/metrics/forecast/weeks/2026-W34`), { demandIndex: 1.2 }));
    await assertSucceeds(getDoc(doc(LEAD(), `operators/${OP}/metrics/forecast/weeks/2026-W34`)));
    await assertFails(getDoc(doc(ATT(), `operators/${OP}/metrics/forecast/weeks/2026-W34`)));
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/metrics/forecast/weeks/2026-W35`), { demandIndex: 1.0 }));
  });
});

describe('platform/auditLog/entries', () => {
  it('platform admin reads; tenant admin and staff denied; unwritable by anyone', async () => {
    await seed(async (db) => setDoc(doc(db, 'platform/auditLog/entries/e1'), { at: NOW, actorUid: 'pa1', action: 'x' }));
    await assertSucceeds(getDoc(doc(PLATFORM(), 'platform/auditLog/entries/e1')));
    await assertFails(getDoc(doc(ADMIN(), 'platform/auditLog/entries/e1')));
    await assertFails(getDoc(doc(anon(), 'platform/auditLog/entries/e1')));
    await assertFails(setDoc(doc(PLATFORM(), 'platform/auditLog/entries/e2'), { at: NOW }));
  });
});

describe('fleetVehicles: currentDriverUid is Functions-only (addendum)', () => {
  it('admin creates and edits other fields but cannot change currentDriverUid on update; platform admin bypasses', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(ADMIN(), `operators/${OP}/fleetVehicles/fv1`), { id: 'fv1', operatorId: OP, plate: 'ABC123', make: 'Ford', model: 'Transit', status: 'available' }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/fleetVehicles/fv1`), { status: 'in_service' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/fleetVehicles/fv1`), { currentDriverUid: 'drv1' }));
    await assertSucceeds(updateDoc(doc(PLATFORM(), `operators/${OP}/fleetVehicles/fv1`), { currentDriverUid: 'drv1' }));
  });
});

describe('transactions: manager unrestricted, lead venue-scoped (Ruling S)', () => {
  it('a lead scoped to V1 only reads/lists their own venue; unconstrained list and cross-venue read denied; admin unrestricted', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/transactions/tx1`), { id: 'tx1', operatorId: OP, venueId: V1, ticketId: TID, status: 'succeeded' });
      await setDoc(doc(db, `operators/${OP}/transactions/tx2`), { id: 'tx2', operatorId: OP, venueId: V2, ticketId: TID, status: 'succeeded' });
    });
    // LEAD() in helpers.ts carries venueIds [V1, V2] (multi-venue lead1) — this case needs a
    // lead scoped to ONLY V1 to distinguish "own venue" from "other venue", so build one directly.
    const leadV1 = ctx('leadv1', { operatorId: OP, roles: ['lead'], venueIds: [V1] });
    await assertSucceeds(getDoc(doc(leadV1, `operators/${OP}/transactions/tx1`)));
    await assertFails(getDoc(doc(leadV1, `operators/${OP}/transactions/tx2`)));
    await assertSucceeds(getDocs(query(collection(leadV1, `operators/${OP}/transactions`), where('venueId', '==', V1))));
    await assertFails(getDocs(collection(leadV1, `operators/${OP}/transactions`))); // unconstrained
    await assertSucceeds(getDocs(collection(ADMIN(), `operators/${OP}/transactions`))); // admin unrestricted, no venue filter needed
  });
});
