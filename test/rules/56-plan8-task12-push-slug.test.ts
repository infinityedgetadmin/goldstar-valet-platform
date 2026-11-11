import { describe, it } from 'vitest';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, OP, V1, assertFails, assertSucceeds, seed, seedTenant } from './helpers';

// Plan 8 Task 12 (carry #15): `venues/{venueId}.pushSlug` is minted by the venue trigger and is
// client-immutable, exactly like qr.staticCheckoutToken. A client-chosen slug is a guessable slug.
describe('venues.pushSlug is server-only', () => {
  const V = `operators/${OP}/venues/${V1}`;
  it('an operator admin cannot set pushSlug on create, cannot change or clear it on update, and can still edit the venue', async () => {
    await seedTenant();
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/venues/vnew`), { id: 'vnew', operatorId: OP, name: 'New', type: 'hotel', status: 'active', pushSlug: 'chosen' }));
    await seed(async (db) => updateDoc(doc(db, V), { pushSlug: 'AbCdEfGhIjKlMnOpQrStUv' }));
    await assertFails(updateDoc(doc(ADMIN(), V), { pushSlug: 'other' }));
    await assertFails(updateDoc(doc(ADMIN(), V), { pushSlug: null }));
    await assertSucceeds(updateDoc(doc(ADMIN(), V), { name: 'St. Elmo Steak House' }));
  });
});
