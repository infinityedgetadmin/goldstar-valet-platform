import { beforeEach, describe, expect, it } from 'vitest';
import { jobLifecycleSweepHandler } from './jobLifecycleSweep.js';
import { NOW, OP, TID, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  status: string;
  cancelReason?: string;
  times: { completedAt?: string; closedAt?: string; cancelledAt?: string };
}

const minutes = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();

async function seedCompletedJob(deps: ReturnType<typeof testDeps>, id: string, completedAt: string, over: Record<string, unknown> = {}) {
  const job = ticketDoc({
    id,
    jobType: 'drive_home',
    status: 'completed',
    attendants: { primaryDriverUid: 'primary1', chaseDriverUid: 'chase1' },
    driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'done' } },
    times: { checkedInAt: NOW, completedAt },
    payment: { status: 'paid', base: 2500, tip: 0, tax: 0, fees: 0, total: 2500, currency: 'USD', billTo: 'guest' },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, id)).set(job);
  return job;
}

async function seedQuotedJob(deps: ReturnType<typeof testDeps>, id: string, expiresAt: string, over: Record<string, unknown> = {}) {
  const job = ticketDoc({
    id,
    jobType: 'drive_home',
    status: 'quoted',
    driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [], expiresAt }, chase: { status: 'pending' } },
    times: { checkedInAt: NOW },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, id)).set(job);
  return job;
}

describe('jobLifecycleSweepHandler: completed -> closed', () => {
  it('closes a job completed more than 1h ago, sets times.closedAt, audits SYS', async () => {
    const deps = testDeps();
    await seedCompletedJob(deps, TID, NOW);
    const later = testDeps({ now: () => minutes(61) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 1, quoteExpired: 0 });

    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('closed');
    expect(t.times.closedAt).toBe(minutes(61));

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.close_job').get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data().actorUid).toBe('system');
    expect(audits.docs[0]!.data().target).toBe(TID);
  });

  it('boundary: a job completed 59 minutes ago is left alone (still completed)', async () => {
    const deps = testDeps();
    await seedCompletedJob(deps, TID, NOW);
    const almost = testDeps({ now: () => minutes(59) });

    const out = await jobLifecycleSweepHandler(almost);
    expect(out).toEqual({ closed: 0, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('completed');
  });

  it('boundary: a job completed exactly 60 minutes ago closes (>= the cutoff, not strictly past it)', async () => {
    const deps = testDeps();
    await seedCompletedJob(deps, TID, NOW);
    const exact = testDeps({ now: () => minutes(60) });

    const out = await jobLifecycleSweepHandler(exact);
    expect(out).toEqual({ closed: 1, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('closed');
  });

  it('closes a passenger_ride job the same way as drive_home', async () => {
    const deps = testDeps();
    const ride = ticketDoc({
      id: TID,
      jobType: 'passenger_ride',
      status: 'completed',
      attendants: { primaryDriverUid: 'primary1' },
      vehicle: { fleetVehicleId: 'fv1' },
      ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
      times: { checkedInAt: NOW, completedAt: NOW },
      payment: { status: 'paid', base: 1000, tip: 0, tax: 0, fees: 0, total: 1000, currency: 'USD', billTo: 'guest' },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(ride);
    const later = testDeps({ now: () => minutes(90) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 1, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('closed');
  });

  it('leaves a valet ticket alone even if one were somehow sitting at status "completed" (defensive — collectionGroup scan trusts nothing)', async () => {
    const deps = testDeps();
    const valet = ticketDoc({
      id: TID,
      jobType: 'valet',
      status: 'completed', // contrived — 'completed' is not a real valet status; exercises the defensive jobType guard
      times: { checkedInAt: NOW, completedAt: NOW },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(valet);
    const later = testDeps({ now: () => minutes(120) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 0, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('completed');
  });

  it('is idempotent — a second run finds nothing left to close', async () => {
    const deps = testDeps();
    await seedCompletedJob(deps, TID, NOW);
    const later = testDeps({ now: () => minutes(90) });

    await jobLifecycleSweepHandler(later);
    const out2 = await jobLifecycleSweepHandler(later);
    expect(out2).toEqual({ closed: 0, quoteExpired: 0 });

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.close_job').get();
    expect(audits.size).toBe(1);
  });
});

describe('jobLifecycleSweepHandler: quoted -> cancelled (quote_expired)', () => {
  it('cancels a drive_home job whose quote expired more than 24h ago, sets cancelReason, audits SYS', async () => {
    const deps = testDeps();
    await seedQuotedJob(deps, TID, NOW);
    const later = testDeps({ now: () => minutes(24 * 60 + 1) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 0, quoteExpired: 1 });

    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('cancelled');
    expect(t.cancelReason).toBe('quote_expired');
    expect(t.times.cancelledAt).toBe(minutes(24 * 60 + 1));

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.cancel_expired_quote').get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data().actorUid).toBe('system');
  });

  it('cancels a passenger_ride job the same way, reading ride.quote.expiresAt', async () => {
    const deps = testDeps();
    const ride = ticketDoc({
      id: TID,
      jobType: 'passenger_ride',
      status: 'quoted',
      ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest', quote: { base: 1000, distanceMeters: 100, durationSec: 300, amount: 1500, breakdown: [], expiresAt: NOW } },
      times: { checkedInAt: NOW },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(ride);
    const later = testDeps({ now: () => minutes(24 * 60 + 30) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 0, quoteExpired: 1 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('cancelled');
    expect(t.cancelReason).toBe('quote_expired');
  });

  it('boundary: a quote expired 23h59m ago is left alone (still quoted)', async () => {
    const deps = testDeps();
    await seedQuotedJob(deps, TID, NOW);
    const almost = testDeps({ now: () => minutes(24 * 60 - 1) });

    const out = await jobLifecycleSweepHandler(almost);
    expect(out).toEqual({ closed: 0, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('quoted');
  });

  it('boundary: a quote expired exactly 24h ago cancels (>= the cutoff, not strictly past it)', async () => {
    const deps = testDeps();
    await seedQuotedJob(deps, TID, NOW);
    const exact = testDeps({ now: () => minutes(24 * 60) });

    const out = await jobLifecycleSweepHandler(exact);
    expect(out).toEqual({ closed: 0, quoteExpired: 1 });
  });

  it('a quote with no expiresAt is left alone entirely (never expires server-side)', async () => {
    const deps = testDeps();
    const job = ticketDoc({
      id: TID,
      jobType: 'drive_home',
      status: 'quoted',
      driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { base: 2500, distanceMeters: 100, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'pending' } },
      times: { checkedInAt: NOW },
    });
    await deps.db.doc(P.ticket(OP, TID)).set(job);
    const later = testDeps({ now: () => minutes(24 * 60 * 10) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 0, quoteExpired: 0 });
    const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
    expect(t.status).toBe('quoted');
  });

  it('leaves valet tickets alone entirely', async () => {
    const deps = testDeps();
    const valet = ticketDoc({ id: TID, jobType: 'valet', status: 'checked_in' });
    await deps.db.doc(P.ticket(OP, TID)).set(valet);
    const later = testDeps({ now: () => minutes(24 * 60 * 10) });

    const out = await jobLifecycleSweepHandler(later);
    expect(out).toEqual({ closed: 0, quoteExpired: 0 });
  });

  it('is idempotent — a second run finds nothing left to cancel', async () => {
    const deps = testDeps();
    await seedQuotedJob(deps, TID, NOW);
    const later = testDeps({ now: () => minutes(24 * 60 + 60) });

    await jobLifecycleSweepHandler(later);
    const out2 = await jobLifecycleSweepHandler(later);
    expect(out2).toEqual({ closed: 0, quoteExpired: 0 });

    const audits = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'dispatch.cancel_expired_quote').get();
    expect(audits.size).toBe(1);
  });
});
