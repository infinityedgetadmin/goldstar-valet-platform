import { beforeEach, expect, it } from 'vitest';
import { MockPmsProvider } from './mock.adapter.js';
import { MOCK_RESERVATIONS } from '../../../test/pmsFixtures.js';

let pms: MockPmsProvider;
beforeEach(() => {
  pms = new MockPmsProvider(MOCK_RESERVATIONS);
});

it('lookupReservation filters by exact room, case-insensitive name substring, and both together', async () => {
  expect((await pms.lookupReservation({ room: '412' })).reservations.map((r) => r.reservationRef)).toEqual(['res_100']);
  expect((await pms.lookupReservation({ name: 'nopost' })).reservations.map((r) => r.reservationRef)).toEqual(['res_101']);
  expect((await pms.lookupReservation({ name: 'Sam', room: '115' })).reservations.map((r) => r.reservationRef)).toEqual(['res_102']);
  expect((await pms.lookupReservation({ name: 'Jordan', room: '412' })).reservations).toEqual([]);
});

it('postCharge mints opaque mock_{n} postingRefs and records every posting for inspection', async () => {
  const charge = { amount: 1605, currency: 'USD', chargeCode: 'VALET', description: 'Valet', referenceId: 't1' };
  const a = await pms.postCharge({ reservationRef: 'res_100', ...charge });
  const b = await pms.postCharge({ reservationRef: 'res_102', ...charge, referenceId: 't2' });
  expect(a.postingRef).not.toBe(b.postingRef);
  expect(pms.postings).toHaveLength(2);
  expect(pms.postings[0]).toMatchObject({ reservationRef: 'res_100', amount: 1605, chargeCode: 'VALET', referenceId: 't1', reversed: false });
});

it('postCharge rejects a reservationRef it does not hold (Ruling X: never guess at a foreign ref)', async () => {
  await expect(pms.postCharge({ reservationRef: 'res_999', amount: 100, currency: 'USD', chargeCode: 'V', description: 'x', referenceId: 't' })).rejects.toMatchObject({ code: 'not_found' });
});

it('postCharge REJECTS a noPost reservation — defense in depth even though handlers check first', async () => {
  await expect(pms.postCharge({ reservationRef: 'res_101', amount: 100, currency: 'USD', chargeCode: 'V', description: 'x', referenceId: 't' })).rejects.toMatchObject({ code: 'failed_precondition', message: 'no_post' });
  expect(pms.postings).toHaveLength(0);
});

it('reverseCharge: idempotent per referenceId (L2 port contract) — same ref no-ops, a DIFFERENT ref and an unminted posting stay loud', async () => {
  const { postingRef } = await pms.postCharge({ reservationRef: 'res_100', amount: 1605, currency: 'USD', chargeCode: 'V', description: 'Valet', referenceId: 't1' });
  await pms.reverseCharge({ postingRef, referenceId: 'rev_t1' });
  expect(pms.postings[0]!.reversed).toBe(true);
  await expect(pms.reverseCharge({ postingRef: 'mock_999', referenceId: 'rev' })).rejects.toMatchObject({ code: 'not_found' });
  // Same referenceId = the caller's own crash-retry: success no-op, still reversed exactly once.
  await pms.reverseCharge({ postingRef, referenceId: 'rev_t1' });
  expect(pms.postings[0]!.reversed).toBe(true);
  // A different referenceId is a genuine double-reverse — loud.
  await expect(pms.reverseCharge({ postingRef, referenceId: 'rev_OTHER' })).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('healthCheck reports ok', async () => {
  expect(await pms.healthCheck()).toEqual({ ok: true });
});
