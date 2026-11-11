import type { ValetRates } from '../schemas/venue';
import { minutesBetween } from '../time';
/** subtotal is the pre-tax figure (base - validation + fees); total is subtotal + tax, the tax-inclusive figure. */
export interface PriceBreakdown { base: number; tax: number; fees: number; validation: number; subtotal: number; total: number; lines: { label: string; amount: number }[] }
export function computeValetPrice(input: { rates: ValetRates; checkedInAt: Date; at: Date; validationAmount?: number }): PriceBreakdown {
  const { rates } = input;
  const minutes = minutesBetween(input.checkedInAt, input.at);
  const first = rates.items[0]!;
  let base = 0; let label = first.label;
  switch (rates.model) {
    case 'flat': case 'overnight': base = first.amount; break;
    case 'hourly': base = first.amount * Math.max(1, Math.ceil(minutes / 60)); break;
    case 'tiered': { const tier = rates.items.find((i) => i.upToMinutes !== undefined && minutes <= i.upToMinutes) ?? rates.items[rates.items.length - 1]!; base = tier.amount; label = tier.label; break; }
  }
  const fees = rates.fees.reduce((s, f) => s + f.amount, 0);
  const validation = Math.min(base, Math.max(0, input.validationAmount ?? 0));
  const subtotal = Math.max(0, base - validation + fees);
  const tax = Math.round((subtotal * rates.taxRateBps) / 10_000);
  const total = subtotal + tax;
  const lines = [{ label, amount: base }, ...rates.fees.map((f) => ({ label: f.label, amount: f.amount }))];
  if (validation > 0) lines.push({ label: 'Validation', amount: -validation });
  if (tax > 0) lines.push({ label: 'Tax', amount: tax });
  return { base, tax, fees, validation, subtotal, total, lines };
}
