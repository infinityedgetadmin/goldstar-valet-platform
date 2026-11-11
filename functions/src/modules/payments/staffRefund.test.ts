import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staffRefundHandler } from './staffRefund.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from './registry.js';
import { StripeGateway } from './stripe.adapter.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

async function seedPaidTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(
    ticketDoc({
      status: 'closed',
      payment: { status: 'paid', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' },
      ...over,
    }),
  );
}

describe('staffRefund', () => {
  it('denies an attendant', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps);
    await expect(
      staffRefundHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { ticketId: TID, reason: 'guest request' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('denies a lead at another venue', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps);
    await expect(
      staffRefundHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: ['v2'] }, { ticketId: TID, reason: 'guest request' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a lead at the ticket venue passes a partial amount through to the gateway', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedPaidTicket(deps);
    const out = await staffRefundHandler(deps, { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: ['v1'] }, { ticketId: TID, amount: 500, reason: 'partial refund' });
    expect(out.refundRef).toBe('re_1');
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.calls.refunds[0]!.params).toMatchObject({ amount: 500 });
  });

  it('rejects an amount greater than the ticket total', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps);
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 999_999, reason: 'oops' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  // Ruling C-2: the rules-boundary suspension gate (Ruling C) only stops direct Firestore access —
  // this staff-scoped callable runs on the Admin SDK, bypassing rules entirely, so it needs its own
  // gate. "full-fetch" pattern: staffRefundHandler doesn't otherwise fetch the operator doc, so
  // requireActiveOperator does the one added read itself.
  it('rejects with failed_precondition when the operator is suspended (Ruling C-2)', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'guest request' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('rejects an unpaid ticket with failed_precondition', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'guest request' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  // Ruling AU (1d final review, finding 14): refund.ts's authorized branch always voids the FULL
  // authorization via cancelIntent, silently ignoring `amount` — a partial request on an authorized
  // (uncaptured) ticket must fail honestly instead of surprise-voiding the whole hold.
  it('rejects a partial amount on an authorized (uncaptured) ticket with invalid_argument (Ruling AU)', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps, { payment: { status: 'authorized', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 500, reason: 'partial on authorized' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('allows a FULL amount refund on an authorized ticket (voids via cancelIntent)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedPaidTicket(deps, { payment: { status: 'authorized', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    const out = await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 1905, reason: 'full on authorized' });
    expect(out.refundRef).toBe('void');
    expect(fake.calls.cancel).toHaveLength(1);
  });

  it('allows an amount-less (implicit full) refund on an authorized ticket without the AU guard tripping', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedPaidTicket(deps, { payment: { status: 'authorized', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    const out = await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'full' });
    expect(out.refundRef).toBe('void');
    expect(fake.calls.cancel).toHaveLength(1);
  });

  // Ruling AH: the same write that sets refundRequested:true persists refundRequestId/amount/reason —
  // assert that write shape directly, since it's what makes the trigger-race fix (webhook.test.ts) work.
  // Forced Stripe failure so the write is observable afterward: on SUCCESS, Ruling AX now clears these
  // same fields (a later unrelated request must never inherit them) — the catch/retry branch does not
  // touch them, which is exactly why they must survive a failure for the retry to reuse them.
  it('persists refundRequestId + amount + reason in the SAME write that sets refundRequested:true, surviving a failed attempt (Ruling AH)', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.refunds.create = () => Promise.reject(new Error('stripe down'));
    await seedPaidTicket(deps);
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 500, reason: 'partial refund' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    const after = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment: { refundRequestId?: string; refundAmount?: number; refundReason?: string } };
    expect(after.payment.refundRequestId).toBeTruthy();
    expect(after.payment.refundAmount).toBe(500);
    expect(after.payment.refundReason).toBe('partial refund');
  });

  // Ruling AX (finding N1): the SUCCESS side of the same coin — once a refund actually completes, its
  // amount/reason/nonce must not linger on the doc for a later unrelated request to inherit.
  it('clears refundRequestId/refundAmount/refundReason once the refund actually succeeds (Ruling AX)', async () => {
    const deps = testDeps();
    useFake();
    await seedPaidTicket(deps);
    await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 500, reason: 'partial refund' });
    const after = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment: { refundRequestId?: string; refundAmount?: number; refundReason?: string } };
    expect(after.payment.refundRequestId).toBeUndefined();
    expect(after.payment.refundAmount).toBeUndefined();
    expect(after.payment.refundReason).toBeUndefined();
  });

  // Ruling AQ (finding 10): a non-success outcome must map to provider_unavailable WITHOUT reading a
  // stale lastRefundRef left over from a PRIOR successful refund on this same ticket.
  it('a failure on a SECOND refund request never returns the stale lastRefundRef from the first (Ruling AQ)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedPaidTicket(deps);
    const first = await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 300, reason: 'first partial' });
    expect(first.refundRef).toBe('re_1');
    // The remainder is still refundable (Ruling AK) — but this second attempt fails at Stripe.
    fake.refunds.create = () => Promise.reject(new Error('stripe down'));
    await expect(
      staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 200, reason: 'second partial' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  // Ruling AX (finding N1): a stale payment.refundAmount left over from an earlier PARTIAL request
  // must never leak into a later FULL (amount-less) request on the same ticket.
  it('a partial refund followed by a FULL refund never carries the stale partial amount to the gateway (Ruling AX)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedPaidTicket(deps);
    const first = await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, amount: 500, reason: 'first partial' });
    expect(first.refundRef).toBe('re_1');
    expect(fake.calls.refunds[0]!.params).toMatchObject({ amount: 500 });
    const second = await staffRefundHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, reason: 'remainder, full' });
    expect(second.refundRef).toBe('re_1'); // FakeStripe always returns re_1; distinctness isn't the point here
    expect(fake.calls.refunds).toHaveLength(2);
    expect(fake.calls.refunds[1]!.params).not.toHaveProperty('amount');
  });
});
