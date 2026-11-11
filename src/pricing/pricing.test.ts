import { describe, expect, it } from 'vitest';
import { computeValetPrice, computeTripQuote, computeTip } from './index';
const flat = { model: 'flat' as const, items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [{ id: 'svc', label: 'Service', amount: 100 }] };
describe('valet', () => {
  it('flat + tax + fees', () => {
    const p = computeValetPrice({ rates: flat, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T03:00Z') });
    expect(p).toMatchObject({ base: 1500, fees: 100, tax: 112, validation: 0, subtotal: 1600, total: 1712 }); // tax on base+fees: 1600*0.07=112
  });
  it('hourly rounds up with first item as hourly rate', () => {
    const p = computeValetPrice({ rates: { ...flat, model: 'hourly', items: [{ id: 'h', label: 'Per hour', amount: 500 }], fees: [] }, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T02:01Z') });
    expect(p.base).toBe(1500);
  });
  it('hourly charges a minimum of 1 hour even for a zero-minute stay', () => {
    const p = computeValetPrice({ rates: { ...flat, model: 'hourly', items: [{ id: 'h', label: 'Per hour', amount: 500 }], fees: [] }, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T00:00Z') });
    expect(p.base).toBe(500);
  });
  it('tiered picks first tier whose upToMinutes covers the stay; last tier otherwise', () => {
    const rates = { ...flat, model: 'tiered' as const, fees: [], items: [{ id: 't1', label: '0-2h', amount: 1000, upToMinutes: 120 }, { id: 't2', label: '2-6h', amount: 2000, upToMinutes: 360 }, { id: 't3', label: 'Day', amount: 3000 }] };
    expect(computeValetPrice({ rates, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T01:00Z') }).base).toBe(1000);
    expect(computeValetPrice({ rates, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T05:00Z') }).base).toBe(2000);
    expect(computeValetPrice({ rates, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-02T05:00Z') }).base).toBe(3000);
  });
  it('tiered uses the tier whose upToMinutes exactly equals the stay length (inclusive boundary)', () => {
    const rates = { ...flat, model: 'tiered' as const, fees: [], items: [{ id: 't1', label: '0-2h', amount: 1000, upToMinutes: 120 }, { id: 't2', label: '2-6h', amount: 2000, upToMinutes: 360 }, { id: 't3', label: 'Day', amount: 3000 }] };
    expect(computeValetPrice({ rates, checkedInAt: new Date('2026-01-01T00:00Z'), at: new Date('2026-01-01T02:00Z') }).base).toBe(1000);
  });
  it('validation reduces base before tax, never below zero', () => {
    const p = computeValetPrice({ rates: { ...flat, fees: [] }, checkedInAt: new Date(), at: new Date(), validationAmount: 5000 });
    expect(p).toMatchObject({ base: 1500, validation: 1500, tax: 0, subtotal: 0, total: 0 });
  });
  it('validation caps at the base (not base+fees); fees remain taxed', () => {
    const p = computeValetPrice({ rates: flat, checkedInAt: new Date(), at: new Date(), validationAmount: 5000 });
    expect(p.validation).toBe(1500); // capped at base=1500, not base+fees=1600
    expect(p.subtotal).toBe(100); // base(1500) - validation(1500) + fees(100)
    expect(p.tax).toBe(7); // round(100 * 700 / 10000)
    expect(p.total).toBe(107);
  });
  it('rounds a half-cent tax up (Math.round semantics)', () => {
    const rates = { ...flat, items: [{ id: 'std', label: 'Valet', amount: 1050 }], fees: [] };
    const p = computeValetPrice({ rates, checkedInAt: new Date(), at: new Date() });
    expect(p.subtotal).toBe(1050);
    expect(p.tax).toBe(74); // round(1050 * 700 / 10000) = round(73.5) = 74
    expect(p.total).toBe(1124);
  });
});
describe('trip', () => {
  it('base + distance + time with minimum', () => {
    const q = computeTripQuote({ rates: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 }, distanceMeters: 8046.7, durationSec: 900 });
    expect(q.amount).toBe(2500 + 1250 + 750);
    expect(computeTripQuote({ rates: { base: 1000, perMile: 100, perMinute: 10, minimum: 3900 }, distanceMeters: 1000, durationSec: 60 }).amount).toBe(3900);
  });
});
describe('tip', () => {
  it('presets, custom clamp, none', () => {
    expect(computeTip({ subtotal: 1712, choice: { kind: 'preset', percent: 20 }, presets: [18, 20, 25] })).toBe(342);
    expect(computeTip({ subtotal: 1712, choice: { kind: 'preset', percent: 99 }, presets: [18, 20, 25] })).toBe(0); // not an allowed preset
    expect(computeTip({ subtotal: 1712, choice: { kind: 'custom', amount: 99_999 }, presets: [] })).toBe(1712);
    expect(computeTip({ subtotal: 1712, choice: { kind: 'none' }, presets: [] })).toBe(0);
  });
  it('clamps a negative custom tip to zero', () => {
    expect(computeTip({ subtotal: 1712, choice: { kind: 'custom', amount: -500 }, presets: [] })).toBe(0);
  });
  it('rounds a fractional custom tip', () => {
    expect(computeTip({ subtotal: 1712, choice: { kind: 'custom', amount: 123.6 }, presets: [] })).toBe(124);
  });
});
