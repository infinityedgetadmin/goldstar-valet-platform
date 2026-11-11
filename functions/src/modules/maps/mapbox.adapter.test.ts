import { describe, expect, it, vi } from 'vitest';
import { MapboxMaps } from './mapbox.adapter.js';
import { FakeMapbox } from '../../../test/fakes/mapbox.js';

describe('MapboxMaps.autocomplete', () => {
  it('builds the exact suggest URL (q, session_token, access_token, proximity as lng,lat) and maps the fixture to suggestions', async () => {
    const fake = new FakeMapbox();
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    const res = await maps.autocomplete({ query: 'st elmo', sessionToken: 'sess-1234', proximity: { lat: 39.765, lng: -86.158 } });
    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/searchbox/v1/suggest');
    expect(url.searchParams.get('q')).toBe('st elmo');
    expect(url.searchParams.get('session_token')).toBe('sess-1234');
    expect(url.searchParams.get('access_token')).toBe('tok_test');
    expect(url.searchParams.get('proximity')).toBe('-86.158,39.765');
    expect(res.suggestions).toEqual([
      { id: 'dXJuOm1ieHNiOnN0LWVsbW8tc3RlYWtob3VzZQ', label: '127 S Illinois St, Indianapolis, Indiana 46225, United States' },
      { id: 'dXJuOm1ieHNiOnN0LWVsbW8tZGVudGFsLWNhcmU', label: '5333 N Tacoma Ave, Indianapolis, Indiana 46220, United States' },
    ]);
  });

  it('omits proximity from the URL when not given', async () => {
    const fake = new FakeMapbox();
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await maps.autocomplete({ query: 'coffee', sessionToken: 'sess-1234' });
    const url = new URL(fake.calls[0]!);
    expect(url.searchParams.has('proximity')).toBe(false);
  });

  it('URL-encodes a query containing "&" via URLSearchParams so it round-trips correctly, not string-concatenated', async () => {
    const fake = new FakeMapbox();
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await maps.autocomplete({ query: 'coffee & tea', sessionToken: 'sess-1234' });
    const raw = fake.calls[0]!;
    const url = new URL(raw);
    expect(url.searchParams.get('q')).toBe('coffee & tea');
    expect(url.searchParams.get('session_token')).toBe('sess-1234');
    expect(url.searchParams.get('access_token')).toBe('tok_test');
    // A literal, unescaped '&' in the query would have split into a bogus extra param — exactly 3
    // params confirms URLSearchParams encoded it (q=coffee+%26+tea) rather than breaking on it.
    expect([...url.searchParams.keys()]).toHaveLength(3);
  });
});

describe('MapboxMaps.retrieve', () => {
  it('builds the exact retrieve URL and maps the fixture feature to address+geo', async () => {
    const fake = new FakeMapbox();
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    const res = await maps.retrieve({ id: 'dXJuOm1ieHNiOnN0LWVsbW8tc3RlYWtob3VzZQ', sessionToken: 'sess-1234' });
    const url = new URL(fake.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/searchbox/v1/retrieve/dXJuOm1ieHNiOnN0LWVsbW8tc3RlYWtob3VzZQ');
    expect(url.searchParams.get('session_token')).toBe('sess-1234');
    expect(url.searchParams.get('access_token')).toBe('tok_test');
    expect(res).toEqual({ address: '127 S Illinois St, Indianapolis, Indiana 46225, United States', geo: { lat: 39.765, lng: -86.158 } });
  });
});

describe('MapboxMaps.route', () => {
  it('builds the exact directions URL (lng,lat;lng,lat, overview=full, geometries=polyline) and maps the fixture route', async () => {
    const fake = new FakeMapbox();
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    const res = await maps.route({ from: { lat: 39.765, lng: -86.158 }, to: { lat: 39.85, lng: -86.15 } });
    const url = new URL(fake.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-86.158,39.765;-86.15,39.85');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('geometries')).toBe('polyline');
    expect(url.searchParams.get('access_token')).toBe('tok_test');
    expect(res).toEqual({ distanceMeters: 3820.5, durationSec: 542.3, polyline: 'ojmyJdazkC_ByEwHqDaDcC' });
  });
});

describe('MapboxMaps error handling', () => {
  it('a non-OK response surfaces provider_unavailable', async () => {
    const fake = new FakeMapbox();
    fake.status = 401;
    fake.body = { message: 'Not Authorized' };
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.autocomplete({ query: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('a network failure surfaces provider_unavailable', async () => {
    const fake = new FakeMapbox();
    fake.fail = true;
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.retrieve({ id: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('a timeout aborts the request via the 8s AbortController and surfaces provider_unavailable', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeMapbox();
      fake.hang = true;
      const maps = new MapboxMaps(fake.fetch, 'tok_test');
      const pending = expect(maps.route({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 } })).rejects.toMatchObject({ code: 'provider_unavailable' });
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retrieve with an empty feature collection surfaces provider_unavailable', async () => {
    const fake = new FakeMapbox();
    fake.body = { type: 'FeatureCollection', features: [] };
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.retrieve({ id: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('directions with no routes surfaces provider_unavailable', async () => {
    const fake = new FakeMapbox();
    fake.body = { routes: [], code: 'NoRoute' };
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.route({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 } })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  // Ruling AF regression coverage: a malformed body must never leak a raw SyntaxError, and a
  // well-formed-but-wrong-shape body must never leak a raw TypeError — both fold into
  // provider_unavailable, same as the network/timeout/non-OK cases above.
  it('a non-JSON (malformed) response body surfaces provider_unavailable, not a raw SyntaxError', async () => {
    const fake = new FakeMapbox();
    fake.raw = 'not json{{{';
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.autocomplete({ query: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('a well-formed JSON body missing the expected top-level key surfaces provider_unavailable, not a raw TypeError', async () => {
    const fake = new FakeMapbox();
    fake.body = { message: 'unexpected shape' }; // no suggestions/features/routes key at all
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.autocomplete({ query: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(maps.retrieve({ id: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(maps.route({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 } })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('a retrieve feature missing geometry.coordinates surfaces provider_unavailable, not a raw TypeError', async () => {
    const fake = new FakeMapbox();
    fake.body = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'x' } }] };
    const maps = new MapboxMaps(fake.fetch, 'tok_test');
    await expect(maps.retrieve({ id: 'x', sessionToken: 'sess-1234' })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
