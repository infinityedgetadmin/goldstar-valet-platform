import { describe, it } from 'vitest';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { OP, TID, V1, assertFails, assertSucceeds, baseTicket, seed, seedTenant } from './helpers';
import { env } from './setup';

// final-review.md F2 / Ruling F-4a: firestore.rules' Ruling C suspended-operator gate had no Storage
// mirror — a suspended operator's staff kept full Storage access (ticket photos, credentials,
// branding writes) even though the suspend dialog claims they "immediately lose ... data access".
// storage.rules now gates operatorActive(op) on every branch that has read-budget headroom (Storage
// caps firestore.get()/exists() at 2 unique documents per rule evaluation), and deliberately leaves
// inVenueOfTicket()'s/inVenueOfIncident()'s >=20-venueIds fallback branch ungated (documented in
// storage.rules itself) since it already spends the full 2-document budget (ticket + user) reaching
// that branch — a third (operator) read there would hard-deny active and suspended operators alike.

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const st = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, { claimsVersion: 1, ...claims }).storage();
async function seedStorage(path: string, contentType: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), jpeg, { contentType });
  });
}
async function suspendOperator() {
  await seed(async (db) => updateDoc(doc(db, `operators/${OP}`), { status: 'suspended' }));
}

describe('F2 / Ruling F-4a: suspended operator gates Storage on the branches with read-budget headroom', () => {
  it('ticket photos MAIN path (direct venueIds match): suspended denies staff read + write; active-operator control case still allows it', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket()));
    const path = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
    await seedStorage(path, 'image/jpeg');
    // active control: att1 (venueIds [V1], direct match, not the fallback) can read while active.
    await assertSucceeds(getBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path)));

    await suspendOperator();
    await assertFails(getBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path)));
    const path2 = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde7.jpg`;
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path2), jpeg, { contentType: 'image/jpeg' }));
    // manager bypass branch is gated too — lead1 also denied once suspended.
    await assertFails(getBytes(ref(st('lead1', { operatorId: OP, roles: ['lead'] }), path)));
  });

  it("ticket photos >=20-venueIds FALLBACK path (Plan 8 Task 10, #8): a token minted BEFORE the suspend still reads until it refreshes; a refreshed token carrying operatorSuspended is denied at zero read cost", async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket())); // ticket is at V1
    const many = Array.from({ length: 21 }, (_, i) => `vx${i}`); // 21 venue ids, none is 'v1'
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/users/multi21`), { uid: 'multi21', operatorId: OP, roles: ['attendant'], venueIds: [...many, V1], status: 'active' }));
    const path = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
    await seedStorage(path, 'image/jpeg');
    await suspendOperator();

    // The remaining, honestly-stated window: a token minted before the suspend carries no bit, and
    // this branch cannot afford a 3rd document read, so it reads until the client's next refresh.
    await assertSucceeds(getBytes(ref(st('multi21', { operatorId: OP, roles: ['attendant'], venueIds: many }), path)));
    // After the refresh (claimsVersion bump → proactive), the bit arrives and the branch denies.
    await assertFails(getBytes(ref(st('multi21', { operatorId: OP, roles: ['attendant'], venueIds: many, operatorSuspended: true }), path)));
    // Control on the same statement: the bit alone does not deny an ACTIVE operator's fallback read
    // (a stale bit after reactivation resolves at the next refresh, which setStatus also triggers).
    await seed(async (db) => updateDoc(doc(db, `operators/${OP}`), { status: 'active' }));
    await assertSucceeds(getBytes(ref(st('multi21', { operatorId: OP, roles: ['attendant'], venueIds: many }), path)));
  });

  it('credentials upload: suspended denies both self-upload and admin-on-behalf; active control case still allows self-upload', async () => {
    await seedTenant();
    const path = `operators/${OP}/users/att1/credentials/license.pdf`;
    // active control.
    await assertSucceeds(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), path), jpeg, { contentType: 'application/pdf' }));

    await suspendOperator();
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/credentials/insurance.pdf`), jpeg, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/users/att1/credentials/background.pdf`), jpeg, { contentType: 'application/pdf' }));
    // read is gated too.
    await assertFails(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), path)));
  });

  it('branding write: suspended denies admin/owner write; public read is UNAFFECTED (deliberately not gated); active control case still allows the write', async () => {
    await seedTenant();
    const path = `operators/${OP}/branding/logo-light.png`;
    // active control.
    await assertSucceeds(uploadBytes(ref(st('own1', { operatorId: OP, roles: ['owner'] }), path), jpeg, { contentType: 'image/png' }));

    await suspendOperator();
    await assertFails(uploadBytes(ref(st('own1', { operatorId: OP, roles: ['owner'] }), `operators/${OP}/branding/logo-dark.png`), jpeg, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/branding/favicon.png`), jpeg, { contentType: 'image/png' }));
    // read stays public even while suspended — branding is a public asset, not staff data.
    await assertSucceeds(getBytes(ref(env.unauthenticatedContext().storage(), path)));
  });

  it('avatar and exports also gate on suspension (broader read-budget-headroom sweep)', async () => {
    await seedTenant();
    await seedStorage(`operators/${OP}/exports/payroll.csv`, 'text/csv');
    await suspendOperator();
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/avatar.jpg`), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(getBytes(ref(st('lead1', { operatorId: OP, roles: ['lead'] }), `operators/${OP}/users/att1/avatar.jpg`)));
    await assertFails(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/exports/payroll.csv`)));
  });

  it('platform_admin is unaffected by any of the new Storage gates on a suspended operator', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket()));
    const ticketPhoto = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
    await seedStorage(ticketPhoto, 'image/jpeg');
    await seedStorage(`operators/${OP}/users/att1/credentials/license.pdf`, 'application/pdf');
    await seedStorage(`operators/${OP}/branding/logo-light.png`, 'image/png');
    await suspendOperator();

    const pa = () => st('pa1', { roles: ['platform_admin'] });
    await assertSucceeds(getBytes(ref(pa(), ticketPhoto)));
    await assertSucceeds(getBytes(ref(pa(), `operators/${OP}/users/att1/credentials/license.pdf`)));
    await assertSucceeds(getBytes(ref(pa(), `operators/${OP}/branding/logo-light.png`)));
    await assertSucceeds(uploadBytes(ref(pa(), `operators/${OP}/branding/logo-dark.png`), jpeg, { contentType: 'image/png' }));
  });
});
