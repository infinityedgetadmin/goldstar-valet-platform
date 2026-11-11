import { beforeEach, expect, it, vi } from 'vitest';
import { guestConfirmDriveHomeHandler } from './confirmDriveHome.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import * as registry from '../payments/registry.js';
import { StripeGateway } from '../payments/stripe.adapter.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  status?: string;
  payment?: { status?: string };
  driveHome?: { termsAcceptedAt?: string; termsVersion?: string };
}

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

const QUOTE = { base: 2500, distanceMeters: 16_093, durationSec: 900, amount: 5750, breakdown: [{ label: 'Base', amount: 2500 }] };

async function seedJob(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'drive_home',
    status: 'quoted',
    guestToken: TOKEN,
    driveHome: { destination: { address: '1 Home St', geo: { lat: 39.8, lng: -86.1 } }, quote: { ...QUOTE, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() }, chase: { status: 'pending' } },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  return job;
}

it('confirms from quoted: accepts terms, transitions to confirmed, and creates a manual-capture checkout', async () => {
  const deps = testDeps();
  await seedJob(deps);
  const fake = useFake();
  const out = await guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'drive-home-v1' });
  expect(out.total).toBeGreaterThan(0);
  expect(fake.calls.paymentIntentsCreate[0]!.params.capture_method).toBe('manual');
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('confirmed');
  expect(t.driveHome?.termsAcceptedAt).toBe(NOW);
  expect(t.driveHome?.termsVersion).toBe('drive-home-v1');
  expect(t.payment).toMatchObject({ status: 'pending' });
});

it('rejects an expired quote with failed_precondition (quote_expired)', async () => {
  const deps = testDeps();
  await seedJob(deps, { driveHome: { destination: { address: 'x', geo: { lat: 1, lng: 2 } }, quote: { ...QUOTE, expiresAt: '2020-01-01T00:00:00.000Z' }, chase: { status: 'pending' } } });
  useFake();
  await expect(guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'drive-home-v1' })).rejects.toMatchObject({ code: 'failed_precondition', message: 'quote_expired' });
});

it('rejects a wrong/unsupported termsVersion', async () => {
  const deps = testDeps();
  await seedJob(deps);
  useFake();
  await expect(guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'v0-old' })).rejects.toMatchObject({ code: 'invalid_argument' });
});

it('re-confirming an already-confirmed job (reload/retry) re-runs checkout idempotently without re-attempting the transition', async () => {
  const deps = testDeps();
  await seedJob(deps);
  useFake();
  await guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'drive-home-v1' });
  const out2 = await guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'drive-home-v1' });
  expect(out2.total).toBeGreaterThan(0);
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as JobView;
  expect(t.status).toBe('confirmed');
});

it('rejects confirming a job that is neither quoted nor confirmed (e.g. already assigned)', async () => {
  const deps = testDeps();
  await seedJob(deps, { status: 'assigned', attendants: { primaryDriverUid: 'd1', chaseDriverUid: 'd2' } });
  useFake();
  await expect(guestConfirmDriveHomeHandler(deps, null, { token: TOKEN, termsVersion: 'drive-home-v1' })).rejects.toMatchObject({ code: 'ticket_invalid_transition' });
});
