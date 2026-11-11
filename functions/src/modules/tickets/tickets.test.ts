import { beforeEach, describe, expect, it } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { ticketWrittenHandler } from './ticket.handler.js';
import { archiveHandler } from './archive.js';
import { shouldProcessTicketWrite } from './onTicketWritten.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
interface WrittenTicket extends Record<string, unknown> {
  metrics?: { retrievalSec?: number; readyToDeliverSec?: number; tripSec?: number };
  payment?: { status?: string; refundRequested?: boolean; refundRequestId?: string };
}
const template = (d: QueryDocumentSnapshot): string => (d.data() as { template: string }).template;
beforeEach(async () => { await wipe(testDeps()); });
async function write(deps: ReturnType<typeof testDeps>, before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<WrittenTicket> { await deps.db.doc(P.ticket(OP, TID)).set(after); await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before, after }); return (await deps.db.doc(P.ticket(OP, TID)).get()).data() as WrittenTicket; }
describe('ticket written', () => {
  it('on create: projection exists without PII, welcome SMS queued when consented', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await write(deps, null, ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, name: 'Jane Guest' } }));
    const proj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data()!;
    expect(proj).toMatchObject({ operatorId: OP, ticketId: TID, venueName: 'St. Elmo', status: 'checked_in', vehicleSummary: 'Blue Honda Civic', payment: { status: 'none', total: 0, currency: 'USD', tipPresets: [18, 20, 25] } });
    // Guest PII (phone, plate, name) must not leak into the public projection — checked against the
    // ticket's actual values, not a bare '+1317' area-code prefix, which also matches the operator's
    // own legitimately-included branding.supportPhone ('+13175550100', same Indianapolis area code).
    expect(JSON.stringify(proj)).not.toContain('+13175550123'); expect(JSON.stringify(proj)).not.toContain('ABC123'); expect(JSON.stringify(proj)).not.toContain('Jane Guest');
    const msgs = await deps.db.collection('outboundMessages').get(); expect(msgs.docs.map(template)).toEqual(['welcome']);
    expect(msgs.docs[0]!.data()).toMatchObject({ operatorId: OP, to: '+13175550123', status: 'queued' });
  });
  it('no welcome SMS without consent; no duplicate on retry', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const t = ticketDoc({ guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: false } });
    await write(deps, null, t); await write(deps, null, t);
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(0);
    await write(deps, null, ticketDoc()); await write(deps, null, ticketDoc());
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(1);
  });
  it('ready computes retrievalSec, queues ready SMS; delivered computes readyToDeliverSec; closed queues survey and expires projection', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const req = ticketDoc({ status: 'requested', times: { checkedInAt: NOW, requestedAt: '2026-08-23T21:10:00.000Z' } });
    await write(deps, ticketDoc(), req);
    const ready = { ...req, status: 'ready', times: { ...req.times, readyAt: '2026-08-23T21:16:30.000Z' } };
    const afterReady = await write(deps, req, ready); expect(afterReady.metrics?.retrievalSec).toBe(390);
    const delivered = { ...ready, status: 'delivered', times: { ...ready.times, deliveredAt: '2026-08-23T21:18:00.000Z' } };
    const afterDelivered = await write(deps, ready, delivered); expect(afterDelivered.metrics?.readyToDeliverSec).toBe(90);
    const closed = { ...delivered, status: 'closed', times: { ...delivered.times, closedAt: '2026-08-23T21:19:00.000Z' } };
    await write(deps, delivered, closed);
    const templates = (await deps.db.collection('outboundMessages').orderBy('createdAt').get()).docs.map(template); expect(templates).toEqual(['ready', 'survey']);
    expect((await deps.db.doc(P.guestTicket(TOKEN)).get()).data()?.expiresAt).toBe('2026-08-24T21:19:00.000Z');
  });
  it('push events queued for guest uid on status change; redelivered trigger does not duplicate or reset status', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const t = ticketDoc({ guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } });
    const after = { ...t, status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } };
    await write(deps, t, after);
    const pushes = await deps.db.collection('pushEvents').get();
    const target = pushes.docs.find((d) => d.data().toUid === 'g1' && d.data().kind === 'ticket.status');
    expect(target).toBeDefined();
    expect(target!.data().id).toBe(target!.id); // stored `id` field is the FULL doc id (uid suffix included)
    await target!.ref.update({ status: 'sent' }); // simulate the push worker having already delivered it
    await write(deps, t, after); // redelivered trigger invocation for the identical before/after pair
    const pushesAfterRetry = await deps.db.collection('pushEvents').get();
    expect(pushesAfterRetry.size).toBe(pushes.size);
    expect((await target!.ref.get()).data()?.status).toBe('sent');
  });
  it("GUEST COPY GOES TO THE GUEST ONLY: no ticket.status push event ever targets the venue topic — attendants were receiving 'Your car is ready'", async () => {
    // Pre-fix, enqueuePush targeted the guest uid AND `venue_{op}_{venueId}` — the exact topic every
    // on-shift attendant's device subscribes to (mobile's venueTopic()) — with copyFor's GUEST copy
    // ("Your car is ready — Head to the valet stand", "Enjoy your drive — Thanks for choosing us").
    // Staff-facing venue-topic pushes stay where they were designed: venue.request/venue.pre_arrival.
    const deps = testDeps(); await seedOperator(deps);
    const t = ticketDoc({ guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } });
    let cur = t;
    for (const status of ['requested', 'ready', 'delivered'] as const) {
      const next = { ...cur, status, times: { ...cur.times, [`${status}At`]: NOW } };
      await write(deps, cur, next);
      cur = next;
    }
    const pushes = await deps.db.collection('pushEvents').get();
    const statusEvents = pushes.docs.map((d) => d.data()).filter((d) => d.kind === 'ticket.status');
    expect(statusEvents.length).toBe(3); // one per status change — the uid target, nothing else
    for (const ev of statusEvents) {
      expect(ev.toUid).toBe('g1');
      expect(ev.toTopic).toBeUndefined();
    }
  });
  it('a ticket whose guest never linked (no uid) queues NO ticket.status push at all — SMS owns that guest', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const t = ticketDoc(); // helpers' default guest has no uid
    const after = { ...t, status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } };
    await write(deps, t, after);
    const pushes = await deps.db.collection('pushEvents').get();
    expect(pushes.docs.filter((d) => d.data().kind === 'ticket.status')).toHaveLength(0);
  });
});
describe('cancel → refund flag, push preference', () => {
  it('cancelling a paid ticket flags a refund server-side', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const paid = ticketDoc({ status: 'requested', payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_1' } });
    const cancelled = await write(deps, paid, { ...paid, status: 'cancelled', cancelReason: 'offline cancel', times: { checkedInAt: NOW, cancelledAt: NOW } });
    expect(cancelled.payment?.refundRequested).toBe(true);
    // Ruling AH: refundRequestId minted in the SAME write as refundRequested:true.
    expect(cancelled.payment?.refundRequestId).toBeTruthy();
  });
  it('skips status SMS when the guest has push tokens; welcome still sent', async () => {
    const deps = testDeps(); await seedOperator(deps); await deps.db.doc(P.guest('g1')).set({ phoneE164: '+13175550123', fcmTokens: ['t'], consent: { sms: true, push: true } });
    const t = ticketDoc({ guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } });
    await write(deps, null, t); await write(deps, t, { ...t, status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    const ready = { ...t, status: 'ready', times: { checkedInAt: NOW, requestedAt: NOW, readyAt: NOW } }; await write(deps, { ...t, status: 'requested' }, ready);
    expect((await deps.db.collection('outboundMessages').get()).docs.map(template)).toEqual(['welcome']);
  });
});
describe('archive', () => {
  it('moves closed tickets older than 90 days with subcollections, keeps recent', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed', times: { checkedInAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T01:00:00.000Z' } }));
    await deps.db.doc(P.custody(OP, TID, '01912345-7abc-7def-8123-456789abcde1')).set({ id: '01912345-7abc-7def-8123-456789abcde1', actorUid: 'att1', action: 'parked', at: NOW, deviceId: 'd' });
    await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-456789abcde2')).set(ticketDoc({ id: '01912345-7abc-7def-8123-456789abcde2', status: 'closed', times: { checkedInAt: NOW, closedAt: NOW } }));
    const res = await archiveHandler(deps, { cutoffDays: 90 }); expect(res.archived).toBe(1);
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).exists).toBe(false);
    expect((await deps.db.doc(P.archiveTicket(OP, TID)).get()).data()?.status).toBe('closed');
    expect((await deps.db.doc(`${P.archiveTicket(OP, TID)}/custodyEvents/01912345-7abc-7def-8123-456789abcde1`).get()).exists).toBe(true);
    expect((await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-456789abcde2')).get()).exists).toBe(true);
    // No single operatorId spans a collectionGroup archive run, so the summary audit entry lands
    // in the platform-level log (P.audit with no operatorId).
    const archiveLogs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'tickets.archive').get();
    expect(archiveLogs.size).toBe(1);
    expect(archiveLogs.docs[0]!.data()).toMatchObject({ actorUid: 'system', after: { archived: 1 } });
  });
  it('writes no audit entry when nothing was archived', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const res = await archiveHandler(deps, { cutoffDays: 90 });
    expect(res.archived).toBe(0);
    const archiveLogs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'tickets.archive').get();
    expect(archiveLogs.size).toBe(0);
  });

  // Carry #21, boundary chosen deliberately: per ticket the archive needs 1 (dest set) + 2 per
  // custody event (copy + delete) + 1 (ticket delete) = 2 + 2N operations against the DOCUMENTED
  // batched-write contract of at most 500 operations per commit (verified against current
  // @google-cloud/firestore docs — the client sends without any local check, so the rejection is
  // server-side). 2 + 2·249 = 500 commits AT the cap; 2 + 2·250 = 502 is the FIRST failing N.
  // The ledger's original ">248" was off by one — a regression test written to that number passes
  // against the broken function — which is why this comment pins the arithmetic and the test
  // uses 250. ONE MORE TRAP, learned running this test: the EMULATOR does not enforce the cap
  // (an unchunked 502-op commit was observed to succeed here), so asserting only "it archives"
  // passes against the broken production behavior too. The test therefore pins the contract
  // directly: it counts the operations in every committed batch through a proxy and fails any
  // commit exceeding the chunk bound — which an unchunked implementation fails at 502.
  it('carry #21: a ticket with 250 custody events (2+2N = 502 ops, first N past the 500 cap) archives completely, no batch over the bound', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed', times: { checkedInAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T01:00:00.000Z' } }));
    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        deps.db.doc(P.custody(OP, TID, `01912345-7abc-7def-8123-456789${String(i).padStart(6, '0')}`)).set({ id: `e${i}`, actorUid: 'att1', action: 'parked', at: NOW, deviceId: 'd' }),
      ),
    );

    const batchSizes: number[] = [];
    const countedDb = new Proxy(deps.db, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return () => {
            const b = target.batch();
            let ops = 0;
            return new Proxy(b, {
              get(bt, bp, br) {
                if (bp === 'set' || bp === 'delete' || bp === 'update' || bp === 'create') {
                  const fn = Reflect.get(bt, bp, br) as (...a: unknown[]) => unknown;
                  return (...args: unknown[]) => { ops++; return fn.apply(bt, args); };
                }
                if (bp === 'commit') return () => { batchSizes.push(ops); return bt.commit(); };
                const v: unknown = Reflect.get(bt, bp, br);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
              },
            });
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

    const res = await archiveHandler({ ...deps, db: countedDb }, { cutoffDays: 90 });

    expect(res.archived).toBe(1);
    // every committed batch stays within the chunk bound (the documented cap is 500; we chunk at
    // 450 for headroom) — an unchunked implementation commits one 502-op batch and fails HERE,
    // regardless of the emulator's leniency
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(502);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(450);
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).exists).toBe(false);
    expect((await deps.db.doc(P.archiveTicket(OP, TID)).get()).data()?.status).toBe('closed');
    expect((await deps.db.doc(P.archiveTicket(OP, TID)).collection('custodyEvents').count().get()).data().count).toBe(250);
    expect((await deps.db.doc(P.ticket(OP, TID)).collection('custodyEvents').count().get()).data().count).toBe(0);
  });

  // Carry #21's real blast radius: the old single try-less loop meant one poison ticket failed the
  // WHOLE run — and because the closed pass ran first, cancelled tickets were never archived at
  // all, forever, and the deterministic path-ordered limit(200) re-selected the same poison ticket
  // first on every subsequent run (zero progress platform-wide). The poison here is real and
  // reachable: an `operatorId` field containing '/' makes P.archiveTicket an invalid doc path and
  // deps.db.doc() throws synchronously. The poison id sorts FIRST so this also proves later docs
  // in the same pass still proceed.
  it('carry #21: one poison ticket is skipped and counted; the rest of its pass AND the other status pass still archive', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const POISON = '00000000-0000-7000-8000-000000000bad';
    const CANCELLED = '01912345-7abc-7def-8123-456789cccccc';
    await deps.db.doc(P.ticket(OP, POISON)).set(ticketDoc({ id: POISON, operatorId: 'bad/slash', status: 'closed', times: { checkedInAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T01:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed', times: { checkedInAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T01:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, CANCELLED)).set(ticketDoc({ id: CANCELLED, status: 'cancelled', times: { checkedInAt: '2026-01-01T00:00:00.000Z', cancelledAt: '2026-01-01T01:00:00.000Z' } }));

    const res = await archiveHandler(deps, { cutoffDays: 90 });

    expect(res.archived).toBe(2);
    expect(res.failed).toBe(1);
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).exists).toBe(false);
    expect((await deps.db.doc(P.ticket(OP, CANCELLED)).get()).exists).toBe(false);
    expect((await deps.db.doc(P.archiveTicket(OP, CANCELLED)).get()).exists).toBe(true);
    // the poison ticket stays in place, un-archived, for a human to fix
    expect((await deps.db.doc(P.ticket(OP, POISON)).get()).exists).toBe(true);
    const archiveLogs = await deps.db.collection('platform/auditLog/entries').where('action', '==', 'tickets.archive').get();
    expect(archiveLogs.size).toBe(1);
    expect(archiveLogs.docs[0]!.data()).toMatchObject({ after: { archived: 2, failed: 1 } });
  });
});
describe('shouldProcessTicketWrite (recursion guard)', () => {
  const base = ticketDoc();
  it('after missing (delete) → false', () => {
    expect(shouldProcessTicketWrite(base, undefined)).toBe(false);
  });
  it('before missing (create) → true', () => {
    expect(shouldProcessTicketWrite(null, base)).toBe(true);
  });
  it('identical docs → false', () => {
    expect(shouldProcessTicketWrite(base, { ...base })).toBe(false);
  });
  it('metrics-only change → false (would otherwise recurse forever on the handler\'s own metrics patch)', () => {
    expect(shouldProcessTicketWrite(base, { ...base, metrics: { retrievalSec: 10 } })).toBe(false);
  });
  it('status change → true', () => {
    expect(shouldProcessTicketWrite(base, { ...base, status: 'requested' })).toBe(true);
  });
  it('payment-only change → true', () => {
    expect(shouldProcessTicketWrite(base, { ...base, payment: { status: 'paid' } })).toBe(true);
  });
  it('times-only change → true', () => {
    expect(shouldProcessTicketWrite(base, { ...base, times: { ...base.times, requestedAt: NOW } })).toBe(true);
  });
});
// The 'photo counter' suite was deleted with `onPhotoCreated` (Plan 8 Task 6, carry #20/#25):
// nothing maintains or reads `photoCount` any more — the inspection gate count()s the photos
// subcollection (pinned in onJobWritten.test.ts, including the lying-field regression).
describe('linked jobs projection (4b-F3 carry, WITH TEETH)', () => {
  const CHILD1 = '01912345-7abc-7def-8123-456789job0001';
  const CHILD2 = '01912345-7abc-7def-8123-456789job0002';
  const CHILD1_TOKEN = 'AbCdEfGhIjKlMnOpQrSt01';
  const CHILD2_TOKEN = 'AbCdEfGhIjKlMnOpQrSt02';

  it('rebuilding the parent projection for an UNRELATED reason derives linkedJobs fresh — active children survive, terminal ones are excluded', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await write(deps, null, ticketDoc());
    const child1 = ticketDoc({ id: CHILD1, parentTicketId: TID, jobType: 'drive_home', status: 'confirmed', guestToken: CHILD1_TOKEN });
    const child2 = ticketDoc({ id: CHILD2, parentTicketId: TID, jobType: 'passenger_ride', status: 'cancelled', cancelReason: 'guest changed plans', guestToken: CHILD2_TOKEN });
    await deps.db.doc(P.ticket(OP, CHILD1)).set(child1);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD1, before: null, after: child1 });
    await deps.db.doc(P.ticket(OP, CHILD2)).set(child2);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD2, before: null, after: child2 });

    // Rebuild the PARENT for a reason that has nothing to do with either child (a plain vehicle edit)
    // — this is the regression case: buildProjection's caller never carries linkedJobs forward from a
    // prior write, so this MUST re-derive from the current children, not from whatever the child
    // writes above happened to leave behind.
    const before = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as Record<string, unknown>;
    const after = { ...before, vehicle: { ...(before.vehicle as Record<string, unknown>), notes: 'scratch on rear bumper' } };
    await write(deps, before, after);

    const proj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as { linkedJobs?: unknown[] };
    expect(proj.linkedJobs).toEqual([{ ticketId: CHILD1, jobType: 'drive_home', status: 'confirmed', token: CHILD1_TOKEN }]);
  });

  it('a status change on the child job propagates to the parent projection linkedJobs entry', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await write(deps, null, ticketDoc());
    const child = ticketDoc({ id: CHILD1, parentTicketId: TID, jobType: 'drive_home', status: 'confirmed', guestToken: CHILD1_TOKEN });
    await deps.db.doc(P.ticket(OP, CHILD1)).set(child);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD1, before: null, after: child });
    let proj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as { linkedJobs?: { status?: string }[] };
    expect(proj.linkedJobs?.[0]?.status).toBe('confirmed');

    const assigned = { ...child, status: 'assigned', attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' } };
    await deps.db.doc(P.ticket(OP, CHILD1)).set(assigned);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD1, before: child, after: assigned });
    proj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as { linkedJobs?: { status?: string }[] };
    expect(proj.linkedJobs?.[0]?.status).toBe('assigned');
  });

  it("a job ticket's own projection never carries linkedJobs of its own (jobs don't spawn sub-jobs) — always []", async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await write(deps, null, ticketDoc());
    const child = ticketDoc({ id: CHILD1, parentTicketId: TID, jobType: 'drive_home', status: 'confirmed', guestToken: CHILD1_TOKEN });
    await deps.db.doc(P.ticket(OP, CHILD1)).set(child);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD1, before: null, after: child });
    const childProj = (await deps.db.doc(P.guestTicket(CHILD1_TOKEN)).get()).data() as { linkedJobs?: unknown[] };
    expect(childProj.linkedJobs).toEqual([]);
  });
});
describe('driver projection (derived, not merge-written)', () => {
  it('derives driver.firstName once attendants.primaryDriverUid is set, keeps it through completed, and drops it once the job reaches a TERMINAL status (closed/cancelled)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.user(OP, 'primary1')).set({
      uid: 'primary1', operatorId: OP, displayName: 'Jordan Lee', email: 'jordan@example.com', roles: ['driver'],
      venueIds: [], status: 'active', eligibility: { driveHome: true, passengerRide: false, reasons: [] }, payoutStatus: 'none', fcmTokens: [], invitedAt: NOW,
    });
    const CHILD = '01912345-7abc-7def-8123-456789job0003';
    const CHILD_TOKEN = 'AbCdEfGhIjKlMnOpQrSt03';
    const unassigned = ticketDoc({ id: CHILD, parentTicketId: TID, jobType: 'drive_home', status: 'confirmed', guestToken: CHILD_TOKEN });
    await deps.db.doc(P.ticket(OP, CHILD)).set(unassigned);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD, before: null, after: unassigned });
    let proj = (await deps.db.doc(P.guestTicket(CHILD_TOKEN)).get()).data() as { driver?: { firstName?: string } };
    expect(proj.driver).toBeUndefined();

    const assigned = { ...unassigned, status: 'assigned', attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' } };
    await deps.db.doc(P.ticket(OP, CHILD)).set(assigned);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD, before: unassigned, after: assigned });
    proj = (await deps.db.doc(P.guestTicket(CHILD_TOKEN)).get()).data() as { driver?: { firstName?: string } };
    expect(proj.driver?.firstName).toBe('Jordan');

    // 'completed' is NOT a terminal status (TERMINAL_STATUSES is only ['closed', 'cancelled']) — the
    // driver's name/photo should still show on a just-completed trip's projection (e.g. a trip
    // summary), so it stays derived here.
    const completed = { ...assigned, status: 'completed' };
    await deps.db.doc(P.ticket(OP, CHILD)).set(completed);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD, before: assigned, after: completed });
    proj = (await deps.db.doc(P.guestTicket(CHILD_TOKEN)).get()).data() as { driver?: { firstName?: string } };
    expect(proj.driver?.firstName).toBe('Jordan');

    const closed = { ...completed, status: 'closed' };
    await deps.db.doc(P.ticket(OP, CHILD)).set(closed);
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: CHILD, before: completed, after: closed });
    proj = (await deps.db.doc(P.guestTicket(CHILD_TOKEN)).get()).data() as { driver?: { firstName?: string } };
    expect(proj.driver).toBeUndefined();
  });
});

describe('poison-event guard (carry #18)', () => {
  // `onTicketWritten` is registered with `retry: true`, so a throw here is not one failure — it is
  // an infinite redelivery loop for a ticket whose operator or venue doc has been deleted. The
  // guard converts that permanent-poison case into a logged skip; a transient read failure still
  // throws (and retries), which is the behavior retry exists for.
  it('a ticket referencing a missing OPERATOR doc returns without throwing and writes nothing', async () => {
    const deps = testDeps();
    await wipe(deps); // no seedOperator — the operator doc genuinely does not exist
    const t = ticketDoc();
    await deps.db.doc(P.ticket(OP, TID)).set(t);

    await expect(ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t })).resolves.toBeUndefined();
    expect((await deps.db.doc(P.guestTicket(TOKEN)).get()).exists).toBe(false);
  });

  it('a ticket referencing a missing VENUE doc likewise returns without throwing and writes nothing', async () => {
    const deps = testDeps();
    await wipe(deps);
    await seedOperator(deps);
    const t = ticketDoc({ venueId: 'ghost-venue' });
    await deps.db.doc(P.ticket(OP, TID)).set(t);

    await expect(ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t })).resolves.toBeUndefined();
    expect((await deps.db.doc(P.guestTicket(TOKEN)).get()).exists).toBe(false);
  });
});
