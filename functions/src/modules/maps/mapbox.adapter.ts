import { err } from '../../lib/errors.js';
import type { Geo, MapsProvider } from './port.js';

// Mapbox aborts a hung request after this long — no per-call override needed today, so it's a
// module constant rather than a constructor param (keeps the port's `MapboxMaps(fetchFn, token)`
// shape exactly as specced).
const TIMEOUT_MS = 8_000;

// Confirmed via Context7 (/websites/mapbox, source docs.mapbox.com/api/search/search-box,
// "GET https://api.mapbox.com/search/searchbox/v1/suggest"): suggest is a lightweight,
// coordinate-free result list — `q`, `session_token`, `access_token`, `proximity` (as
// `longitude,latitude`) are the documented request params. The Search Box v1 suggestion object
// itself (not shown as a full JSON example by that doc, only the request contract) carries the
// same property names Search Box uses everywhere else — `name`/`mapbox_id`/`full_address`/
// `place_formatted`/`feature_type` — just without `coordinates`, which is why a follow-up
// `retrieve` call is required to get a geo.
interface SuggestResponse {
  suggestions: { name: string; mapbox_id: string; full_address?: string; place_formatted?: string }[];
}

// Confirmed via Context7 (/websites/mapbox, source docs.mapbox.com/api/search/search-box,
// "Retrieve a suggested feature" — the exact retrieve-endpoint example): a GeoJSON
// FeatureCollection; `features[0].properties.{name,full_address,place_formatted}` and
// `features[0].geometry.coordinates` as `[lng, lat]`.
interface RetrieveResponse {
  features: {
    properties: { name: string; full_address?: string; place_formatted?: string };
    // Optional (not just `{ coordinates: [number, number] }`): the compile-time shape trusts the
    // documented response, but the runtime guard in `retrieve()` below (Ruling AF) treats a
    // malformed provider response as a real possibility, and an always-present type here would
    // make that guard's `?.` read as dead code to the linter.
    geometry?: { coordinates: [number, number] };
  }[];
}

// Confirmed via Context7 (/websites/mapbox, source docs.mapbox.com/api/navigation/directions,
// multiple response examples): `routes[0].{distance,duration}` are numbers, and `routes[0].geometry`
// is the route's encoded polyline string when the request sets `geometries=polyline` (as opposed to
// per-step geometry nested under `legs[].steps[]`, which this adapter never requests via `overview`).
interface DirectionsResponse {
  routes: { distance: number; duration: number; geometry: string }[];
}

export class MapboxMaps implements MapsProvider {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly token: string,
  ) {}

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: controller.signal });
    } catch (e) {
      // Covers both a network failure and the timeout abort above. Never log/include `url` — it
      // carries `access_token` as a query param; name-only is the same discipline push.ts and
      // twilio.adapter.ts already apply to provider errors that might embed a secret.
      throw err('provider_unavailable', 'mapbox request failed', { name: e instanceof Error ? e.name : typeof e });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw err('provider_unavailable', 'mapbox request failed', { status: res.status });
    try {
      return (await res.json()) as T;
    } catch (e) {
      // Ruling AF: a malformed (non-JSON) body must never surface as a raw SyntaxError through the
      // generic 'internal' path — same provider_unavailable treatment as a network failure or a
      // non-OK status above. Never log/include `url` — it carries `access_token` as a query param.
      throw err('provider_unavailable', 'mapbox response was not valid JSON', { name: e instanceof Error ? e.name : typeof e });
    }
  }

  // Ruling AF: `getJson<T>`'s `as T` cast trusts the shape at compile time but not at runtime — a
  // 200 response whose body parses as JSON but doesn't carry the expected top-level array key
  // (an unexpected error envelope, an API version drift, a test fixture typo) would otherwise
  // throw a raw TypeError (`Cannot read properties of undefined`) once autocomplete/retrieve/route
  // indexed into it. Every accessor below validates its top-level key is actually an array before
  // touching it, so that failure mode also maps to provider_unavailable.
  private static requireArray<T>(v: unknown, field: string): T[] {
    if (!Array.isArray(v)) throw err('provider_unavailable', `mapbox response missing ${field}`);
    return v as T[];
  }

  async autocomplete(i: { query: string; sessionToken: string; proximity?: Geo }): Promise<{ suggestions: { id: string; label: string; geo?: Geo }[] }> {
    const params = new URLSearchParams({ q: i.query, session_token: i.sessionToken, access_token: this.token });
    if (i.proximity) params.set('proximity', `${i.proximity.lng},${i.proximity.lat}`);
    const data = await this.getJson<SuggestResponse>(`https://api.mapbox.com/search/searchbox/v1/suggest?${params.toString()}`);
    const suggestions = MapboxMaps.requireArray<SuggestResponse['suggestions'][number]>(data.suggestions, 'suggestions');
    return { suggestions: suggestions.map((s) => ({ id: s.mapbox_id, label: s.full_address ?? s.place_formatted ?? s.name })) };
  }

  async retrieve(i: { id: string; sessionToken: string }): Promise<{ address: string; geo: Geo }> {
    const params = new URLSearchParams({ session_token: i.sessionToken, access_token: this.token });
    const data = await this.getJson<RetrieveResponse>(`https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(i.id)}?${params.toString()}`);
    const features = MapboxMaps.requireArray<RetrieveResponse['features'][number]>(data.features, 'features');
    const f = features[0];
    if (!f) throw err('provider_unavailable', 'mapbox retrieve returned no feature');
    const coordinates = f.geometry?.coordinates;
    if (!Array.isArray(coordinates)) throw err('provider_unavailable', 'mapbox retrieve feature missing geometry.coordinates');
    const [lng, lat] = coordinates;
    return { address: f.properties.full_address ?? f.properties.place_formatted ?? f.properties.name, geo: { lat, lng } };
  }

  async route(i: { from: Geo; to: Geo }): Promise<{ distanceMeters: number; durationSec: number; polyline: string }> {
    const params = new URLSearchParams({ overview: 'full', geometries: 'polyline', access_token: this.token });
    const coords = `${i.from.lng},${i.from.lat};${i.to.lng},${i.to.lat}`;
    const data = await this.getJson<DirectionsResponse>(`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?${params.toString()}`);
    const routes = MapboxMaps.requireArray<DirectionsResponse['routes'][number]>(data.routes, 'routes');
    const route = routes[0];
    if (!route) throw err('provider_unavailable', 'mapbox directions returned no route');
    return { distanceMeters: route.distance, durationSec: route.duration, polyline: route.geometry };
  }
}
