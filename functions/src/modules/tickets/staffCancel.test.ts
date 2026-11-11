import { beforeEach, expect, it } from 'vitest';
import { staffCancelHandler } from './staffCancel.js';
import { OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
beforeEach(async () => { await wipe(testDeps()); });
it('lead at venue cancels with reason; attendant denied; paid ticket flags refund', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'requested', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } }));
  await expect(staffCancelHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { ticketId: TID, reason: 'x' })).rejects.toMatchObject({ code: 'permission_denied' });
  await staffCancelHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: ['v1'] }, { ticketId: TID, reason: 'guest left' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { status: string; payment?: { refundRequested?: boolean; refundRequestId?: string } };
  expect(t.status).toBe('cancelled'); expect(t.payment?.refundRequested).toBe(true);
  // Ruling AH: refundRequestId minted in the SAME write as refundRequested:true.
  expect(t.payment?.refundRequestId).toBeTruthy();
});
it('lead whose claims venueIds does not include the ticket venue is denied', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'requested' }));
  await expect(
    staffCancelHandler(deps, { uid: 'lead2', operatorId: OP, roles: ['lead'], venueIds: ['v2'] }, { ticketId: TID, reason: 'x' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});
// Ruling C-2: "full-fetch" pattern — staffCancelHandler doesn't otherwise fetch the operator doc, so
// requireActiveOperator does the one added read itself.
it('rejects with failed_precondition when the operator is suspended (Ruling C-2)', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'requested' }));
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  await expect(
    staffCancelHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: ['v1'] }, { ticketId: TID, reason: 'guest left' }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
});
const TRUNCATED_VENUE_IDS = Array.from({ length: 20 }, (_, i) => `x${i + 1}`);
it('lead with truncated (>=20) claims venueIds falls back to the user doc; allowed when the user doc has the venue', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'requested' }));
  await deps.db.doc(P.user(OP, 'lead3')).set({ roles: ['lead'], venueIds: ['v1'], status: 'active' });
  await staffCancelHandler(deps, { uid: 'lead3', operatorId: OP, roles: ['lead'], venueIds: TRUNCATED_VENUE_IDS }, { ticketId: TID, reason: 'guest left' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { status: string };
  expect(t.status).toBe('cancelled');
});
it('lead with truncated (>=20) claims venueIds and no matching venue in the user doc is denied', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'requested' }));
  await deps.db.doc(P.user(OP, 'lead4')).set({ roles: ['lead'], venueIds: ['v2'], status: 'active' });
  await expect(
    staffCancelHandler(deps, { uid: 'lead4', operatorId: OP, roles: ['lead'], venueIds: TRUNCATED_VENUE_IDS }, { ticketId: TID, reason: 'x' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});
