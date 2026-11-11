import { describe, it } from 'vitest';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { doc, setDoc } from 'firebase/firestore';
import { assertFails, assertSucceeds, seed, seedTenant, OP, OP2, TID, V1, V2, baseTicket } from './helpers';
import { env } from './setup';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const st = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, { claimsVersion: 1, ...claims }).storage();
// Storage rules have no Firestore-doc-shaped write path, so seeding an object for a read assertion
// must bypass Storage rules directly (the harness's seed() helper only bypasses Firestore rules).
async function seedStorage(path: string, contentType: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), jpeg, { contentType });
  });
}

describe('storage', () => {
  it('ticket photos: venue staff write jpeg <=10MB at canonical path; other operator denied; other venue denied; public denied', async () => {
    // Ruling A: the photo path only carries the ticket id, so the rule cross-service-looks-up the
    // ticket's venueId via firestore.get(). That means the ticket must exist in Firestore before any
    // read/write the rule evaluates, or the lookup errors out and the rule denies. Seed it directly,
    // bypassing security rules, rather than through the (still-untested) Firestore ticket-create flow.
    // F2/Ruling F-4a: the operator doc must also exist now — inVenueOfTicket()'s manager/direct-match
    // branches cross-service-read operatorActive(op) on a success path (matching the "operators/{op}
    // is never deletable" invariant firestore.rules already relies on).
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket());
    });
    const path = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
    await assertSucceeds(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path), jpeg, { contentType: 'image/jpeg' }));
    // Ruling AA: create-only — the same valid staff member cannot overwrite the object once it exists.
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), path), jpeg, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(st('att9', { operatorId: OP2, roles: ['attendant'] }), path), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/tickets/${TID}/photos/evil.exe`), jpeg, { contentType: 'image/jpeg' }));
    // Ruling A: att2 claims venueIds [V2] — the seeded ticket is venue V1, so the cross-service
    // venue check must deny this even though att2 is staff of the same operator.
    await assertFails(uploadBytes(ref(st('att2', { operatorId: OP, roles: ['attendant'], venueIds: [V2] }), path), jpeg, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(st('lead1', { operatorId: OP, roles: ['lead'] }), path)));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), path)));
  });

  it('incidents: venue-scoped like ticket photos (Ruling Q) — venue staff write+read; other-venue staff denied; managers bypass', async () => {
    await seedTenant(); // F2/Ruling F-4a: inVenueOfIncident()'s gated branches need the operator doc to exist.
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/incidents/i1`), { id: 'i1', operatorId: OP, venueId: V1, reportedBy: 'att1', at: '2026-08-23T21:00:00.000Z' });
    });
    const path = `operators/${OP}/incidents/i1/scene.jpg`;
    await assertSucceeds(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path), jpeg, { contentType: 'image/jpeg' }));
    // Ruling AA: create-only — a second upload to the same path is denied even for valid same-venue staff.
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path), jpeg, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] }), path)));
    await assertFails(uploadBytes(ref(st('att2', { operatorId: OP, roles: ['attendant'], venueIds: [V2] }), path), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(getBytes(ref(st('att2', { operatorId: OP, roles: ['attendant'], venueIds: [V2] }), path)));
    // manager bypass: lead1 has no venueIds claim at all yet still reads across venues.
    await assertSucceeds(getBytes(ref(st('lead1', { operatorId: OP, roles: ['lead'] }), path)));
  });

  it('exports: admin/owner read; attendant and other-operator denied; unwritable by anyone', async () => {
    await seedTenant(); // F2/Ruling F-4a: exports read now gates on operatorActive(op).
    const path = `operators/${OP}/exports/payroll.csv`;
    await seedStorage(path, 'text/csv');
    await assertSucceeds(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), path)));
    await assertFails(getBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), path)));
    await assertFails(getBytes(ref(st('adm9', { operatorId: OP2, roles: ['admin'] }), path)));
    // brief's rule is `allow write: if false` unconditionally — not even an admin can write.
    await assertFails(uploadBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), path), jpeg, { contentType: 'text/csv' }));
  });

  it('guests: self-path write succeeds and is readable back; another uid path denied for both (Ruling AA / finding 9b)', async () => {
    await assertSucceeds(uploadBytes(ref(st('g1', {}), 'guests/g1/id-photo.jpg'), jpeg, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(st('g1', {}), 'guests/g1/id-photo.jpg')));   // previously broken: isImage() reads request.resource, null on read
    await assertFails(uploadBytes(ref(st('g1', {}), 'guests/g2/id-photo.jpg'), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(getBytes(ref(st('g2', {}), 'guests/g1/id-photo.jpg')));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), 'guests/g1/id-photo.jpg')));
  });

  it('marketing: public read; unwritable by anyone', async () => {
    const path = 'marketing/hero.jpg';
    await seedStorage(path, 'image/jpeg');
    await assertSucceeds(getBytes(ref(env.unauthenticatedContext().storage(), path)));
    // brief's rule is `allow write: if false` unconditionally — not even an owner can write.
    await assertFails(uploadBytes(ref(st('own1', { operatorId: OP, roles: ['owner'] }), path), jpeg, { contentType: 'image/jpeg' }));
  });

  it('branding is public-read, owner/admin write; claims bundles admin-only and unwritable; avatars staff-read/self-write; credentials owner-or-admin-read/self-write', async () => {
    // F2/Ruling F-4a: branding write, claims read, avatar read/write, and credentials read/write all
    // now gate on operatorActive(op) — the operator doc must exist for any of this test's
    // assertSucceeds() calls to actually reach a true outcome.
    await seedTenant();
    await assertSucceeds(uploadBytes(ref(st('own1', { operatorId: OP, roles: ['owner'] }), `operators/${OP}/branding/logo-light.png`), jpeg, { contentType: 'image/png' }));
    await assertSucceeds(getBytes(ref(env.unauthenticatedContext().storage(), `operators/${OP}/branding/logo-light.png`)));
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/branding/logo-light.png`), jpeg, { contentType: 'image/png' }));

    // claims bundles are never client-writable (Functions-only); admin can read, attendant cannot.
    await assertFails(uploadBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/claims/c1/bundle.pdf`), jpeg, { contentType: 'application/pdf' }));
    await seedStorage(`operators/${OP}/claims/c1/bundle.pdf`, 'application/pdf');
    await assertSucceeds(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/claims/c1/bundle.pdf`)));
    await assertFails(getBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/claims/c1/bundle.pdf`)));

    // avatars: self-write only, but any staff member (not just self) can read.
    await assertSucceeds(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/avatar.jpg`), jpeg, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/lead1/avatar.jpg`), jpeg, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(st('lead1', { operatorId: OP, roles: ['lead'] }), `operators/${OP}/users/att1/avatar.jpg`)));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), `operators/${OP}/users/att1/avatar.jpg`)));

    // credentials: self-write, OR an admin/owner uploading on behalf of the staff member (Plan 4a
    // T6 — CredentialsPanel does this); a peer with no admin role may write neither their own nor
    // anyone else's; readable by the owner themself or by owner/admin roles, not by a peer attendant.
    await assertSucceeds(uploadBytes(ref(st('att1', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/credentials/license.pdf`), jpeg, { contentType: 'application/pdf' }));
    await assertSucceeds(getBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/users/att1/credentials/license.pdf`)));
    await assertFails(getBytes(ref(st('att2', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/credentials/license.pdf`)));

    // task-6-review.md Minor 1: admin-on-behalf was correct but unverified — the rule allows an
    // admin to upload to a DIFFERENT staff member's credentials path (what CredentialsPanel relies
    // on); a non-admin peer may not upload on anyone else's behalf; a same-operator peer may not
    // even overwrite their OWN credentials once someone else's admin already has (isDoc() has no
    // create-only constraint here, unlike ticket photos, so this is testing the ROLE gate, not
    // overwrite semantics); and an admin from a DIFFERENT operator is denied by inOperator(op).
    await assertSucceeds(uploadBytes(ref(st('adm1', { operatorId: OP, roles: ['admin'] }), `operators/${OP}/users/att1/credentials/insurance.pdf`), jpeg, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(st('att2', { operatorId: OP, roles: ['attendant'] }), `operators/${OP}/users/att1/credentials/background.pdf`), jpeg, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(st('adm9', { operatorId: OP2, roles: ['admin'] }), `operators/${OP}/users/att1/credentials/insurance.pdf`), jpeg, { contentType: 'application/pdf' }));
  });
});
