import { describe, it } from 'vitest';
import { doc, updateDoc } from 'firebase/firestore';
import { ADMIN, LEAD, OP, OWNER, assertFails, assertSucceeds, seedTenant } from './helpers';

// final-review.md F4 / Ruling E-4a (rules half): spec §2.2's role table grants `admin` "...branding",
// but operators/{op}'s update rule previously admitted only platform_admin/owner — every admin who
// used the dashboard's Branding page got a 100%-failing save. The rule gains a third branch: an admin
// may update operators/{op} ONLY when the changed top-level keys are confined to
// branding(+updatedAt) — onlyChanged(['branding', 'updatedAt']) — the inverse idiom of the owner
// branch's unchanged() pin on the same rule.
describe('operators: admin may update branding-only (Ruling E-4a / final-review F4)', () => {
  it('admin: branding-only dot-path update (matching branding-editor.tsx\'s actual write shape) succeeds', async () => {
    await seedTenant();
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}`), {
      'branding.displayName': 'New Name',
      'branding.primaryColor': '#112233',
      'branding.accentColor': '#445566',
      updatedAt: '2026-08-26T00:00:00.000Z',
    }));
  });

  it("admin: a logo-upload-shaped write (single branding.logo*Path field + updatedAt) succeeds", async () => {
    await seedTenant();
    await assertSucceeds(updateDoc(doc(ADMIN(), `operators/${OP}`), {
      'branding.logoLightPath': `operators/${OP}/branding/logo-light.png`,
      updatedAt: '2026-08-26T00:00:00.000Z',
    }));
  });

  it('admin: touching any non-branding top-level key alongside branding is denied entirely (onlyChanged fails closed on the whole write)', async () => {
    await seedTenant();
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}`), { 'branding.displayName': 'New Name', name: 'Renamed Co' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}`), { 'branding.displayName': 'New Name', status: 'suspended' }));
  });

  it('admin: a non-branding-only update (e.g. plain name change, no branding involved) is denied', async () => {
    await seedTenant();
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}`), { name: 'Renamed Co' }));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}`), { 'modules.payments.tipPresets': [15, 18, 20] }));
  });

  it('lead: denied entirely, including a branding-only attempt (lead is not isAdmin())', async () => {
    await seedTenant();
    await assertFails(updateDoc(doc(LEAD(), `operators/${OP}`), { 'branding.displayName': 'New Name' }));
  });

  it('owner: unaffected by the new admin branch — full update (including non-branding fields) still succeeds as before', async () => {
    await seedTenant();
    await assertSucceeds(updateDoc(doc(OWNER(), `operators/${OP}`), { name: 'Renamed Co', 'branding.displayName': 'New Name' }));
  });
});
