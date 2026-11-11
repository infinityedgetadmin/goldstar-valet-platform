import { describe, it } from 'vitest';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ATT, GUEST, NOW, OP, assertFails, assertSucceeds, seedTenant } from './helpers';

// Plan 8 Task 14 — telemetry/{uid}.operatorId is pinned to the writer's operator claim. The
// rollup (functions/src/modules/analytics/rollup.ts) selects rows by operatorId, so before this
// pin any signed-in device could file its health under a different operator. Each deny is paired
// with a succeed on the same statement shape so it cannot be the expression ceiling.
const good = () => ({
  operatorId: OP, day: '2026-08-23', photosUploaded: 3, photosNeedsAttention: 0, writesPending: 0,
  appVersion: '1.0.0', platform: 'ios', updatedAt: NOW,
});

describe('telemetry operatorId pin (Plan 8 Task 14)', () => {
  it('create: own operator succeeds; another operator, or no operatorId at all, is denied', async () => {
    await seedTenant();
    await assertFails(setDoc(doc(ATT(), 'telemetry/att1'), { ...good(), operatorId: 'valetb' }));
    const { operatorId: _omit, ...withoutOperator } = good();
    await assertFails(setDoc(doc(ATT(), 'telemetry/att1'), withoutOperator));
    await assertSucceeds(setDoc(doc(ATT(), 'telemetry/att1'), good()));
  });
  it('update: cannot re-point an existing row at another operator; a same-operator refresh succeeds', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(ATT(), 'telemetry/att1'), good()));
    await assertFails(updateDoc(doc(ATT(), 'telemetry/att1'), { operatorId: 'valetb', updatedAt: NOW }));
    await assertSucceeds(updateDoc(doc(ATT(), 'telemetry/att1'), { photosUploaded: 4, updatedAt: NOW }));
  });
  it('a guest (no operatorId claim) cannot write telemetry at all — there is no operator to pin to', async () => {
    await seedTenant();
    await assertFails(setDoc(doc(GUEST(), 'telemetry/g1'), good()));
  });
});
