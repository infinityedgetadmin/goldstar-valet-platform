import { describe, it } from 'vitest';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { ADMIN, ATT, GUEST, OP, OP2, OTHER_OP, OWNER, PLATFORM, V1, anon, assertFails, assertSucceeds, seedTenant } from './helpers';
describe('operator document', () => {
  it('own operator readable by staff; other operator denied; platform admin reads all', async () => {
    await seedTenant();
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}`)));
    await assertFails(getDoc(doc(OTHER_OP(), `operators/${OP}`)));
    await assertSucceeds(getDoc(doc(PLATFORM(), `operators/${OP2}`)));
    await assertFails(getDoc(doc(anon(), `operators/${OP}`)));
    await assertFails(getDoc(doc(GUEST(), `operators/${OP}`)));   // guests use projections, never the operator doc
  });
  it('owner or platform admin writes operator freely (branding/modules, never id/slug); admin is branding-only (Ruling E-4a / final-review F4)', async () => {
    await seedTenant();
    // Ruling E-4a: an admin (not owner) is now permitted to update operators/{op}, but ONLY when the
    // changed keys are confined to branding(+updatedAt) — see 49-e4a-admin-branding.test.ts for the
    // dedicated coverage. Here: the boundary against a non-branding field (slug).
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}`), { 'branding.displayName': 'X' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}`), { slug: 'hacked' }));
    await assertSucceeds(updateDoc(doc(OWNER(), `operators/${OP}`), { 'branding.displayName': 'X', updatedAt: '2026-08-23T22:00:00.000Z' }));
    await assertFails(updateDoc(doc(OWNER(), `operators/${OP}`), { slug: 'hacked' }));
    await assertSucceeds(setDoc(doc(PLATFORM(), `operators/newco`), { id: 'newco', name: 'New', slug: 'newco', status: 'onboarding', timezone: 'UTC', currency: 'USD', isSandbox: false, plan: 'standard', branding: { displayName: 'New', primaryColor: '#ab6034', accentColor: '#ffc30c' }, modules: {}, features: {}, createdAt: '2026-08-23T22:00:00.000Z', updatedAt: '2026-08-23T22:00:00.000Z', createdBy: 'pa1' }));
    await assertFails(setDoc(doc(OWNER(), `operators/newco2`), { id: 'newco2' }));
  });
  it('collection listing across operators is denied', async () => {
    await seedTenant();
    await assertFails(getDocs(collection(ATT(), 'operators')));
    await assertSucceeds(getDocs(collection(PLATFORM(), 'operators')));
  });
});
describe('venues', () => {
  it('venue read requires membership or manager; write requires admin/owner', async () => {
    await seedTenant();
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/venues/${V1}`)));
    await assertFails(getDoc(doc(ATT(), `operators/${OP}/venues/v2`)));
    await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/venues/v2`)));
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/venues/${V1}`), { name: 'x' }));
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { name: 'x' }));
    await assertFails(updateDoc(doc(OTHER_OP(), `operators/${OP}/venues/${V1}`), { name: 'x' }));
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/venues`), where('id', 'in', [V1]))));
  });
});
