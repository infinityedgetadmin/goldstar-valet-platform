import { beforeEach, describe, expect, it } from 'vitest';
import { requestVehicleHandler } from './requestVehicle.js';
import { assistanceHandler } from './assistance.js';
import { cancelHandler } from './cancel.js';
import { rateLimit } from './rateLimit.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
beforeEach(async () => { await wipe(testDeps()); });
async function seedTicket(deps: ReturnType<typeof testDeps>, over = {}) { const t = ticketDoc(over); await deps.db.doc(P.ticket(OP, TID)).set(t); await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t }); }
describe('guest callables', () => {
  it('request vehicle moves checked_in → requested and stamps requestedAt; idempotent; unknown token rejected', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps);
    expect(await requestVehicleHandler(deps, null, { token: TOKEN })).toEqual({ status: 'requested' });
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()).toMatchObject({ status: 'requested', times: { requestedAt: NOW } });
    expect(await requestVehicleHandler(deps, null, { token: TOKEN })).toEqual({ status: 'requested' });
    await expect(requestVehicleHandler(deps, null, { token: 'ZzZzZzZzZzZzZzZzZzZzZz' })).rejects.toMatchObject({ code: 'guest_token_expired' });
  });
  it('cannot request on a closed ticket or expired projection', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps, { status: 'closed', times: { checkedInAt: NOW, closedAt: NOW } });
    await expect(requestVehicleHandler(deps, null, { token: TOKEN })).rejects.toMatchObject({ code: 'ticket_closed' });
  });
  it('assistance flag and guest cancel with reason', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps, { jobType: 'drive_home', status: 'quoted', attendants: {} });
    await assistanceHandler(deps, null, { token: TOKEN, assistance: true });
    const afterFlag = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { flags: { assistance: boolean } } | undefined;
    expect(afterFlag?.flags.assistance).toBe(true);
    const assistanceLogs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'guest.flagAssistance').get();
    expect(assistanceLogs.size).toBe(1);
    expect(assistanceLogs.docs[0]!.data()).toMatchObject({ actorUid: 'guest', target: TID, after: { assistance: true } });
    await cancelHandler(deps, null, { token: TOKEN, reason: 'changed my mind' }); expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()).toMatchObject({ status: 'cancelled', cancelReason: 'changed my mind' });
  });
  it('valet guest cancel is denied (staff must cancel)', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps);
    await expect(cancelHandler(deps, null, { token: TOKEN, reason: 'x' })).rejects.toMatchObject({ code: 'ticket_invalid_transition' });
  });
  it('rate limit: 6th call in window rejected', async () => {
    const deps = testDeps();
    for (let i = 0; i < 5; i++) await rateLimit(deps, 'k', 5, 60);
    await expect(rateLimit(deps, 'k', 5, 60)).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it('expired projection is rejected before any rate-limit write (zero residue for fabricated/expired tokens)', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps);
    await deps.db.doc(P.guestTicket(TOKEN)).update({ expiresAt: '2020-01-01T00:00:00.000Z' });
    await expect(requestVehicleHandler(deps, null, { token: TOKEN })).rejects.toMatchObject({ code: 'guest_token_expired' });
    expect((await deps.db.collection('rateLimits').get()).size).toBe(0);
  });
  it('guestToken mismatch after reassignment is rejected (anti-reassignment)', async () => {
    const deps = testDeps(); await seedOperator(deps); await seedTicket(deps);
    await deps.db.doc(P.ticket(OP, TID)).update({ guestToken: 'ZzYyXxWwVvUuTtSsRrQqPp' });
    await expect(requestVehicleHandler(deps, null, { token: TOKEN })).rejects.toMatchObject({ code: 'guest_token_expired' });
  });
  it('rate limit keys are isolated per token', async () => {
    const deps = testDeps();
    for (let i = 0; i < 5; i++) await rateLimit(deps, 'a', 5, 60);
    await expect(rateLimit(deps, 'a', 5, 60)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(rateLimit(deps, 'b', 5, 60)).resolves.toBeUndefined();
  });
});
