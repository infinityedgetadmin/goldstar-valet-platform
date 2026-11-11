import { beforeEach, expect, it } from 'vitest';
import { callables } from '@goldstar/platform';
import { mapsAutocompleteHandler } from './autocomplete.js';
import type { Geo, MapsProvider } from './port.js';
import { testDeps, wipe } from '../../../test/helpers.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function fakeMaps(overrides: Partial<MapsProvider> = {}): MapsProvider {
  return {
    autocomplete: () => Promise.resolve({ suggestions: [] }),
    retrieve: () => Promise.reject(new Error('retrieve not stubbed')),
    route: () => Promise.reject(new Error('route not stubbed')),
    ...overrides,
  };
}

it('fills geo via retrieve for up to 3 geo-less suggestions; leaves the rest (already-geo, over-cap) untouched', async () => {
  const deps = testDeps();
  const retrieved: string[] = [];
  const geo: Geo = { lat: 10, lng: 20 };
  const maps = fakeMaps({
    autocomplete: () =>
      Promise.resolve({
        suggestions: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
          { id: 'd', label: 'D' }, // 4th geo-less suggestion — beyond the cap of 3, stays geo-less
          { id: 'e', label: 'E', geo: { lat: 1, lng: 2 } }, // already has geo — retrieve skipped
        ],
      }),
    retrieve: (i) => {
      retrieved.push(i.id);
      return Promise.resolve({ address: `addr-${i.id}`, geo });
    },
  });
  const res = await mapsAutocompleteHandler(deps, null, { query: 'st elmo', sessionToken: 'sess-1234' }, maps);
  expect(retrieved.sort()).toEqual(['a', 'b', 'c']);
  expect(res.suggestions).toEqual([
    { id: 'a', label: 'A', geo },
    { id: 'b', label: 'B', geo },
    { id: 'c', label: 'C', geo },
    { id: 'd', label: 'D' },
    { id: 'e', label: 'E', geo: { lat: 1, lng: 2 } },
  ]);
});

it('an individual retrieve failure degrades that suggestion to geo-less rather than failing the call', async () => {
  const deps = testDeps();
  const maps = fakeMaps({
    autocomplete: () => Promise.resolve({ suggestions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
    retrieve: (i) => (i.id === 'a' ? Promise.reject(new Error('mapbox down')) : Promise.resolve({ address: 'addr-b', geo: { lat: 3, lng: 4 } })),
  });
  const res = await mapsAutocompleteHandler(deps, null, { query: 'st elmo', sessionToken: 'sess-1234' }, maps);
  expect(res.suggestions).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', geo: { lat: 3, lng: 4 } }]);
});

it('passes proximity through to the provider only when given', async () => {
  const deps = testDeps();
  const seen: unknown[] = [];
  const maps = fakeMaps({ autocomplete: (i) => { seen.push(i); return Promise.resolve({ suggestions: [] }); } });
  await mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-1234' }, maps);
  expect(seen[0]).toEqual({ query: 'a', sessionToken: 'sess-1234' });
  await mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-5678', proximity: { lat: 1, lng: 2 } }, maps);
  expect(seen[1]).toEqual({ query: 'a', sessionToken: 'sess-5678', proximity: { lat: 1, lng: 2 } });
});

it('rate limit: rejects the 31st call within a minute for the same session token', async () => {
  const deps = testDeps();
  const maps = fakeMaps();
  for (let i = 0; i < 30; i++) await mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-1234' }, maps);
  await expect(mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-1234' }, maps)).rejects.toMatchObject({ code: 'rate_limited' });
});

it('rate limit keys are isolated per session token', async () => {
  const deps = testDeps();
  const maps = fakeMaps();
  for (let i = 0; i < 30; i++) await mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-AAAA' }, maps);
  await expect(mapsAutocompleteHandler(deps, null, { query: 'a', sessionToken: 'sess-BBBB' }, maps)).resolves.toEqual({ suggestions: [] });
});

it('schema rejects a query under 2 chars and a session token under 8 chars; accepts a valid pair', () => {
  const { input } = callables.mapsAutocomplete;
  expect(input.safeParse({ query: 'a', sessionToken: 'sess-1234' }).success).toBe(false);
  expect(input.safeParse({ query: 'ab', sessionToken: 'short' }).success).toBe(false);
  expect(input.safeParse({ query: 'ab', sessionToken: 'sess-1234' }).success).toBe(true);
});
