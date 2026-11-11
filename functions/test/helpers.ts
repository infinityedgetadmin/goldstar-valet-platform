import { makeDeps, type Deps } from '../src/lib/deps.js';
import { P } from '../src/lib/paths.js';

export const OP = 'goldstar';
export const V1 = 'v1';
export const NOW = '2026-08-23T21:00:00.000Z';
export const TID = '01912345-7abc-7def-8123-456789abcdef';
export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

export function testDeps(over: Partial<Deps> = {}): Deps {
  let n = 0;
  return makeDeps({
    now: () => NOW,
    newId: () => `01912345-7abc-7def-8123-4567${String(n++).padStart(8, '0')}`,
    secrets: {
      get: (k) =>
        ({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', TWILIO_ACCOUNT_SID: 'AC_x', TWILIO_AUTH_TOKEN: 'tok_x' })[k] ??
        `secret:${k}`,
    },
    ...over,
  });
}

// Emulator port isolation (infra task, task-platform-report.md): derived from the SAME
// `*_EMULATOR_HOST` env vars `setup.ts` (or `scripts/seed-emulator.ts`, this function's other
// caller) already populates — never a second, independently-hardcoded port literal. Whichever of
// those two set the var first (both use the identical `??=`-then-`GOLDSTAR_EMU_*_PORT`-fallback
// pattern), this reads the result; the bare `127.0.0.1:8080`/`127.0.0.1:9099` fallbacks here are a
// last-resort safety net for the unlikely case neither caller ran first, not a second source of
// truth for the actual port number.
export async function wipe(deps: Deps) {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
  // Per-offset project id (carry #70): the wipe must target the SAME project the suite writes to,
  // or it "succeeds" against an empty namespace and every test starts dirty. Same source as
  // setup.ts — GCLOUD_PROJECT, which setup.ts sets from GOLDSTAR_EMU_PROJECT_ID before any test runs.
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOLDSTAR_EMU_PROJECT_ID ?? 'demo-goldstar';
  const firestoreRes = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!firestoreRes.ok) throw new Error('wipe failed');
  const authRes = await fetch(`http://${authHost}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' });
  if (!authRes.ok) throw new Error('auth wipe failed');
  void deps;
}

export async function seedOperator(deps: Deps) {
  await deps.db.doc(P.operator(OP)).set({
    id: OP,
    name: 'Goldstar',
    slug: OP,
    status: 'active',
    timezone: 'America/Indiana/Indianapolis',
    currency: 'USD',
    isSandbox: false,
    plan: 'standard',
    branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c', supportPhone: '+13175550100' },
    modules: {
      payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' },
      messaging: { provider: 'twilio', messagingServiceSid: 'MG_x' },
      scheduling: { provider: 'internal' },
      vision: { provider: 'none' },
      accounting: { provider: 'csv' },
    },
    features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'system',
  });
  await deps.db.doc(P.venue(OP, V1)).set({
    id: V1,
    operatorId: OP,
    name: 'St. Elmo',
    type: 'restaurant',
    status: 'active',
    address: { line1: '127 S Illinois St', city: 'Indianapolis', region: 'IN', postalCode: '46225', country: 'US' },
    geo: { lat: 39.765, lng: -86.158 },
    zones: [{ id: 'A', name: 'Lot A' }],
    rates: {
      valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [] },
      driveHome: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 },
      passengerRide: { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 },
      validations: { allowPartial: true, maxAmount: 1500 },
    },
    sms: {},
    qr: { staticCheckoutEnabled: false },
    pushSlug: 'slug_v1', // Plan 8 Task 12: producers target venue_{pushSlug}; a venue without one gets no topic push
    contract: { model: 'per_ticket', perTicketFee: 250, taxRateBps: 0, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 1 },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function ticketDoc(over: Record<string, unknown> = {}) {
  return {
    id: TID,
    operatorId: OP,
    venueId: V1,
    jobType: 'valet',
    status: 'checked_in',
    source: 'staff',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
    vehicle: { plate: 'ABC123', state: 'IN', make: 'Honda', model: 'Civic', color: 'Blue' },
    keyTagId: 'k1',
    zoneId: 'A',
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: { checkedInBy: 'att1' },
    times: { checkedInAt: NOW },
    damageReportIds: [],
    incidentIds: [],
    guestToken: TOKEN,
    ...over,
  };
}
