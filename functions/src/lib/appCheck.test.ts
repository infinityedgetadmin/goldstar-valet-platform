import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callables } from '@goldstar/platform';

/**
 * Plan 8 Task 16 (carry #33): App Check enforcement for callables, asserted by CI rather than by
 * `scripts/check-appcheck.sh`'s deploy-time grep alone.
 *
 * Why a source scan and not a runtime read: `firebase-functions`' `onCall` resolves
 * `enforceAppCheck` into the internal request handler's options and never exposes it on the
 * returned function (`__endpoint.callableTrigger` is `{}` — verified against
 * firebase-functions/lib/v2/providers/https.js), so there is nothing on an export to inspect.
 * What IS observable is that every callable is built through ONE wrapper whose default is
 * `true`, and that no call site opts out. Those three facts are what this file pins.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = 'lib/callable.ts';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));
const wrapper = files.find((f) => f.rel === WRAPPER);

describe('App Check enforcement on callables (static guard)', () => {
  it('onCall() is invoked only inside lib/callable.ts — every callable goes through defineCallable', () => {
    const offenders = files.filter((f) => f.rel !== WRAPPER && /\bonCall\s*\(/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    expect(wrapper && /\bonCall\s*\(/.test(wrapper.text)).toBe(true);
  });

  it('defineCallable defaults enforceAppCheck to true (the line scripts/check-appcheck.sh also greps)', () => {
    expect(wrapper?.text).toMatch(/enforceAppCheck:\s*opts\.enforceAppCheck\s*\?\?\s*true/);
  });

  it('no defineCallable call site opts out with enforceAppCheck: false', () => {
    const offenders = files.filter((f) => /enforceAppCheck\s*:\s*false/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every contract callable is defined exactly once via defineCallable, and every defineCallable names a contract callable', () => {
    const defined = new Map<string, string[]>();
    for (const f of files) {
      for (const m of f.text.matchAll(/defineCallable\s*\(\s*'([A-Za-z0-9_]+)'/g)) {
        const name = m[1]!;
        defined.set(name, [...(defined.get(name) ?? []), f.rel]);
      }
    }
    const contract = Object.keys(callables).sort();
    const missing = contract.filter((n) => !defined.has(n));
    const unknown = [...defined.keys()].filter((n) => !(n in callables)).sort();
    const duplicated = [...defined.entries()].filter(([, where]) => where.length > 1).map(([n, where]) => `${n} in ${where.join(', ')}`);
    expect({ missing, unknown, duplicated }).toEqual({ missing: [], unknown: [], duplicated: [] });
  });
});
