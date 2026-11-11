import { beforeEach, describe, expect, it } from 'vitest';
import { guestEmailReceiptHandler } from './emailReceipt.js';
import type { Caller } from '../../lib/callable.js';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

beforeEach(async () => {
  await wipe(testDeps());
});

const GUEST: Caller = { uid: 'g1', roles: ['guest'], venueIds: [] };

async function seedPaidTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc({
    status: 'closed',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' },
    times: { checkedInAt: NOW, closedAt: NOW },
    payment: { status: 'paid', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', paidAt: NOW },
    ...over,
  });
  // Task 7: `over.id` needs to drive the WRITE PATH too, not just the doc's own `id` field — the
  // distinct-recipients-per-ticket test needs a genuinely second ticket doc, not the same TID path
  // overwritten with a doc whose internal id disagrees with where it actually lives.
  const id = (over.id as string | undefined) ?? TID;
  await deps.db.doc(P.ticket(OP, id)).set(t);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: id, before: null, after: t });
  return t;
}

describe('guestEmailReceipt', () => {
  it('queues an outboundMessages email with the receipt template and this ticket\'s totals; audited', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    const out = await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    expect(out).toEqual({ ok: true });
    // Filtered to channel:'email' — ticketWrittenHandler's own 'welcome'/'survey' SMS enqueues (fired
    // by seedPaidTicket's create + closed-status write above) also carry this ticketId.
    const q = await deps.db.collection('outboundMessages').where('ticketId', '==', TID).where('channel', '==', 'email').get();
    expect(q.size).toBe(1);
    expect(q.docs[0]!.data()).toMatchObject({ channel: 'email', template: 'receipt', to: 'taylor@example.com', status: 'queued', attempts: 0 });
    expect(q.docs[0]!.data().vars).toMatchObject({ venueName: 'St. Elmo', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD' });
    const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'guest.emailReceipt').get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0]!.data()).toMatchObject({ actorUid: 'g1', target: TID });
    // PII minimization: the email address is not stored in the audit payload.
    expect(JSON.stringify(logs.docs[0]!.data())).not.toContain('taylor@example.com');
  });

  it('does not collide with the automatic SMS receipt\'s deterministic outbox id (CARRY 2c)', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    // The automatic SMS receipt path (applyEvent.ts/enqueueSms) uses id `${ticketId}_receipt` — seed
    // it directly to prove the email path uses a genuinely distinct id, not a shared/collapsing one.
    await deps.db.doc(P.outbound(`${TID}_receipt`)).create({ id: `${TID}_receipt`, channel: 'sms', operatorId: OP, to: '+13175550123', template: 'receipt', vars: {}, status: 'sent', attempts: 1, createdAt: NOW });
    await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    const smsDoc = (await deps.db.doc(P.outbound(`${TID}_receipt`)).get()).data();
    expect(smsDoc).toMatchObject({ channel: 'sms', status: 'sent' }); // untouched by the email enqueue
    const q = await deps.db.collection('outboundMessages').where('channel', '==', 'email').get();
    expect(q.size).toBe(1);
  });

  it('a repeated request for the same ticket+email is idempotent (no duplicate outbound doc)', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    const q = await deps.db.collection('outboundMessages').where('channel', '==', 'email').get();
    expect(q.size).toBe(1);
  });

  it('a different email address for the same ticket gets its own outbound doc', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'other@example.com' });
    const q = await deps.db.collection('outboundMessages').where('channel', '==', 'email').get();
    expect(q.size).toBe(2);
  });

  it('a ticket that does not belong to the caller is rejected with permission_denied (no cross-tenant oracle)', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps, { guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'someone-else' } });
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('an unknown ticketId is rejected the SAME way as a foreign ticket — permission_denied, not not_found', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: '01912345-7abc-7def-8123-456789abcdff', email: 'taylor@example.com' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a ticket with no completed payment is rejected with failed_precondition', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' } }); // status checked_in, no payment
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' })).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('Task 7: rate limits per uid (10/600s) — the 11th call in the window rejects with rate_limited', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    for (let i = 0; i < 10; i++) await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' });
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'taylor@example.com' })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('Task 7: distinct recipients per ticket are capped at 5 — the (ticketId,email) dedupe alone lets a fresh address bypass the per-uid limit, so this closes that gap independently', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    for (let i = 0; i < 5; i++) {
      await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: `recipient${i}@example.com` });
    }
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'recipient5@example.com' })).rejects.toMatchObject({ code: 'rate_limited' });
    // The cap is on DISTINCT recipients, not calls — a retry of an ALREADY-recorded address must
    // still succeed (idempotent, matching the existing (ticketId,email) dedupe test above), never
    // counted as a 6th distinct value.
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: 'recipient0@example.com' })).resolves.toEqual({ ok: true });
  });

  it('Task 7: the distinct-recipients cap is per-TICKET, not per-guest — a second ticket gets its own fresh cap', async () => {
    const deps = testDeps();
    await seedPaidTicket(deps);
    const TID2 = '01912345-7abc-7def-8123-456789abcdf2';
    await seedPaidTicket(deps, { id: TID2 });
    for (let i = 0; i < 5; i++) {
      await guestEmailReceiptHandler(deps, GUEST, { ticketId: TID, email: `recipient${i}@example.com` });
    }
    // Ticket 1 is now at its cap; ticket 2 has never been emailed and must still accept a first request.
    await expect(guestEmailReceiptHandler(deps, GUEST, { ticketId: TID2, email: 'recipient0@example.com' })).resolves.toEqual({ ok: true });
  });
});
