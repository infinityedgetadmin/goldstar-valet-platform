import { describe, expect, it } from 'vitest';
import { callables } from './callables';
import { QUERIES } from './queries';

const ID = '01912345-7abc-7def-8123-456789abcdef';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

const NEW_CALLABLES = [
  'identityRevokeInvitation', 'platformCreateOperator', 'platformSetOperatorStatus', 'auditQuery',
  'guestStaticCheckout', 'guestSurvey', 'guestListPaymentMethods', 'guestDetachPaymentMethod', 'guestSetupIntent', 'guestDeleteAccount', 'guestEmailReceipt', 'mapsAutocomplete',
  'staffApplyValidation', 'staffReverseRoomCharge', 'shiftsCorrectClock', 'ticketsSearch', 'ticketsRevealPhone', 'paymentsSearch', 'connectAccountStatus',
  'integrationsSetSecret', 'integrationsHealthCheck', 'venueGenerateKeyTags', 'pmsPostRoomCharge', 'posFindCheck', 'posAddValetCharge', 'invoicesSend', 'invoicesMarkPaid',
] as const;

describe('callables addenda', () => {
  it('every new callable has input and output schemas', () => {
    for (const name of NEW_CALLABLES) {
      const c = callables[name];
      expect(c, name).toBeDefined();
      expect(c.input, name).toBeDefined();
      expect(c.output, name).toBeDefined();
    }
  });

  it('staffMarkRoomCharge is removed; pmsPostRoomCharge replaces it', () => {
    expect(Object.prototype.hasOwnProperty.call(callables, 'staffMarkRoomCharge')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(callables, 'pmsPostRoomCharge')).toBe(true);
    expect(callables.pmsPostRoomCharge.input.safeParse({ ticketId: ID, reservationRef: 'r1', room: '204' }).success).toBe(true);
    // v0.4.3 L3: `{}` used to parse (both fields optional) and read as SUCCESS to any
    // `fallback === 'card'` discriminator. The union closes it: exactly one branch or invalid.
    expect(callables.pmsPostRoomCharge.output.safeParse({}).success).toBe(false);
    expect(callables.pmsPostRoomCharge.output.safeParse({ postingRef: 'p1' }).success).toBe(true);
    expect(callables.pmsPostRoomCharge.output.safeParse({ fallback: 'card' }).success).toBe(true);
  });

  it('guestRequestDriveHome output requires jobToken (replaces the old { quote } shape)', () => {
    const quote = { base: 100, distanceMeters: 10, durationSec: 60, amount: 100, breakdown: [] };
    expect(callables.guestRequestDriveHome.output.safeParse({ quote }).success).toBe(false);
    expect(callables.guestRequestDriveHome.output.safeParse({ quote, jobToken: TOKEN }).success).toBe(true);
  });

  it('guestRequestRide output requires jobToken instead of ticketId', () => {
    const quote = { base: 100, distanceMeters: 10, durationSec: 60, amount: 100, breakdown: [] };
    expect(callables.guestRequestRide.output.safeParse({ quote, ticketId: ID }).success).toBe(false);
    expect(callables.guestRequestRide.output.safeParse({ quote, jobToken: TOKEN }).success).toBe(true);
  });

  it('staffRefund is unchanged', () => {
    expect(callables.staffRefund.input.safeParse({ ticketId: ID, reason: 'guest dispute' }).success).toBe(true);
  });

  it('platformCreateOperator input omits server-managed operator fields and requires an owner contact', () => {
    const good = {
      id: 'goldstar', name: 'Goldstar', slug: 'goldstar', timezone: 'America/Indiana/Indianapolis', currency: 'USD', isSandbox: false, plan: 'standard',
      branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' },
      modules: { payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [20], tipPolicy: 'deliverer' }, messaging: { provider: 'twilio' }, scheduling: { provider: 'internal' }, vision: { provider: 'none' }, accounting: { provider: 'csv' } },
      features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true },
      ownerEmail: 'owner@goldstar-mgmt.example.com', ownerName: 'Owner',
    };
    expect(callables.platformCreateOperator.input.safeParse(good).success).toBe(true);
    expect(callables.platformCreateOperator.input.safeParse({ ...good, ownerEmail: 'not-an-email' }).success).toBe(false);
  });

  it('ticketsSearch input validates jobType', () => {
    expect(callables.ticketsSearch.input.safeParse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-23T00:00:00.000Z' }).success).toBe(true);
    expect(callables.ticketsSearch.input.safeParse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-23T00:00:00.000Z', jobType: 'scooter' }).success).toBe(false);
  });

  it('ticketsRevealPhone output requires a valid e164 phone', () => {
    expect(callables.ticketsRevealPhone.output.safeParse({ phoneE164: '+13175550123' }).success).toBe(true);
    expect(callables.ticketsRevealPhone.output.safeParse({ phoneE164: '317-555-0123' }).success).toBe(false);
  });

  it('staffApplyValidation requires a 6-char uppercase code', () => {
    expect(callables.staffApplyValidation.input.safeParse({ ticketId: ID, code: 'ABC123' }).success).toBe(true);
    expect(callables.staffApplyValidation.input.safeParse({ ticketId: ID, code: 'abc123' }).success).toBe(false);
  });

  it('guestStaticCheckout output extends checkout with a required ticketToken', () => {
    expect(callables.guestStaticCheckout.output.safeParse({ clientSecret: 'cs', publishableKey: 'pk', total: 100, tip: 0, ticketToken: TOKEN }).success).toBe(true);
    expect(callables.guestStaticCheckout.output.safeParse({ clientSecret: 'cs', publishableKey: 'pk', total: 100, tip: 0 }).success).toBe(false);
  });

  it('invoicesMarkPaid input accepts an optional paidAt', () => {
    expect(callables.invoicesMarkPaid.input.safeParse({ invoiceId: 'inv1' }).success).toBe(true);
    expect(callables.invoicesMarkPaid.input.safeParse({ invoiceId: 'inv1', paidAt: '2026-08-23T00:00:00.000Z' }).success).toBe(true);
  });
});

describe('query registry addenda', () => {
  const NEW_QUERIES = [
    'venueParked', 'reportsByTicket', 'guestByPhone', 'archiveClosed', 'archiveCancelled', 'auditByAction', 'auditByActor', 'outboundRetry',
    'myPrimaryJobs', 'myChaseJobs', 'jobsActive', 'platesByOperator', 'validationsByCode', 'hostRequestsOpen', 'transactionsByVenue', 'invoicesByVenue', 'guestsByPhone',
  ] as const;
  it('registers every new query', () => {
    for (const name of NEW_QUERIES) expect(QUERIES, name).toHaveProperty(name);
  });
  it('guestByPhone and the archive queries scan a collection group of tickets', () => {
    expect(QUERIES.guestByPhone).toMatchObject({ collectionGroup: 'tickets', fields: ['guest.phoneE164', 'status'] });
    expect(QUERIES.archiveClosed).toMatchObject({ collectionGroup: 'tickets', fields: ['status', 'times.closedAt'] });
    expect(QUERIES.archiveCancelled).toMatchObject({ collectionGroup: 'tickets', fields: ['status', 'times.cancelledAt'] });
  });
  it('outboundRetry indexes status and retryAt', () => {
    expect(QUERIES.outboundRetry.fields).toEqual(['status', 'retryAt']);
  });
  it('venueParked orders the staff parking queue by check-in time', () => {
    expect(QUERIES.venueParked).toEqual({ collection: 'tickets', fields: ['venueId', 'status', 'times.checkedInAt'], desc: 'times.checkedInAt' });
  });
});
