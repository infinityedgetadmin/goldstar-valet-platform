import type { Operator, Ticket } from '@goldstar/platform';
import type { Deps } from '../../../lib/deps.js';
import { P } from '../../../lib/paths.js';

/**
 * Deliverer-policy tip allocation (Plan 8 Task 1, carry #1's producer half): on a ticket's
 * transition INTO 'closed' with a PAID payment carrying a tip, under `tipPolicy: 'deliverer'`,
 * the tip is allocated to the person who delivered — `attendants.deliveredBy` for valet,
 * `attendants.primaryDriverUid` for jobs. The `shift_pool` policy stays tipPool.ts's business
 * entirely (that trigger no-ops for 'deliverer' and this one no-ops for 'shift_pool').
 *
 * Allocate-at-closed rule (the original plan's): tips are evaluated ONCE, here — the same
 * Ruling M2(a) product decision tipPool documents: a refund landing AFTER close does not claw
 * the tip back; the SWEEP cross-checks funding before paying and flags, never claws.
 *
 * The allocation doc (`users/{uid}/payouts/{ticketId}` — deterministic id, one tip per ticket)
 * stores `fundingRef` (= `payment.lastIntentId`, the transaction row's own id) precisely so the
 * sweep can re-read the funding transaction's CURRENT status without archaeology. CREATE-only
 * (code-6 swallow): a redelivered trigger or a reopen-reclose never resets `createdAt` or
 * reverts a doc the sweep already paid — the same carry #2/#3 discipline tipPool's writer got.
 */
export async function allocateDelivererTip(deps: Deps, e: { operatorId: string; before: Ticket | null; after: Ticket }): Promise<void> {
  const { before, after } = e;
  if (after.status !== 'closed' || before?.status === 'closed') return;
  const payment = after.payment;
  if (!payment || payment.status !== 'paid' || payment.tip <= 0) return;

  const op = (await deps.db.doc(P.operator(e.operatorId)).get()).data() as Operator | undefined;
  if (!op || op.modules.payments.tipPolicy !== 'deliverer') return;

  const uid = after.jobType === 'valet' ? after.attendants.deliveredBy : after.attendants.primaryDriverUid;
  if (!uid) {
    // A paid, tipped, closed ticket with nobody recorded as its deliverer — allocating to a guess
    // would be inventing a payee. Log-and-skip (the repo's out-of-band-race convention).
    console.warn(`allocateDelivererTip: ticket ${after.id} closed with a tip but no deliverer recorded — tip unallocated`);
    return;
  }

  await deps.db
    .doc(P.payout(e.operatorId, uid, after.id))
    .create({
      id: after.id,
      ticketId: after.id,
      amount: payment.tip,
      currency: payment.currency,
      status: 'pending',
      createdAt: deps.now(),
      ...(payment.lastIntentId ? { fundingRef: payment.lastIntentId } : {}),
    })
    .catch((err: unknown) => {
      if ((err as { code?: number }).code !== 6) throw err; // redelivery/reclose — the original allocation stands
    });
}
