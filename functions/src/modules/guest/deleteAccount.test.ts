import { beforeEach, describe, expect, it, vi } from 'vitest';
import { e164Schema } from '@goldstar/platform';
import { guestDeleteAccountHandler } from './deleteAccount.js';
import type { Caller } from '../../lib/callable.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import * as registry from '../payments/registry.js';
import { StripeGateway } from '../payments/stripe.adapter.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getPlatformGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

const GUEST: Caller = { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' };

async function seedGuestWithTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.guest('g1')).set({
    phoneE164: '+13175550123',
    name: 'Taylor Guest',
    savedVehicles: [{ plate: 'ABC123', label: 'My car' }],
    savedAddresses: [{ label: 'Home', address: '1 Main St', geo: { lat: 39.7, lng: -86.1 } }],
    needs: { wheelchair: false, extraTime: true, other: 'note' },
    fcmTokens: ['tok1', 'tok2'],
    stripeCustomerId: 'cus_1',
    lastOperatorId: OP,
    consent: { sms: true, push: true },
  });
  const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' }, ...over });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
}

describe('guestDeleteAccount', () => {
  it('anonymizes the guest doc (phone hashed, name/vehicles/addresses/needs/fcmTokens cleared), unlinks the ticket (guest.uid removed, phoneE164/phoneLast4 kept), detaches payment methods, keeps the Stripe customer, deletes the Auth user, and audits', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextPaymentMethods = [
      { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
      { id: 'pm_2', card: { brand: 'mastercard', last4: '1881', exp_month: 6, exp_year: 2031 } },
    ];
    await seedGuestWithTicket(deps);
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });

    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    expect(out).toEqual({ ok: true });

    const g = (await deps.db.doc(P.guest('g1')).get()).data() as {
      phoneE164: string;
      deletedPhoneHash?: string;
      deletedAt?: string;
      name?: string;
      savedVehicles: unknown[];
      savedAddresses: unknown[];
      needs?: unknown;
      fcmTokens: string[];
      stripeCustomerId?: string;
    };
    // Fix round 2 (M1): phoneE164 is overwritten with a SCHEMA-VALID sentinel (never the real
    // number, never the hash) — the doc stays a valid `Guest` forever, unlike the earlier version.
    expect(g.phoneE164).not.toBe('+13175550123');
    expect(e164Schema.safeParse(g.phoneE164).success).toBe(true);
    // The one-way hash lives in a DISTINCT, non-schema field instead.
    expect(g.deletedPhoneHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest — never turns back into a real phone number
    expect(g.deletedAt).toBeTruthy();
    expect(g.name).toBeUndefined();
    expect(g.savedVehicles).toEqual([]);
    expect(g.savedAddresses).toEqual([]);
    expect(g.needs).toBeUndefined();
    expect(g.fcmTokens).toEqual([]);
    // Deliberately retained (Fix round 1 ruling) — the Stripe CUSTOMER survives; only its PMs are detached.
    expect(g.stripeCustomerId).toBe('cus_1');

    // Fix round 1 ruling: every PaymentMethod is detached...
    expect(fake.calls.paymentMethodsList[0]!.params).toMatchObject({ customer: 'cus_1' });
    expect(fake.calls.paymentMethodsDetach.sort()).toEqual(['pm_1', 'pm_2']);
    // ...but the Customer object itself is never deleted — no such call exists on the port at all
    // (StripeGateway has no deleteCustomer method), so this is a structural guarantee, not just an
    // assertion on the fake's call log.

    const ticketAfter = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { uid?: string; phoneE164?: string; phoneLast4?: string } };
    expect(ticketAfter.guest.uid).toBeUndefined();
    // Operator-facing ticket fields survive deletion — brief's explicit retention call.
    expect(ticketAfter.guest.phoneE164).toBe('+13175550123');
    expect(ticketAfter.guest.phoneLast4).toBe('0123');

    await expect(deps.auth.getUser('g1')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0]!.data()).toMatchObject({ actorUid: 'g1', target: 'g1', after: { ticketsUnlinked: 1, paymentMethodsDetached: 2, paymentMethodDetachFailures: 0 } });
  });

  it('a Stripe detach failure on one PM does not abort the rest of deletion — best-effort, counted in the audit row', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextPaymentMethods = [
      { id: 'pm_ok', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
      { id: 'pm_fails', card: { brand: 'visa', last4: '0002', exp_month: 12, exp_year: 2030 } },
    ];
    let call = 0;
    fake.paymentMethods.detach = (id: string) => {
      call++;
      if (id === 'pm_fails') return Promise.reject(new Error('Stripe outage'));
      return Promise.resolve({});
    };
    await seedGuestWithTicket(deps);
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });

    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    expect(out).toEqual({ ok: true }); // deletion still completes
    expect(call).toBe(2); // both detach attempts were made

    // The guest doc, ticket, and Auth user are all still fully processed despite the one failure.
    const g = (await deps.db.doc(P.guest('g1')).get()).data() as { deletedPhoneHash?: string };
    expect(g.deletedPhoneHash).toMatch(/^[0-9a-f]{64}$/);
    const ticketAfter = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { uid?: string } };
    expect(ticketAfter.guest.uid).toBeUndefined();
    await expect(deps.auth.getUser('g1')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.docs[0]!.data()).toMatchObject({ after: { paymentMethodsDetached: 1, paymentMethodDetachFailures: 1 } });
  });

  it('a guest with no Stripe customer skips the detach step entirely (no Stripe call)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } }); // no stripeCustomerId
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });
    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    expect(out).toEqual({ ok: true });
    expect(fake.calls.paymentMethodsList).toHaveLength(0);
  });

  it('re-run is safe: calling the handler a second time (Auth user already gone, guest doc already anonymized) does not throw, does not re-hash, and does not write a duplicate audit row (Fix round 2, N1)', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedGuestWithTicket(deps);
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });
    await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    // FakeStripe returns a static list regardless of prior detach calls — reset it to empty to
    // accurately model what a real Stripe customer looks like the second time around (every card
    // already detached by the first call), so this re-run is a genuine, fully-no-op retry.
    fake.nextPaymentMethods = [];

    const gBefore = (await deps.db.doc(P.guest('g1')).get()).data() as { phoneE164: string; deletedPhoneHash?: string; deletedAt?: string };
    await expect(guestDeleteAccountHandler(deps, GUEST, { confirm: true })).resolves.toEqual({ ok: true });
    const gAfter = (await deps.db.doc(P.guest('g1')).get()).data() as { phoneE164: string; deletedPhoneHash?: string; deletedAt?: string };
    // Not double-hashed/re-stamped on the second pass — everything is stable across the re-run.
    expect(gAfter.phoneE164).toBe(gBefore.phoneE164);
    expect(gAfter.deletedPhoneHash).toBe(gBefore.deletedPhoneHash);
    expect(gAfter.deletedAt).toBe(gBefore.deletedAt);

    // A fully no-op re-run does not spam a second audit row.
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.size).toBe(1);
  });

  it('Fix round 5: a resuming call that finds every Firestore/Stripe write already done but the Auth user still present performs the deletion AND writes the audit row (the exact missing-audit regression the re-review found)', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.nextPaymentMethods = []; // simulates: a prior, crashed invocation already detached every card
    await seedOperator(deps);
    // State left behind by a prior invocation that completed every real write (guest doc anonymized,
    // payment methods detached, ticket unlinked) but crashed before ever reaching deleteUser() — so
    // no audit row exists yet, and the Auth user is still present.
    await deps.db.doc(P.guest('g1')).set({
      phoneE164: '+10000000000',
      deletedPhoneHash: 'a'.repeat(64),
      deletedAt: NOW,
      savedVehicles: [],
      savedAddresses: [],
      fcmTokens: [],
      stripeCustomerId: 'cus_1',
      consent: { sms: true, push: true },
    });
    const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }); // guest.uid already removed by the prior call
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' }); // still present — the crashed prior call never reached this step

    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    expect(out).toEqual({ ok: true });

    // THIS call is the one that actually performs the deletion (it wasn't already gone).
    await expect(deps.auth.getUser('g1')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    // The old (round 2) counts-only gate would have skipped this — every count is 0 this call,
    // but the auth deletion itself is real, first-time work that must be audited.
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0]!.data()).toMatchObject({ actorUid: 'g1', target: 'g1', after: { ticketsUnlinked: 0, paymentMethodsDetached: 0, paymentMethodDetachFailures: 0 } });
  });

  it('Fix round 5: a genuine no-op retry (Auth user already gone, nothing left to do) still writes no duplicate audit row', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.guest('g1')).set({
      phoneE164: '+10000000000',
      deletedPhoneHash: 'b'.repeat(64),
      deletedAt: NOW,
      savedVehicles: [],
      savedAddresses: [],
      fcmTokens: [],
      consent: { sms: true, push: true },
    }); // no stripeCustomerId — nothing to detach either
    fake.nextPaymentMethods = [];
    // No Auth user created at all — models the state AFTER a fully successful prior run.

    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    expect(out).toEqual({ ok: true });

    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.size).toBe(0); // true no-op: nothing changed, auth user was already gone — no audit noise
  });

  it('a caller without the guest role is rejected', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(guestDeleteAccountHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [] }, { confirm: true })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('a closed/terminal ticket is unlinked too, not just open ones', async () => {
    const deps = testDeps();
    useFake();
    await seedGuestWithTicket(deps, { status: 'closed', times: { checkedInAt: NOW, closedAt: NOW } });
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });
    await guestDeleteAccountHandler(deps, GUEST, { confirm: true });
    const ticketAfter = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { uid?: string } };
    expect(ticketAfter.guest.uid).toBeUndefined();
  });

  it('Fix round 1 ruling: pagination completes fully across multiple pages — every ticket unlinked, not just the first page', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', savedVehicles: [], fcmTokens: [], consent: { sms: true, push: true } });
    await deps.auth.createUser({ uid: 'g1', phoneNumber: '+13175550123' });
    // 5 tickets, a page size of 2 → 3 pages (2 + 2 + 1) exercises the actual startAfter cursor walk
    // in ticketsByGuest.ts's paginateGuestTickets, not just a single-page happy path.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = deps.newId();
      ids.push(id);
      const t = ticketDoc({ id, guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'g1' } });
      await deps.db.doc(P.ticket(OP, id)).set(t);
      await ticketWrittenHandler(deps, { operatorId: OP, ticketId: id, before: null, after: t });
    }
    const out = await guestDeleteAccountHandler(deps, GUEST, { confirm: true }, 2);
    expect(out).toEqual({ ok: true });
    for (const id of ids) {
      const t = (await deps.db.doc(P.ticket(OP, id)).get()).data() as { guest: { uid?: string } };
      expect(t.guest.uid).toBeUndefined();
    }
    const logs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'guest.deleteAccount').get();
    expect(logs.docs[0]!.data()).toMatchObject({ after: { ticketsUnlinked: 5 } });
  });
});
