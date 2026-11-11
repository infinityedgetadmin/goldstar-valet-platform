import { beforeEach, expect, it, vi } from 'vitest';
import { staticCheckoutHandler } from './staticCheckout.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from '../payments/registry.js';
import { StripeGateway } from '../payments/stripe.adapter.js';
import { FakeStripe } from '../../../test/fakes/stripe.js';

beforeEach(async () => {
  await wipe(testDeps());
});

// Shared by the fix-round-1 tests below (Rulings J/L/M) — the given test above stays untouched
// (inlines its own venuePublic doc + spy verbatim, per the brief).
async function seedVenuePublic(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await deps.db.doc('venuePublic/VENUETOKEN_ABCDEFGHIJKLMN').set({
    operatorId: OP,
    venueId: V1,
    venueName: 'St. Elmo',
    branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' },
    tipPresets: [18, 20, 25],
    ...over,
  });
}

function useFake() {
  const fake = new FakeStripe();
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(fake, { publishableKey: 'pk' }));
  return fake;
}

it('creates a ticket and checkout from a venue token', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc('venuePublic/VENUETOKEN_ABCDEFGHIJKLMN').set({
    operatorId: OP,
    venueId: V1,
    venueName: 'St. Elmo',
    branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' },
    tipPresets: [18, 20, 25],
  });
  vi.spyOn(registry, 'getGateway').mockReturnValue(new StripeGateway(new FakeStripe(), { publishableKey: 'pk' }));
  const out = await staticCheckoutHandler(deps, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', plateLast4: '1234', tip: { kind: 'none' } });
  expect(out.total).toBe(1605);
  expect(out.ticketToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const tickets = await deps.db.collection(`operators/${OP}/tickets`).get();
  expect(tickets.size).toBe(1);
  expect(tickets.docs[0]!.data()).toMatchObject({ source: 'guest_web', vehicle: { plate: '1234' }, payment: { status: 'pending' } });
});

it('Fix round 1 (Ruling J): rate limit is keyed by deps.callerIp, not caller.ip — which is always null for a real anonymous call post-revert (task-5-review.md C1)', async () => {
  const deps = testDeps({ callerIp: '1.2.3.4' });
  await seedOperator(deps);
  await seedVenuePublic(deps);
  useFake();
  await staticCheckoutHandler(deps, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', tip: { kind: 'none' } });
  expect((await deps.db.doc('rateLimits/static:1.2.3.4').get()).exists).toBe(true);
  // A deps without callerIp set (the given Functions test above uses plain testDeps()) falls back to
  // a shared 'unknown' bucket — degraded, not broken. Same underlying emulator db as `deps` above
  // (testDeps() singletons on adminDb), so the operator/venuePublic docs already seeded are visible.
  const depsNoIp = testDeps();
  await staticCheckoutHandler(depsNoIp, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', tip: { kind: 'none' } });
  expect((await depsNoIp.db.doc('rateLimits/static:unknown').get()).exists).toBe(true);
});

it("Fix round 1 (Ruling L): accepts a preset tip that matches the operator's real tipPresets", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedVenuePublic(deps);
  useFake();
  const out = await staticCheckoutHandler(deps, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', tip: { kind: 'preset', percent: 20 } });
  expect(out.tip).toBe(Math.round(1605 * 0.2)); // 321
});

it('Fix round 1 (Ruling L): rejects a preset tip percent the operator has not configured, before minting a ticket', async () => {
  const deps = testDeps();
  await seedOperator(deps); // op.modules.payments.tipPresets is [18, 20, 25] — 99 is not a member
  await seedVenuePublic(deps);
  useFake();
  await expect(
    staticCheckoutHandler(deps, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', tip: { kind: 'preset', percent: 99 } }),
  ).rejects.toMatchObject({ code: 'invalid_argument' });
  expect((await deps.db.collection(`operators/${OP}/tickets`).get()).size).toBe(0);
});

it('Fix round 1 (Ruling M): rejects a non-flat-rate venue with failed_precondition, before minting a ticket', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.venue(OP, V1)).update({ 'rates.valet.model': 'hourly' });
  await seedVenuePublic(deps);
  useFake();
  await expect(
    staticCheckoutHandler(deps, null, { venueToken: 'VENUETOKEN_ABCDEFGHIJKLMN', tip: { kind: 'none' } }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
  expect((await deps.db.collection(`operators/${OP}/tickets`).get()).size).toBe(0);
});
