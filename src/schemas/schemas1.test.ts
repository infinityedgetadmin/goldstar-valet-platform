import { describe, expect, it } from 'vitest';
import { operatorSchema } from './operator';
import { venueSchema } from './venue';
import { userSchema } from './user';
import { shiftSchema, clockEventSchema } from './shift';
import { keyTagSchema } from './keyTag';
import { e164Schema, hexColorSchema, moneySchema } from './common';

describe('common', () => {
  it('money is non-negative integer', () => { expect(moneySchema.safeParse(1050).success).toBe(true); expect(moneySchema.safeParse(10.5).success).toBe(false); expect(moneySchema.safeParse(-1).success).toBe(false); });
  it('e164', () => { expect(e164Schema.safeParse('+13175550123').success).toBe(true); expect(e164Schema.safeParse('317-555-0123').success).toBe(false); });
  it('hex color', () => { expect(hexColorSchema.safeParse('#ab6034').success).toBe(true); expect(hexColorSchema.safeParse('ab6034').success).toBe(false); });
});

describe('operator', () => {
  it('parses the Goldstar default and rejects bad module providers', () => {
    const op = operatorSchema.parse({
      id: 'goldstar', name: 'Goldstar Parking & Transportation', slug: 'goldstar', status: 'active', timezone: 'America/Indiana/Indianapolis', currency: 'USD', isSandbox: false, plan: 'standard',
      branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c', logoLightPath: 'operators/goldstar/branding/logo-light.png', logoDarkPath: 'operators/goldstar/branding/logo-dark.png', supportPhone: '+13175550100', supportEmail: 'support@goldstar-mgmt.example.com', receiptFooter: 'Thank you for choosing Goldstar.' },
      modules: { payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' }, messaging: { provider: 'twilio' }, scheduling: { provider: 'internal' }, vision: { provider: 'none' }, accounting: { provider: 'csv' } },
      features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true },
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z', createdBy: 'system',
    });
    expect(op.modules.payments.tipPresets).toEqual([18, 20, 25]);
    expect(operatorSchema.safeParse({ ...op, modules: { ...op.modules, scheduling: { provider: 'bogus' } } }).success).toBe(false);
  });
});

describe('venue', () => {
  it('requires zones ids unique and rates valid', () => {
    const base = { id: 'v1', operatorId: 'goldstar', name: 'St. Elmo', type: 'restaurant', status: 'active', address: { line1: '127 S Illinois St', city: 'Indianapolis', region: 'IN', postalCode: '46225', country: 'US' }, geo: { lat: 39.765, lng: -86.158 }, phone: '+13175550101',
      zones: [{ id: 'A', name: 'Lot A', capacity: 40 }], rates: { valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [] }, driveHome: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 }, passengerRide: { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 }, validations: { allowPartial: true, maxAmount: 1500 } },
      sms: {}, qr: { staticCheckoutEnabled: false }, contract: { model: 'per_ticket', perTicketFee: 250, terms: '', billingEmail: 'ap@stelmo.example.com', invoiceDay: 1 }, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z' };
    expect(venueSchema.safeParse(base).success).toBe(true);
    expect(venueSchema.safeParse({ ...base, zones: [{ id: 'A', name: 'x' }, { id: 'A', name: 'y' }] }).success).toBe(false);
    expect(venueSchema.safeParse({ ...base, type: 'hospital' }).success).toBe(false);
  });
  // v0.4.5, Ruling BF: the contract's figures — the active model's REQUIRED, foreign REJECTED
  // (money configuration is never a suggestion), taxRateBps defaulting to 0.
  it("contract figures: the model's own figure required, a foreign figure rejected, taxRateBps defaults 0", () => {
    const base = { model: 'per_ticket', perTicketFee: 250, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 1 };
    const contractOf = (c: object) => venueSchema.shape.contract.safeParse(c);
    expect(contractOf(base).success).toBe(true);
    expect((venueSchema.shape.contract.parse(base) as { taxRateBps: number }).taxRateBps).toBe(0);
    expect(contractOf({ ...base, perTicketFee: undefined }).success).toBe(false); // figure-less per_ticket
    expect(contractOf({ ...base, revShareBps: 1000 }).success).toBe(false); // stray foreign figure
    // v0.4.8: each issue names its FIELD. A pathless cross-field issue lands on the contract object,
    // where a field-bound form renders nothing — the dashboard's venue form rejected every submit
    // under v0.4.6 with no visible error for exactly this reason. Consumers rely on these paths.
    const pathsOf = (c: object) => { const r = contractOf(c); return r.success ? [] : r.error.issues.map((i) => i.path.join('.')); };
    expect(pathsOf({ ...base, perTicketFee: undefined })).toEqual(['perTicketFee']);
    expect(pathsOf({ ...base, revShareBps: 1000 })).toEqual(['revShareBps']);
    expect(contractOf({ model: 'flat', flatMonthly: 250_000, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 1, taxRateBps: 700 }).success).toBe(true);
    expect(contractOf({ model: 'rev_share', revShareBps: 10_001, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 1 }).success).toBe(false); // >100%
    expect(contractOf({ model: 'rev_share', revShareBps: 1000, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 1 }).success).toBe(true);
  });
});

describe('user, shift, keyTag', () => {
  it('user roles are validated and eligibility defaults false', () => {
    const u = userSchema.parse({ uid: 'u1', operatorId: 'goldstar', displayName: 'Ana', email: 'ana@x.example.com', roles: ['attendant', 'driver'], venueIds: ['v1'], status: 'active', fcmTokens: [], invitedAt: '2026-08-23T00:00:00.000Z' });
    expect(u.eligibility).toEqual({ driveHome: false, passengerRide: false, reasons: [] });
    expect(userSchema.safeParse({ ...u, roles: ['king'] }).success).toBe(false);
  });
  it('shift assignments and clock events', () => {
    expect(shiftSchema.safeParse({ id: 's1', operatorId: 'goldstar', venueId: 'v1', date: '2026-08-23', startsAt: '2026-08-23T21:00:00.000Z', endsAt: '2026-08-24T03:00:00.000Z', status: 'planned', assignments: [{ uid: 'u1', role: 'attendant', startsAt: '2026-08-23T21:00:00.000Z', endsAt: '2026-08-24T03:00:00.000Z', confirmed: false }], source: { provider: 'internal' }, notes: '' }).success).toBe(true);
    expect(clockEventSchema.safeParse({ id: '01912345-7abc-7def-8123-456789abcdef', uid: 'u1', type: 'in', at: '2026-08-23T21:01:00.000Z', deviceId: 'd1' }).success).toBe(true);
    expect(clockEventSchema.safeParse({ id: 'nope', uid: 'u1', type: 'in', at: '2026-08-23T21:01:00.000Z', deviceId: 'd1' }).success).toBe(false);
  });
  it('shift assignedUids defaults to empty and accepts the denormalized uid list', () => {
    const base = { id: 's1', operatorId: 'goldstar', venueId: 'v1', date: '2026-08-23', startsAt: '2026-08-23T21:00:00.000Z', endsAt: '2026-08-24T03:00:00.000Z', status: 'planned', assignments: [], source: { provider: 'internal' }, notes: '' };
    expect(shiftSchema.parse(base).assignedUids).toEqual([]);
    const withAssignments = { ...base, assignments: [{ uid: 'u1', role: 'attendant', startsAt: '2026-08-23T21:00:00.000Z', endsAt: '2026-08-24T03:00:00.000Z', confirmed: true }], assignedUids: ['u1'] };
    expect(shiftSchema.parse(withAssignments).assignedUids).toEqual(['u1']);
  });
  it('keyTag', () => { expect(keyTagSchema.safeParse({ id: 'k1', operatorId: 'goldstar', value: 'GS-V1-0001', venueId: 'v1', status: 'available' }).success).toBe(true); });
});
