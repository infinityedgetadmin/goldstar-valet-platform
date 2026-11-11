import { describe, it } from 'vitest';
import { doc, updateDoc } from 'firebase/firestore';
import { ADMIN, OP, V1, assertFails, assertSucceeds, seed, seedTenant } from './helpers';

// Fix round 1, M2 (task-5-review.md): the venue update rule previously only pinned
// operatorId/stripeLocationId — nothing stopped a client from writing qr.staticCheckoutToken
// directly, which onVenueWritten (Admin SDK) then trusts verbatim to (re)project venuePublic/{token}.
describe('venues: qr.staticCheckoutToken is client-immutable, qr.staticCheckoutEnabled stays writable (Fix round 1, M2)', () => {
  it('an operator admin cannot set/overwrite qr.staticCheckoutToken directly', async () => {
    await seedTenant();
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { qr: { staticCheckoutEnabled: false, staticCheckoutToken: 'AttackerChosenToken12' } }));
  });

  it('an operator admin cannot rewrite an EXISTING staticCheckoutToken to a different value (the venue-B-steals-venue-A\'s-signage scenario) — token seeded the way onVenueWritten (Admin SDK) actually sets it, not through a rules-governed write', async () => {
    await seedTenant();
    await seed(async (db) => updateDoc(doc(db, `operators/${OP}/venues/${V1}`), { qr: { staticCheckoutEnabled: true, staticCheckoutToken: 'OriginalServerMintedTok' } }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { qr: { staticCheckoutEnabled: true, staticCheckoutToken: 'HijackedToken123456789' } }));
  });

  it("StaticQrPanel's legitimate toggle (qr.staticCheckoutEnabled only) still succeeds", async () => {
    await seedTenant();
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { 'qr.staticCheckoutEnabled': true }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { 'qr.staticCheckoutEnabled': false }));
  });

  it('an ordinary venue edit (name) untouched by qr is unaffected by the new pin', async () => {
    await seedTenant();
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { name: 'St. Elmo Steak House' }));
  });
});
