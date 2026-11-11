import { describe, expect, it } from 'vitest';
import { ticketCreateSchema, ticketSchema, custodyEventSchema } from './ticket';
import { damageReportSchema, photoSchema } from './damage';
import { guestTicketSchema } from './guestTicket';
import { transactionSchema } from './transaction';
const ID = '01912345-7abc-7def-8123-456789abcdef';
describe('ticket', () => {
  const create = { id: ID, operatorId: 'goldstar', venueId: 'v1', jobType: 'valet', status: 'checked_in', source: 'staff', guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, vehicle: { plate: 'ABC123', state: 'IN', make: 'Honda', model: 'Civic', color: 'Blue' }, keyTagId: 'k1', zoneId: 'A', flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false }, attendants: { checkedInBy: 'u1' }, times: { checkedInAt: '2026-08-23T21:00:00.000Z' }, guestToken: 'AbCdEfGhIjKlMnOpQrStUv', damageReportIds: [], incidentIds: [] };
  it('create schema rejects server-only fields', () => {
    expect(ticketCreateSchema.safeParse(create).success).toBe(true);
    expect(ticketCreateSchema.safeParse({ ...create, payment: { status: 'paid' } }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...create, guestToken: 'short' }).success).toBe(false);
  });
  it('full schema accepts server fields', () => {
    expect(ticketSchema.safeParse({ ...create, payment: { status: 'none', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', billTo: 'guest' }, metrics: {} }).success).toBe(true);
  });
  it('custody event', () => {
    expect(custodyEventSchema.safeParse({ id: ID, actorUid: 'u1', action: 'keys_stored', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1', zoneId: 'A' }).success).toBe(true);
    expect(custodyEventSchema.safeParse({ id: ID, actorUid: 'u1', action: 'teleported', at: '2026-08-23T21:00:00.000Z', deviceId: 'd1' }).success).toBe(false);
  });
  it('rejects a create payload with a client-supplied driveHome quote', () => {
    const driveHomeCreate = {
      ...create, jobType: 'drive_home', status: 'requested',
      driveHome: { destination: { address: '123 Main St', geo: { lat: 1, lng: 1 } }, chase: { status: 'pending' }, quote: { base: 100, distanceMeters: 10, durationSec: 60, amount: 100, breakdown: [] } },
    };
    expect(ticketCreateSchema.safeParse(driveHomeCreate).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...driveHomeCreate, driveHome: { destination: driveHomeCreate.driveHome.destination, chase: driveHomeCreate.driveHome.chase } }).success).toBe(true);
  });
  // v0.4.2, Ruling W: room charging was a ride-only gap — ride.billTo gains 'room' so the JOB
  // itself says who pays (payment-layer-only was rejected: job and payment disagreeing about the
  // payer is false data inside a money-bearing record). driveHome deliberately gets NO billTo:
  // no PMS drive-home flow is specified, and an unused field is speculation.
  // v0.4.4, Ruling BB: pmsChargeSeq is a SERVER field (reversal increments it; clients never write
  // it) — full schema accepts, create schema rejects, negatives rejected.
  it('pmsChargeSeq: server-only generation counter — full schema accepts, create rejects, negative rejects', () => {
    expect(ticketSchema.safeParse({ ...create, pmsChargeSeq: 2 }).success).toBe(true);
    expect(ticketSchema.safeParse({ ...create, pmsChargeSeq: -1 }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...create, pmsChargeSeq: 0 }).success).toBe(false);
  });
  it("ride.billTo accepts 'room' (Ruling W), rejects unknown payers, and driveHome still has no billTo field", () => {
    const ride = {
      ...create, jobType: 'passenger_ride', status: 'requested',
      ride: { pickup: { geo: { lat: 1, lng: 1 } }, dropoff: { address: '123 Main St', geo: { lat: 2, lng: 2 } }, passengers: 2, accessible: false, billTo: 'room' },
    };
    expect(ticketSchema.safeParse(ride).success).toBe(true);
    expect(ticketSchema.safeParse({ ...ride, ride: { ...ride.ride, billTo: 'folio' } }).success).toBe(false);
    const driveHome = {
      ...create, jobType: 'drive_home', status: 'requested',
      driveHome: { destination: { address: '123 Main St', geo: { lat: 1, lng: 1 } }, chase: { status: 'pending' }, billTo: 'room' },
    };
    const parsed = ticketSchema.parse(driveHome);
    expect(parsed.driveHome).not.toHaveProperty('billTo'); // stray key stripped — the field does not exist
  });
  it('rejects a create payload whose status is not the jobType initial status', () => {
    expect(ticketCreateSchema.safeParse({ ...create, status: 'delivered' }).success).toBe(false);
  });
  it("rejects a create payload whose status is not a member of the jobType's status list", () => {
    expect(ticketCreateSchema.safeParse({ ...create, jobType: 'valet', status: 'en_route_to_pickup' }).success).toBe(false);
  });
  it('rejects a create payload with a cancelReason', () => {
    expect(ticketCreateSchema.safeParse({ ...create, cancelReason: 'nope' }).success).toBe(false);
  });
  it('accepts a valid create payload', () => {
    expect(ticketCreateSchema.safeParse(create).success).toBe(true);
  });
});
describe('damage + photos', () => {
  const photoBase = { id: ID, storagePath: 'operators/goldstar/tickets/t/photos/x.jpg', stage: 'wide' as const, at: '2026-08-23T21:00:00.000Z', actorUid: 'u1', deviceId: 'd1', width: 1600, height: 1200, sha256: 'a'.repeat(64) };
  it('validates', () => {
    expect(damageReportSchema.safeParse({ id: ID, operatorId: 'goldstar', ticketId: ID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [{ panel: 'front_left_door', x: 0.4, y: 0.5, kind: 'scratch', preExisting: true }], notes: '', createdBy: 'u1', createdAt: '2026-08-23T21:00:00.000Z' }).success).toBe(true);
    expect(photoSchema.safeParse({ ...photoBase, bytes: 120000 }).success).toBe(true);
  });
  it('rejects photo bytes of 0 or over the 10MB cap', () => {
    expect(photoSchema.safeParse({ ...photoBase, bytes: 0 }).success).toBe(false);
    expect(photoSchema.safeParse({ ...photoBase, bytes: 10_485_761 }).success).toBe(false);
    expect(photoSchema.safeParse({ ...photoBase, bytes: 10_485_760 }).success).toBe(true);
  });
  it('rejects a sha256 of the wrong length', () => {
    expect(photoSchema.safeParse({ ...photoBase, bytes: 120000, sha256: 'a'.repeat(63) }).success).toBe(false);
  });
  it('rejects an out-of-range diagram mark coordinate', () => {
    expect(damageReportSchema.safeParse({ id: ID, operatorId: 'goldstar', ticketId: ID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [{ panel: 'front_left_door', x: 1.5, y: 0.5, kind: 'scratch', preExisting: true }], notes: '', createdBy: 'u1', createdAt: '2026-08-23T21:00:00.000Z' }).success).toBe(false);
  });
});
describe('guest projection + transaction', () => {
  it('projection has no phone/plate fields', () => {
    const keys = Object.keys(guestTicketSchema.shape);
    expect(keys).not.toContain('guest'); expect(keys).not.toContain('vehicle');
  });
  it('transaction', () => {
    expect(transactionSchema.safeParse({ id: 'tx1', operatorId: 'goldstar', venueId: 'v1', ticketId: ID, provider: 'stripe', providerRef: 'pi_1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', method: 'web', at: '2026-08-23T21:00:00.000Z' }).success).toBe(true);
  });
  it('rejects a negative total', () => {
    expect(transactionSchema.safeParse({ id: 'tx1', operatorId: 'goldstar', venueId: 'v1', ticketId: ID, provider: 'stripe', providerRef: 'pi_1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: -1, currency: 'USD', method: 'web', at: '2026-08-23T21:00:00.000Z' }).success).toBe(false);
  });
  it('rejects a missing venueId', () => {
    expect(transactionSchema.safeParse({ id: 'tx1', operatorId: 'goldstar', ticketId: ID, provider: 'stripe', providerRef: 'pi_1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', method: 'web', at: '2026-08-23T21:00:00.000Z' }).success).toBe(false);
  });
});
