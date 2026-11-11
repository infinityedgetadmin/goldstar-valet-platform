import type { Invoice } from '@goldstar/platform';
import { err } from '../../lib/errors.js';

/**
 * The billing figures a venue contract carries for its model (v0.4.5, Ruling BF) — extracted from
 * `venue.contract` by `figuresFrom` below, the one seam between this pure function and the schema.
 */
export interface ContractFigures {
  model: 'per_ticket' | 'flat' | 'rev_share';
  /** Integer cents per billable ticket — required iff model 'per_ticket'. */
  perTicketFee?: number | undefined;
  /** Integer cents per period — required iff model 'flat'. */
  flatMonthly?: number | undefined;
  /** Basis points of period gross — required iff model 'rev_share'. */
  revShareBps?: number | undefined;
  /** Tax applied to THIS invoice (what Goldstar charges the venue) — NOT venue.rates.valet.taxRateBps, which is guest pricing tax. */
  taxRateBps: number;
}

/**
 * What the venue did in the period — read from transactions/tickets AS THEY WERE in the period.
 * Both bases are RULING BF DECISIONS (business calls made by the controller, reversible via
 * config), not facts of nature — whoever revisits should know they were chosen:
 *  - `ticketCount` counts VALET tickets ONLY. A venue-billed job already generates its own
 *    venue-billed transaction; counting it again as a per-ticket fee bills the venue twice for
 *    one service. If a venue ever wants jobs in a per-ticket fee, that is a new contract-model
 *    field, never an inferred default.
 *  - `shareableBase` is the sum of `base` net of the base portion of refunds — never gross:
 *    tips are STAFF income (revenue-sharing one takes money from an attendant's pocket), tax is
 *    remitted not earned, fees are pass-through.
 */
export interface PeriodActivity {
  /** Billable tickets: jobType 'valet', checkedInAt within the period, status not cancelled (Ruling BF a). */
  ticketCount: number;
  /** Integer cents: succeeded/refunded transactions' `base`, net of refunds' base portion, all providers (Ruling BF b). */
  shareableBase: number;
}

/** Extracts the model's figures from a contract doc, failing honestly when they are absent. */
export function figuresFrom(contract: { model: 'per_ticket' | 'flat' | 'rev_share'; perTicketFee?: number | undefined; flatMonthly?: number | undefined; revShareBps?: number | undefined; taxRateBps?: number | undefined }): ContractFigures {
  const { model } = contract;
  if (model === 'per_ticket' && contract.perTicketFee === undefined) throw err('failed_precondition', 'contract has no perTicketFee');
  if (model === 'flat' && contract.flatMonthly === undefined) throw err('failed_precondition', 'contract has no flatMonthly');
  if (model === 'rev_share' && contract.revShareBps === undefined) throw err('failed_precondition', 'contract has no revShareBps');
  return {
    model,
    taxRateBps: contract.taxRateBps ?? 0,
    ...(contract.perTicketFee !== undefined ? { perTicketFee: contract.perTicketFee } : {}),
    ...(contract.flatMonthly !== undefined ? { flatMonthly: contract.flatMonthly } : {}),
    ...(contract.revShareBps !== undefined ? { revShareBps: contract.revShareBps } : {}),
  };
}

/**
 * THE invoice math — the one place in the pipeline where the arithmetic is decided, so the one
 * place it is enforced (T5 acceptance criteria, stated rather than assumed):
 *
 *   - every line: `amount = quantity × unitAmount` — BY CONSTRUCTION (amount is computed from
 *     the other two, never accepted as an input), and asserted before returning.
 *   - `total = subtotal + tax` — same: constructed, then asserted.
 *
 * POLARITY (the guard-reads-now / ledger-reads-then rule): this function is LEDGER — it computes
 * over `PeriodActivity`, a snapshot of the period AS IT WAS, assembled by the caller from
 * period-bounded queries. It never re-reads anything live; an invoice that consulted today's
 * transaction states while generating last month's lines would satisfy both arithmetic criteria
 * and still be wrong.
 *
 * Integer cents throughout; the only rounding is rev-share's basis-point product and the tax
 * line, both `Math.round` — banker's-vs-half-up is immaterial at our volumes but half-up is
 * pinned by test so it cannot drift silently.
 */
export function computeInvoiceAmounts(figures: ContractFigures, activity: PeriodActivity): Pick<Invoice, 'lines' | 'subtotal' | 'tax' | 'total'> {
  let lines: Invoice['lines'];
  if (figures.model === 'per_ticket') {
    const unitAmount = figures.perTicketFee!;
    lines = [{ label: 'Valet service — per ticket', quantity: activity.ticketCount, unitAmount, amount: activity.ticketCount * unitAmount }];
  } else if (figures.model === 'flat') {
    const unitAmount = figures.flatMonthly!;
    lines = [{ label: 'Valet service — monthly', quantity: 1, unitAmount, amount: unitAmount }];
  } else {
    const unitAmount = Math.round((activity.shareableBase * figures.revShareBps!) / 10_000);
    lines = [{ label: `Valet service — revenue share (${(figures.revShareBps! / 100).toFixed(2)}%)`, quantity: 1, unitAmount, amount: unitAmount }];
  }
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const tax = Math.round((subtotal * figures.taxRateBps) / 10_000);
  const total = subtotal + tax;
  // The invariants, enforced here — a future edit that breaks either fails loudly, not silently.
  for (const l of lines) {
    if (l.amount !== l.quantity * l.unitAmount) throw err('internal', 'invoice line arithmetic violated');
  }
  if (total !== subtotal + tax) throw err('internal', 'invoice total arithmetic violated');
  return { lines, subtotal, tax, total };
}
