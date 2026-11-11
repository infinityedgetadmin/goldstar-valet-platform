import { describe, expect, it } from 'vitest';
import { paymentStateSchema, quoteSchema, ticketCreateSchema } from './ticket';
import { userSchema } from './user';
import { venueSchema } from './venue';
import { transactionSchema } from './transaction';
import { guestTicketSchema } from './guestTicket';
import { fleetVehicleSchema } from './fleetVehicle';
import { guestSchema } from './guest';
import { claimSchema } from './claim';
import { validationSchema } from './validation';
import { hostRequestSchema } from './hostRequest';
import { invoiceSchema } from './invoice';
import { payoutAllocationSchema, payoutBatchSchema } from './payoutBatch';
import { liveLocationSchema } from './liveLocation';
import { surveySchema } from './survey';
import { telemetrySchema } from './telemetry';

const ID = '01912345-7abc-7def-8123-456789abcdef';
const ID2 = '01912345-7abc-7def-8123-456789abcdff';
const now = '2026-08-23T21:00:00.000Z';

describe('ticket addenda', () => {
  const baseCreate = {
    id: ID, operatorId: 'goldstar', venueId: 'v1', jobType: 'valet', status: 'checked_in', source: 'staff',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, vehicle: { plate: 'ABC123' },
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: {}, times: { checkedInAt: now }, guestToken: 'AbCdEfGhIjKlMnOpQrStUv', damageReportIds: [], incidentIds: [],
  };
  it('accepts lastCustodyEventId and parentTicketId', () => {
    expect(ticketCreateSchema.safeParse({ ...baseCreate, lastCustodyEventId: ID2, parentTicketId: ID2 }).success).toBe(true);
  });
  it('rejects a non-uuid lastCustodyEventId', () => {
    expect(ticketCreateSchema.safeParse({ ...baseCreate, lastCustodyEventId: 'not-a-uuid' }).success).toBe(false);
  });
  it('quoteSchema accepts an optional expiresAt', () => {
    const base = { base: 100, distanceMeters: 10, durationSec: 60, amount: 100, breakdown: [] };
    expect(quoteSchema.safeParse({ ...base, expiresAt: now }).success).toBe(true);
    expect(quoteSchema.safeParse(base).success).toBe(true);
  });
  it('quoteSchema rejects a malformed expiresAt', () => {
    expect(quoteSchema.safeParse({ base: 100, distanceMeters: 10, durationSec: 60, amount: 100, breakdown: [], expiresAt: 'not-a-date' }).success).toBe(false);
  });
  it('paymentStateSchema accepts the new Functions-written fields', () => {
    const p = { status: 'paid', base: 100, tip: 0, tax: 0, fees: 0, total: 100, currency: 'USD', billTo: 'guest', method: 'tap_to_pay', refundRequested: true, refundInProgress: false, refundAttempts: 1, refundRetryAt: now, paidAt: now, lastRefundRef: 're_1', capturedAt: now, refundRequestId: '01912345-req', refundAmount: 50, refundReason: 'guest request', refundClaimedAt: now, refundLastError: 'stripe down' };
    expect(paymentStateSchema.safeParse(p).success).toBe(true);
  });
  it('paymentStateSchema rejects an unrecognized payment method', () => {
    expect(paymentStateSchema.safeParse({ status: 'paid', base: 100, tip: 0, tax: 0, fees: 0, total: 100, currency: 'USD', billTo: 'guest', method: 'cash' }).success).toBe(false);
  });
  it('accepts flags.inAndOut', () => {
    expect(ticketCreateSchema.safeParse({ ...baseCreate, flags: { ...baseCreate.flags, inAndOut: true } }).success).toBe(true);
  });
  it('rejects a non-boolean flags.inAndOut', () => {
    expect(ticketCreateSchema.safeParse({ ...baseCreate, flags: { ...baseCreate.flags, inAndOut: 'yes' } }).success).toBe(false);
  });
});

describe('user addenda', () => {
  const base = { uid: 'u1', operatorId: 'goldstar', displayName: 'A', email: 'a@b.example.com', roles: ['attendant'], status: 'active', invitedAt: now };
  it('accepts externalIds, hourlyRate, notificationPrefs', () => {
    expect(userSchema.safeParse({ ...base, externalIds: { when_i_work: '123' }, hourlyRate: 1500, notificationPrefs: { emailClaims: true, emailCredentials: false, pushRequests: true } }).success).toBe(true);
  });
  it('rejects a non-integer hourlyRate', () => {
    expect(userSchema.safeParse({ ...base, hourlyRate: 15.5 }).success).toBe(false);
  });
  it('rejects notificationPrefs missing a required key', () => {
    expect(userSchema.safeParse({ ...base, notificationPrefs: { emailClaims: true } }).success).toBe(false);
  });
});

describe('venue addenda', () => {
  const base = {
    id: 'v1', operatorId: 'goldstar', name: 'St. Elmo', type: 'restaurant', status: 'active',
    address: { line1: '127 S Illinois St', city: 'Indianapolis', region: 'IN', postalCode: '46225', country: 'US' }, geo: { lat: 39.765, lng: -86.158 },
    zones: [{ id: 'A', name: 'Lot A' }],
    rates: { valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [] }, driveHome: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 }, passengerRide: { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 }, validations: { allowPartial: true, maxAmount: 1500 } },
    sms: {}, qr: { staticCheckoutEnabled: false }, contract: { model: 'per_ticket', perTicketFee: 250, terms: '', billingEmail: 'ap@stelmo.example.com', invoiceDay: 1 }, createdAt: now, updatedAt: now,
  };
  it('accepts pos discount/item guids, accounting, stripeLocationId, timezone', () => {
    expect(venueSchema.safeParse({ ...base, pos: { provider: 'toast', restaurantGuid: 'g1', validationDiscountGuid: 'd1', valetItemGuid: 'i1' }, accounting: { qboCustomerId: 'q1' }, stripeLocationId: 'loc_1', timezone: 'America/Indiana/Indianapolis' }).success).toBe(true);
  });
  it('rejects an unknown pos provider', () => {
    expect(venueSchema.safeParse({ ...base, pos: { provider: 'square', restaurantGuid: 'g1' } }).success).toBe(false);
  });
});

describe('transaction addenda', () => {
  const base = { id: 'tx1', operatorId: 'goldstar', venueId: 'v1', ticketId: ID, providerRef: 'pi_1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', at: now };
  it('accepts provider/method pos and chargeRef/failureMessage', () => {
    expect(transactionSchema.safeParse({ ...base, provider: 'pos', method: 'pos', chargeRef: 'ch_1', failureMessage: 'declined' }).success).toBe(true);
  });
  it('rejects an unsupported provider', () => {
    expect(transactionSchema.safeParse({ ...base, provider: 'paypal', method: 'web' }).success).toBe(false);
  });
});

describe('guestTicket addenda', () => {
  const base = {
    operatorId: 'goldstar', ticketId: 't1', venueName: 'St. Elmo', jobType: 'valet', status: 'checked_in',
    branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' }, vehicleSummary: 'Blue Honda Civic',
    times: { checkedInAt: now }, payment: { status: 'none', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', tipPresets: [18, 20, 25] },
    features: { driveHome: true, passengerRides: true }, expiresAt: now, updatedAt: now,
  };
  it('accepts linkedJobs and driver.geo', () => {
    expect(guestTicketSchema.safeParse({ ...base, linkedJobs: [{ ticketId: ID, jobType: 'drive_home', status: 'requested', token: 'AbCdEfGhIjKlMnOpQrStUv' }], driver: { firstName: 'Sam', geo: { lat: 1, lng: 1 } } }).success).toBe(true);
  });
  it('defaults linkedJobs to an empty array', () => {
    expect(guestTicketSchema.parse(base).linkedJobs).toEqual([]);
  });
  it('rejects a linkedJobs entry with a malformed token', () => {
    expect(guestTicketSchema.safeParse({ ...base, linkedJobs: [{ ticketId: ID, jobType: 'drive_home', status: 'requested', token: 'short' }] }).success).toBe(false);
  });
  // v0.3.9 (fix round 1, Critical #2): a quoted job's own projection carries enough to re-render the
  // quote/terms/confirm screen on a resumed page — quote (incl. expiresAt), destination, and (once
  // set) termsAcceptedAt for drive_home; quote, dropoff, passengers for ride.
  const quote = { base: 2500, distanceMeters: 16_093, durationSec: 900, amount: 5750, breakdown: [{ label: 'Base', amount: 2500 }], expiresAt: now };
  it('accepts a drive_home job projection carrying quote+destination', () => {
    expect(guestTicketSchema.safeParse({ ...base, jobType: 'drive_home', status: 'quoted', driveHome: { quote, destination: { address: '1 Home St', geo: { lat: 1, lng: 2 } } } }).success).toBe(true);
  });
  it('accepts a drive_home job projection with termsAcceptedAt once confirmed', () => {
    expect(guestTicketSchema.safeParse({ ...base, jobType: 'drive_home', status: 'confirmed', driveHome: { quote, destination: { address: '1 Home St', geo: { lat: 1, lng: 2 } }, termsAcceptedAt: now } }).success).toBe(true);
  });
  it('accepts a passenger_ride job projection carrying quote+dropoff+passengers', () => {
    expect(guestTicketSchema.safeParse({ ...base, jobType: 'passenger_ride', status: 'quoted', ride: { quote, dropoff: { address: '2 Away Ave', geo: { lat: 3, lng: 4 } }, passengers: 2 } }).success).toBe(true);
  });
  it('rejects a driveHome display block missing its quote', () => {
    expect(guestTicketSchema.safeParse({ ...base, jobType: 'drive_home', status: 'quoted', driveHome: { destination: { address: '1 Home St', geo: { lat: 1, lng: 2 } } } }).success).toBe(false);
  });
  it('a valet projection has neither driveHome nor ride', () => {
    const parsed = guestTicketSchema.parse(base);
    expect(parsed.driveHome).toBeUndefined();
    expect(parsed.ride).toBeUndefined();
  });
});

describe('fleetVehicle', () => {
  const base = { id: 'fv1', operatorId: 'goldstar', plate: 'ABC123', make: 'Ford', model: 'Transit', color: 'White', capacity: 4, accessible: false, status: 'available' };
  it('parses', () => { expect(fleetVehicleSchema.safeParse(base).success).toBe(true); });
  it('rejects capacity over 8', () => { expect(fleetVehicleSchema.safeParse({ ...base, capacity: 9 }).success).toBe(false); });
});

describe('guest', () => {
  const base = { phoneE164: '+13175550123', consent: { sms: true, push: false } };
  it('parses with array defaults', () => {
    const g = guestSchema.parse(base);
    expect(g.savedVehicles).toEqual([]);
    expect(g.fcmTokens).toEqual([]);
  });
  it('rejects an invalid phone', () => { expect(guestSchema.safeParse({ ...base, phoneE164: '317-555-0123' }).success).toBe(false); });
});

describe('claim', () => {
  const base = { id: ID, operatorId: 'goldstar', ticketId: ID, status: 'intake', reportedAt: now, description: 'scratch on door', allegedDamage: [{ panel: 'front_left_door', kind: 'scratch', description: 'small scratch' }], guestContact: {}, createdBy: 'u1', createdAt: now };
  it('parses', () => { expect(claimSchema.safeParse(base).success).toBe(true); });
  it('rejects an unknown status', () => { expect(claimSchema.safeParse({ ...base, status: 'archived' }).success).toBe(false); });
});

describe('validation', () => {
  const base = { id: 'val1', operatorId: 'goldstar', venueId: 'v1', code: 'ABC123', type: 'full', issuedBy: 'u1', issuedAt: now };
  it('parses', () => { expect(validationSchema.safeParse(base).success).toBe(true); });
  it('rejects a lowercase code', () => { expect(validationSchema.safeParse({ ...base, code: 'abc123' }).success).toBe(false); });
});

describe('hostRequest', () => {
  const base = { id: 'hr1', operatorId: 'goldstar', venueId: 'v1', kind: 'car', at: now, by: 'u1', status: 'open' };
  it('parses and defaults vip to false', () => { expect(hostRequestSchema.parse(base).vip).toBe(false); });
  it('rejects an unknown kind', () => { expect(hostRequestSchema.safeParse({ ...base, kind: 'valet' }).success).toBe(false); });
});

describe('invoice', () => {
  const base = { id: 'inv1', operatorId: 'goldstar', venueId: 'v1', period: '2026-08', lines: [{ label: 'Valet', quantity: 100, unitAmount: 1500, amount: 150000 }], subtotal: 150000, tax: 10500, total: 160500, currency: 'USD', status: 'draft', createdAt: now };
  it('parses', () => { expect(invoiceSchema.safeParse(base).success).toBe(true); });
  it('rejects a malformed period', () => { expect(invoiceSchema.safeParse({ ...base, period: '2026-8' }).success).toBe(false); });
});

describe('payoutBatch + payoutAllocation', () => {
  const batch = { id: 'pb1', operatorId: 'goldstar', period: '2026-08', totalTips: 100000, currency: 'USD', allocations: [{ uid: 'u1', amount: 50000, status: 'paid' }], createdAt: now, status: 'completed' };
  it('parses payoutBatchSchema', () => { expect(payoutBatchSchema.safeParse(batch).success).toBe(true); });
  it('rejects an unknown batch status', () => { expect(payoutBatchSchema.safeParse({ ...batch, status: 'archived' }).success).toBe(false); });
  const alloc = { id: 'pa1', amount: 5000, currency: 'USD', status: 'pending', createdAt: now };
  it('parses payoutAllocationSchema', () => { expect(payoutAllocationSchema.safeParse(alloc).success).toBe(true); });
  it('rejects a non-uuid ticketId', () => { expect(payoutAllocationSchema.safeParse({ ...alloc, ticketId: 'not-a-uuid' }).success).toBe(false); });
});

describe('liveLocation', () => {
  const base = { ticketId: ID, geo: { lat: 1, lng: 1 }, heading: 90, speed: 10, at: now, expiresAt: now };
  it('parses', () => { expect(liveLocationSchema.safeParse(base).success).toBe(true); });
  it('rejects a heading over 360', () => { expect(liveLocationSchema.safeParse({ ...base, heading: 400 }).success).toBe(false); });
});

describe('survey', () => {
  const base = { id: 'sv1', operatorId: 'goldstar', venueId: 'v1', ticketId: ID, score: 5, at: now };
  it('parses', () => { expect(surveySchema.safeParse(base).success).toBe(true); });
  it('rejects a score over 5', () => { expect(surveySchema.safeParse({ ...base, score: 6 }).success).toBe(false); });
});

describe('telemetry', () => {
  const base = { operatorId: 'goldstar', day: '2026-08-23', photosUploaded: 10, photosNeedsAttention: 0, writesPending: 0, appVersion: '1.0.0', platform: 'ios', updatedAt: now };
  it('parses', () => { expect(telemetrySchema.safeParse(base).success).toBe(true); });
  it('rejects an unknown platform', () => { expect(telemetrySchema.safeParse({ ...base, platform: 'web' }).success).toBe(false); });
});
