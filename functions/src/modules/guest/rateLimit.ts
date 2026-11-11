import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';

export async function rateLimit(deps: Deps, key: string, max: number, windowSec: number): Promise<void> {
  const ref = deps.db.doc(`rateLimits/${key.replace(/[^a-zA-Z0-9_:.-]/g, '_')}`);
  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.parse(deps.now());
    const d = snap.data() as { count: number; windowStart: number } | undefined;
    if (!d || now - d.windowStart > windowSec * 1000) {
      tx.set(ref, { count: 1, windowStart: now });
      return;
    }
    if (d.count >= max) throw err('rate_limited');
    tx.update(ref, { count: d.count + 1 });
  });
}

/**
 * Task 7 (guest-callable rate limits, M1): caps the number of DISTINCT values ever recorded
 * against one key — a different shape from `rateLimit`'s own windowed count, for a case
 * `rateLimit` alone can't close: `guestEmailReceipt`'s `(ticketId,email)` dedupe already lets the
 * SAME address retry freely (a typo fix, a client retry), so a per-uid `rateLimit` caps how often
 * the CALLER can call the endpoint, but not how many DIFFERENT addresses one ticket's receipt can
 * be fanned out to — a fresh email each call sails past a windowed count untouched.
 *
 * Permanent (no window, unlike `rateLimit`): a ticket's lifetime is bounded and there is no
 * legitimate reason a receipt should ever need MORE than a handful of distinct recipients, ever —
 * a resettable window would just mean an attacker waits it out and resumes.
 *
 * Values are stored as whatever the caller passes — callers should hash anything that's PII
 * (`emailReceipt.ts` reuses its own `outboxId` email hash) rather than pass raw values, matching
 * this codebase's existing PII-minimization discipline for this same doc.
 */
export async function capDistinctValues(deps: Deps, key: string, value: string, max: number): Promise<void> {
  const ref = deps.db.doc(`rateLimits/${key.replace(/[^a-zA-Z0-9_:.-]/g, '_')}`);
  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() as { values?: string[] } | undefined;
    const values = d?.values ?? [];
    if (values.includes(value)) return; // already recorded — a retry of the SAME value is not a new one
    if (values.length >= max) throw err('rate_limited');
    tx.set(ref, { values: [...values, value] }, { merge: true });
  });
}
