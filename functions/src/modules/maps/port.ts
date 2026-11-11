export interface Geo {
  lat: number;
  lng: number;
}

export interface MapSuggestion {
  id: string;
  label: string;
  geo?: Geo;
}

export interface MapsProvider {
  autocomplete(i: { query: string; sessionToken: string; proximity?: Geo }): Promise<{ suggestions: MapSuggestion[] }>;
  retrieve(i: { id: string; sessionToken: string }): Promise<{ address: string; geo: Geo }>;
  route(i: { from: Geo; to: Geo }): Promise<{ distanceMeters: number; durationSec: number; polyline: string }>;
}
