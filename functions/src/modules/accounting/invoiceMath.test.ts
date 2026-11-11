import { describe, expect, it } from 'vitest';
import { computeInvoiceAmounts, figuresFrom } from './invoiceMath.js';

describe('figuresFrom', () => {
  it("fails honestly when the model's figure is absent — the gap that blocked generation is a named error, not a silent zero", () => {
    expect(() => figuresFrom({ model: 'per_ticket' })).toThrowError(/perTicketFee/);
    expect(() => figuresFrom({ model: 'flat' })).toThrowError(/flatMonthly/);
    expect(() => figuresFrom({ model: 'rev_share' })).toThrowError(/revShareBps/);
  });
  it('defaults taxRateBps to 0 and passes the figures through', () => {
    expect(figuresFrom({ model: 'flat', flatMonthly: 250_000 })).toMatchObject({ model: 'flat', flatMonthly: 250_000, taxRateBps: 0 });
  });
});

describe('computeInvoiceAmounts — the T5 acceptance criteria, pinned', () => {
  it('per_ticket: line amount = count × fee; total = subtotal + tax (7%)', () => {
    const out = computeInvoiceAmounts({ model: 'per_ticket', perTicketFee: 250, taxRateBps: 700 }, { ticketCount: 412, shareableBase: 0 });
    expect(out.lines).toEqual([{ label: 'Valet service — per ticket', quantity: 412, unitAmount: 250, amount: 103_000 }]);
    expect(out.subtotal).toBe(103_000);
    expect(out.tax).toBe(7210);
    expect(out.total).toBe(110_210);
    expect(out.total).toBe(out.subtotal + out.tax);
    for (const l of out.lines) expect(l.amount).toBe(l.quantity * l.unitAmount);
  });
  it('flat: one line at the monthly figure regardless of activity', () => {
    const out = computeInvoiceAmounts({ model: 'flat', flatMonthly: 250_000, taxRateBps: 0 }, { ticketCount: 9999, shareableBase: 123 });
    expect(out.lines).toEqual([{ label: 'Valet service — monthly', quantity: 1, unitAmount: 250_000, amount: 250_000 }]);
    expect(out.total).toBe(250_000);
  });
  it('rev_share: basis points of period gross, half-up rounding PINNED so it cannot drift silently', () => {
    // 1250 bps of $1,234.55 = 15431.875 cents → 15432 (half-up).
    const out = computeInvoiceAmounts({ model: 'rev_share', revShareBps: 1250, taxRateBps: 0 }, { ticketCount: 0, shareableBase: 123_455 });
    expect(out.lines[0]).toMatchObject({ quantity: 1, unitAmount: 15_432, amount: 15_432 });
    expect(out.lines[0]!.label).toContain('12.50%');
    expect(out.total).toBe(15_432);
  });
  it('zero activity produces a valid zero invoice, not an error — a quiet month still invoices under flat', () => {
    const perTicket = computeInvoiceAmounts({ model: 'per_ticket', perTicketFee: 250, taxRateBps: 700 }, { ticketCount: 0, shareableBase: 0 });
    expect(perTicket).toMatchObject({ subtotal: 0, tax: 0, total: 0 });
  });
});
