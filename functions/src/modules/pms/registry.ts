import type { Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { err } from '../../lib/errors.js';
import { demoPms } from './demo.adapter.js';
import type { PmsProvider } from './port.js';

/**
 * Resolves the PMS provider for a venue. Same `(deps, operatorId, venue) => Promise<Provider>`
 * registry shape as `pos/registry.ts`'s `getPos` so handler tests mock it with
 * `vi.spyOn(registry, 'getPms')` (the FakeStripe convention).
 *
 * RULING H: no live adapter exists yet — the OHIP contract could not be verified (internally
 * inconsistent generated docs; the load-bearing `noPost` flag unfindable), and OPERA cannot be
 * smoke-tested without a real customer property. A venue configured for `opera_cloud` therefore
 * gets an HONEST `provider_unavailable`, never a silent mock: a registry that quietly substitutes
 * a fake for real money operations would make every room-charge flow appear to work while posting
 * nothing to any folio (`pos/registry.ts` documents the same rule). `MockPmsProvider` exists for
 * tests (spied in) and never ships as a fallback.
 *
 * When the OPERA adapter lands (external gate: live OHIP credentials against a real property),
 * this becomes the one place that constructs it — credentials via the integrations convention
 * (`operators/{op}/integrations/opera_{venueId}` → `deps.secrets`), `venue.pms.hotelId` as
 * constructor config, exactly as `getPos` does for Toast.
 */
export function getPms(_deps: Deps, _operatorId: string, venue: Venue): Promise<PmsProvider> {
  // Rejected promises, not sync throws — callers `await` this and must see the same shape a
  // constructed adapter's failure would have.
  if (!venue.pms) return Promise.reject(err('failed_precondition', 'pms not configured for this venue'));
  // The one exception to "never a silent mock": the emulator-only demo switch, which no deployed
  // function can enable (lib/demoProviders.ts). It still requires `venue.pms` above.
  if (demoProvidersEnabled()) return Promise.resolve(demoPms());
  return Promise.reject(err('provider_unavailable', 'opera_cloud adapter not yet available (Ruling H external gate — needs live OHIP credentials against a real property)'));
}
