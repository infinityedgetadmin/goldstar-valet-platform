import { computeTip, computeValetPrice, type Operator, type Ticket, type TipChoice, type Venue } from '@goldstar/platform';

export interface Priced {
  base: number;
  tip: number;
  tax: number;
  fees: number;
  total: number;
  currency: string;
  validation: number;
  capture: 'automatic' | 'manual';
}

export function priceTicket(op: Operator, venue: Venue, t: Ticket, tipChoice: TipChoice, now: string): Priced {
  if (t.jobType === 'valet') {
    const p = computeValetPrice({
      rates: venue.rates.valet,
      checkedInAt: new Date(t.times.checkedInAt),
      at: new Date(now),
      ...(t.payment?.validationAmount !== undefined ? { validationAmount: t.payment.validationAmount } : {}),
    });
    // computeTip's basis is the tax-inclusive total (its own JSDoc: pass PriceBreakdown.total, not
    // .subtotal) — and the checkout total mirrors that: total = p.total + tip, not p.subtotal + tip.
    const tip = computeTip({ subtotal: p.total, choice: tipChoice, presets: op.modules.payments.tipPresets });
    return { base: p.base - p.validation, tip, tax: p.tax, fees: p.fees, total: p.total + tip, currency: op.currency, validation: p.validation, capture: 'automatic' };
  }
  const quote = t.jobType === 'drive_home' ? t.driveHome?.quote : t.ride?.quote;
  if (!quote) throw new Error('quote missing');
  // quote.amount is already the full trip charge; tax is computed on it and the resulting subtotal
  // (quote.amount + tax) is already tax-inclusive, so it's passed straight through as computeTip's basis.
  const tax = Math.round((quote.amount * venue.rates.valet.taxRateBps) / 10_000);
  const subtotal = quote.amount + tax;
  const tip = computeTip({ subtotal, choice: tipChoice, presets: op.modules.payments.tipPresets });
  return { base: quote.amount, tip, tax, fees: 0, total: subtotal + tip, currency: op.currency, validation: 0, capture: 'manual' };
}

/** The frozen-amount shape provider-charge claim markers store (pms/roomCharge, pos/addCharge). */
export interface SettlementAmounts {
  base: number;
  tax: number;
  fees: number;
  total: number;
  currency: string;
  validationId?: string | undefined;
  validationAmount?: number | undefined;
}

/**
 * `priceTicket` plus the validation passthrough fields, in the shape charge-claim markers FREEZE
 * at post time. The crash-retry completion path must reuse the frozen copy — never re-price:
 * hourly valet bases grow, so a late retry re-pricing at retry time would put a ledger total on
 * the ticket that differs from what the provider was actually charged.
 */
export function pricedForSettlement(op: Operator, venue: Venue, ticket: Ticket, now: string): SettlementAmounts {
  const p = priceTicket(op, venue, ticket, { kind: 'none' }, now);
  return {
    base: p.base,
    tax: p.tax,
    fees: p.fees,
    total: p.total,
    currency: p.currency,
    ...(ticket.payment?.validationId !== undefined ? { validationId: ticket.payment.validationId, validationAmount: ticket.payment.validationAmount } : {}),
  };
}
