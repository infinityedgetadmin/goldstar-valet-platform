import { beforeEach, describe, expect, it } from 'vitest';
import { ticketsRevealPhoneHandler } from './revealPhone.js';
import { OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

async function seedTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc(over));
}

describe('ticketsRevealPhone: role gate', () => {
  it('denies a lead (admin+ only, unlike ticketsSearch)', async () => {
    const deps = testDeps();
    await seedTicket(deps);
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] }, { ticketId: TID, reason: 'guest called in' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('denies an attendant', async () => {
    const deps = testDeps();
    await seedTicket(deps);
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] }, { ticketId: TID, reason: 'guest called in' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects an admin with failed_precondition when the operator is suspended (no auditQuery-style platform_admin exemption here — disclosed judgment call)', async () => {
    const deps = testDeps();
    await seedTicket(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'guest called in' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    // platform_admin sessions carry 'admin' too (Ruling C-2) — still gated, unlike auditQuery.
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] }, { ticketId: TID, reason: 'guest called in' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });
});

describe('ticketsRevealPhone: reveal + audit', () => {
  it('an owner reveals the E.164 number and an audit row is written that never contains the number itself', async () => {
    const deps = testDeps();
    await seedTicket(deps, { guest: { phoneE164: '+13175559876', phoneLast4: '9876', consentSms: true } });
    const out = await ticketsRevealPhoneHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { ticketId: TID, reason: 'lost item follow-up' });
    expect(out.phoneE164).toBe('+13175559876');

    const auditSnap = await deps.db.collection(`operators/${OP}/auditLog`).get();
    expect(auditSnap.docs).toHaveLength(1);
    const entry = auditSnap.docs[0]!.data();
    expect(entry).toMatchObject({ operatorId: OP, actorUid: 'owner1', action: 'ticket.revealPhone', target: TID, after: { reason: 'lost item follow-up' } });
    expect(JSON.stringify(entry)).not.toContain('+13175559876');
    expect(JSON.stringify(entry)).not.toContain('9876');
  });

  it('an admin (not owner) can also reveal', async () => {
    const deps = testDeps();
    await seedTicket(deps, { guest: { phoneE164: '+13175551212', phoneLast4: '1212', consentSms: true } });
    const out = await ticketsRevealPhoneHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'callback requested' });
    expect(out.phoneE164).toBe('+13175551212');
  });
});

describe('ticketsRevealPhone: not-found classes', () => {
  it('a sentinel 0000 (QR-only, no phone collected) ticket returns not_found, never a stale/synthetic number', async () => {
    const deps = testDeps();
    // Mirrors Plan 2b's staff no-phone flow: guestToken exists, phoneLast4 is the '0000' sentinel,
    // and — per ticket.ts's own comment on `guest.phoneLast4` — no `phoneE164` is ever written for it.
    await seedTicket(deps, { guest: { phoneLast4: '0000', consentSms: false } });
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { ticketId: TID, reason: 'front desk asked' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a non-existent ticket returns not_found', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(
      ticketsRevealPhoneHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { ticketId: TID, reason: 'front desk asked' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
