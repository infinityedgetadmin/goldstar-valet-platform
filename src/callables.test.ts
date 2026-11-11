import { expect, it } from 'vitest';
import { callables } from './callables';
import { INTEGRATION_IDS, INTEGRATION_MANIFEST } from './integrations/manifest';
import { QUERIES } from './queries';
it('every callable has input and output schemas', () => {
  for (const [name, c] of Object.entries(callables)) { expect(c.input, name).toBeDefined(); expect(c.output, name).toBeDefined(); }
  expect(callables.guestCreateCheckout.input.safeParse({ token: 'AbCdEfGhIjKlMnOpQrStUv', tip: { kind: 'preset', percent: 20 } }).success).toBe(true);
  expect(callables.guestCreateCheckout.input.safeParse({ token: 'x', tip: { kind: 'preset', percent: 20 } }).success).toBe(false);
});
it('manifest ids are unique and each has a config schema', () => {
  const ids = INTEGRATION_MANIFEST.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(INTEGRATION_MANIFEST.find((m) => m.id === 'when_i_work')?.configSchema.safeParse({ apiKey: 'k', locationId: '1' }).success).toBe(true);
});
it('INTEGRATION_IDS matches the manifest exactly', () => {
  expect(new Set(INTEGRATION_MANIFEST.map((m) => m.id))).toEqual(new Set(INTEGRATION_IDS));
});
it('queries registry names index requirements', () => { expect(QUERIES.venueQueue.fields).toEqual(['venueId', 'status', 'times.requestedAt']); });
it('myShifts is implementable as an array-contains query against the denormalized assignedUids field', () => {
  expect(QUERIES.myShifts).toEqual({ collection: 'shifts', fields: ['assignedUids', 'date'], arrayContains: 'assignedUids' });
});
it('dispatchQuote output reuses the canonical quoteSchema', () => {
  expect(callables.dispatchQuote.output.safeParse({ quote: { base: 100, distanceMeters: -1, durationSec: 10, amount: 100, breakdown: [] } }).success).toBe(false);
  expect(callables.dispatchQuote.output.safeParse({ quote: { base: 100, distanceMeters: 1000, durationSec: 600, amount: 1500, breakdown: [{ label: 'base', amount: 100 }] } }).success).toBe(true);
});
