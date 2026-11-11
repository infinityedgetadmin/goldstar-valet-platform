import { beforeEach, expect, it, vi } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import { posAddValetChargeHandler } from './addCharge.js';
import { posFindCheckHandler } from './findCheck.js';
import { MockPosProvider } from './mock.adapter.js';
import * as registry from './registry.js';
import { getPos } from './registry.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Venue } from '@goldstar/platform';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function useMockPos() {
  const pos = new MockPosProvider();
  vi.spyOn(registry, 'getPos').mockResolvedValue(pos);
  return pos;
}

async function seedParked(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc({ status: 'checked_in', ...over });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  return t;
}

// ---------- authorization (§9.1) ----------

it('SECURITY: both POS callables reject a venue_user whose claim lacks the venue, and non-venue_user roles', async () => {
  const deps = testDeps();
  await seedParked(deps);
  useMockPos();
  const foreign: Caller = { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] };
  const admin: Caller = { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] };
  await expect(posAddValetChargeHandler(deps, foreign, { venueId: V1, checkRef: 'mock:1', ticketId: TID })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(posFindCheckHandler(deps, foreign, { venueId: V1 })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(posFindCheckHandler(deps, admin, { venueId: V1 })).rejects.toMatchObject({ code: 'permission_denied' });
});

it('rejects under a suspended operator', async () => {
  const deps = testDeps();
  await seedParked(deps);
  await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
  useMockPos();
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef: 'mock:1', ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- posFindCheck ----------

it('posFindCheck passes the table through the provider and returns its checks', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const pos = useMockPos();
  pos.seedCheck({ table: '12', total: 9125 });
  pos.seedCheck({ table: '4', total: 2000 });

  const out = await posFindCheckHandler(deps, HOST, { venueId: V1, table: '12' });
  expect(out.checks).toHaveLength(1);
  expect(out.checks[0]).toMatchObject({ table: '12', total: 9125 });
});

it('the REAL registry fails honestly for a venue with no pos config — never a silent mock', async () => {
  const deps = testDeps();
  await seedOperator(deps); // seed venue has no `pos` block
  const venue = (await deps.db.doc(P.venue(OP, V1)).get()).data() as Venue;
  await expect(getPos(deps, OP, venue)).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- posAddValetCharge ----------

it('MONEY: prices server-side, marks the ticket paid via pos billTo guest, writes the transaction row keyed on the opaque checkRef, and pushes the item', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  const out = await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  expect(out).toEqual({ ok: true });

  // Seed venue: flat 1500 + 7% tax = 1605. The item lands on the check at OUR full total.
  expect(pos.check(checkRef)!.items).toEqual([{ name: 'Valet parking', amount: 1605 }]);

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ status: 'paid', method: 'pos', billTo: 'guest', base: 1500, tax: 105, fees: 0, total: 1605, tip: 0, paidAt: NOW });

  const tx = (await deps.db.doc(P.tx(OP, `pos_${TID}`)).get()).data()!;
  expect(tx).toMatchObject({ kind: 'charge', provider: 'pos', method: 'pos', status: 'succeeded', providerRef: checkRef, total: 1605, ticketId: TID });

  expect((await deps.db.doc(`processedEvents/posCharge_${TID}`).get()).exists).toBe(true);
});

it('MONEY: a validation already redeemed onto the ticket reduces what lands on the check — priceTicket consumes payment.validationAmount', async () => {
  const deps = testDeps();
  await seedParked(deps);
  await deps.db.doc(P.ticket(OP, TID)).update({ payment: { validationId: 'val1', validationAmount: 500 } });
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });

  // base 1500 − 500 validation = 1000; 7% tax = 70; total 1070. Validation fields preserved.
  expect(pos.check(checkRef)!.items).toEqual([{ name: 'Valet parking', amount: 1070 }]);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ total: 1070, base: 1000, validationId: 'val1', validationAmount: 500 });
});

it('guards: wrong venue, non-valet, closed, and already-paid tickets are all rejected before any POS call', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const pos = useMockPos();
  const spy = vi.spyOn(pos, 'addCharge');
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'checked_in', venueId: 'v2' }));
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition' });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'confirmed', jobType: 'passenger_ride' }));
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition' });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed' }));
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'ticket_closed' });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'delivered', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', method: 'web' } }));
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'payment_already_paid' });

  expect(spy).not.toHaveBeenCalled();
});

it('IDEMPOTENCY: a second call after success is payment_already_paid; a crash-retry (marker exists, payment missing) completes WITHOUT re-posting the line item', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const pos = useMockPos();
  const spy = vi.spyOn(pos, 'addCharge');
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'payment_already_paid' });
  expect(spy).toHaveBeenCalledTimes(1);

  // Crash simulation: marker + POS item exist, but the payment/tx writes never landed.
  await deps.db.doc(P.ticket(OP, TID)).update({ payment: (await import('firebase-admin/firestore')).FieldValue.delete() });
  await deps.db.doc(P.tx(OP, `pos_${TID}`)).delete();

  await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  expect(spy).toHaveBeenCalledTimes(1); // marker short-circuited the POS call
  expect(pos.check(checkRef)!.items).toHaveLength(1); // still exactly one line item on the check
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ status: 'paid', method: 'pos' });
});

it('RACE (sibling of fix-round M1): two concurrent posAddValetCharge calls — one line item, the loser is refused', async () => {
  const deps = testDeps();
  await seedParked(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realAdd = pos.addCharge.bind(pos);
  vi.spyOn(pos, 'addCharge').mockImplementation(async (i) => { await gate; return realAdd(i); });

  const first = posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  for (let i = 0; i < 100; i++) {
    const m = (await deps.db.doc(`processedEvents/posCharge_${TID}`).get()).data() as { status?: string } | undefined;
    if (m?.status === 'pending') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Pre-claim both calls passed the marker read and BOTH pushed the line item (T3 review nit,
  // now closed rather than accepted a third time).
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'charge in progress' });

  release();
  await first;
  expect(pos.check(checkRef)!.items).toEqual([{ name: 'Valet parking', amount: 1605 }]); // exactly one
});

it("BINDING (M2's shape in addCharge, found by the sweep): a crash-retry naming a DIFFERENT check is rejected — the item landed on the marker's check", async () => {
  const deps = testDeps();
  await seedParked(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const otherRef = pos.seedCheck({ table: '4', total: 2000 });

  await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  // Crash simulation: marker posted, settlement writes missing.
  await deps.db.doc(P.ticket(OP, TID)).update({ payment: (await import('firebase-admin/firestore')).FieldValue.delete() });
  await deps.db.doc(P.tx(OP, `pos_${TID}`)).delete();

  // Pre-fix this completed and wrote providerRef = otherRef — a transaction row naming a check
  // the item never touched.
  await expect(posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef: otherRef, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'charge already completed against a different check' });
  expect(pos.check(otherRef)!.items).toHaveLength(0);

  await posAddValetChargeHandler(deps, HOST, { venueId: V1, checkRef, ticketId: TID });
  expect(pos.check(checkRef)!.items).toHaveLength(1);
  const tx = (await deps.db.doc(P.tx(OP, `pos_${TID}`)).get()).data()!;
  expect(tx.providerRef).toBe(checkRef);
});
