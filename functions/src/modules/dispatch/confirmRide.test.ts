import { beforeEach, expect, it, vi } from 'vitest';
import { guestConfirmRideHandler } from './confirmRide.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import * as registry from '../payments/registry.js';
import { StripeGateway } from '../payments/stripe.adapter.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk_test_x' }));
  return fake;
}

const QUOTE = { base: 1000, distanceMeters: 1609, durationSec: 120, amount: 1500, breakdown: [{ label: 'Base', amount: 1000 }] };

async function seedJob(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const job = ticketDoc({
    id: TID,
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    jobType: 'passenger_ride',
    status: 'quoted',
    guestToken: TOKEN,
    ride: {
      pickup: { geo: { lat: 39.76, lng: -86.16 } },
      dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } },
      passengers: 1,
      accessible: false,
      billTo: 'guest',
      quote: { ...QUOTE, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() },
    },
    ...over,
  });
  await deps.db.doc(P.ticket(OP, TID)).set(job);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: job });
  return job;
}

it('confirms from quoted: transitions to confirmed and creates a manual-capture checkout', async () => {
  const deps = testDeps();
  await seedJob(deps);
  const fake = useFake();
  const out = await guestConfirmRideHandler(deps, null, { token: TOKEN });
  expect(out.total).toBeGreaterThan(0);
  expect(fake.calls.paymentIntentsCreate[0]!.params.capture_method).toBe('manual');
  const t = (await deps.db.doc(P.ticket(OP, TID)).get()).data()!;
  expect(t.status).toBe('confirmed');
});

it('rejects an expired quote with failed_precondition (quote_expired)', async () => {
  const deps = testDeps();
  await seedJob(deps, { ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest', quote: { ...QUOTE, expiresAt: '2020-01-01T00:00:00.000Z' } } });
  useFake();
  await expect(guestConfirmRideHandler(deps, null, { token: TOKEN })).rejects.toMatchObject({ code: 'failed_precondition', message: 'quote_expired' });
});

it('rejects confirming a non-ride job', async () => {
  const deps = testDeps();
  await seedJob(deps, { jobType: 'drive_home' });
  useFake();
  await expect(guestConfirmRideHandler(deps, null, { token: TOKEN })).rejects.toMatchObject({ code: 'invalid_argument' });
});

// L3 (Plan 6 final wave), comment corrected per Ruling AH: `runCheckout` hardcodes
// `billTo: 'guest'`, so confirming a non-guest-billed ride through the guest path would charge
// the guest for a trip someone else is billed for. This guard is LIVE, not future-proofing —
// Plan 7 T1's `venueHostRequest` kind:'ride' creates venue-billed rides in this same range.
it('L3: rejects a venue-billed ride and leaves it untouched — no transition, no checkout', async () => {
  const deps = testDeps();
  const fake = useFake();
  await seedJob(deps, { ride: {
    pickup: { geo: { lat: 39.76, lng: -86.16 } },
    dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } },
    passengers: 2,
    accessible: false,
    billTo: 'venue',
    quote: { ...QUOTE, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() },
  } });

  await expect(guestConfirmRideHandler(deps, null, { token: TOKEN })).rejects.toThrow(/venue_billed_ride/);

  // The rejection must happen BEFORE the quoted->confirmed transition, or a retry would find the
  // job already confirmed and the guard would be bypassed on the second call.
  const after = (await deps.db.doc(P.ticket(OP, TID)).get()).data();
  expect(after?.status).toBe('quoted');
  // ...and nothing was charged.
  expect(fake.calls.paymentIntentsCreate.length).toBe(0);
});

it("RULING AH: the guard is EXCLUSION-shaped — a billing party that doesn't exist yet ('room') is rejected, not waved through", async () => {
  // `ride.billTo`'s schema does not yet permit 'room' — that is Ruling W's contracts change and
  // it belongs to Task 2's window, so the cast below is deliberate and comes out when Task 2
  // lands the enum value. This test exists to pin the guard's EXCLUSION shape (`!== 'guest'`)
  // AHEAD of that change: the whole point of the shape is that it holds for a value that does
  // not exist yet, and without this case nothing distinguishes it from the old inclusion-shaped
  // `=== 'venue'` — a regression back to inclusion would pass every other test and wave 'room'
  // straight into guest checkout the day Task 2 ships it.
  const deps = testDeps();
  const fake = useFake();
  await seedJob(deps, { ride: {
    pickup: { geo: { lat: 39.76, lng: -86.16 } },
    dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } },
    passengers: 2,
    accessible: false,
    billTo: 'room' as unknown as 'venue',
    quote: { ...QUOTE, expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString() },
  } });

  await expect(guestConfirmRideHandler(deps, null, { token: TOKEN })).rejects.toThrow(/venue_billed_ride/);
  const after = (await deps.db.doc(P.ticket(OP, TID)).get()).data();
  expect(after?.status).toBe('quoted'); // untouched — rejected before the transition
  expect(fake.calls.paymentIntentsCreate.length).toBe(0); // and nothing charged
});

it('L3: a guest-billed ride is unaffected by the venue guard', async () => {
  const deps = testDeps();
  useFake();
  await seedJob(deps);
  await expect(guestConfirmRideHandler(deps, null, { token: TOKEN })).resolves.toBeDefined();
  expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()?.status).toBe('confirmed');
});
