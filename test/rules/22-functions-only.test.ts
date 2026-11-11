import { it } from 'vitest';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, OP, OWNER, PLATFORM, assertFails, assertSucceeds, seed, seedTenant } from './helpers';
it('transactions, payoutBatches, invoices, metrics, auditLog, archive, claims.evidenceBundle are read-only for clients (admin+) and unwritable', async () => {
  await seedTenant();
  for (const c of ['transactions', 'payoutBatches', 'invoices', 'auditLog']) {
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/${c}/x`), { id: 'x' }));
    await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/${c}/x`)));
    await assertFails(setDoc(doc(OWNER(), `operators/${OP}/${c}/y`), { id: 'y' }));
    await assertFails(setDoc(doc(PLATFORM(), `operators/${OP}/${c}/y`), { id: 'y' }));
  }
  await seed(async (db) => setDoc(doc(db, `operators/${OP}/metrics/daily/days/2026-08-23`), { tickets: 1 }));
  await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/metrics/daily/days/2026-08-23`)));
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/metrics/daily/days/2026-08-24`), { tickets: 2 }));
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/stripe`), { status: 'active', secretRef: 'projects/x/secrets/y' }));
  // Ruling AB (finding 12): status is now Functions-only too (matching the rule's own comment) — an
  // owner creates config without it; Functions set the initial status after onboarding/health-check.
  await assertSucceeds(setDoc(doc(OWNER(), `operators/${OP}/integrations/ical`), { config: { feedUrl: 'https://x', venueId: 'v1', matchBy: 'email' } }));
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/ical2`), { status: 'configured', config: { feedUrl: 'https://x', venueId: 'v1', matchBy: 'email' } }));
  await assertFails(updateDoc(doc(OWNER(), `operators/${OP}/integrations/ical`), { lastError: 'boom' }));
  // Final-wave item 10: `lastErrorAt` was missed by the Functions-only lock — closed alongside
  // `lastError` (healthCheck.ts/sync.ts always write the two together).
  await assertFails(updateDoc(doc(OWNER(), `operators/${OP}/integrations/ical`), { lastErrorAt: '2026-08-23T21:00:00.000Z' }));
});
