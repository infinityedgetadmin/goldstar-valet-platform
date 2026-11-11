import type { Operator } from '../../src/schemas/operator';
import type { Venue } from '../../src/schemas/venue';
import { DEMO_TIMEZONE, OP, OP_ONBOARDING, OP_SUSPENDED, V_EVENT, V_HOTEL, V1 } from './constants';
import type { DemoClock } from './context';
import { demoToken } from './context';
import type { SeedDoc } from './types';

/** Static-checkout token for the event venue: /pay/<this> is the demo's "scan the sign" page. */
export const EVENT_CHECKOUT_TOKEN = demoToken(9001);

const SHARED_RATES = {
  driveHome: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 },
  passengerRide: { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 },
} as const;

function operatorDoc(clock: DemoClock, over: Pick<Operator, 'id' | 'name' | 'slug' | 'status'> & Partial<Operator>): Operator {
  return {
    timezone: DEMO_TIMEZONE,
    currency: 'USD',
    isSandbox: false,
    plan: 'standard',
    branding: { displayName: over.name, primaryColor: '#ab6034', accentColor: '#ffc30c' },
    modules: {
      payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 150, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' },
      messaging: { provider: 'twilio', messagingServiceSid: 'MG_demo' },
      scheduling: { provider: 'internal' },
      vision: { provider: 'none' },
      accounting: { provider: 'csv' },
    },
    features: { driveHome: false, passengerRides: false, venuePortals: false, tapToPay: false, plateOcr: false, payouts: false },
    security: { requireMfaForAdmins: false },
    createdAt: clock.daysAgo(200),
    updatedAt: clock.daysAgo(1),
    createdBy: 'platform1',
    ...over,
  };
}

function venueDoc(clock: DemoClock, over: Pick<Venue, 'id' | 'name' | 'type' | 'address' | 'geo' | 'zones' | 'rates' | 'contract'> & Partial<Venue>): Venue {
  return {
    operatorId: OP,
    status: 'active',
    sms: {
      welcome: 'Welcome to {venue}! Your valet ticket: {link}',
      ready: 'Your car is ready at the curb. Thank you for choosing {venue}.',
    },
    qr: { staticCheckoutEnabled: false },
    timezone: DEMO_TIMEZONE,
    createdAt: clock.daysAgo(180),
    updatedAt: clock.daysAgo(1),
    ...over,
  };
}

export function buildPlaces(clock: DemoClock): SeedDoc[] {
  const goldstar = operatorDoc(clock, {
    id: OP,
    name: 'Goldstar',
    slug: OP,
    status: 'active',
    branding: {
      displayName: 'Goldstar Valet',
      primaryColor: '#ab6034',
      accentColor: '#ffc30c',
      supportPhone: '+13175550100',
      supportEmail: 'info@goldstar-mgmt.example.com',
      receiptFooter: 'Thank you for parking with Goldstar. Questions? Call (317) 429-6781.',
    },
    // vision: plate_recognizer so check-in offers plate OCR; the emulator-only demo providers
    // switch answers it with the mock reader instead of the real Plate Recognizer API.
    modules: {
      payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 150, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' },
      messaging: { provider: 'twilio', messagingServiceSid: 'MG_demo' },
      scheduling: { provider: 'internal' },
      vision: { provider: 'plate_recognizer' },
      accounting: { provider: 'csv' },
    },
    features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: true, plateOcr: true, payouts: true },
    createdAt: clock.daysAgo(400),
  });

  const stElmo = venueDoc(clock, {
    id: V1,
    name: 'St. Elmo',
    type: 'restaurant',
    address: { line1: '127 S Illinois St', city: 'Indianapolis', region: 'IN', postalCode: '46225', country: 'US' },
    geo: { lat: 39.765, lng: -86.158 },
    phone: '+13175550142',
    // Zone "A" is the base seed's only zone; the Maestro flows park cars there.
    zones: [
      { id: 'A', name: 'Lot A', capacity: 60 },
      { id: 'B', name: 'Garage B', capacity: 40 },
      { id: 'VIP', name: 'Front row', capacity: 6 },
    ],
    rates: {
      valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [] },
      ...SHARED_RATES,
      validations: { allowPartial: true, maxAmount: 1500 },
    },
    // Toast POS: "apply validation to the check" in the venue portal. Answered by the demo
    // providers' POS mock in the emulator.
    pos: { provider: 'toast', restaurantGuid: 'demo-toast-st-elmo', validationDiscountGuid: 'demo-discount', valetItemGuid: 'demo-valet-item' },
    pushSlug: 'slug_v1',
    contract: { model: 'per_ticket', perTicketFee: 250, taxRateBps: 0, terms: 'Net 15. Per-ticket management fee.', billingEmail: 'ap@stelmo.example.com', invoiceDay: 1 },
  });

  const hotel = venueDoc(clock, {
    id: V_HOTEL,
    name: 'The Meridian Hotel',
    type: 'hotel',
    address: { line1: '50 W Washington St', city: 'Indianapolis', region: 'IN', postalCode: '46204', country: 'US' },
    geo: { lat: 39.7669, lng: -86.1586 },
    zones: [
      { id: 'G1', name: 'Garage level 1', capacity: 80 },
      { id: 'G2', name: 'Garage level 2', capacity: 80 },
    ],
    rates: {
      valet: {
        model: 'overnight',
        items: [
          { id: 'day', label: 'Day valet (up to 4h)', amount: 2200, upToMinutes: 240 },
          { id: 'night', label: 'Overnight', amount: 4800 },
        ],
        taxRateBps: 900,
        fees: [{ id: 'city', label: 'City parking fee', amount: 200 }],
      },
      ...SHARED_RATES,
      validations: { allowPartial: false, maxAmount: 2200 },
    },
    // OPERA PMS: room lookup + charge-to-room, answered by the demo PMS mock in the emulator.
    pms: { provider: 'opera_cloud', hotelId: 'DEMO-MERIDIAN', noPostBehavior: 'fallback_card', chargeCode: 'VALET' },
    pushSlug: 'slug_meridian',
    contract: { model: 'rev_share', revShareBps: 2000, taxRateBps: 0, terms: 'Net 30. 20% revenue share.', billingEmail: 'finance@meridian.example.com', invoiceDay: 5 },
  });

  const eventHall = venueDoc(clock, {
    id: V_EVENT,
    name: 'Fountain Square Event Hall',
    type: 'event',
    address: { line1: '1105 Prospect St', city: 'Indianapolis', region: 'IN', postalCode: '46203', country: 'US' },
    geo: { lat: 39.7533, lng: -86.1407 },
    zones: [{ id: 'E', name: 'Event lot', capacity: 150 }],
    rates: {
      valet: { model: 'flat', items: [{ id: 'event', label: 'Event valet', amount: 2000 }], taxRateBps: 700, fees: [] },
      ...SHARED_RATES,
      validations: { allowPartial: true, maxAmount: 2000 },
    },
    // Flat rate + static checkout: onVenueWritten projects /venuePublic/<token> for the pay page.
    qr: { staticCheckoutEnabled: true, staticCheckoutToken: EVENT_CHECKOUT_TOKEN },
    pushSlug: 'slug_fountain',
    contract: { model: 'flat', flatMonthly: 180000, taxRateBps: 0, terms: 'Flat monthly retainer.', billingEmail: 'events@fountainsquare.example.com', invoiceDay: 1 },
  });

  const suspended = operatorDoc(clock, { id: OP_SUSPENDED, name: 'Circle City Parking', slug: OP_SUSPENDED, status: 'suspended', branding: { displayName: 'Circle City Parking', primaryColor: '#1f2937', accentColor: '#10b981' } });
  const onboarding = operatorDoc(clock, { id: OP_ONBOARDING, name: 'Northside Valet', slug: OP_ONBOARDING, status: 'onboarding', branding: { displayName: 'Northside Valet', primaryColor: '#7c3aed', accentColor: '#f59e0b' }, createdAt: clock.daysAgo(3) });

  return [
    { kind: 'operator', path: `operators/${OP}`, data: goldstar },
    { kind: 'operator', path: `operators/${OP_SUSPENDED}`, data: suspended },
    { kind: 'operator', path: `operators/${OP_ONBOARDING}`, data: onboarding },
    { kind: 'venue', path: `operators/${OP}/venues/${V1}`, data: stElmo },
    { kind: 'venue', path: `operators/${OP}/venues/${V_HOTEL}`, data: hotel },
    { kind: 'venue', path: `operators/${OP}/venues/${V_EVENT}`, data: eventHall },
  ];
}
