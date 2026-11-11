import { err } from '../../lib/errors.js';
import type { PosCheck, PosProvider } from './port.js';

/**
 * In-memory POS for tests and for the Ruling Y development path — `posApplyValidation`'s live
 * Toast call is unverified, so the flow that redeems a validation and pushes the discount is
 * proven end-to-end against THIS provider (which the port fully specifies) rather than against
 * fixtures of a contract nobody has confirmed.
 *
 * Mints its own opaque `checkRef`s (`mock:{n}`) and rejects refs it did not mint — the same
 * contract the Toast adapter enforces, so a test passing here can't be quietly depending on a
 * parseable ref.
 */
export class MockPosProvider implements PosProvider {
  private nextRef = 1;
  private checks = new Map<string, PosCheck & { discounts: { amount: number; reason: string }[]; items: { name: string; amount: number }[] }>();

  seedCheck(i: { table?: string; total: number; openedAt?: string }): string {
    const checkRef = `mock:${this.nextRef++}`;
    this.checks.set(checkRef, {
      checkRef,
      ...(i.table !== undefined ? { table: i.table } : {}),
      total: i.total,
      openedAt: i.openedAt ?? '2026-08-23T20:00:00.000Z',
      discounts: [],
      items: [],
    });
    return checkRef;
  }

  /** Test inspection surface. */
  check(checkRef: string) {
    return this.checks.get(checkRef);
  }

  private mustHold(checkRef: string) {
    const c = this.checks.get(checkRef);
    if (!c) throw err('not_found', 'check');
    return c;
  }

  // `async` (not sync-return-Promise.resolve): `mustHold`'s throw must surface as a REJECTED
  // promise, exactly as a real provider's failure would — a synchronous throw out of a
  // Promise-returning signature is a shape no caller of the port ever handles.
  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see above
  async findCheck(i: { table?: string | undefined; checkRef?: string | undefined }): Promise<{ checks: PosCheck[] }> {
    let all = [...this.checks.values()];
    if (i.checkRef !== undefined) all = all.filter((c) => c.checkRef === i.checkRef);
    if (i.table !== undefined) all = all.filter((c) => c.table === i.table);
    return { checks: all.map(({ checkRef, table, total, openedAt }) => ({ checkRef, ...(table !== undefined ? { table } : {}), total, openedAt })) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see findCheck
  async applyValidation(i: { checkRef: string; amount: number; reason: string }): Promise<{ ok: true }> {
    const c = this.mustHold(i.checkRef);
    c.discounts.push({ amount: i.amount, reason: i.reason });
    c.total = Math.max(0, c.total - i.amount);
    return { ok: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see findCheck
  async addCharge(i: { checkRef: string; item: { name: string; amount: number } }): Promise<{ ok: true }> {
    const c = this.mustHold(i.checkRef);
    c.items.push(i.item);
    c.total += i.item.amount;
    return { ok: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see findCheck
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}
