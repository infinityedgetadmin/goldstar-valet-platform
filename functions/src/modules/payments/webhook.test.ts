import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPaymentEvent } from './applyEvent.js';
import { handleStripeWebhook, type WebhookRequest, type WebhookResponse } from './webhook.js';
import type { PaymentEvent } from './port.js';
import { reclaimStuckRefunds, refundRequestedHandler } from './refund.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { StripeGateway } from './stripe.adapter.js';

// Firestore's `.data()` returns `DocumentData` (index-signature `any`); two-level chained access
// (`.data()?.payment.status`) trips `@typescript-eslint/no-unsafe-member-access` on the second hop,
// so assertions cast through this narrow view first — matches staffCancel.test.ts's pattern.
type TicketPaymentView = {
  payment?: {
    status?: string;
    refundRequested?: boolean;
    refundAttempts?: number;
    refundInProgress?: boolean;
    refundRequestId?: string;
    refundAmount?: number;
    refundReason?: string;
    refundRetryAt?: string;
    lastIntentId?: string;
    lastRefundRef?: string;
  };
};

const OTHER_TID = '01912345-7abc-7def-8123-456789abcdff';

beforeEach(async () => {
  await wipe(testDeps());
});

const paid = {
  kind: 'payment_succeeded' as const,
  eventId: 'evt_1',
  providerRef: 'pi_123',
  amount: 1926,
  base: 1500,
  tip: 321,
  tax: 105,
  fees: 0,
  currency: 'USD',
  operatorId: OP,
  ticketId: TID,
  chargeRef: 'ch_1',
};

// ---------- Plan 8 Task 3 (#7): the TRANSPORT, which had no tests ----------
function fakeReq(sig: string | undefined): WebhookRequest {
  return { get: (h) => (h === 'stripe-signature' ? sig : undefined), rawBody: Buffer.from('{}') };
}
function fakeRes() {
  const r = { code: 0, body: undefined as unknown, status(code: number) { r.code = code; return r; }, send(b: string) { r.body = b; }, json(b: unknown) { r.body = b; } };
  return r as typeof r & WebhookResponse;
}
/** A gateway whose parseWebhook returns a script — or throws, as a real signature failure would. */
function scriptedGw(script: PaymentEvent[] | Error) {
  const calls: unknown[] = [];
  return { calls, parseWebhook: (i: unknown) => { calls.push(i); return script instanceof Error ? Promise.reject(script) : Promise.resolve(script); } };
}
async function seedPendingTicket(deps: ReturnType<typeof testDeps>) {
  await seedOperator(deps);
  const t = ticketDoc({ payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
}

describe('stripe webhook transport (Plan 8 Task 3, #7)', () => {
  it('a missing stripe-signature header is 400 before the body is ever parsed', async () => {
    const deps = testDeps();
    const gw = scriptedGw([paid]);
    const res = fakeRes();
    await handleStripeWebhook({ deps, gw, secret: 'whsec' }, fakeReq(undefined), res);
    expect(res.code).toBe(400);
    expect(res.body).toBe('missing signature');
    expect(gw.calls).toHaveLength(0);
  });
  it('a parse/signature failure is 400 "invalid" and applies nothing', async () => {
    const deps = testDeps();
    await seedPendingTicket(deps);
    const res = fakeRes();
    await handleStripeWebhook({ deps, gw: scriptedGw(new Error('No signatures found matching the expected signature')), secret: 'whsec' }, fakeReq('t=1,v1=bad'), res);
    expect(res.code).toBe(400);
    expect(res.body).toBe('invalid');
    expect((await deps.db.doc(P.processed('stripe', 'evt_1')).get()).exists).toBe(false);
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('pending');
  });
  it('a valid delivery is 200 {received:true} and the event lands; the secret and signature reach the gateway verbatim', async () => {
    const deps = testDeps();
    await seedPendingTicket(deps);
    const gw = scriptedGw([paid]);
    const res = fakeRes();
    await handleStripeWebhook({ deps, gw, secret: 'whsec_test' }, fakeReq('t=1,v1=ok'), res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(gw.calls[0]).toMatchObject({ signature: 't=1,v1=ok', secret: 'whsec_test' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
  });
  it('the same event.id delivered twice (Stripe retry) is 200 both times and applied once', async () => {
    const deps = testDeps();
    await seedPendingTicket(deps);
    const applied: string[] = [];
    const apply = async (d: typeof deps, ev: PaymentEvent) => { const out = await applyPaymentEvent(d, ev); applied.push(`${ev.eventId}:${out}`); return out; };
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes();
      await handleStripeWebhook({ deps, gw: scriptedGw([paid]), secret: 'whsec', apply }, fakeReq('sig'), res);
      expect(res.code).toBe(200);
    }
    expect(applied).toEqual(['evt_1:applied', 'evt_1:duplicate']);
  });
  it('N4: a throw on event 2 of 3 answers 400 with event 1 applied and event 3 untouched; redelivery resumes at 2 — safe because every event is idempotent per id', async () => {
    const deps = testDeps();
    await seedPendingTicket(deps);
    const evs: PaymentEvent[] = [
      { ...paid, eventId: 'evt_a' },
      { ...paid, kind: 'payment_authorized', eventId: 'evt_b', amount: 500 },
      { ...paid, kind: 'refunded', eventId: 'evt_c', refundRef: 're_1', refundAmount: 100 },
    ];
    let failOnce = true;
    const apply = (d: typeof deps, ev: PaymentEvent) => {
      if (ev.eventId === 'evt_b' && failOnce) { failOnce = false; return Promise.reject(new Error('transient')); }
      return applyPaymentEvent(d, ev);
    };
    const first = fakeRes();
    await handleStripeWebhook({ deps, gw: scriptedGw(evs), secret: 'whsec', apply }, fakeReq('sig'), first);
    expect(first.code).toBe(400);
    expect((await deps.db.doc(P.processed('stripe', 'evt_a')).get()).exists).toBe(true);   // applied before the failure
    expect((await deps.db.doc(P.processed('stripe', 'evt_b')).get()).exists).toBe(false);  // the one that threw
    expect((await deps.db.doc(P.processed('stripe', 'evt_c')).get()).exists).toBe(false);  // never reached
    // Stripe redelivers the same payload.
    const second = fakeRes();
    await handleStripeWebhook({ deps, gw: scriptedGw(evs), secret: 'whsec', apply }, fakeReq('sig'), second);
    expect(second.code).toBe(200);
    for (const id of ['evt_a', 'evt_b', 'evt_c']) expect((await deps.db.doc(P.processed('stripe', id)).get()).exists).toBe(true);
    // And evt_a was NOT re-applied on redelivery: its row's charge-time `at` and status are as the first delivery left them.
    const row = (await deps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { status?: string; refunds?: unknown[] } | undefined;
    expect(row?.status).toBe('succeeded'); // the re-fired authorized (evt_b) did not downgrade it (#6)
    expect(row?.refunds).toHaveLength(1);  // evt_c's partial refund appended exactly once
  });
});

describe('apply payment event', () => {
  it('succeeded → transaction + ticket paid + projection paid; replay is a no-op', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
    expect(await applyPaymentEvent(deps, paid)).toBe('applied');
    expect(await applyPaymentEvent(deps, paid)).toBe('duplicate');
    expect((await deps.db.doc(P.tx(OP, 'pi_123')).get()).data()).toMatchObject({ kind: 'charge', status: 'succeeded', total: 1926, tip: 321, method: 'web' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    expect(((await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
  });

  it('late authorized event never regresses paid/cancelled; crash-safety: key and writes are one transaction', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, kind: 'payment_authorized', eventId: 'evt_late' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    expect((await deps.db.doc(P.processed('stripe', 'evt_late')).get()).data()?.regress).toBe(true);
  });

  it('#6: a re-fired authorized event after capture never rewrites the SETTLED transaction row (ledger reads then)', async () => {
    // Stripe re-fires amount_capturable_updated after a partial capture, with a NEW event.id and
    // `amount` = the REMAINING capturable — so per-event dedupe cannot catch it. The ticket was
    // already guarded (regress → skipTicketUpdate) but the tx row write was unconditional: the
    // ledger row for a settled charge flipped to status 'authorized' with the remainder as its total.
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    expect(await applyPaymentEvent(deps, paid)).toBe('applied');
    expect(await applyPaymentEvent(deps, { ...paid, kind: 'payment_authorized', eventId: 'evt_refire', amount: 500 })).toBe('applied');
    const row = (await deps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { status?: string; total?: number } | undefined;
    expect(row?.status).toBe('succeeded');
    expect(row?.total).toBe(1926);
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    expect((await deps.db.doc(P.processed('stripe', 'evt_refire')).get()).data()?.regress).toBe(true);
  });

  it('a late failed event never regresses an already-paid ticket (Ruling AL, finding 5a)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, kind: 'payment_failed', eventId: 'evt_late_fail', providerRef: 'pi_123', amount: 1605, failureMessage: 'card declined' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    expect((await deps.db.doc(P.processed('stripe', 'evt_late_fail')).get()).data()).toMatchObject({ regress: true });
  });

  it('an event about an abandoned/older intent writes only the tx row — ticket payment state and lastIntentId are untouched (Ruling AL, finding 5b)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // The ticket has since moved on to intent pi_456 (a re-checkout after pi_123 failed/was abandoned).
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_456' } }));
    // A delayed payment_failed for the OLD intent pi_123 finally arrives.
    await applyPaymentEvent(deps, { ...paid, kind: 'payment_failed', eventId: 'evt_stale', providerRef: 'pi_123', amount: 1605, failureMessage: 'card declined' });
    const p = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment;
    expect(p?.status).toBe('paid'); // untouched
    expect(p?.lastIntentId).toBe('pi_456'); // never repointed at the dead intent
    expect((await deps.db.doc(P.tx(OP, 'pi_123')).get()).data()).toMatchObject({ status: 'failed' }); // still recorded, tx-row-only
    expect((await deps.db.doc(P.processed('stripe', 'evt_stale')).get()).data()).toMatchObject({ staleIntent: true });
  });

  it('failed and refunded events', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, kind: 'payment_failed', eventId: 'evt_2', failureMessage: 'card declined' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('failed');
    await applyPaymentEvent(deps, { ...paid, eventId: 'evt_3' });
    await applyPaymentEvent(deps, { ...paid, kind: 'refunded', eventId: 'evt_4', refundAmount: 1926, refundRef: 're_1' });
    const tx = (await deps.db.doc(P.tx(OP, 'pi_123')).get()).data()!;
    expect(tx.status).toBe('refunded');
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('refunded');
  });

  it('a partial refund keeps the ticket paid and appends to the transaction refunds array; a second partial appends without erasing the first (Ruling AK, finding 4)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, kind: 'payment_succeeded', eventId: 'evt_p1', providerRef: 'pi_123', amount: 1605, tip: 0 });
    await applyPaymentEvent(deps, { ...paid, kind: 'refunded', eventId: 'evt_r1', providerRef: 'pi_123', amount: 1605, tip: 0, refundAmount: 500, refundRef: 're_1' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    let tx = (await deps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { status: string; refunds: { refundRef: string; amount: number }[] };
    expect(tx.status).toBe('succeeded');
    expect(tx.refunds).toHaveLength(1);
    expect(tx.refunds[0]).toMatchObject({ refundRef: 're_1', amount: 500 });

    // refundAmount here is Stripe's CUMULATIVE amount_refunded (1605 = fully refunded), not this
    // event's own delta — the stored entry (Ruling AY, finding N2) must record the delta (1605-500 =
    // 1105), not the cumulative total, or the two entries would sum to more than the charge.
    await applyPaymentEvent(deps, { ...paid, kind: 'refunded', eventId: 'evt_r2', providerRef: 'pi_123', amount: 1605, tip: 0, refundAmount: 1605, refundRef: 're_2' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('refunded');
    tx = (await deps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { status: string; refunds: { refundRef: string; amount: number }[] };
    expect(tx.status).toBe('refunded');
    expect(tx.refunds).toHaveLength(2);
    expect(tx.refunds.map((r) => r.refundRef)).toEqual(['re_1', 're_2']);
    expect(tx.refunds.map((r) => r.amount)).toEqual([500, 1105]);
  });

  it("C1 (final whole-branch review): a refund event never rewrites the transaction row's `at` — it stays the original charge time (rollup.test.ts proves the through-the-rollup consequence)", async () => {
    const CHARGE_AT = '2026-08-23T15:00:00.000Z';
    const REFUND_AT = '2026-08-25T15:00:00.000Z'; // two days later — a normal refund timeline, not an edge case
    const chargeDeps = testDeps({ now: () => CHARGE_AT });
    await seedOperator(chargeDeps);
    await chargeDeps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'pending', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(chargeDeps, { ...paid, kind: 'payment_succeeded', eventId: 'evt_at1', providerRef: 'pi_123', amount: 1605, tip: 0 });
    expect(((await chargeDeps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { at: string }).at).toBe(CHARGE_AT);

    const refundDeps = testDeps({ now: () => REFUND_AT });
    await applyPaymentEvent(refundDeps, { ...paid, kind: 'refunded', eventId: 'evt_at2', providerRef: 'pi_123', amount: 1605, tip: 0, refundAmount: 500, refundRef: 're_at' });
    // `at` is unchanged; the refund's own timestamp lives in refunds[].at instead (Ruling AY).
    const tx = (await chargeDeps.db.doc(P.tx(OP, 'pi_123')).get()).data() as { at: string; refunds: { at: string }[] };
    expect(tx.at).toBe(CHARGE_AT);
    expect(tx.refunds[0]?.at).toBe(REFUND_AT);
  });

  it('ignores an event missing operatorId/ticketId', async () => {
    const deps = testDeps();
    const ev = { kind: 'payment_succeeded' as const, eventId: 'evt_missing_ids', providerRef: 'pi_999', amount: 100, base: 100, tip: 0, tax: 0, fees: 0, currency: 'USD' };
    expect(await applyPaymentEvent(deps, ev)).toBe('ignored');
    expect((await deps.db.doc(P.processed('stripe', 'evt_missing_ids')).get()).data()).toMatchObject({ ignored: true });
  });

  it('ignores an event for a ticket that does not exist', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const result = await applyPaymentEvent(deps, { ...paid, eventId: 'evt_no_ticket', ticketId: 'does-not-exist' });
    expect(result).toBe('ignored');
    expect((await deps.db.doc(P.processed('stripe', 'evt_no_ticket')).get()).data()).toMatchObject({ ignored: true });
  });

  it('regress guard: a payment_succeeded event never un-refunds an already-refunded ticket', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'refunded', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, eventId: 'evt_regress' });
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('refunded');
    expect((await deps.db.doc(P.processed('stripe', 'evt_regress')).get()).data()).toMatchObject({ regress: true });
  });

  it('a failed projection refresh (Ruling T) is swallowed — the financial write still lands and the call still resolves applied', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
    // Injection changed with carry #18 (Plan 8 Task 6): this test used to DELETE the operator doc,
    // but the poison-event guard now turns a missing parent doc into a clean logged skip — no
    // throw, nothing for the swallow to swallow. What the swallow exists for is the TRANSIENT
    // failure (the guard deliberately lets those propagate), so that is what gets injected:
    // reads of the operator doc REJECT, scoped to exactly that path — applyPaymentEvent itself
    // never reads it (grep-verified), so the financial phase is untouched and the rejection can
    // only land inside the projection refresh.
    const realDoc = deps.db.doc.bind(deps.db);
    const faultedDb = new Proxy(deps.db, {
      get(target, prop, receiver) {
        if (prop === 'doc') {
          return (path: string) => {
            const ref = realDoc(path);
            if (path !== P.operator(OP)) return ref;
            return new Proxy(ref, {
              get(rt, rp, rr) {
                if (rp === 'get') return () => Promise.reject(new Error('injected transient read failure'));
                const v: unknown = Reflect.get(rt, rp, rr);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(rt) : v;
              },
            });
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await applyPaymentEvent({ ...deps, db: faultedDb }, paid);
    expect(result).toBe('applied');
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.status).toBe('paid');
    expect(errSpy).toHaveBeenCalledWith('applyPaymentEvent projection refresh failed', { name: 'Error' });
    errSpy.mockRestore();
  });

  it('a transition to paid enqueues exactly one receipt SMS, replay-safe (Ruling AT, finding 13)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await applyPaymentEvent(deps, paid);
    const receipt = (await deps.db.doc(P.outbound(`${TID}_receipt`)).get()).data();
    expect(receipt).toMatchObject({ channel: 'sms', template: 'receipt', status: 'queued' });
    await applyPaymentEvent(deps, paid); // replay — dedupe key already set, must not enqueue a second one
    expect((await deps.db.collection('outboundMessages').where('template', '==', 'receipt').get()).size).toBe(1);
  });

  it('consentSms:false suppresses the receipt SMS (Ruling AT)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: false }, payment: { status: 'pending', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await applyPaymentEvent(deps, paid);
    expect((await deps.db.doc(P.outbound(`${TID}_receipt`)).get()).exists).toBe(false);
  });

  it('a regressed/stale-intent event never enqueues a receipt', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'refunded', base: 1500, tip: 321, tax: 105, fees: 0, total: 1926, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123' } }));
    await applyPaymentEvent(deps, { ...paid, eventId: 'evt_regress_receipt' });
    expect((await deps.db.doc(P.outbound(`${TID}_receipt`)).get()).exists).toBe(false);
  });
});

describe('reclaimStuckRefunds', () => {
  it('resets a claim stuck in progress past the 10-minute window; leaves a fresh claim untouched', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const staleAt = new Date(Date.parse(NOW) - 11 * 60_000).toISOString();
    const freshAt = new Date(Date.parse(NOW) - 1 * 60_000).toISOString();
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: false, refundInProgress: true, refundClaimedAt: staleAt } }));
    await deps.db
      .doc(P.ticket(OP, OTHER_TID))
      .set(ticketDoc({ id: OTHER_TID, status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_456', refundRequested: false, refundInProgress: true, refundClaimedAt: freshAt } }));
    await reclaimStuckRefunds(deps);
    const stuck = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView).payment!;
    expect(stuck.refundRequested).toBe(true);
    expect(stuck.refundInProgress).toBe(false);
    const fresh = ((await deps.db.doc(P.ticket(OP, OTHER_TID)).get()).data() as TicketPaymentView).payment!;
    expect(fresh.refundRequested).toBe(false);
    expect(fresh.refundInProgress).toBe(true);
  });
});

describe('refund requested trigger', () => {
  it('failure schedules a retry and gives up after 5 attempts with an audit entry', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    fake.refunds.create = () => {
      throw new Error('stripe down');
    };
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_giveup', refundAttempts: 4 } }));
    const outcome = await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    expect(outcome).toBe('gave_up');
    const p = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView).payment!;
    expect(p.refundRequested).toBe(false);
    expect(p.refundAttempts).toBeUndefined(); // cleared on give-up so a future NEW request isn't blocked
    expect(p.refundRetryAt).toBeUndefined();
    expect(p.refundInProgress).toBe(false);
    expect((await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'payment.refund.failed').get()).size).toBe(1);
  });

  it('calls gateway refund once and clears the flag', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_once' } }));
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('noop');
    expect(fake.calls.refunds).toHaveLength(1);
    expect(((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView | undefined)?.payment?.refundRequested).toBe(false);
  });

  it('an authorized (uncaptured) ticket is voided via cancelIntent, not refunded, and the outcome is "voided" (Ruling AQ, finding 10)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'authorized', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_void' } }));
    const outcome = await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    expect(outcome).toBe('voided');
    expect(fake.calls.cancel).toHaveLength(1);
    expect(fake.calls.refunds).toHaveLength(0);
    const p = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView).payment!;
    expect(p.status).toBe('refunded');
    expect(p.lastRefundRef).toBe('void');
  });

  // Plan 5 T2 fix (pre-flight CRITICAL CONFLICT flag): this branch previously called `cancelIntent`,
  // whose F2 guard treats `requires_capture` as already-paid — the emulator's FakeStripe defaults its
  // `cancel()` mock to succeed unconditionally, so that bug was invisible to the "voided" test above
  // (it never exercises the F2 retrieve-guard's status set at all). This test asserts the CORRECT
  // port method is the one actually called, so a regression back to `cancelIntent` fails here even
  // though it might still coincidentally return the right outcome against the happy-path fake.
  it('an authorized ticket is voided via cancelAuthorization, never cancelIntent (Plan 5 T2 fix — cancelIntent would wrongly throw payment_already_paid on requires_capture)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const cancelAuthorizationSpy = vi.spyOn(gw, 'cancelAuthorization');
    const cancelIntentSpy = vi.spyOn(gw, 'cancelIntent');
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'authorized', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_456', refundRequested: true, refundRequestId: 'req_void2' } }));
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('voided');
    expect(cancelAuthorizationSpy).toHaveBeenCalledWith({ providerRef: 'pi_456', reason: 'requested_by_customer' });
    expect(cancelIntentSpy).not.toHaveBeenCalled();
  });

  it('a persisted partial-refund request survives a concurrent claim race — the amount never escalates to a full refund (Ruling AH, finding 1)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    // As staffRefund now writes it: refundRequested:true, refundRequestId, refundAmount all in ONE
    // atomic update. Simulate the trigger firing concurrently with an explicit call — both would read
    // this SAME persisted amount; only one wins the claim transaction.
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_race', refundAmount: 500, refundReason: 'partial refund' } }));
    await Promise.all([refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw), refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)]);
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.calls.refunds[0]!.params).toMatchObject({ amount: 500 });
  });

  it('a transient Stripe failure schedules a retry that preserves the persisted amount/reason (Ruling AH, finding 1)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    let calls = 0;
    fake.refunds.create = (params, options) => {
      calls++;
      fake.calls.refunds.push({ params: params as unknown as Record<string, unknown>, options: (options ?? {}) as unknown as Record<string, unknown> });
      if (calls === 1) return Promise.reject(new Error('stripe down'));
      return Promise.resolve({ id: 're_retry', status: 'succeeded' });
    };
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_retry', refundAmount: 500, refundReason: 'partial refund' } }));
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('retry_scheduled');
    const mid = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView).payment!;
    expect(mid.refundAmount).toBe(500); // survived the failed attempt untouched — no call-site arg to lose
    expect(mid.refundRequestId).toBe('req_retry');
    // Simulate the backoff window having elapsed (retryRefunds' scheduled sweep re-fires it).
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.refundRequested': true, 'payment.refundRetryAt': new Date(Date.parse(NOW) - 1000).toISOString() });
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(fake.calls.refunds[1]!.params).toMatchObject({ amount: 500 });
  });

  it('a claim inside the backoff window is a no-op; the same request succeeds once the window elapses (Ruling AJ, finding 3)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    const futureRetryAt = new Date(Date.parse(NOW) + 60_000).toISOString();
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_backoff', refundAttempts: 1, refundRetryAt: futureRetryAt } }));
    // Trigger's immediate re-fire — inside the window, must not burn an attempt.
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('noop');
    expect(fake.calls.refunds).toHaveLength(0);
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.refundRetryAt': new Date(Date.parse(NOW) - 1000).toISOString() });
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(fake.calls.refunds).toHaveLength(1);
  });

  it('a connected-account refund passes reverse_transfer:true and refund_application_fee:false to the gateway (Ruling AI, finding 2)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ 'modules.payments.connectedAccountId': 'acct_conn' });
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_conn' } }));
    await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    expect(fake.calls.refunds[0]!.params).toMatchObject({ reverse_transfer: true, refund_application_fee: false });
  });

  it('a non-connected refund omits reverse_transfer/refund_application_fee entirely (Ruling AI, finding 2)', async () => {
    const deps = testDeps();
    await seedOperator(deps); // default seedOperator has no connectedAccountId
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_noconn' } }));
    await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    expect(fake.calls.refunds[0]!.params).not.toHaveProperty('reverse_transfer');
    expect(fake.calls.refunds[0]!.params).not.toHaveProperty('refund_application_fee');
  });

  it('passes a deterministic idempotency key derived from refundRequestId — identical across a reclaim/retry of the same logical refund request', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    let calls = 0;
    fake.refunds.create = (params, options) => {
      calls++;
      fake.calls.refunds.push({ params: params as unknown as Record<string, unknown>, options: (options ?? {}) as unknown as Record<string, unknown> });
      if (calls === 1) return Promise.reject(new Error('stripe down'));
      return Promise.resolve({ id: 're_1', status: 'succeeded' });
    };
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'cancelled', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_key' } }));
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('retry_scheduled');
    const expectedKey = `refund_${TID}_req_key`;
    expect(fake.calls.refunds[0]!.options).toMatchObject({ idempotencyKey: expectedKey });
    // Simulate the scheduled retry sweep re-driving the SAME logical refund request after a FAILED
    // first attempt — refundRequestId is untouched by a failed attempt (Ruling AJ/AX only clear it on
    // a TERMINAL outcome — refunded/voided/gave_up — never on a scheduled retry), so the key stays
    // identical across the retry.
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.refundRequested': true, 'payment.refundRetryAt': new Date(Date.parse(NOW) - 1000).toISOString() });
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(fake.calls.refunds).toHaveLength(2);
    expect(fake.calls.refunds[1]!.options).toMatchObject({ idempotencyKey: expectedKey });
  });

  it('two distinct refund requests for the same amount on the same ticket get DIFFERENT idempotency keys (never collide at Stripe)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_first', refundAmount: 300 } }));
    await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    // A SECOND, independent partial refund request for the same amount (AK now allows repeat partials).
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.refundRequested': true, 'payment.refundRequestId': 'req_second', 'payment.refundAmount': 300 });
    await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw);
    expect(fake.calls.refunds).toHaveLength(2);
    expect(fake.calls.refunds[0]!.options).toMatchObject({ idempotencyKey: `refund_${TID}_req_first` });
    expect(fake.calls.refunds[1]!.options).toMatchObject({ idempotencyKey: `refund_${TID}_req_second` });
  });

  // Ruling AX (finding N1): a cancel (staffCancel / the ticket-cancel trigger) always requests a FULL
  // refund and never sets payment.refundAmount itself — after an EARLIER partial refund has already
  // succeeded (and cleared its own amount/reason/nonce per this same ruling), the cancel-driven request
  // must reach the gateway with NO amount param, never a stale leftover from that first partial.
  it('a cancel-driven full refund after an earlier successful partial carries no amount param to the gateway (Ruling AX)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeStripe();
    const gw = new StripeGateway(fake, { publishableKey: 'pk' });
    await deps.db
      .doc(P.ticket(OP, TID))
      .set(ticketDoc({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_123', refundRequested: true, refundRequestId: 'req_partial', refundAmount: 500, refundReason: 'guest request' } }));
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(fake.calls.refunds[0]!.params).toMatchObject({ amount: 500 });
    const midway = ((await deps.db.doc(P.ticket(OP, TID)).get()).data() as TicketPaymentView).payment!;
    expect(midway.refundAmount).toBeUndefined(); // cleared on success (Ruling AX)
    expect(midway.refundReason).toBeUndefined();
    expect(midway.refundRequestId).toBeUndefined();
    // Mirrors exactly what staffCancel.ts / ticket.handler.ts's cancel trigger write — refundRequestId
    // only, never amount/reason — for a subsequent full-refund-on-cancel request.
    await deps.db.doc(P.ticket(OP, TID)).update({ 'payment.refundRequested': true, 'payment.refundRequestId': 'req_cancel' });
    expect(await refundRequestedHandler(deps, { operatorId: OP, ticketId: TID }, gw)).toBe('refunded');
    expect(fake.calls.refunds).toHaveLength(2);
    expect(fake.calls.refunds[1]!.params).not.toHaveProperty('amount');
  });
});
