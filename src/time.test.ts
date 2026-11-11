import { expect, it } from 'vitest';
import { minutesBetween, nowIso } from './time';
it('nowIso is ISO-8601 UTC', () => { expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); });
it('minutesBetween rounds down and is non-negative', () => {
  expect(minutesBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:07:59Z'))).toBe(7);
  expect(minutesBetween(new Date('2026-01-01T00:10:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(0);
});
