import type { Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { demoPos } from './demo.adapter.js';
import type { PosProvider } from './port.js';
import { ToastPos } from './toast.adapter.js';

/**
 * Resolves the POS provider for a venue. Same `(deps, ...) => Provider` registry shape as
 * `payments/registry.ts`/`maps/registry.ts` so handler tests mock it with
 * `vi.spyOn(registry, 'getPos')` (the FakeStripe convention) instead of a one-off DI shape.
 *
 * Credentials follow the integrations convention exactly (scheduling/sync.ts, integrations/
 * healthCheck.ts): the venue-scoped integration doc `operators/{op}/integrations/toast_{venueId}`
 * carries `secretRef`, and secrets resolve as `${secretRef}_{FIELD}` through `deps.secrets`
 * (Toast's manifest `secretFields` are clientId/clientSecret → `_CLIENT_ID`/`_CLIENT_SECRET`).
 *
 * An unconfigured venue (`venue.pos` absent) is `failed_precondition`, not a silent mock — a
 * registry that quietly substitutes a fake for real money operations would make every POS flow
 * appear to work while doing nothing. The MockPosProvider exists for tests (spied in) and never
 * ships as a fallback.
 */
export async function getPos(deps: Deps, operatorId: string, venue: Venue): Promise<PosProvider> {
  const pos = venue.pos;
  if (!pos) throw err('failed_precondition', 'pos not configured for this venue');
  // The one exception to "never a silent fallback": the emulator-only demo switch, which no
  // deployed function can enable (lib/demoProviders.ts). It still requires `venue.pos` above, and
  // no Toast credentials are read.
  if (demoProvidersEnabled()) return demoPos();
  const integ = (await deps.db.doc(P.integration(operatorId, `toast_${venue.id}`)).get()).data() as { secretRef?: string } | undefined;
  const secretRef = integ?.secretRef ?? `${operatorId.toUpperCase()}_TOAST`;
  return new ToastPos(
    fetch,
    {
      clientId: deps.secrets.get(`${secretRef}_CLIENT_ID`),
      clientSecret: deps.secrets.get(`${secretRef}_CLIENT_SECRET`),
      restaurantGuid: pos.restaurantGuid,
    },
    {
      validationDiscountGuid: pos.validationDiscountGuid,
      valetItemGuid: pos.valetItemGuid,
      valetItemGroupGuid: pos.valetItemGroupGuid,
    },
  );
}
