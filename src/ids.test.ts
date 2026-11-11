import { describe, expect, it } from 'vitest';
import { isUuid, secretToken, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('produces RFC-4122 shaped v7 ids that sort by time', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuid(a)).toBe(true);
    expect(a < b || a === b).toBe(true);
  });
  it('never repeats across 10k calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(uuidv7());
    expect(set.size).toBe(10_000);
  });
});

describe('secretToken', () => {
  it('is 22 chars of base64url from 16 random bytes', () => {
    const t = secretToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(secretToken()).not.toBe(t);
  });
});
