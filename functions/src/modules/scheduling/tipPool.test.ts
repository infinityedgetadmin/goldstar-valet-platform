import { beforeEach, describe, expect, it } from 'vitest';
import { computeClockedHours, computeTipPoolAllocations, tipPoolHandler } from './tipPool.js';
import { NOW, OP, V1, ticketDoc, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Deps } from '../../lib/deps.js';
import type { Shift } from '@goldstar/platform';

beforeEach(async () => {
  await wipe(testDeps());
});

async function getShift(deps: Deps, id: string): Promise<Shift | undefined> {
  return (await deps.db.doc(P.shift(OP, id)).get()).data() as Shift | undefined;
}

async function seedShiftPoolOperator(deps: Deps) {
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ 'modules.payments.tipPolicy': 'shift_pool' });
}

function shiftDoc(over: Record<string, unknown> = {}) {
  return {
    id: 'shift1',
    operatorId: OP,
    venueId: V1,
    date: '2026-08-23',
    startsAt: '2026-08-23T21:00:00.000Z',
    endsAt: '2026-08-24T05:00:00.000Z',
    status: 'open',
    assignments: [],
    notes: '',
    assignedUids: [],
    source: { provider: 'internal' },
    ...over,
  };
}

async function seedSucceededTransaction(deps: Deps, id: string, ticketId: string, tip: number) {
  await deps.db.doc(P.tx(OP, id)).set({
    id,
    operatorId: OP,
    venueId: V1,
    ticketId,
    provider: 'stripe',
    providerRef: id,
    kind: 'charge',
    status: 'succeeded',
    base: 1500,
    tip,
    tax: 100,
    fees: 0,
    total: 1500 + tip + 100,
    currency: 'USD',
    method: 'web',
    at: '2026-08-23T22:00:00.000Z',
  });
}

describe('computeClockedHours', () => {
  it('a single matched in/out pair yields the exact duration', () => {
    const hours = computeClockedHours(
      [
        { uid: 'a', type: 'in', at: '2026-08-23T21:00:00.000Z' },
        { uid: 'a', type: 'out', at: '2026-08-24T01:00:00.000Z' },
      ],
      '2026-08-24T05:00:00.000Z',
    );
    expect(hours).toEqual({ a: 4 });
  });

  it('given test: two attendants clock 4h and 2h', () => {
    const hours = computeClockedHours(
      [
        { uid: 'a', type: 'in', at: '2026-08-23T21:00:00.000Z' },
        { uid: 'a', type: 'out', at: '2026-08-24T01:00:00.000Z' },
        { uid: 'b', type: 'in', at: '2026-08-23T21:00:00.000Z' },
        { uid: 'b', type: 'out', at: '2026-08-23T23:00:00.000Z' },
      ],
      '2026-08-24T05:00:00.000Z',
    );
    expect(hours).toEqual({ a: 4, b: 2 });
  });

  it('a missing "out" is capped at the shift end, not excluded', () => {
    const hours = computeClockedHours([{ uid: 'a', type: 'in', at: '2026-08-24T03:00:00.000Z' }], '2026-08-24T05:00:00.000Z');
    expect(hours).toEqual({ a: 2 });
  });

  it('an "out" with no preceding "in" contributes zero (anomaly, not negative time)', () => {
    const hours = computeClockedHours([{ uid: 'a', type: 'out', at: '2026-08-23T21:00:00.000Z' }], '2026-08-24T05:00:00.000Z');
    expect(hours).toEqual({ a: 0 });
  });

  it('a second "in" before a matching "out" abandons the earlier open interval', () => {
    const hours = computeClockedHours(
      [
        { uid: 'a', type: 'in', at: '2026-08-23T21:00:00.000Z' },
        { uid: 'a', type: 'in', at: '2026-08-23T23:00:00.000Z' }, // abandons the 21:00 open — not stacked
        { uid: 'a', type: 'out', at: '2026-08-24T00:00:00.000Z' },
      ],
      '2026-08-24T05:00:00.000Z',
    );
    expect(hours).toEqual({ a: 1 }); // only the 23:00->00:00 span counts
  });

  it('break_start/break_end events do not reduce clocked hours (gross in-to-out time)', () => {
    const hours = computeClockedHours(
      [
        { uid: 'a', type: 'in', at: '2026-08-23T21:00:00.000Z' },
        { uid: 'a', type: 'break_start', at: '2026-08-23T22:00:00.000Z' },
        { uid: 'a', type: 'break_end', at: '2026-08-23T22:30:00.000Z' },
        { uid: 'a', type: 'out', at: '2026-08-24T01:00:00.000Z' },
      ],
      '2026-08-24T05:00:00.000Z',
    );
    expect(hours).toEqual({ a: 4 });
  });

  it('events out of insertion order are still paired correctly (sorted by "at")', () => {
    const hours = computeClockedHours(
      [
        { uid: 'a', type: 'out', at: '2026-08-24T01:00:00.000Z' },
        { uid: 'a', type: 'in', at: '2026-08-23T21:00:00.000Z' },
      ],
      '2026-08-24T05:00:00.000Z',
    );
    expect(hours).toEqual({ a: 4 });
  });
});

describe('computeTipPoolAllocations', () => {
  it('given test: $90 (9000 cents) split 4h/2h -> $60/$30 exactly', () => {
    const out = computeTipPoolAllocations(9000, { a: 4, b: 2 });
    expect(out).toEqual(expect.arrayContaining([{ uid: 'a', amount: 6000 }, { uid: 'b', amount: 3000 }]));
    expect(out.reduce((s, a) => s + a.amount, 0)).toBe(9000);
  });

  it('a non-exact split still sums to exactly the total (largest-remainder rounding)', () => {
    const out = computeTipPoolAllocations(100, { a: 1, b: 1, c: 1 });
    expect(out.reduce((s, a) => s + a.amount, 0)).toBe(100);
    // 100/3 = 33.33 each; exactly one of the three gets the extra cent.
    const amounts = out.map((a) => a.amount).sort((x, y) => x - y);
    expect(amounts).toEqual([33, 33, 34]);
  });

  it('is deterministic given the same input (repeat calls produce the identical allocation)', () => {
    const a = computeTipPoolAllocations(101, { x: 3, y: 2, z: 1 });
    const b = computeTipPoolAllocations(101, { x: 3, y: 2, z: 1 });
    expect(a).toEqual(b);
  });

  it('zero total hours -> everyone gets zero (no division by zero)', () => {
    const out = computeTipPoolAllocations(9000, { a: 0, b: 0 });
    expect(out).toEqual(expect.arrayContaining([{ uid: 'a', amount: 0 }, { uid: 'b', amount: 0 }]));
  });

  it('zero total tips -> everyone gets zero even with clocked hours', () => {
    const out = computeTipPoolAllocations(0, { a: 4, b: 2 });
    expect(out.every((a) => a.amount === 0)).toBe(true);
  });
});

describe('tipPoolHandler', () => {
  it('given test end-to-end: 2 attendants (4h/2h), $90 in delivered tips -> $60/$30, written to shift.tipPool and users/{uid}/payouts', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());

    // Two delivered tickets inside the shift's window at the shift's venue, each with a succeeded
    // Stripe transaction — $50 + $40 tip = $90 total.
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:30:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 5000);
    await deps.db.doc(P.ticket(OP, 't2')).set(ticketDoc({ id: 't2', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-24T02:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 4000, tax: 100, fees: 0, total: 5600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_2' } }));
    await seedSucceededTransaction(deps, 'pi_2', 't2', 4000);

    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).set({ id: 'e3', uid: 'att2', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd2' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).set({ id: 'e4', uid: 'att2', type: 'out', at: '2026-08-23T23:00:00.000Z', deviceId: 'd2' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    // allocations is sorted by uid ascending (computeTipPoolAllocations) — 'att1' < 'att2', exact order.
    expect(shift?.tipPool).toEqual({ total: 9000, hoursByUid: { att1: 4, att2: 2 }, allocations: [{ uid: 'att1', amount: 6000 }, { uid: 'att2', amount: 3000 }] });

    const payout1 = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data();
    const payout2 = (await deps.db.doc(P.payout(OP, 'att2', 'shift1')).get()).data();
    expect(payout1).toMatchObject({ id: 'shift1', shiftId: 'shift1', amount: 6000, currency: 'USD', status: 'pending' });
    expect(payout2).toMatchObject({ id: 'shift1', shiftId: 'shift1', amount: 3000, currency: 'USD', status: 'pending' });
  });

  it('excludes a ticket delivered outside the shift window', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());
    // Delivered a day before the shift window.
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-22T20:00:00.000Z', deliveredAt: '2026-08-22T23:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 5000);
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', deviceId: 'd1' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool?.total).toBe(0);
  });

  // m2 (final whole-branch review): [start, end) — a ticket delivered at the EXACT instant this
  // shift ends must not be counted (it belongs to whatever shift starts at that same instant, per
  // rollup.ts's own window convention). Before the fix, `deliveredAt <= endsAt` double-counted a
  // boundary-instant delivery into BOTH the closing shift's pool and the next one's.
  it('excludes a ticket delivered at the EXACT shift-end instant (m2, [start, end) boundary)', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());
    // shift1.endsAt === '2026-08-24T05:00:00.000Z' — delivered at that exact instant.
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T21:30:00.000Z', deliveredAt: '2026-08-24T05:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 5000);
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T05:00:00.000Z', deviceId: 'd1' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool?.total).toBe(0);
  });

  it('excludes a transaction that is not "succeeded" (e.g. fully refunded)', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:00:00.000Z' }, payment: { status: 'refunded', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await deps.db.doc(P.tx(OP, 'pi_1')).set({ id: 'pi_1', operatorId: OP, venueId: V1, ticketId: 't1', provider: 'stripe', providerRef: 'pi_1', kind: 'charge', status: 'refunded', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', method: 'web', at: '2026-08-23T22:00:00.000Z' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool?.total).toBe(0);
  });

  it('is a no-op when the operator tipPolicy is "deliverer" (not "shift_pool")', async () => {
    const deps = testDeps();
    await seedOperator(deps); // default tipPolicy: 'deliverer'
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool).toBeUndefined();
  });

  it('is a no-op when the shift was already closed before this write (recursion guard)', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc({ status: 'closed' }));

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'closed' }), after: shiftDoc({ status: 'closed', tipPool: { total: 9000, hoursByUid: {}, allocations: [] } }) });

    const auditEntries = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'scheduling.tipPool').get();
    expect(auditEntries.size).toBe(0);
  });

  it('is idempotent: re-firing the handler for the same close event does not double-write the payout entry', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 9000, tax: 100, fees: 0, total: 10600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 9000);
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', deviceId: 'd1' });

    const evt = { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) };
    await tipPoolHandler(deps, evt);
    await tipPoolHandler(deps, evt); // simulated redelivery of the same trigger event

    const payouts = await deps.db.collection(`operators/${OP}/users/att1/payouts`).get();
    expect(payouts.size).toBe(1);
    expect(payouts.docs[0]!.data()).toMatchObject({ amount: 9000 });
  });

  it('assignees with zero clocked hours receive no payout entry', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 9000, tax: 100, fees: 0, total: 10600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 9000);
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
    await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', deviceId: 'd1' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const payouts2 = await deps.db.collection(`operators/${OP}/users/att2/payouts`).get();
    expect(payouts2.size).toBe(0);
  });

  it('the tip query is venue-isolated: a ticket delivered in the same time window at a DIFFERENT venue is excluded (m1, task-2-review.md)', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.venue(OP, 'v2')).set({ id: 'v2', operatorId: OP, name: 'Other Venue', type: 'restaurant', status: 'active', address: { line1: 'x', city: 'x', region: 'IN', postalCode: '00000', country: 'US' }, geo: { lat: 0, lng: 0 }, zones: [], rates: { valet: { model: 'flat', items: [], taxRateBps: 0, fees: [] }, driveHome: { base: 0, perMile: 0, perMinute: 0, minimum: 0 }, passengerRide: { base: 0, perMile: 0, perMinute: 0, minimum: 0 }, validations: { allowPartial: false, maxAmount: 0 } }, sms: {}, qr: { staticCheckoutEnabled: false }, contract: { model: 'per_ticket', terms: '', billingEmail: '', invoiceDay: 1 } });
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc());

    // The shift's OWN venue (V1) ticket — should count.
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', venueId: V1, times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 5000, tax: 100, fees: 0, total: 6600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 5000);
    // A DIFFERENT venue's ticket, delivered inside the exact same time window — must NOT count, even
    // though `times.deliveredAt` alone would match.
    await deps.db.doc(P.ticket(OP, 't2')).set(ticketDoc({ id: 't2', venueId: 'v2', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:30:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 4000, tax: 100, fees: 0, total: 5600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_2' } }));
    await deps.db.doc(P.tx(OP, 'pi_2')).set({ id: 'pi_2', operatorId: OP, venueId: 'v2', ticketId: 't2', provider: 'stripe', providerRef: 'pi_2', kind: 'charge', status: 'succeeded', base: 1500, tip: 4000, tax: 100, fees: 0, total: 5600, currency: 'USD', method: 'web', at: '2026-08-23T23:30:00.000Z' });

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool?.total).toBe(5000); // only V1's $50, not V1's $50 + v2's $40
  });

  it('a shift closes with real tips but nobody ever clocked in: total is recorded, allocations/payouts are all empty (m2, task-2-review.md)', async () => {
    const deps = testDeps();
    await seedShiftPoolOperator(deps);
    await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc({ assignedUids: ['att1'] }));
    await deps.db.doc(P.ticket(OP, 't1')).set(ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:00:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 9000, tax: 100, fees: 0, total: 10600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
    await seedSucceededTransaction(deps, 'pi_1', 't1', 9000);
    // Deliberately no clockEvents subcollection docs at all.

    await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });

    const shift = await getShift(deps, 'shift1');
    expect(shift?.tipPool).toEqual({ total: 9000, hoursByUid: {}, allocations: [] });
    const payouts = await deps.db.collection(`operators/${OP}/users/att1/payouts`).get();
    expect(payouts.size).toBe(0);
  });

  describe('reopen + reclose reconciliation (fix round 1, C1: task-2-review.md)', () => {
    async function seedClosableShift(deps: Deps) {
      await seedShiftPoolOperator(deps);
      await deps.db.doc(P.shift(OP, 'shift1')).set(shiftDoc({ assignedUids: ['att1', 'att2'] }));
      await deps.db.doc(P.ticket(OP, 't1')).set(
        ticketDoc({ id: 't1', times: { checkedInAt: '2026-08-23T20:00:00.000Z', deliveredAt: '2026-08-23T23:30:00.000Z' }, payment: { status: 'paid', base: 1500, tip: 9000, tax: 100, fees: 0, total: 10600, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }),
      );
      await seedSucceededTransaction(deps, 'pi_1', 't1', 9000);
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e1')).set({ id: 'e1', uid: 'att1', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' });
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e2')).set({ id: 'e2', uid: 'att1', type: 'out', at: '2026-08-24T01:00:00.000Z', deviceId: 'd1' });
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).set({ id: 'e3', uid: 'att2', type: 'in', at: '2026-08-23T21:00:00.000Z', deviceId: 'd2' });
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).set({ id: 'e4', uid: 'att2', type: 'out', at: '2026-08-23T23:00:00.000Z', deviceId: 'd2' });
    }

    it('reopen, drop an assignee\'s clocked hours, reclose: the dropped uid\'s stale payout doc is deleted; the kept uid\'s is overwritten with the new amount', async () => {
      const deps = testDeps();
      await seedClosableShift(deps);

      // Close #1: att1 4h, att2 2h -> $60/$30 (matches the given test's own math).
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      const afterFirstClose = await getShift(deps, 'shift1');
      expect(afterFirstClose?.tipPool?.allocations).toEqual([{ uid: 'att1', amount: 6000 }, { uid: 'att2', amount: 3000 }]);
      expect((await deps.db.doc(P.payout(OP, 'att2', 'shift1')).get()).exists).toBe(true);

      // Reopen + correction: a lead voids att2's punch (e.g. discovers they were on the wrong shift)
      // by removing their clock events entirely — assignments alone don't affect hoursByUid (it's
      // keyed off clockEvents, not assignments), so this is what actually changes the computed split.
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).delete();
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).delete();

      // Close #2: `before` carries the shift's REAL state at the moment of this write — status
      // flipped back to 'open' during the reopen, but `tipPool` untouched (rules-pinned), exactly like
      // `firestore.rules`'s `unchanged(['tipPool', ...])` guarantees in production.
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: { ...afterFirstClose, status: 'open' }, after: shiftDoc({ status: 'closed' }) });

      const afterSecondClose = await getShift(deps, 'shift1');
      expect(afterSecondClose?.tipPool).toEqual({ total: 9000, hoursByUid: { att1: 4 }, allocations: [{ uid: 'att1', amount: 9000 }] });

      const payout1 = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data();
      expect(payout1).toMatchObject({ amount: 9000 }); // overwritten from 6000 -> the full pool

      const payout2Snap = await deps.db.doc(P.payout(OP, 'att2', 'shift1')).get();
      expect(payout2Snap.exists).toBe(false); // stale $30 pending doc cleaned up, not left behind
    });

    it('reclose with an unchanged allocation set leaves both payout docs untouched (no spurious deletes)', async () => {
      const deps = testDeps();
      await seedClosableShift(deps);

      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      const afterFirstClose = await getShift(deps, 'shift1');

      // Reopen with NO actual change to clock events, then close again — allocations recompute to the
      // exact same values.
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: { ...afterFirstClose, status: 'open' }, after: shiftDoc({ status: 'closed' }) });

      const payout1 = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data();
      const payout2 = (await deps.db.doc(P.payout(OP, 'att2', 'shift1')).get()).data();
      expect(payout1).toMatchObject({ amount: 6000, status: 'pending' });
      expect(payout2).toMatchObject({ amount: 3000, status: 'pending' });
    });

    it('does not delete a stale payout doc a downstream sweep already moved to "paid" — logs instead', async () => {
      const deps = testDeps();
      await seedClosableShift(deps);

      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      const afterFirstClose = await getShift(deps, 'shift1');

      // Simulate Plan 8's payout sweep having already paid att2 out before the reopen happened.
      await deps.db.doc(P.payout(OP, 'att2', 'shift1')).update({ status: 'paid' });
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).delete();
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).delete();

      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: { ...afterFirstClose, status: 'open' }, after: shiftDoc({ status: 'closed' }) });

      const payout2 = (await deps.db.doc(P.payout(OP, 'att2', 'shift1')).get()).data();
      expect(payout2).toMatchObject({ amount: 3000, status: 'paid' }); // left alone, not deleted
    });

    it('carry #3: reopen-reclose leaves exactly ONE pending doc with the ORIGINAL createdAt — the sweep will age by it', async () => {
      const deps = testDeps();
      await seedClosableShift(deps);
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      const first = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data()!;
      expect(first).toMatchObject({ status: 'pending', amount: 6000, createdAt: NOW });

      // Reopen + reclose an hour later with att2's punches voided — att1 recomputes to the full pool.
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).delete();
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).delete();
      const later = new Date(Date.parse(NOW) + 3600_000).toISOString();
      const lateDeps = testDeps({ now: () => later });
      await tipPoolHandler(lateDeps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open', tipPool: { total: 9000, hoursByUid: { att1: 4, att2: 2 }, allocations: [{ uid: 'att1', amount: 6000 }, { uid: 'att2', amount: 3000 }] } }), after: shiftDoc({ status: 'closed' }) });

      const after = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data()!;
      expect(after.amount).toBe(9000); // recomputed
      expect(after.createdAt).toBe(NOW); // ORIGINAL — pre-fix the set() stamped `later` here
      expect(after.status).toBe('pending');
    });

    it("carry #2: a reclose NEVER reverts a 'paid' payout back to pending — settled money is not the trigger's to touch", async () => {
      const deps = testDeps();
      await seedClosableShift(deps);
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      // The sweep pays att1 out between the close and the reclose.
      await deps.db.doc(P.payout(OP, 'att1', 'shift1')).update({ status: 'paid', transferRef: 'tr_1' });

      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e3')).delete();
      await deps.db.doc(P.clockEvent(OP, 'shift1', 'e4')).delete();
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open', tipPool: { total: 9000, hoursByUid: { att1: 4, att2: 2 }, allocations: [{ uid: 'att1', amount: 6000 }, { uid: 'att2', amount: 3000 }] } }), after: shiftDoc({ status: 'closed' }) });

      const after = (await deps.db.doc(P.payout(OP, 'att1', 'shift1')).get()).data()!;
      // Pre-fix the set() rewrote this to { status: 'pending', amount: 9000 } — a DOUBLE PAY once
      // the sweep ran again. The paid record survives untouched, original amount included.
      expect(after).toMatchObject({ status: 'paid', amount: 6000, transferRef: 'tr_1' });
    });

    it('first close (no before.tipPool) does no reconciliation reads or deletes', async () => {
      const deps = testDeps();
      await seedClosableShift(deps);
      // shiftDoc() carries no `tipPool` key at all — exactly what a genuinely first-ever close sees.
      await tipPoolHandler(deps, { operatorId: OP, shiftId: 'shift1', before: shiftDoc({ status: 'open' }), after: shiftDoc({ status: 'closed' }) });
      const shift = await getShift(deps, 'shift1');
      expect(shift?.tipPool?.allocations).toEqual([{ uid: 'att1', amount: 6000 }, { uid: 'att2', amount: 3000 }]);
    });
  });
});
