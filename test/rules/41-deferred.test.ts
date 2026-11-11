import { describe, it } from 'vitest';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import {
  ADMIN, ATT, EID, LEAD, NOW, OP, PLATFORM, TID, V1,
  assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant,
} from './helpers';
import { env } from './setup';

// Controller-deferred additions from Task 7's briefing (binding rulings from earlier task reviews),
// implemented alongside the brief's own Step 1-4 addenda in 40-addenda.test.ts.

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const st = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, { claimsVersion: 1, ...claims }).storage();
async function seedStorage(path: string, contentType: string, bytes: Uint8Array = jpeg) {
  await env.withSecurityRulesDisabled(async (c) => { await uploadBytes(ref(c.storage(), path), bytes, { contentType }); });
}

// ---------- 2. 22-functions-only gaps: claims client write, archive read/write ----------

describe('claims: create/update split, evidenceBundle Functions-only (22-functions-only gap)', () => {
  it('admin creates a claim without evidenceBundle; attendant cannot create/update; evidenceBundle/ticketId/operatorId locked on update; managers read, attendant denied', async () => {
    await seedTenant();
    const C = `operators/${OP}/claims/c1`;
    await assertFails(setDoc(doc(ATT(), C), { id: 'c1', operatorId: OP, ticketId: TID, status: 'open', createdAt: NOW }));
    await assertSucceeds(setDoc(doc(ADMIN(), C), { id: 'c1', operatorId: OP, ticketId: TID, status: 'open', createdAt: NOW }));
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/claims/c2`), { id: 'c2', operatorId: OP, ticketId: TID, status: 'open', createdAt: NOW, evidenceBundle: { items: [] } })); // Functions-only on create
    await assertSucceeds(getDoc(doc(LEAD(), C)));
    await assertFails(getDoc(doc(ATT(), C)));
    await assertSucceeds(updateDoc(doc(ADMIN(), C), { status: 'reviewing' }));
    await assertFails(updateDoc(doc(ADMIN(), C), { evidenceBundle: { items: [] } })); // Functions-only on update too
    await assertFails(updateDoc(doc(ADMIN(), C), { ticketId: EID }));
    await assertFails(updateDoc(doc(ADMIN(), C), { operatorId: 'valetb' }));
    await assertFails(updateDoc(doc(ATT(), C), { status: 'reviewing' }));
    await assertFails(deleteDoc(doc(ADMIN(), C)));
    await assertSucceeds(updateDoc(doc(PLATFORM(), C), { status: 'closed' }));
  });
});

describe('archive: deny-all for clients at any depth (Ruling R)', () => {
  it('ADMIN and ATT are denied read and write at a shallow archive doc and at a nested one', async () => {
    await seedTenant();
    // Ruling R replaces the old archive/{collection}/{docId} (+ /{sub}/{subId}) matches — which had
    // a structural bug making them unreachable at odd segment counts (see Task 7's original report)
    // — with a single archive/{rest=**} deny-all. That recursive wildcard covers any depth, so both a
    // 4-segment doc (operators/{op}/archive/tickets) and a 6-segment one (.../tickets/items/x1) are
    // both denied identically, regardless of what shape the future archival Function actually writes.
    await assertFails(getDoc(doc(ADMIN(), `operators/${OP}/archive/tickets`)));
    await assertFails(getDoc(doc(ATT(), `operators/${OP}/archive/tickets`)));
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/archive/tickets`), { archived: true }));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/archive/tickets`), { archived: true }));
    await assertFails(getDoc(doc(ADMIN(), `operators/${OP}/archive/tickets/items/x1`)));
    await assertFails(getDoc(doc(ATT(), `operators/${OP}/archive/tickets/items/x1`)));
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/archive/tickets/items/x1`), { id: 'x1' }));
    await assertFails(setDoc(doc(ATT(), `operators/${OP}/archive/tickets/items/x1`), { id: 'x1' }));
  });
});

// ---------- 3. Dedicated ≥20-venueIds fallback tests, both services ----------

describe('≥20-venueIds claim fallback to the user doc (Ruling O / inVenue parity)', () => {
  it('firestore: shifts get at V1 succeeds via the fallback when the user doc lists v1; denied when it does not', async () => {
    await seedTenant();
    const many = Array.from({ length: 21 }, (_, i) => `vx${i}`); // 21 venue ids, none is 'v1'
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/shifts/s21`), { id: 's21', operatorId: OP, venueId: V1, date: '2026-08-23', startsAt: NOW, endsAt: NOW, status: 'planned', assignments: [], assignedUids: [], source: { provider: 'internal' }, notes: '' });
      await setDoc(doc(db, `operators/${OP}/users/multi21`), { uid: 'multi21', operatorId: OP, roles: ['attendant'], venueIds: [...many, V1], status: 'active' });
      await setDoc(doc(db, `operators/${OP}/users/multi21b`), { uid: 'multi21b', operatorId: OP, roles: ['attendant'], venueIds: many, status: 'active' });
    });
    const multi21 = ctx('multi21', { operatorId: OP, roles: ['attendant'], venueIds: many });
    const multi21b = ctx('multi21b', { operatorId: OP, roles: ['attendant'], venueIds: many });
    await assertSucceeds(getDoc(doc(multi21, `operators/${OP}/shifts/s21`)));   // token capped at 21 ids, falls back to user doc which includes v1
    await assertFails(getDoc(doc(multi21b, `operators/${OP}/shifts/s21`)));    // fallback user doc does NOT include v1
  });

  it('storage: ticket-photo read succeeds via inVenueOfTicket\'s ≥20-venueIds fallback; denied when the user doc lacks v1', async () => {
    await seedTenant();
    const many = Array.from({ length: 21 }, (_, i) => `vx${i}`);
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket()); // ticket is at V1
      await setDoc(doc(db, `operators/${OP}/users/multi21`), { uid: 'multi21', operatorId: OP, roles: ['attendant'], venueIds: [...many, V1], status: 'active' });
      await setDoc(doc(db, `operators/${OP}/users/multi21b`), { uid: 'multi21b', operatorId: OP, roles: ['attendant'], venueIds: many, status: 'active' });
    });
    const path = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
    await seedStorage(path, 'image/jpeg');
    await assertSucceeds(getBytes(ref(st('multi21', { operatorId: OP, roles: ['attendant'], venueIds: many }), path)));
    await assertFails(getBytes(ref(st('multi21b', { operatorId: OP, roles: ['attendant'], venueIds: many }), path)));
  });
});

// ---------- 4. assumedUntil expiry tests, both services ----------

describe('assumedUntil expiry gates inOperator()/notExpiredAssumption() identically in both services', () => {
  it('firestore: operator get denied with a past assumedUntil, allowed with a future one', async () => {
    await seedTenant();
    const past = Date.now() - 60_000;
    const future = Date.now() + 3_600_000;
    const expired = env.authenticatedContext('adm1', { claimsVersion: 1, operatorId: OP, roles: ['admin'], assumedUntil: past }).firestore();
    const assumed = env.authenticatedContext('adm1', { claimsVersion: 1, operatorId: OP, roles: ['admin'], assumedUntil: future }).firestore();
    await assertFails(getDoc(doc(expired, `operators/${OP}`)));
    await assertSucceeds(getDoc(doc(assumed, `operators/${OP}`)));
  });

  it('storage: exports read denied with a past assumedUntil, allowed with a future one', async () => {
    // F2/Ruling F-4a: exports read now also gates on operatorActive(op), which cross-service-reads
    // the operator doc — must exist (matching the same "operators/{op} is never deletable" invariant
    // firestore.rules relies on) or the read errors closed with a null-value evaluation error.
    await seedTenant();
    const path = `operators/${OP}/exports/payroll.csv`;
    await seedStorage(path, 'text/csv', new Uint8Array([1, 2, 3]));
    const past = Date.now() - 60_000;
    const future = Date.now() + 3_600_000;
    await assertFails(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'], assumedUntil: past }), path)));
    await assertSucceeds(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'], assumedUntil: future }), path)));
  });
});
