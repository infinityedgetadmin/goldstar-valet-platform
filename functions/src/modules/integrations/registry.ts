import { getApp } from 'firebase-admin/app';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { demoSecretManagerClient } from './demo.adapter.js';
import type { SecretWriter } from './port.js';
import { GcpSecretManagerWriter } from './secretManager.adapter.js';
import { secretManagerClient } from './secretManagerClient.js';

/**
 * `deps` is unused today (no deps-derived config feeds this writer) but is kept as
 * the parameter — same `(deps) => X` shape as `payments/registry.ts`'s `getGateway`
 * and `messaging/registry.ts`'s `getMessaging` — so `setSecret.ts` can mock this
 * registry function via `vi.spyOn(registry, 'getSecretWriter')` exactly like those
 * two call sites already do for Stripe/Twilio, instead of a one-off DI shape.
 */
export function getSecretWriter(deps: Deps): SecretWriter {
  void deps;
  // `getApp()` reuses the default app `lib/app.ts` already initialized via the
  // no-arg `initializeApp()` — that call auto-resolves `projectId` from the Cloud
  // Functions runtime environment, so this reads the already-resolved value rather
  // than re-guessing which of `GCLOUD_PROJECT`/`GCP_PROJECT`/`GOOGLE_CLOUD_PROJECT`
  // the runtime happens to set.
  const projectId = getApp().options.projectId;
  if (!projectId) throw new Error('unable to resolve GCP project id for Secret Manager');
  // Emulator-only demo switch: the real writer over an in-memory client (lib/demoProviders.ts).
  if (demoProvidersEnabled()) return new GcpSecretManagerWriter(demoSecretManagerClient(), projectId);
  return new GcpSecretManagerWriter(secretManagerClient(), projectId);
}
