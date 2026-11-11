import { beforeEach, describe, expect, it } from 'vitest';
import { guestCreatedHandler } from './onGuestCreated.js';
import { guestWrittenHandler } from './onGuestWritten.js';
import { OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

beforeEach(async () => {
  await wipe(testDeps());
});

describe('guestCreatedHandler (onGuestCreated)', () => {
  it('mints roles:[\'guest\'] claims for an Auth user with no existing claims', async () => {
    const deps = testDeps();
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });
    await guestCreatedHandler(deps, { uid: 'g1' });
    expect((await deps.auth.getUser('g1')).customClaims).toEqual({ roles: ['guest'], claimsVersion: 1 });
  });

  it('no-op when the Auth user does not exist (does not throw)', async () => {
    const deps = testDeps();
    await expect(guestCreatedHandler(deps, { uid: 'ghost' })).resolves.toBeUndefined();
  });

  it('does not re-mint when the caller already holds roles:[\'guest\'] (claimsVersion left untouched)', async () => {
    const deps = testDeps();
    await deps.auth.createUser({ uid: 'g2', phoneNumber: '+13175550123' });
    await deps.auth.setCustomUserClaims('g2', { roles: ['guest'], claimsVersion: 7 });
    await guestCreatedHandler(deps, { uid: 'g2' });
    expect((await deps.auth.getUser('g2')).customClaims).toEqual({ roles: ['guest'], claimsVersion: 7 });
  });

  it('never clobbers a richer existing claim carrying an operatorId (staff identity)', async () => {
    const deps = testDeps();
    await deps.auth.createUser({ uid: 'staff1', email: 'staff@x.example.com', password: 'password123' });
    await deps.auth.setCustomUserClaims('staff1', { operatorId: OP, roles: ['attendant'], claimsVersion: 3 });
    await guestCreatedHandler(deps, { uid: 'staff1' });
    expect((await deps.auth.getUser('staff1')).customClaims).toEqual({ operatorId: OP, roles: ['attendant'], claimsVersion: 3 });
  });

  it('never clobbers a richer existing claim carrying a non-guest role even with no operatorId', async () => {
    const deps = testDeps();
    await deps.auth.createUser({ uid: 'venueUser1', email: 'vu@x.example.com', password: 'password123' });
    await deps.auth.setCustomUserClaims('venueUser1', { roles: ['venue_user'], claimsVersion: 2 });
    await guestCreatedHandler(deps, { uid: 'venueUser1' });
    expect((await deps.auth.getUser('venueUser1')).customClaims).toEqual({ roles: ['venue_user'], claimsVersion: 2 });
  });
});

describe('guestWrittenHandler (onGuestWritten)', () => {
  async function seedTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
    const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' }, ...over });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
  }

  it('propagates a consent.sms change onto the guest\'s OPEN ticket', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps);
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(t.guest.consentSms).toBe(false);
  });

  it('does NOT touch a TERMINAL (closed) ticket', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps, { status: 'closed', times: { checkedInAt: '2026-08-23T21:00:00.000Z', closedAt: '2026-08-23T21:00:00.000Z' } });
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(t.guest.consentSms).toBe(true); // untouched
  });

  it('no-op guard: an unrelated guest doc write (consent.sms unchanged) never queries/touches tickets', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps);
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: true } } });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(t.guest.consentSms).toBe(true);
  });

  it('idempotent: redelivering the same event twice converges without error, and a repeat fire that already matches is a zero-write no-op', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps);
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } });
    await expect(guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } })).resolves.toBeUndefined();
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(t.guest.consentSms).toBe(false);
  });

  it('a delete event (after undefined) is a no-op', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicket(deps);
    await expect(guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: undefined })).resolves.toBeUndefined();
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(t.guest.consentSms).toBe(true);
  });

  it('Fix round 1 ruling: pagination completes fully across multiple pages when under the maxPages ceiling', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = deps.newId();
      ids.push(id);
      const t = ticketDoc({ id, guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' } });
      await deps.db.doc(P.ticket(OP, id)).set(t);
      await ticketWrittenHandler(deps, { operatorId: OP, ticketId: id, before: null, after: t });
    }
    // pageSize 2, maxPages 10 → 3 pages (2+2+1) fully exhausts all 5 tickets, well under the ceiling.
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } }, { pageSize: 2, maxPages: 10 });
    for (const id of ids) {
      const t = (await deps.db.doc(P.ticket(OP, id)).get()).data() as { guest: { consentSms: boolean } };
      expect(t.guest.consentSms).toBe(false);
    }
  });

  it('Fix round 1 ruling: the maxPages ceiling actually bounds work — a trigger cannot run unbounded', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = deps.newId();
      ids.push(id);
      const t = ticketDoc({ id, guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' } });
      await deps.db.doc(P.ticket(OP, id)).set(t);
      await ticketWrittenHandler(deps, { operatorId: OP, ticketId: id, before: null, after: t });
    }
    // pageSize 1, maxPages 2 → only the first 2 (of 5) tickets are ever visited/updated; the ceiling
    // stops the walk before it reaches the rest, proving the cap is real, not just documented.
    await guestWrittenHandler(deps, { uid: 'g1', before: { consent: { sms: true } }, after: { consent: { sms: false } } }, { pageSize: 1, maxPages: 2 });
    let updated = 0;
    for (const id of ids) {
      const t = (await deps.db.doc(P.ticket(OP, id)).get()).data() as { guest: { consentSms: boolean } };
      if (!t.guest.consentSms) updated++;
    }
    expect(updated).toBe(2);
  });
});
