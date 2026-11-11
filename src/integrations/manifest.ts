import { z } from 'zod';
export const INTEGRATION_IDS = ['stripe', 'twilio', 'internal', 'ical', 'when_i_work', 'plate_recognizer', 'opera_cloud', 'toast', 'csv', 'quickbooks_online', 'mapbox'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];
export interface IntegrationManifestEntry { id: IntegrationId; module: 'payments' | 'messaging' | 'scheduling' | 'pms' | 'pos' | 'accounting' | 'vision' | 'maps'; label: string; scope: 'operator' | 'venue'; configSchema: z.ZodTypeAny; secretFields: readonly string[]; capabilities: readonly string[]; docsUrl: string }
export const INTEGRATION_MANIFEST: readonly IntegrationManifestEntry[] = [
  { id: 'stripe', module: 'payments', label: 'Stripe', scope: 'operator', configSchema: z.object({ connectedAccountId: z.string().optional(), platformFeeBps: z.number().int().min(0).max(10000).default(0) }), secretFields: [], capabilities: ['checkout', 'tap_to_pay', 'reader', 'refunds', 'connect', 'payouts'], docsUrl: 'https://docs.stripe.com/connect' },
  { id: 'twilio', module: 'messaging', label: 'Twilio SMS', scope: 'operator', configSchema: z.object({ messagingServiceSid: z.string().min(1) }), secretFields: ['accountSid', 'authToken'], capabilities: ['sms', 'inbound', 'status'], docsUrl: 'https://www.twilio.com/docs/messaging' },
  { id: 'internal', module: 'scheduling', label: 'Built-in scheduling', scope: 'operator', configSchema: z.object({}), secretFields: [], capabilities: ['editor'], docsUrl: '' },
  { id: 'ical', module: 'scheduling', label: 'Calendar feed (iCal)', scope: 'operator', configSchema: z.object({ feedUrl: z.string().url(), venueId: z.string().min(1), matchBy: z.enum(['email', 'name']).default('email') }), secretFields: [], capabilities: ['pull'], docsUrl: '' },
  // When I Work has NO static API key. You POST to a DIFFERENT host
  // (https://api.login.wheniwork.com/login) with a `W-Key: <developerKey>` header and an
  // {email, password} body; the response is a person object carrying a JWT, which is then sent as
  // `W-Token` (or `Authorization: Bearer`) to https://api.wheniwork.com. So the credential set is
  // THREE secrets, not one, and the adapter needs a login-and-cache step.
  //
  // `workplaceUserId`: when the authenticating user belongs to multiple Workplaces you must first
  // GET /2/login?show_pending=true and pick a user-id before any other call resolves.
  // Multi-location valet operators are Goldstar's normal case, so this is configurable rather
  // than assumed-single. Optional: single-workplace accounts omit it, and the adapter uses the
  // sole entry, erroring only if it finds more than one and none is set.
  //
  // `roleMap` keys are When I Work POSITION IDs, which are integers — stored as their decimal
  // string form because zod record keys are strings and Firestore map keys must be strings. A
  // position RENAMED in WIW keeps its id, but one deleted and recreated gets a NEW id and
  // silently stops mapping, so `syncNow` must REPORT unmapped positions rather than dropping the
  // shift. Verified against dev.wheniwork.com; see external-api-contracts.md §3.
  { id: 'when_i_work', module: 'scheduling', label: 'When I Work', scope: 'operator', configSchema: z.object({ locationId: z.string().min(1), workplaceUserId: z.string().optional(), venueMap: z.record(z.string(), z.string()).default({}), roleMap: z.record(z.string(), z.enum(['lead', 'attendant', 'driver'])).default({}), pushClock: z.boolean().default(false) }), secretFields: ['developerKey', 'username', 'password'], capabilities: ['pull', 'push_clock'], docsUrl: 'https://apidocs.wheniwork.com/' },
  { id: 'plate_recognizer', module: 'vision', label: 'Plate Recognizer', scope: 'operator', configSchema: z.object({ region: z.string().default('us') }), secretFields: ['apiToken'], capabilities: ['read_plate'], docsUrl: 'https://guides.platerecognizer.com/' },
  { id: 'opera_cloud', module: 'pms', label: 'Oracle OPERA Cloud (OHIP)', scope: 'venue', configSchema: z.object({ hotelId: z.string().min(1), gatewayUrl: z.string().url(), chargeCode: z.string().min(1), noPostBehavior: z.enum(['block', 'fallback_card']).default('block') }), secretFields: ['clientId', 'clientSecret', 'appKey', 'username', 'password'], capabilities: ['lookup', 'post_charge', 'reverse'], docsUrl: 'https://docs.oracle.com/en/industries/hospitality/integration-platform/' },
  { id: 'toast', module: 'pos', label: 'Toast POS', scope: 'venue', configSchema: z.object({ restaurantGuid: z.string().min(1) }), secretFields: ['clientId', 'clientSecret'], capabilities: ['find_check', 'apply_validation', 'add_charge'], docsUrl: 'https://doc.toasttab.com/' },
  { id: 'csv', module: 'accounting', label: 'CSV export', scope: 'operator', configSchema: z.object({}), secretFields: [], capabilities: ['export'], docsUrl: '' },
  // `refreshToken` is deliberately NOT a secretField: Intuit ROTATES it on every refresh (each
  // response carries a new one and invalidates the old), so it is mutable STATE, not
  // configuration, and the named-secret store is read-only to Functions. It lives in
  // `operators/{op}/integrationTokens/quickbooks_online` instead — see `integrationTokenSchema`
  // and that path's Functions-only rule.
  //
  // `clientId`/`clientSecret` were MISSING entirely (the entry listed only `refreshToken`), so as
  // shipped there was no way to configure the app credentials the refresh call's
  // `Authorization: Basic base64(clientId:clientSecret)` header needs — this integration could
  // never have authenticated. Those two are true secrets: they are the app's own credentials and
  // never rotate. Verified against developer.intuit.com; see external-api-contracts.md §4.
  { id: 'quickbooks_online', module: 'accounting', label: 'QuickBooks Online', scope: 'operator', configSchema: z.object({ realmId: z.string().min(1), incomeAccountId: z.string().min(1) }), secretFields: ['clientId', 'clientSecret'], capabilities: ['invoices'] /* 'sales_receipts' dropped — Ruling AA cut syncSalesReceipts from Plan 7; advertising a capability nothing implements is the assert-something-untrue class in miniature */, docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/get-started' },
  { id: 'mapbox', module: 'maps', label: 'Mapbox', scope: 'operator', configSchema: z.object({}), secretFields: ['serverToken'], capabilities: ['directions', 'geocoding'], docsUrl: 'https://docs.mapbox.com/api/' },
];
