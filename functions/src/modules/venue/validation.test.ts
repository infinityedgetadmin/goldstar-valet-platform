import { beforeEach, expect, it } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import { redemptionAmount, staffApplyValidationHandler, venueIssueValidationHandler } from './validation.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { priceTicket } from '../payments/pricing.js';
import type { Operator, Ticket, Venue } from '@goldstar/platform';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };
const ADMIN: Caller = { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] };
const ATT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };

const CODE_RE = /^[A-Z0-9]{6}$/;
const T2 = '01912345-7abc-7def-8123-456789abcd88';

beforeEach(async () => {
  await wipe(testDeps());
});

async function seedParkedTicket(deps: ReturnType<typeof testDeps>, id = TID, over: Record<string, unknown> = {}) {
  const t = ticketDoc({ id, status: 'checked_in', ...over });
  await deps.db.doc(P.ticket(OP, id)).set(t);
  return t;
}

async function issued(deps: ReturnType<typeof testDeps>, input: Parameters<typeof venueIssueValidationHandler>[2], caller: Caller = HOST) {
  const { code } = await venueIssueValidationHandler(deps, caller, input);
  const snap = await deps.db.collection(`operators/${OP}/validations`).where('code', '==', code).get();
  return { code, doc: snap.docs[0]!.data(), id: snap.docs[0]!.id };
}

// ---------- venueIssueValidation ----------

it('issues a full validation: 6-char contract-shaped code, no stored amount (Ruling O: computed at redemption)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { code, doc } = await issued(deps, { venueId: V1, type: 'full' });
  expect(code).toMatch(CODE_RE);
  expect(doc).toMatchObject({ venueId: V1, type: 'full', issuedBy: 'host1', issuedAt: NOW });
  expect(doc.amount).toBeUndefined();
  expect(doc.redeemedTicketId).toBeUndefined();
  // RULING AE: every code expires 24h after issue — an unbounded code is a standing money exposure.
  expect(doc.expiresAt).toBe(new Date(Date.parse(NOW) + 24 * 3600_000).toISOString());
});

it('partial: requires an amount, enforces the venue max, and stores integer cents', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'partial' })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'partial', amount: 1501 })).rejects.toMatchObject({ code: 'invalid_argument' });
  const { doc } = await issued(deps, { venueId: V1, type: 'partial', amount: 700 });
  expect(doc.amount).toBe(700);
});

it('partial: rejected when the venue disallows partials', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.venue(OP, V1)).update({ 'rates.validations.allowPartial': false });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'partial', amount: 100 })).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('MONEY-CONFIG STRICTNESS: a stray amount on a non-partial, or a stray/unknown rateId, is rejected — never silently ignored', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'full', amount: 100 })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'comp', rateId: 'std' })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'rate' })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'rate', rateId: 'nope' })).rejects.toMatchObject({ code: 'invalid_argument' });
});

it('SECURITY: role/venue gates mirror the rules — attendant denied; venue_user outside their claim denied; admin any venue allowed', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(venueIssueValidationHandler(deps, ATT, { venueId: V1, type: 'full' })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(
    venueIssueValidationHandler(deps, { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] }, { venueId: V1, type: 'full' }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  const { code } = await venueIssueValidationHandler(deps, ADMIN, { venueId: V1, type: 'full' });
  expect(code).toMatch(CODE_RE);
});

it('rejects issuing under a suspended operator', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'full' })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- redemptionAmount (Ruling O unit surface) ----------

const VENUE_FIXTURE = {
  rates: { valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }, { id: 'evt', label: 'Event', amount: 1000 }], taxRateBps: 700, fees: [] } },
} as unknown as Venue;
const TICKET_FIXTURE = { times: { checkedInAt: NOW } } as unknown as Ticket;

it('RULING O: full and comp discount the full CURRENT base; partial uses the stored amount; rate discounts down to the alternate rate', () => {
  expect(redemptionAmount({ type: 'full' }, VENUE_FIXTURE, TICKET_FIXTURE, NOW)).toEqual({ amount: 1500, base: 1500 });
  expect(redemptionAmount({ type: 'comp' }, VENUE_FIXTURE, TICKET_FIXTURE, NOW)).toEqual({ amount: 1500, base: 1500 });
  expect(redemptionAmount({ type: 'partial', amount: 700 }, VENUE_FIXTURE, TICKET_FIXTURE, NOW)).toEqual({ amount: 700, base: 1500 });
  expect(redemptionAmount({ type: 'rate', rateId: 'evt' }, VENUE_FIXTURE, TICKET_FIXTURE, NOW)).toEqual({ amount: 500, base: 1500 });
});

it('RULING O: an hourly base grows between issue and redemption — full covers what is owed NOW, not at issue time', () => {
  const hourly = { rates: { valet: { model: 'hourly', items: [{ id: 'h', label: 'Hourly', amount: 500 }], taxRateBps: 0, fees: [] } } } as unknown as Venue;
  const threeHoursLater = new Date(Date.parse(NOW) + 3 * 3600_000).toISOString();
  expect(redemptionAmount({ type: 'full' }, hourly, TICKET_FIXTURE, threeHoursLater)).toEqual({ amount: 1500, base: 1500 });
});

it('RULING O: a rate item deleted since issue fails honestly rather than guessing a price', () => {
  expect(() => redemptionAmount({ type: 'rate', rateId: 'gone' }, VENUE_FIXTURE, TICKET_FIXTURE, NOW)).toThrowError(/rate no longer available/);
});

// ---------- staffApplyValidation + the shared guard (Ruling F/S) ----------

it('redeems at the stand: validation gets redeemedTicketId + the Ruling S redemption {amount, base, at} group, ticket gets the pricing fields, marker exists', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps);
  const { code, id } = await issued(deps, { venueId: V1, type: 'full' });

  const out = await staffApplyValidationHandler(deps, ATT, { ticketId: TID, code });
  expect(out.validationAmount).toBe(1500);

  const v = (await deps.db.doc(P.validation(OP, id)).get()).data()!;
  expect(v.redeemedTicketId).toBe(TID);
  expect(v.redemption).toEqual({ amount: 1500, base: 1500, at: NOW });

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toEqual({ validationId: id, validationAmount: 1500 });

  const marker = await deps.db.doc(`processedEvents/val_${id}`).get();
  expect(marker.exists).toBe(true);
  expect(marker.data()).toMatchObject({ ticketId: TID, source: 'staff' });

  // Integration with pricing: the next checkout's priceTicket consumes exactly these fields.
  const op = (await deps.db.doc(P.operator(OP)).get()).data() as Operator;
  const venue = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Venue;
  const priced = priceTicket(op, venue, t as Ticket, { kind: 'none' }, NOW);
  expect(priced.validation).toBe(1500);
  expect(priced.base).toBe(0);
});

it('RULING F, THE RACE: two concurrent redemptions of one code — exactly one wins, one rejects, one marker, one winner ticket', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps, TID);
  await seedParkedTicket(deps, T2, { guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true } });
  const { code, id } = await issued(deps, { venueId: V1, type: 'partial', amount: 700 });

  const results = await Promise.allSettled([
    staffApplyValidationHandler(deps, ATT, { ticketId: TID, code }),
    staffApplyValidationHandler(deps, ATT, { ticketId: T2, code }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'failed_precondition' });

  const v = (await deps.db.doc(P.validation(OP, id)).get()).data()!;
  const winner = v.redeemedTicketId as string;
  const loser = winner === TID ? T2 : TID;
  expect([TID, T2]).toContain(winner);
  const winnerTicket = (await deps.db.doc(P.ticket(OP, winner)).get()).data()!;
  const loserTicket = (await deps.db.doc(P.ticket(OP, loser)).get()).data()!;
  expect(winnerTicket.payment).toEqual({ validationId: id, validationAmount: 700 });
  expect(loserTicket.payment).toBeUndefined();
  expect((await deps.db.doc(`processedEvents/val_${id}`).get()).data()!.ticketId).toBe(winner);
});

it('a second, sequential redemption of an already-redeemed code rejects', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps);
  await seedParkedTicket(deps, T2, { guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true } });
  const { code } = await issued(deps, { venueId: V1, type: 'full' });
  await staffApplyValidationHandler(deps, ATT, { ticketId: TID, code });
  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: T2, code })).rejects.toMatchObject({ code: 'failed_precondition', message: 'validation already redeemed' });
});

it('guards: expired code, wrong-venue ticket, already-paid ticket, closed ticket, unknown code', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps);
  const { code, id } = await issued(deps, { venueId: V1, type: 'full' });

  await deps.db.doc(P.validation(OP, id)).update({ expiresAt: '2020-01-01T00:00:00.000Z' });
  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: TID, code })).rejects.toMatchObject({ code: 'failed_precondition', message: 'validation expired' });
  await deps.db.doc(P.validation(OP, id)).update({ expiresAt: '2030-01-01T00:00:00.000Z' });

  await deps.db.doc(P.ticket(OP, TID)).update({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', method: 'web' } });
  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: TID, code })).rejects.toMatchObject({ code: 'payment_already_paid' });

  await deps.db.doc(P.ticket(OP, TID)).update({ status: 'closed', payment: { status: 'none', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', billTo: 'guest' } });
  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: TID, code })).rejects.toMatchObject({ code: 'ticket_closed' });

  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: TID, code: 'ZZZ999' })).rejects.toMatchObject({ code: 'not_found' });
});

it("wrong venue: a v2 ticket can't redeem a v1 code (the venue-scoped lookup reads as not_found)", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const v1Data = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Record<string, unknown>;
  await deps.db.doc(P.venue(OP, 'v2')).set({ ...v1Data, id: 'v2', name: 'Rooftop' });
  await seedParkedTicket(deps, T2, { venueId: 'v2' });
  const { code } = await issued(deps, { venueId: V1, type: 'full' });
  const attBoth: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1, 'v2'] };
  await expect(staffApplyValidationHandler(deps, attBoth, { ticketId: T2, code })).rejects.toMatchObject({ code: 'not_found' });
});

it('SECURITY: staff scoping — a venue_user cannot redeem, and an attendant outside the ticket venue is denied', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps);
  const { code } = await issued(deps, { venueId: V1, type: 'full' });
  await expect(staffApplyValidationHandler(deps, HOST, { ticketId: TID, code })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(
    staffApplyValidationHandler(deps, { uid: 'att9', operatorId: OP, roles: ['attendant'], venueIds: ['v-other'] }, { ticketId: TID, code }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

it("issue with ticketId applies immediately through the SAME shared guard (source 'issue')", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedParkedTicket(deps);
  const { id } = await issued(deps, { venueId: V1, type: 'partial', amount: 500, ticketId: TID });

  const v = (await deps.db.doc(P.validation(OP, id)).get()).data()!;
  expect(v.redeemedTicketId).toBe(TID);
  expect(v.redemption).toEqual({ amount: 500, base: 1500, at: NOW });
  expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()!.payment).toEqual({ validationId: id, validationAmount: 500 });
  expect((await deps.db.doc(`processedEvents/val_${id}`).get()).data()!.source).toBe('issue');
});

it('issue-with-ticketId failure leaves the validation issued and redeemable (retry surface, not a dangling half-state)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  // no such ticket
  await expect(venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'full', ticketId: T2 })).rejects.toMatchObject({ code: 'not_found' });
  const snap = await deps.db.collection(`operators/${OP}/validations`).get();
  expect(snap.docs).toHaveLength(1);
  expect(snap.docs[0]!.data().redeemedTicketId).toBeUndefined();
});
