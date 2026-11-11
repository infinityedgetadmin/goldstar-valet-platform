import { describe, it } from 'vitest';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ADMIN, OP, PLATFORM, assertFails, seed, seedTenant } from './helpers';

// Plan 8 Task 5 (carry #4): the refund-recompute marker collection is Functions-only. It is written
// by applyEvent.ts inside the refund's own transaction and consumed by the metrics sweep; no client
// role — not even platform admin — reads or writes it.
describe('metricsRecompute is Functions-only', () => {
  it('admin and platform admin can neither read nor write a marker', async () => {
    await seedTenant();
    const M = `operators/${OP}/metricsRecompute/pi_1`;
    await seed(async (db) => setDoc(doc(db, M), { at: '2026-08-23T15:00:00.000Z', txId: 'pi_1' }));
    await assertFails(getDoc(doc(ADMIN(), M)));
    await assertFails(getDoc(doc(PLATFORM(), M)));
    await assertFails(setDoc(doc(ADMIN(), M), { at: 'x', txId: 'pi_1' }));
    await assertFails(setDoc(doc(PLATFORM(), `operators/${OP}/metricsRecompute/pi_2`), { at: 'x', txId: 'pi_2' }));
  });
});
