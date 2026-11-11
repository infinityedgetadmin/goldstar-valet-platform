import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import type { MapsProvider } from './port.js';
import { MapboxMaps } from './mapbox.adapter.js';

export function getMaps(deps: Deps): MapsProvider {
  // Widened to `string`, same idiom as getGateway/getMessaging — except there `provider` comes
  // from an operator's `modules.{payments,messaging}.provider` field (already a widened-to-string
  // switch target because that field's schema union currently has one member). Maps has no
  // operator-scoped config at all: `mapsAutocomplete` is anonymous-callable and platform-wide, not
  // per-operator, so there's no schema field to widen from — the local `provider` constant plays
  // that role instead, keeping this a real dispatch point (not tautological to the type checker)
  // as future providers (e.g. Google Places) are registered.
  const provider: string = 'mapbox';
  switch (provider) {
    case 'mapbox':
      return new MapboxMaps(fetch, deps.secrets.get('MAPBOX_SERVER_TOKEN'));
    default:
      throw err('provider_unavailable', `maps provider ${provider}`);
  }
}
