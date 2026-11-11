import { beforeEach, expect, it, vi } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import { posApplyValidationHandler } from './applyValidation.js';
import { MockPosProvider } from './mock.adapter.js';
import * as registry from './registry.js';
import { redeemValidation, staffApplyValidationHandler, venueIssueValidationHandler } from '../venue/validation.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };
const ATT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
const T2 = '01912345-7abc-7def-8123-456789abcd88';

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function useMockPos() {
  const pos = new MockPosProvider();
  vi.spyOn(registry, 'getPos').mockResolvedValue(pos);
  return pos;
}

async function seed(deps: ReturnType<typeof testDeps>) {
  await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'checked_in' }));
  const { code } = await venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'partial', amount: 700 });
  const snap = await deps.db.collection(`operators/${OP}/validations`).where('code', '==', code).get();
  return { code, validationId: snap.docs[0]!.id };
}

it('SECURITY: §9.1 gate — foreign-venue venue_user and non-venue_user roles are rejected', async () => {
  const deps = testDeps();
  await seed(deps);
  useMockPos();
  await expect(
    posApplyValidationHandler(deps, { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] }, { venueId: V1, checkRef: 'mock:1', code: 'AB23CD', ticketId: TID }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(posApplyValidationHandler(deps, ATT, { venueId: V1, checkRef: 'mock:1', code: 'AB23CD', ticketId: TID })).rejects.toMatchObject({ code: 'permission_denied' });
});

it('RULING F/AJ: redeems through the SHARED guard with a SERVER-computed amount, then pushes exactly that amount to the check', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  const out = await posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID });
  expect(out).toEqual({ ok: true });

  // The guard's full effect — same writes as the stand path, proving ONE implementation:
  const v = (await deps.db.doc(P.validation(OP, validationId)).get()).data()!;
  expect(v.redeemedTicketId).toBe(TID);
  expect(v.redemption).toEqual({ amount: 700, base: 1500, at: NOW });
  expect(v.posPush).toEqual({ checkRef, status: 'pushed', at: NOW });
  expect((await deps.db.doc(`processedEvents/val_${validationId}`).get()).data()).toMatchObject({ ticketId: TID, source: 'pos' });
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.payment).toEqual({ validationId, validationAmount: 700 });

  // ...and the check received the guard's amount, not a client-chosen one.
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]);
});

it('RULING F: MUTUAL EXCLUSION — a code redeemed at the STAND cannot be pushed to a check, and vice versa', async () => {
  const deps = testDeps();
  const { code } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  await staffApplyValidationHandler(deps, ATT, { ticketId: TID, code });
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({
    code: 'failed_precondition',
    message: 'validation already redeemed',
  });
  expect(pos.check(checkRef)!.discounts).toHaveLength(0); // nothing reached the check

  // vice versa on a fresh code
  const { code: code2 } = await venueIssueValidationHandler(deps, HOST, { venueId: V1, type: 'partial', amount: 500 });
  await deps.db.doc(P.ticket(OP, T2)).set(ticketDoc({ id: T2, status: 'checked_in', guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true } }));
  await posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code: code2, ticketId: T2 });
  await expect(staffApplyValidationHandler(deps, ATT, { ticketId: TID, code: code2 })).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('RULING AJ ORDERING: a failed push leaves the redemption standing (posPush failed), and a RETRY re-pushes WITHOUT re-redeeming', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const applySpy = vi.spyOn(pos, 'applyValidation').mockRejectedValueOnce(Object.assign(new Error('toast 503'), { code: 'provider_unavailable' }));

  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'provider_unavailable' });

  const v1 = (await deps.db.doc(P.validation(OP, validationId)).get()).data()!;
  expect(v1.redeemedTicketId).toBe(TID); // terminal — the failure chosen is the retryable one
  expect(v1.posPush).toEqual({ checkRef, status: 'failed', at: NOW });

  // Retry: push succeeds, redemption is NOT re-run (redemption.at unchanged, amount from the doc).
  await posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID });
  const v2 = (await deps.db.doc(P.validation(OP, validationId)).get()).data()!;
  expect(v2.posPush).toEqual({ checkRef, status: 'pushed', at: NOW });
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]); // pushed exactly once
  expect(applySpy).toHaveBeenCalledTimes(2); // one failed, one succeeded

  // A THIRD call after a confirmed push is a hard already-redeemed — no double discount.
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition' });
  expect(pos.check(checkRef)!.discounts).toHaveLength(1);
});

it('RETRY SCOPE: the retry path never covers a DIFFERENT check or a DIFFERENT ticket', async () => {
  const deps = testDeps();
  const { code } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const otherRef = pos.seedCheck({ table: '4', total: 2000 });
  vi.spyOn(pos, 'applyValidation').mockRejectedValueOnce(Object.assign(new Error('toast 503'), { code: 'provider_unavailable' }));
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'provider_unavailable' });

  await deps.db.doc(P.ticket(OP, T2)).set(ticketDoc({ id: T2, status: 'checked_in', guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true } }));
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef: otherRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition' });
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: T2 })).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('guards pass through the shared guard unchanged: unknown code is not_found; expired code rejects; wrong-venue ticket rejects', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code: 'ZZZ999', ticketId: TID })).rejects.toMatchObject({ code: 'not_found' });

  // Wrong-venue ticket (M1: this title used to claim this without testing it — validation.ts's
  // cross-venue guard has NO other reachable route, since the staff path not-founds first):
  await deps.db.doc(P.ticket(OP, T2)).set(ticketDoc({ id: T2, status: 'checked_in', venueId: 'v2', guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true } }));
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: T2 })).rejects.toMatchObject({ code: 'failed_precondition', message: 'validation is for a different venue' });

  await deps.db.doc(P.validation(OP, validationId)).update({ expiresAt: '2020-01-01T00:00:00.000Z' });
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'validation expired' });
});

// ---------- M1 (T2/T3 fix round): the RETRY path re-claims before pushing ----------

/** Polls the validation doc until `pred` holds — the visible commit of a concurrent claim. */
async function waitForPosPush(deps: ReturnType<typeof testDeps>, validationId: string, pred: (pp: { status: string; at: string } | undefined) => boolean) {
  for (let i = 0; i < 100; i++) {
    const v = (await deps.db.doc(P.validation(OP, validationId)).get()).data() as { posPush?: { status: string; at: string } };
    if (pred(v.posPush)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('posPush claim never became visible');
}

it('M1 RACE (failed state): concurrent retries after a FAILED push — the loser is refused, exactly ONE discount lands', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const INPUT = { venueId: V1, checkRef, code, ticketId: TID };

  // First call: push fails — posPush lands as 'failed'. This is the prior-failure precondition.
  vi.spyOn(pos, 'applyValidation').mockRejectedValueOnce(Object.assign(new Error('toast 503'), { code: 'provider_unavailable' }));
  await expect(posApplyValidationHandler(deps, HOST, INPUT)).rejects.toMatchObject({ code: 'provider_unavailable' });

  // Now the double-click: retry A holds its push open on a gate; retry B arrives mid-flight.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realApply = pos.applyValidation.bind(pos);
  vi.spyOn(pos, 'applyValidation').mockImplementation(async (i) => { await gate; return realApply(i); });

  const first = posApplyValidationHandler(deps, HOST, INPUT);
  await waitForPosPush(deps, validationId, (pp) => pp?.status === 'pending'); // A's re-claim committed
  // Pre-M1 both retries qualified here and BOTH pushed — the probe showed two discounts.
  await expect(posApplyValidationHandler(deps, HOST, INPUT)).rejects.toMatchObject({ code: 'failed_precondition', message: 'push in progress' });

  release();
  await first;
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]); // exactly ONE
  const v = (await deps.db.doc(P.validation(OP, validationId)).get()).data()!;
  expect(v.posPush).toMatchObject({ checkRef, status: 'pushed' });
});

it('M1 RACE (stale-pending state): the crash-retry takeover is ALSO single-winner — the sibling state has the same guard', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const INPUT = { venueId: V1, checkRef, code, ticketId: TID };

  // Crash state: redemption committed with a STALE pending claim (see H1 CRASH STATE).
  const STALE = '2026-08-23T20:58:00.000Z';
  await redeemValidation(deps, {
    operatorId: OP, validationId, ticketId: TID, actorUid: HOST.uid, source: 'pos',
    extraValidationFields: { posPush: { checkRef, status: 'pending', at: STALE } },
  });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realApply = pos.applyValidation.bind(pos);
  vi.spyOn(pos, 'applyValidation').mockImplementation(async (i) => { await gate; return realApply(i); });

  const first = posApplyValidationHandler(deps, HOST, INPUT);
  // A's re-claim overwrites the stale `at` with NOW — that write is the observable takeover.
  await waitForPosPush(deps, validationId, (pp) => pp?.status === 'pending' && pp.at === NOW);
  await expect(posApplyValidationHandler(deps, HOST, INPUT)).rejects.toMatchObject({ code: 'failed_precondition', message: 'push in progress' });

  release();
  await first;
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]);
});

// ---------- H1 (T3 review): the push is CLAIMED inside the redemption transaction ----------

it('H1 RACE: a duplicate call during an in-flight push is refused — exactly ONE discount lands', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });

  // Hold the first call's push open on a gate, so its pending claim is live when the second
  // (double-click) call arrives.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realApply = pos.applyValidation.bind(pos);
  vi.spyOn(pos, 'applyValidation').mockImplementation(async (i) => { await gate; return realApply(i); });

  const first = posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID });
  // Wait until the first call's redemption transaction has committed the claim — the exact
  // window in which the shipped version fulfilled the duplicate and landed a second discount.
  for (let i = 0; i < 100; i++) {
    const v = (await deps.db.doc(P.validation(OP, validationId)).get()).data() as { posPush?: { status: string } };
    if (v.posPush?.status === 'pending') break;
    await new Promise((r) => setTimeout(r, 20));
  }

  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'push in progress' });

  release();
  await first;
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]); // ONE discount
  const v = (await deps.db.doc(P.validation(OP, validationId)).get()).data()!;
  expect(v.posPush).toMatchObject({ checkRef, status: 'pushed' });
});

it('H1 CRASH STATE: a STALE pending claim retries only for the SAME check — a different checkRef stays already-redeemed; a fresh pending refuses', async () => {
  const deps = testDeps();
  const { code, validationId } = await seed(deps);
  const pos = useMockPos();
  const checkRef = pos.seedCheck({ table: '12', total: 9125 });
  const otherRef = pos.seedCheck({ table: '4', total: 2000 });

  // The crash state the reviewer probed: redemption committed WITH its claim (as the fixed flow
  // writes it), process died before the push resolved — no 'pushed'/'failed' outcome recorded.
  const STALE = '2026-08-23T20:58:00.000Z'; // NOW − 2min > PROVIDER_CLAIM_TTL_MS
  await redeemValidation(deps, {
    operatorId: OP, validationId, ticketId: TID, actorUid: HOST.uid, source: 'pos',
    extraValidationFields: { posPush: { checkRef, status: 'pending', at: STALE } },
  });

  // A retry naming a DIFFERENT check must NOT qualify — the reviewer demonstrated the shipped
  // version pushing there.
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef: otherRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'validation already redeemed' });
  expect(pos.check(otherRef)!.discounts).toHaveLength(0);

  // The SAME check completes the crashed push exactly once.
  await posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID });
  expect(pos.check(checkRef)!.discounts).toEqual([{ amount: 700, reason: code }]);

  // And a FRESH pending (not stale) refuses even the same check — that's the race, not a crash.
  await deps.db.doc(P.validation(OP, validationId)).update({ posPush: { checkRef, status: 'pending', at: NOW } });
  await expect(posApplyValidationHandler(deps, HOST, { venueId: V1, checkRef, code, ticketId: TID })).rejects.toMatchObject({ code: 'failed_precondition', message: 'push in progress' });
});
