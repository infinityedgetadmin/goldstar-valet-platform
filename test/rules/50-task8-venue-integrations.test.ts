import { it } from 'vitest';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ADMIN, ATT, OP, OWNER, assertFails, assertSucceeds, seedTenant } from './helpers';

// Task 8/9 (task-89-report.md): verifies the specific claim `integrationsSetSecret`'s old comment
// got wrong — that a venue-scoped provider's composite doc id (`{provider}_{venueId}`, e.g.
// `opera_cloud_v1`) is NOT covered by `match /integrations/{provider}` (firestore.rules:566). It is:
// the match is a bare wildcard on the doc id string, so any id shape lands here, composite ones
// included. 22-functions-only.test.ts already proves this indirectly (an arbitrary non-manifest id,
// 'ical2', round-trips through the same rule) — this test proves it with the actual venue-scoped
// naming scheme the dashboard's Integrations page and integrationsSetSecret/integrationsHealthCheck
// now use, and that the same Functions-only field lock
// (status/secretRef/health/lastSyncAt/lastError/lastErrorAt) still applies to that composite id.
it('venue-scoped integration composite doc id (opera_cloud_v1) is covered by the same rule as a plain provider id', async () => {
  await seedTenant();
  await assertSucceeds(setDoc(doc(OWNER(), `operators/${OP}/integrations/opera_cloud_v1`), { config: { hotelId: 'h1', gatewayUrl: 'https://x', chargeCode: 'VLT' } }));
  await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/integrations/opera_cloud_v1`)));
  // Functions-only fields stay locked on the composite id exactly like a plain provider id.
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/toast_v1`), { status: 'active', config: {} }));
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/toast_v1`), { secretRef: 'x', config: {} }));
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/toast_v1`), { health: { ok: true }, config: {} }));
  // Final-wave item 10: `lastErrorAt` closed alongside `lastError` — same composite-id coverage.
  await assertFails(setDoc(doc(OWNER(), `operators/${OP}/integrations/toast_v1`), { lastErrorAt: '2026-08-23T21:00:00.000Z', config: {} }));
  // Non-admin staff can't read it, same as any other integrations doc.
  await assertFails(getDoc(doc(ATT(), `operators/${OP}/integrations/opera_cloud_v1`)));
});
