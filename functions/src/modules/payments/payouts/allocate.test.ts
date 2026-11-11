import { beforeEach, expect, it, vi } from 'vitest';
import type { Ticket } from '@goldstar/platform';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../../test/helpers.js';
import { P } from '../../../lib/paths.js';
import { allocateDelivererTip } from './allocate.js';

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

function closedPaidTicket(over: Record<string, unknown> = {}): Ticket {
  return ticketDoc({
    status: 'closed',
    attendants: { checkedInBy: 'att1', deliveredBy: 'att2' },
    payment: { status: 'paid', base: 1500, tip: 700, tax: 105, fees: 0, total: 2305, currency: 'USD', billTo: 'guest', lastIntentId: 'pi_fund1' },
    ...over,
  }) as unknown as Ticket;
}

it("MONEY: closed+paid+tipped under 'deliverer' allocates the tip to deliveredBy with the funding ref, create-only", async () => {
  const deps = testDeps();
  await seedOperator(deps); // seed operator tipPolicy is 'deliverer'
  const after = closedPaidTicket();
  await allocateDelivererTip(deps, { operatorId: OP, before: ticketDoc({ status: 'delivered' }) as unknown as Ticket, after });

  const doc = (await deps.db.doc(P.payout(OP, 'att2', TID)).get()).data()!;
  expect(doc).toEqual({ id: TID, ticketId: TID, amount: 700, currency: 'USD', status: 'pending', createdAt: NOW, fundingRef: 'pi_fund1' });

  // Redelivery / reclose: create-only — the original doc stands, createdAt included.
  const later = new Date(Date.parse(NOW) + 3600_000).toISOString();
  await allocateDelivererTip(testDeps({ now: () => later }), { operatorId: OP, before: ticketDoc({ status: 'delivered' }) as unknown as Ticket, after });
  expect((await deps.db.doc(P.payout(OP, 'att2', TID)).get()).data()!.createdAt).toBe(NOW);
});

it('a passenger_ride allocates to primaryDriverUid, not deliveredBy', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const after = closedPaidTicket({
    jobType: 'passenger_ride',
    parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'guest' },
    attendants: { checkedInBy: 'att1', primaryDriverUid: 'drv1' },
  });
  await allocateDelivererTip(deps, { operatorId: OP, before: null, after });
  expect((await deps.db.doc(P.payout(OP, 'drv1', TID)).get()).exists).toBe(true);
});

it("no-ops: shift_pool operator, unpaid, untipped, non-closed-transition, and missing deliverer (warn, never a guessed payee)", async () => {
  const deps = testDeps();
  await seedOperator(deps);

  // not a closed transition
  await allocateDelivererTip(deps, { operatorId: OP, before: closedPaidTicket(), after: closedPaidTicket() });
  // unpaid
  await allocateDelivererTip(deps, { operatorId: OP, before: null, after: closedPaidTicket({ payment: { status: 'refunded', base: 1500, tip: 700, tax: 105, fees: 0, total: 2305, currency: 'USD', billTo: 'guest' } }) });
  // untipped
  await allocateDelivererTip(deps, { operatorId: OP, before: null, after: closedPaidTicket({ payment: { status: 'paid', base: 1500, tip: 0, tax: 105, fees: 0, total: 1605, currency: 'USD', billTo: 'guest' } }) });
  // no deliverer recorded
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await allocateDelivererTip(deps, { operatorId: OP, before: null, after: closedPaidTicket({ attendants: { checkedInBy: 'att1' } }) });
  expect(warn).toHaveBeenCalledOnce();
  // shift_pool operator — tipPool.ts's business, not this trigger's
  await deps.db.doc(P.operator(OP)).update({ 'modules.payments.tipPolicy': 'shift_pool' });
  await allocateDelivererTip(deps, { operatorId: OP, before: null, after: closedPaidTicket() });

  const all = await deps.db.collection(`operators/${OP}/users/att2/payouts`).get();
  expect(all.size).toBe(0);
});
