import { beforeEach, expect, it, vi } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import { MockPmsProvider } from './mock.adapter.js';
import { MOCK_RESERVATIONS } from '../../../test/pmsFixtures.js';
import { pmsPostRoomChargeHandler, staffReverseRoomChargeHandler } from './roomCharge.js';
import * as registry from './registry.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };
const ATTENDANT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
const LEAD: Caller = { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function useMockPms() {
  const pms = new MockPmsProvider(MOCK_RESERVATIONS);
  vi.spyOn(registry, 'getPms').mockResolvedValue(pms);
  return pms;
}

async function seedChargeable(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}, noPostBehavior: 'block' | 'fallback_card' = 'block') {
  await seedOperator(deps);
  await deps.db.doc(P.venue(OP, V1)).update({ pms: { provider: 'opera_cloud', hotelId: 'H1', noPostBehavior, chargeCode: 'VALET' } });
  const t = ticketDoc({ status: 'checked_in', ...over });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  return t;
}

const CHARGE_INPUT = { ticketId: TID, reservationRef: 'res_100', room: '412' };

// ---------- pmsPostRoomCharge ----------

it('MONEY: prices server-side, posts to the folio via CHARGE_LABELS description, settles the ticket room_charged/billTo room, writes the pms transaction row, and audits', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();

  const out = await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  expect(out).toEqual({ postingRef: 'mock_1' }); // v0.4.3 L3: union branch, no stray fallback key

  // Seed venue: flat 1500 + 7% tax = 1605. The folio receives OUR full total, labeled from the
  // shared CHARGE_LABELS map (Ruling AN), keyed by the PMS-side dedupe reference = ticketId.
  expect(pms.postings).toEqual([
    { postingRef: 'mock_1', reservationRef: 'res_100', amount: 1605, currency: 'USD', chargeCode: 'VALET', description: 'Valet', referenceId: `${TID}_0`, reversed: false },
  ]);

  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ status: 'room_charged', method: 'pms', billTo: 'room', pmsPostingRef: 'mock_1', base: 1500, tax: 105, fees: 0, total: 1605, tip: 0, paidAt: NOW });
  // T2 addition 1: the charge's own write links the reservation to the ticket — no client path
  // can (venue_user rules branch is too narrow), and without it a disputed room charge could not
  // be traced to the reservation it was posted against.
  expect(t.guest).toMatchObject({ reservationRef: 'res_100', room: '412' });

  const tx = (await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).get()).data()!;
  expect(tx).toMatchObject({ kind: 'room_charge', provider: 'pms', method: 'pms', status: 'succeeded', providerRef: 'mock_1', total: 1605, ticketId: TID, venueId: V1 });

  expect((await deps.db.doc(`processedEvents/pmsCharge_${TID}_0`).get()).exists).toBe(true);
  const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'pms.postRoomCharge').get();
  expect(logs.size).toBe(1);
});

it("noPostBehavior 'block': a noPost reservation fails failed_precondition('no_post') and NOTHING is written or posted", async () => {
  const deps = testDeps();
  await seedChargeable(deps, {}, 'block');
  const pms = useMockPms();

  await expect(pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_101', room: '907' })).rejects.toMatchObject({ code: 'failed_precondition', message: 'no_post', details: { reason: 'no_post' } });
  expect(pms.postings).toHaveLength(0);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toBeUndefined();
  expect((await deps.db.doc(`processedEvents/pmsCharge_${TID}_0`).get()).exists).toBe(false);
});

it("noPostBehavior 'fallback_card': a noPost reservation returns { fallback: 'card' } and NOTHING is written or posted — the card travels the normal checkout path", async () => {
  const deps = testDeps();
  await seedChargeable(deps, {}, 'fallback_card');
  const pms = useMockPms();

  const out = await pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_101', room: '907' });
  expect(out).toEqual({ fallback: 'card' });
  expect(pms.postings).toHaveLength(0);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toBeUndefined();
  expect((await deps.db.doc(`processedEvents/pmsCharge_${TID}_0`).get()).exists).toBe(false);
});

it('noPost is verified SERVER-SIDE against a fresh lookup — a reservationRef not found in the given room is not_found (covers wrong ref AND wrong room)', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  useMockPms();
  await expect(pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_100', room: '907' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_999', room: '412' })).rejects.toMatchObject({ code: 'not_found' });
});

it('guards: closed ticket, already-paid ticket, venue-billed ride, and unquoted ride are all rejected before any PMS call', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();
  const spy = vi.spyOn(pms, 'postCharge');

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed' }));
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'ticket_closed' });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'delivered', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', method: 'web' } }));
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'payment_already_paid' });

  const rideBase = { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false };
  const quote = { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] };
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ jobType: 'passenger_ride', status: 'confirmed', ride: { ...rideBase, quote, billTo: 'venue' } }));
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'failed_precondition', message: 'venue_billed_ride' });

  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ jobType: 'passenger_ride', status: 'requested', ride: { ...rideBase, billTo: 'room' } }));
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'failed_precondition', message: 'job not yet quoted' });

  expect(spy).not.toHaveBeenCalled();
});

it("Ruling W end-to-end: a billTo:'room' ride posts its QUOTED amount (plus tax) to the folio with the 'Ride' label", async () => {
  const deps = testDeps();
  await seedChargeable(deps, {
    jobType: 'passenger_ride',
    status: 'completed',
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'room', quote: { base: 1000, distanceMeters: 100, durationSec: 120, amount: 1500, breakdown: [] } },
  });
  const pms = useMockPms();

  await pmsPostRoomChargeHandler(deps, ATTENDANT, CHARGE_INPUT);
  // quote 1500 + 7% tax = 1605; description is the ride's shared label, not "Valet".
  expect(pms.postings[0]).toMatchObject({ amount: 1605, description: 'Ride' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ status: 'room_charged', billTo: 'room', total: 1605 });
});

it('SECURITY (§9.1, ticket-derived): a venue_user or attendant whose claim lacks the TICKET venue is rejected; nothing posted', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();
  const foreignHost: Caller = { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] };
  const foreignAtt: Caller = { uid: 'att2', operatorId: OP, roles: ['attendant'], venueIds: ['v-other'] };
  await expect(pmsPostRoomChargeHandler(deps, foreignHost, CHARGE_INPUT)).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(pmsPostRoomChargeHandler(deps, foreignAtt, CHARGE_INPUT)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(pms.postings).toHaveLength(0);
});

it('IDEMPOTENCY: a second call is payment_already_paid; a crash-retry (marker exists, writes missing) completes from the marker WITHOUT re-posting — and skips the noPost re-check because the money already moved', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();
  const spy = vi.spyOn(pms, 'postCharge');

  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'payment_already_paid' });
  expect(spy).toHaveBeenCalledTimes(1);

  // Crash simulation: marker + folio posting exist, but the payment/tx writes never landed. The
  // reservation ALSO flipped to noPost since — the retry must still complete (settle the ticket),
  // never bounce to fallback:'card' with a live folio charge outstanding.
  await deps.db.doc(P.ticket(OP, TID)).update({ payment: (await import('firebase-admin/firestore')).FieldValue.delete() });
  await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).delete();
  pms.seedReservation({ ...MOCK_RESERVATIONS.find((r) => r.reservationRef === 'res_100')!, noPost: true });

  const out = await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  expect(out).toEqual({ postingRef: 'mock_1' }); // the marker's preserved ref, not a re-mint (L3 union branch)
  expect(spy).toHaveBeenCalledTimes(1); // marker short-circuited the PMS call
  expect(pms.postings).toHaveLength(1); // still exactly one folio posting
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toMatchObject({ status: 'room_charged', pmsPostingRef: 'mock_1' });
});

it('M2: a crash-retry naming a DIFFERENT reservation is rejected as already-completed — the ticket is only ever stamped with the reservation the folio actually charged', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();

  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT); // charged against res_100 / room 412
  // Crash simulation: marker + folio posting exist, payment/tx/guest writes did not land.
  await deps.db.doc(P.ticket(OP, TID)).update({
    payment: (await import('firebase-admin/firestore')).FieldValue.delete(),
    'guest.reservationRef': (await import('firebase-admin/firestore')).FieldValue.delete(),
    'guest.room': (await import('firebase-admin/firestore')).FieldValue.delete(),
  });
  await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).delete();

  // Pre-M2 this completed and stamped guest.reservationRef = res_102 — a dispute traced to a
  // reservation the money never touched. The rejection's copy/reason must read as "already
  // completed", never as a failed charge (a host who reads failure retries and opens a support
  // case about a charge that worked).
  await expect(pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_102', room: '115' })).rejects.toMatchObject({
    code: 'failed_precondition',
    message: 'charge already completed against a different reservation',
    details: { reason: 'already_charged_other_reservation' },
  });
  const mid = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { reservationRef?: string } };
  expect(mid.guest.reservationRef).toBeUndefined(); // nothing stamped by the rejected retry
  expect(pms.postings).toHaveLength(1); // and nothing re-posted

  // The retry naming the MARKER's reservation completes and stamps the true linkage.
  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.guest).toMatchObject({ reservationRef: 'res_100', room: '412' });
  expect(t.payment).toMatchObject({ status: 'room_charged', pmsPostingRef: 'mock_1' });
});

it('RULING BA/BB end-to-end: charge the WRONG reservation → reverse → charge the CORRECT one as generation 1 → reverse that', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();

  // Generation 0: the host picks the wrong guest — the one first-call mistake M2 cannot prevent.
  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT); // res_100 / 412 → mock_1
  await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'wrong reservation' });
  expect(pms.postings[0]).toMatchObject({ postingRef: 'mock_1', referenceId: `${TID}_0`, reversed: true });

  // Generation 1: pre-BA this was payment_already_paid; pre-BB its ids would have collided —
  // the reversal marker would have skipped the provider and the tx row create would have been
  // swallowed as a "crash retry", moving money with NO ledger entry.
  const out = await pmsPostRoomChargeHandler(deps, HOST, { ticketId: TID, reservationRef: 'res_102', room: '115' });
  expect(out).toEqual({ postingRef: 'mock_2' });
  const mid = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: { pmsPostingRef?: string; status?: string }; pmsChargeSeq?: number; guest: { reservationRef?: string; room?: string } };
  expect(mid.payment).toMatchObject({ status: 'room_charged', pmsPostingRef: 'mock_2' });
  expect(mid.pmsChargeSeq).toBe(1);
  expect(mid.guest).toMatchObject({ reservationRef: 'res_102', room: '115' }); // re-stamped to the folio the money actually reached
  const gen1Tx = (await deps.db.doc(P.tx(OP, `pms_${TID}_1`)).get()).data()!;
  expect(gen1Tx).toMatchObject({ status: 'succeeded', providerRef: 'mock_2', total: 1605 }); // its OWN ledger row
  expect(pms.postings[1]).toMatchObject({ postingRef: 'mock_2', reservationRef: 'res_102', referenceId: `${TID}_1`, reversed: false });

  // Reverse generation 1 — must hit the provider (a pre-BB reversal would have reused gen 0's marker and skipped it).
  await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'guest disputed' });
  expect(pms.postings[1]!.reversed).toBe(true);
  const end = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: unknown; pmsChargeSeq?: number };
  expect(end.payment).toBeUndefined();
  expect(end.pmsChargeSeq).toBe(2);
  expect((await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).get()).data()!.refunds).toEqual([{ refundRef: `pmsrev_${TID}_0`, amount: 1605, at: NOW, reason: 'wrong reservation' }]);
  expect((await deps.db.doc(P.tx(OP, `pms_${TID}_1`)).get()).data()!.refunds).toEqual([{ refundRef: `pmsrev_${TID}_1`, amount: 1605, at: NOW, reason: 'guest disputed' }]);
});

it('RACE (sibling of fix-round M1): two concurrent FIRST calls — the loser is refused, exactly ONE folio posting', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = useMockPms();

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realPost = pms.postCharge.bind(pms);
  vi.spyOn(pms, 'postCharge').mockImplementation(async (i) => { await gate; return realPost(i); });

  const first = pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  // Wait for the first call's claim to commit — the exact window where the pre-claim code let a
  // double-tap post the folio twice.
  for (let i = 0; i < 100; i++) {
    const m = (await deps.db.doc(`processedEvents/pmsCharge_${TID}_0`).get()).data() as { status?: string } | undefined;
    if (m?.status === 'pending') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await expect(pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT)).rejects.toMatchObject({ code: 'failed_precondition', message: 'charge in progress' });

  release();
  const out = await first;
  expect(out).toEqual({ postingRef: 'mock_1' });
  expect(pms.postings).toHaveLength(1); // exactly ONE
});

it('FROZEN PRICING: a LATE crash-retry settles at what was POSTED to the folio, never a re-price (hourly bases grow)', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  // Hourly venue: 500/hr, 7% tax. At charge time (1h in) the folio receives 535.
  await deps.db.doc(P.venue(OP, V1)).update({ 'rates.valet': { model: 'hourly', items: [{ id: 'h', label: 'Per hour', amount: 500 }], taxRateBps: 700, fees: [] } });
  const pms = useMockPms();
  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  expect(pms.postings[0]!.amount).toBe(535);

  // Crash between marker and the settlement writes; the retry arrives THREE HOURS LATER.
  await deps.db.doc(P.ticket(OP, TID)).update({ payment: (await import('firebase-admin/firestore')).FieldValue.delete() });
  await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).delete();
  const later = new Date(Date.parse(NOW) + 3 * 3600_000).toISOString();
  const lateDeps = testDeps({ now: () => later });
  vi.spyOn(registry, 'getPms').mockResolvedValue(pms);

  await pmsPostRoomChargeHandler(lateDeps, HOST, CHARGE_INPUT);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: { total?: number; base?: number } };
  // A re-price at retry time would be 3h × 500 + tax = 1605 — a ledger total the folio never saw.
  expect(t.payment).toMatchObject({ total: 535, base: 500 });
  expect(pms.postings).toHaveLength(1); // and nothing re-posted
});

// ---------- staffReverseRoomCharge ----------

async function chargeFirst(deps: ReturnType<typeof testDeps>) {
  const pms = useMockPms();
  await pmsPostRoomChargeHandler(deps, HOST, CHARGE_INPUT);
  return pms;
}

it('MONEY: a lead reverses — provider reversal, payment reset to absent + generation advanced + markers cleared (Ruling BA), transaction refunded, audited', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = await chargeFirst(deps);

  const out = await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'guest disputed' });
  expect(out).toEqual({ ok: true });
  expect(pms.postings[0]!.reversed).toBe(true);

  // Ruling BA: reversal genuinely UNDOES — payment reset to ABSENT (not 'refunded' with stale
  // figures), the generation counter advanced, and BOTH of the generation's markers deleted.
  // The history lives in the transaction row's refunds and the audit log.
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: unknown; pmsChargeSeq?: number };
  expect(t.payment).toBeUndefined();
  expect(t.pmsChargeSeq).toBe(1);
  expect((await deps.db.doc(`processedEvents/pmsCharge_${TID}_0`).get()).exists).toBe(false);
  expect((await deps.db.doc(`processedEvents/pmsReverse_${TID}_0`).get()).exists).toBe(false);

  const tx = (await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).get()).data()!;
  expect(tx.status).toBe('refunded');
  expect(tx.refunds).toEqual([{ refundRef: `pmsrev_${TID}_0`, amount: 1605, at: NOW, reason: 'guest disputed' }]);

  const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'pms.reverseRoomCharge').get();
  expect(logs.size).toBe(1);
});

it('SECURITY: attendants and venue hosts cannot reverse (manager roles only); an already-reversed or never-charged ticket is nothing-to-reverse', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  await chargeFirst(deps);

  await expect(staffReverseRoomChargeHandler(deps, ATTENDANT, { ticketId: TID, reason: 'x' })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(staffReverseRoomChargeHandler(deps, HOST, { ticketId: TID, reason: 'x' })).rejects.toMatchObject({ code: 'permission_denied' });

  await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'x' });
  // Ruling BA reset payment to ABSENT — a repeat full call fails the same 'nothing to reverse' guard.
  await expect(staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'x' })).rejects.toMatchObject({ code: 'failed_precondition', message: 'nothing to reverse' });
});

it('L2: the OTHER reverse crash window — provider reversed but the marker never landed — self-heals instead of wedging (port idempotency per referenceId)', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = await chargeFirst(deps);

  // Crash simulation: reverseCharge succeeded at the provider, then the process died BEFORE the
  // marker write. Pre-L2 the retry re-called the provider, 'already reversed' threw forever, and
  // payment sat at room_charged with the folio actually reversed — wedged with money wrong.
  await pms.reverseCharge({ postingRef: 'mock_1', referenceId: `rev_${TID}_0` });

  await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'guest disputed' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: unknown; pmsChargeSeq?: number };
  expect(t.payment).toBeUndefined(); // Ruling BA
  expect(t.pmsChargeSeq).toBe(1);
  const tx = (await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).get()).data()!;
  expect(tx.status).toBe('refunded');
  expect(tx.refunds).toHaveLength(1);
});

it('IDEMPOTENCY: a crash-retry (reverse marker exists, writes missing) completes WITHOUT calling the provider again, and arrayUnion reuses the marker timestamp so the refunds entry stays single', async () => {
  const deps = testDeps();
  await seedChargeable(deps);
  const pms = await chargeFirst(deps);
  const spy = vi.spyOn(pms, 'reverseCharge');

  // Crash simulation: the provider reversal + marker happened, the Firestore writes did not.
  await deps.db.doc(`processedEvents/pmsReverse_${TID}_0`).create({ at: NOW, ticketId: TID, seq: 0, postingRef: 'mock_1', reason: 'guest disputed' });
  await pms.reverseCharge({ postingRef: 'mock_1', referenceId: `rev_${TID}_0` });

  await staffReverseRoomChargeHandler(deps, LEAD, { ticketId: TID, reason: 'guest disputed' });
  expect(spy).toHaveBeenCalledTimes(1); // only the simulation's own call — the handler used the marker
  const tx = (await deps.db.doc(P.tx(OP, `pms_${TID}_0`)).get()).data()!;
  expect(tx.refunds).toHaveLength(1);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { payment?: unknown; pmsChargeSeq?: number };
  expect(t.payment).toBeUndefined(); // Ruling BA
  expect(t.pmsChargeSeq).toBe(1);
});
