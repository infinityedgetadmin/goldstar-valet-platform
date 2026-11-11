import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guestCheckoutHandler, staffCheckoutHandler } from './checkout.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import * as registry from './registry.js';
import { StripeGateway } from './stripe.adapter.js';

// Firestore's `.data()` returns `DocumentData` (index-signature `any`); two-level chained access
// (`.data()?.payment.status`) trips `@typescript-eslint/no-unsafe-member-access` on the second hop,
// so this assertion casts through a narrow view first — matches staffCancel.test.ts's pattern.
type TicketPaymentView = { payment?: { status?: string } };

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

async function seed(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc(over);
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
}

describe('guest checkout', () => {
  it('prices from venue rates + preset tip, creates intent, marks payment pending, returns client secret', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps);
    const out = await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 20 } });
    expect(out).toMatchObject({ publishableKey: 'pk_test_x', total: 1926, tip: 321 }); // base 1500, tax 105 → subtotal 1605, tip 20% = 321
    expect(fake.calls.paymentIntentsCreate[0]!.params.amount).toBe(1926);
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
    expect(t.payment).toMatchObject({ status: 'pending', base: 1500, tax: 105, tip: 321, total: 1926, lastIntentId: 'pi_123', billTo: 'guest' });
    expect(((await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('pending');
  });

  it('rejects when already paid; custom tip clamped; no tip allowed; re-pricing cancels the prior pending intent', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps);
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 18 } });
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 25 } });
    expect(fake.calls.cancel).toHaveLength(1);
    expect(fake.calls.paymentIntentsCreate).toHaveLength(2);
    expect((await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'custom', amount: 999999 } })).tip).toBe(1605);
    expect((await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'none' } })).tip).toBe(0);
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.status': 'paid' });
    await expect(guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'none' } })).rejects.toMatchObject({ code: 'payment_already_paid' });
  });

  it('a re-checkout after a decline cancels the prior FAILED intent, not just a pending one (Ruling AO, finding 8)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps);
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 18 } });
    expect(fake.calls.paymentIntentsCreate).toHaveLength(1);
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.status': 'failed' }); // simulates a webhook payment_failed
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 25 } });
    expect(fake.calls.cancel).toHaveLength(1);
    expect(fake.calls.cancel[0]).toMatchObject({ id: 'pi_123' });
    expect(fake.calls.paymentIntentsCreate).toHaveLength(2);
  });

  // F2 (final review): the webhook-lag double-charge trace. Guest pays intent A, it SUCCEEDS at
  // Stripe, but the webhook that would flip the ticket to 'paid' lags — the ticket is still
  // 'pending' when the guest's still-open tab re-submits. Pre-F2, `cancelIntent`'s swallow of
  // `payment_intent_unexpected_state` let `runCheckout` fall straight through to mint a SECOND
  // intent against an already-charged card. Now `cancelIntent` retrieves the intent first and
  // surfaces `payment_already_paid` when it's genuinely already paid — no second intent.
  it('F2: re-submitting against a webhook-lagged pending ticket whose intent actually succeeded rejects payment_already_paid and mints no second intent', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps);
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 18 } });
    expect(fake.calls.paymentIntentsCreate).toHaveLength(1);
    // Ticket is still 'pending' (the webhook that would flip it to 'paid' hasn't landed) — the
    // guest's still-open tab taps Continue again, exactly runCheckout's re-price/re-checkout path.
    // Stripe's `cancel` refuses (the intent already succeeded) and `retrieve` confirms it.
    fake.nextCancelError = Object.assign(new Error('The PaymentIntent could not be canceled'), { code: 'payment_intent_unexpected_state' });
    fake.nextRetrieveStatus = 'succeeded';
    await expect(guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 25 } })).rejects.toMatchObject({
      code: 'payment_already_paid',
    });
    expect(fake.calls.cancel).toHaveLength(1);
    expect(fake.calls.paymentIntentsCreate).toHaveLength(1); // no second intent minted
  });

  // F2's companion case: the swallow-and-proceed behavior for a genuinely-cancellable race must be
  // unchanged — cancelIntent still absorbs payment_intent_unexpected_state when the intent's real
  // status is NOT one of the "already paid" statuses (here: already canceled from another tab), and
  // checkout proceeds to mint the new intent exactly as it did before F2.
  it('F2: a canceled-state intent still swallows the cancel error and checkout proceeds to a second intent', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps);
    await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 18 } });
    expect(fake.calls.paymentIntentsCreate).toHaveLength(1);
    fake.nextCancelError = Object.assign(new Error('cannot cancel'), { code: 'payment_intent_unexpected_state' });
    fake.nextRetrieveStatus = 'canceled';
    const out = await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 25 } });
    expect(out.total).toBeGreaterThan(0);
    expect(fake.calls.cancel).toHaveLength(1);
    expect(fake.calls.paymentIntentsCreate).toHaveLength(2);
  });

  // Ruling C-2: guests must stay able to pay for a parked car regardless of the operator's status
  // (controller ruling — parked cars must stay retrievable/payable). runCheckout's new optional
  // preloadedOperator parameter (added for staffCheckoutHandler below) must not leak a gate into this
  // path — guestCheckoutHandler never passes it, so this proves the guest path is genuinely unaffected.
  it('Ruling C-2: a suspended operator does NOT block guest checkout — guest callables are deliberately ungated', async () => {
    const deps = testDeps();
    useFake();
    await seed(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'preset', percent: 18 } });
    expect(out.total).toBeGreaterThan(0);
  });

  it('drive_home uses the quote as base and manual capture', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seed(deps, {
      jobType: 'drive_home',
      status: 'quoted',
      attendants: {},
      driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 1 } }, quote: { base: 2500, distanceMeters: 8000, durationSec: 900, amount: 4500, breakdown: [] }, chase: { status: 'pending' } },
    });
    const out = await guestCheckoutHandler(deps, null, { token: TOKEN, tip: { kind: 'none' } });
    expect(out.total).toBe(4500 + Math.round(4500 * 0.07));
    expect(fake.calls.paymentIntentsCreate[0]!.params.capture_method).toBe('manual');
  });
});

describe('staff checkout', () => {
  it('venue attendant creates in_app checkout; other venue denied', async () => {
    const deps = testDeps();
    useFake();
    await seed(deps);
    const out = await staffCheckoutHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: ['v1'] }, { ticketId: TID, tip: { kind: 'preset', percent: 18 }, method: 'in_app' });
    expect(out.total).toBe(1605 + Math.round(1605 * 0.18));
    await expect(
      staffCheckoutHandler(deps, { uid: 'att2', operatorId: OP, roles: ['attendant'], venueIds: ['v2'] }, { ticketId: TID, tip: { kind: 'none' }, method: 'in_app' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('owner/admin bypass venue scoping entirely', async () => {
    const deps = testDeps();
    useFake();
    await seed(deps);
    const outOwner = await staffCheckoutHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: ['v2'] }, { ticketId: TID, tip: { kind: 'none' }, method: 'in_app' });
    expect(outOwner.total).toBe(1605);
    // The first call left payment.status 'pending' (not paid/authorized), so a second checkout is
    // just a re-price, not a payment_already_paid rejection — fine to chain the admin call here too.
    const outAdmin = await staffCheckoutHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { ticketId: TID, tip: { kind: 'none' }, method: 'in_app' });
    expect(outAdmin.total).toBe(1605);
  });

  const TRUNCATED_VENUE_IDS = Array.from({ length: 20 }, (_, i) => `x${i + 1}`);

  it('attendant with truncated (>=20) claims venueIds falls back to the user doc; allowed when the user doc has the venue', async () => {
    const deps = testDeps();
    useFake();
    await seed(deps);
    await deps.db.doc(P.user(OP, 'att3')).set({ roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    const out = await staffCheckoutHandler(deps, { uid: 'att3', operatorId: OP, roles: ['attendant'], venueIds: TRUNCATED_VENUE_IDS }, { ticketId: TID, tip: { kind: 'none' }, method: 'in_app' });
    expect(out.total).toBe(1605);
  });

  // Ruling C-2: "pre-fetched" pattern — staffCheckoutHandler fetches the operator itself (to gate on
  // it) and hands it to runCheckout via the new preloadedOperator parameter, so runCheckout doesn't
  // fetch it a second time. Behaviorally this test only proves the gate fires; the zero-extra-read
  // claim itself is structural (see checkout.ts's own comment) rather than something a Firestore-emulator
  // test can directly count reads against.
  it('rejects with failed_precondition when the operator is suspended (Ruling C-2)', async () => {
    const deps = testDeps();
    useFake();
    await seed(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      staffCheckoutHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { ticketId: TID, tip: { kind: 'none' }, method: 'in_app' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });
});
