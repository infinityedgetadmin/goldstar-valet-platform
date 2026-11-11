import { describe, expect, it } from 'vitest';
import { MockPosProvider } from './mock.adapter.js';

describe('MockPosProvider', () => {
  it('seeds checks, finds by table or ref, and mints opaque refs', async () => {
    const pos = new MockPosProvider();
    const a = pos.seedCheck({ table: '12', total: 9125 });
    pos.seedCheck({ table: '4', total: 2000 });

    expect((await pos.findCheck({})).checks).toHaveLength(2);
    expect((await pos.findCheck({ table: '12' })).checks).toEqual([expect.objectContaining({ checkRef: a, table: '12', total: 9125 })]);
    expect((await pos.findCheck({ checkRef: a })).checks).toHaveLength(1);
  });

  it('applyValidation and addCharge mutate the held check and are inspectable', async () => {
    const pos = new MockPosProvider();
    const ref = pos.seedCheck({ table: '12', total: 9125 });

    await pos.addCharge({ checkRef: ref, item: { name: 'Valet parking', amount: 1605 } });
    await pos.applyValidation({ checkRef: ref, amount: 700, reason: 'AB23CD' });

    const c = pos.check(ref)!;
    expect(c.items).toEqual([{ name: 'Valet parking', amount: 1605 }]);
    expect(c.discounts).toEqual([{ amount: 700, reason: 'AB23CD' }]);
    expect(c.total).toBe(9125 + 1605 - 700);
  });

  it('rejects refs it did not mint — same contract the Toast adapter enforces', async () => {
    const pos = new MockPosProvider();
    await expect(pos.applyValidation({ checkRef: 'toast-looking:ref', amount: 1, reason: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(pos.addCharge({ checkRef: 'nope', item: { name: 'x', amount: 1 } })).rejects.toMatchObject({ code: 'not_found' });
  });
});
