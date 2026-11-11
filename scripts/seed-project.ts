/**
 * Seeds a REAL Firebase project (not the emulators) with the demo tenants: the `goldstar` operator
 * with venue `v1`, staff accounts whose custom claims match what `syncClaimsHandler` mints, key
 * tags, two tickets, and the white-label second tenant `valetb` with venue `vb1`.
 *
 * Three deliberate differences from `scripts/seed-emulator.ts`:
 *
 * 1. NO WIPE. The emulator seeder starts by deleting every document and account through the
 *    emulator-only REST endpoints. Those do not exist on a real project, and pointing a wipe at one
 *    would be indefensible regardless. Every write here is to a fixed document id, so re-running is
 *    an idempotent refresh rather than a duplication.
 *
 * 2. REST, not the Admin SDK. `firebase-admin`'s Firestore client refuses anything but a service
 *    account certificate or Application Default Credentials — an access token alone is not enough
 *    (`firestore/invalid-credential`). Rather than mint a long-lived service account key or require
 *    an interactive `gcloud auth application-default login`, this talks to the Firestore and
 *    Identity Toolkit REST APIs directly with a short-lived `gcloud auth print-access-token`. The
 *    token is never written anywhere and expires on its own.
 *
 * 3. CLAIMS ARE WRITTEN DIRECTLY, mirroring `buildClaims` (functions/src/modules/identity/
 *    claims.handler.ts): `{ operatorId, roles, venueIds?, claimsVersion }`, with `venueIds` omitted
 *    when empty. The deployed `onUserWritten` trigger re-syncs them from the user document anyway;
 *    writing them here just means the accounts are usable the moment this script finishes instead
 *    of one trigger-latency later. If that shape ever changes, this comment is the thing to update.
 *
 * Passwords come from `GOLDSTAR_DEMO_PASSWORD`. There is no default: these accounts are reachable
 * from the internet, so a password committed to a repository would be a standing invitation.
 *
 * Usage:
 *   GOLDSTAR_DEMO_PASSWORD='...' npx tsx scripts/seed-project.ts <projectId>
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { damageReportSchema, fleetVehicleSchema, incidentSchema, keyTagSchema, operatorSchema, secretToken, shiftSchema, ticketSchema, userSchema, venueSchema, type DamageReport, type FleetVehicle, type Incident, type KeyTag, type Operator, type Role, type Shift, type Ticket, type User, type Venue } from '../src/index';

const projectArg = process.argv[2];
if (projectArg === undefined || projectArg.length === 0) throw new Error('usage: tsx scripts/seed-project.ts <projectId>');
// Re-bound to a plainly-typed const: TypeScript's narrowing of a module-level `string | undefined`
// does not survive into the closures below, and every request header needs a definite string.
const projectId: string = projectArg;

const rawPassword = process.env.GOLDSTAR_DEMO_PASSWORD;
if (rawPassword === undefined || rawPassword.length < 12) {
  throw new Error('Set GOLDSTAR_DEMO_PASSWORD (12+ chars) — these are internet-reachable accounts, so there is no default.');
}
const password: string = rawPassword;

const TOKEN = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const FS = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const IDP = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`;

/** JS value -> Firestore REST `Value`. `undefined` is dropped by the caller, never encoded. */
function encode(v: unknown): Record<string, unknown> {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  throw new Error(`unencodable value: ${typeof v}`);
}

function encodeFields(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = encode(v);
  return out;
}

async function api(url: string, method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-goog-user-project': projectId },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new Error(`${method} ${url.split('/').slice(-2).join('/')} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/** PATCH with no updateMask replaces the whole document — create-or-overwrite, which is what
 * "re-running is a refresh" needs. */
const setDoc = (path: string, data: Record<string, unknown>) => api(`${FS}/${path}`, 'PATCH', { fields: encodeFields(data) });

/**
 * The guest token already stored at `path`, or `undefined` if the document is new.
 *
 * Without this, every re-run minted a fresh `secretToken()` for the same ticket, orphaning the
 * `guestTickets/{token}` projection the previous run's trigger created: the old link keeps
 * resolving to a snapshot that no longer updates, and the collection grows by ten rows per run.
 * Reusing the stored token is what makes "re-running is a refresh" true for guest links too.
 */
async function existingGuestToken(path: string): Promise<string | undefined> {
  const res = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'x-goog-user-project': projectId } });
  if (!res.ok) return undefined;
  const doc = (await res.json()) as { fields?: { guestToken?: { stringValue?: string } } };
  return doc.fields?.guestToken?.stringValue;
}

const OP = 'goldstar';
const V1 = 'v1';
const OP_B = 'valetb';
const VB1 = 'vb1';
const NOW = new Date().toISOString();
const KEY_TAG_COUNT = 20;

interface StaffSpec {
  uid: string;
  displayName: string;
  roles: Role[];
  venueIds: string[];
  operatorId: string;
}

const STAFF: StaffSpec[] = [
  { uid: 'owner1', displayName: 'Owner One', roles: ['owner'], venueIds: [V1], operatorId: OP },
  { uid: 'platform1', displayName: 'Platform One', roles: ['platform_admin'], venueIds: [], operatorId: OP },
  { uid: 'lead1', displayName: 'Lead One', roles: ['lead'], venueIds: [V1], operatorId: OP },
  { uid: 'att1', displayName: 'Att One', roles: ['attendant'], venueIds: [V1], operatorId: OP },
  { uid: 'driver1', displayName: 'Driver One', roles: ['driver'], venueIds: [V1], operatorId: OP },
  // The PARTNER persona: a venue's own staff (the restaurant's host stand), who sign into the venue
  // portal at /venue and see only their venue — never the operator's other venues or the admin nav.
  { uid: 'venue1', displayName: 'St. Elmo Host Stand', roles: ['venue_user'], venueIds: [V1], operatorId: OP },
  { uid: 'leadb1', displayName: 'Lead B', roles: ['lead'], venueIds: [VB1], operatorId: OP_B },
];

const emailFor = (s: StaffSpec) => (s.uid === 'venue1' ? 'venue1@stelmo.example.com' : `${s.uid}@${s.operatorId === OP ? 'goldstar' : 'valetcob'}.test`);

function operatorDoc(over: Partial<Operator> & Pick<Operator, 'id' | 'name' | 'slug'>): Operator {
  return operatorSchema.parse({
    status: 'active',
    timezone: 'America/Indiana/Indianapolis',
    currency: 'USD',
    isSandbox: true,
    plan: 'standard',
    modules: {
      payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' },
      messaging: { provider: 'twilio', messagingServiceSid: 'MG_x' },
      scheduling: { provider: 'internal' },
      vision: { provider: 'none' },
      accounting: { provider: 'csv' },
    },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'system',
    ...over,
  });
}

function venueDoc(over: Partial<Venue> & Pick<Venue, 'id' | 'operatorId' | 'name' | 'type' | 'pushSlug'>): Venue {
  return venueSchema.parse({
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
    contract: { model: 'per_ticket', perTicketFee: 250, taxRateBps: 0, terms: '', billingEmail: 'ap@example.example.com', invoiceDay: 1 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}

/** Mirrors `buildClaims` — see this file's header note 3. */
function claimsFor(s: StaffSpec): Record<string, unknown> {
  return { operatorId: s.operatorId, roles: s.roles, ...(s.venueIds.length > 0 ? { venueIds: s.venueIds } : {}), claimsVersion: 1 };
}

async function upsertAccount(s: StaffSpec): Promise<void> {
  const email = emailFor(s);
  const base = { localId: s.uid, email, password, displayName: s.displayName, emailVerified: true };
  try {
    await api(`${IDP}/accounts`, 'POST', base);
  } catch (e) {
    // DUPLICATE_LOCAL_ID / EMAIL_EXISTS on a re-run: update the existing account in place so the
    // password and profile are refreshed rather than the whole seed failing.
    if (!/DUPLICATE_LOCAL_ID|EMAIL_EXISTS/.test(String(e))) throw e;
    await api(`${IDP}/accounts:update`, 'POST', base);
  }
  await api(`${IDP}/accounts:update`, 'POST', { localId: s.uid, customAttributes: JSON.stringify(claimsFor(s)) });
}

async function main(): Promise<void> {
  console.log(`[seed-project] target: ${projectId}`);

  console.log('[seed-project] operators + venues...');
  await setDoc(
    `operators/${OP}`,
    operatorDoc({
      id: OP,
      name: 'Goldstar',
      slug: OP,
      branding: { displayName: 'Goldstar Valet', primaryColor: '#ab6034', accentColor: '#ffc30c', supportPhone: '+13175550100' },
      features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true },
    }),
  );
  await setDoc(
    `operators/${OP}/venues/${V1}`,
    venueDoc({ id: V1, operatorId: OP, name: 'St. Elmo', type: 'restaurant', pushSlug: 'slug_v1' }),
  );
  await setDoc(
    `operators/${OP_B}`,
    operatorDoc({
      id: OP_B,
      name: 'Valet Co B',
      slug: OP_B,
      branding: { displayName: 'Valet Co B', primaryColor: '#1d4ed8', accentColor: '#f59e0b', supportPhone: '+15555550100' },
      features: { driveHome: false, passengerRides: false, venuePortals: false, tapToPay: false, plateOcr: false, payouts: false },
    }),
  );
  await setDoc(
    `operators/${OP_B}/venues/${VB1}`,
    venueDoc({
      id: VB1,
      operatorId: OP_B,
      name: 'Blue Harbor Hotel',
      type: 'hotel',
      pushSlug: 'slug_vb1',
      address: { line1: '1 Harbor Way', city: 'Indianapolis', region: 'IN', postalCode: '46204', country: 'US' },
      geo: { lat: 39.77, lng: -86.16 },
    }),
  );

  console.log(`[seed-project] ${STAFF.length} staff accounts (auth + user doc + claims)...`);
  for (const s of STAFF) {
    await upsertAccount(s);
    const doc: User = userSchema.parse({
      uid: s.uid,
      operatorId: s.operatorId,
      displayName: s.displayName,
      email: emailFor(s),
      roles: s.roles,
      venueIds: s.venueIds,
      status: 'active',
      eligibility: { driveHome: s.roles.includes('driver'), passengerRide: s.roles.includes('driver'), reasons: [] },
      payoutStatus: 'none',
      fcmTokens: [],
      invitedAt: NOW,
      activatedAt: NOW,
    });
    await setDoc(`operators/${s.operatorId}/users/${s.uid}`, doc);
  }

  console.log('[seed-project] tickets across the whole valet lifecycle...');
  // Minutes ago -> ISO, so the board shows plausible ages rather than everything at once.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const uuid = (n: number) => `01912345-7abc-7def-8123-4567000000${String(n).padStart(2, '0')}`;

  interface TicketSpec {
    n: number;
    status: string;
    plate: string;
    make: string;
    model: string;
    color: string;
    times: Record<string, string>;
    attendants: Record<string, string>;
    payment?: Record<string, unknown>;
  }

  const paid = (total: number, tip: number) => ({
    status: 'paid' as const, base: total - tip, tip, tax: 0, fees: 0, total, currency: 'USD', billTo: 'guest' as const,
  });

  const SPECS: TicketSpec[] = [
    { n: 1, status: 'checked_in', plate: 'ABC123', make: 'Honda', model: 'Civic', color: 'Blue', times: { checkedInAt: ago(95) }, attendants: { checkedInBy: 'att1' } },
    { n: 2, status: 'checked_in', plate: 'TRX880', make: 'Toyota', model: 'RAV4', color: 'White', times: { checkedInAt: ago(74) }, attendants: { checkedInBy: 'att1' } },
    { n: 3, status: 'requested', plate: 'XYZ789', make: 'Ford', model: 'Explorer', color: 'Silver', times: { checkedInAt: ago(150), requestedAt: ago(6) }, attendants: { checkedInBy: 'att1' } },
    { n: 4, status: 'claimed', plate: 'JKL447', make: 'Subaru', model: 'Outback', color: 'Green', times: { checkedInAt: ago(160), requestedAt: ago(9), claimedAt: ago(7) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1' } },
    { n: 5, status: 'retrieving', plate: 'MNO222', make: 'Tesla', model: 'Model 3', color: 'Black', times: { checkedInAt: ago(180), requestedAt: ago(12), claimedAt: ago(10) }, attendants: { checkedInBy: 'att1', claimedBy: 'driver1' } },
    { n: 6, status: 'staged', plate: 'PQR318', make: 'BMW', model: 'X5', color: 'Grey', times: { checkedInAt: ago(200), requestedAt: ago(18), claimedAt: ago(16), stagedAt: ago(4) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1' } },
    { n: 7, status: 'ready', plate: 'STU905', make: 'Audi', model: 'Q7', color: 'White', times: { checkedInAt: ago(210), requestedAt: ago(22), claimedAt: ago(20), readyAt: ago(3) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1' } },
    { n: 8, status: 'delivered', plate: 'VWX610', make: 'Jeep', model: 'Wrangler', color: 'Red', times: { checkedInAt: ago(240), requestedAt: ago(40), claimedAt: ago(38), readyAt: ago(31), deliveredAt: ago(29) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1', deliveredBy: 'att1' }, payment: paid(1800, 300) },
    { n: 9, status: 'closed', plate: 'YZA733', make: 'Lexus', model: 'RX', color: 'Pearl', times: { checkedInAt: ago(300), requestedAt: ago(70), claimedAt: ago(68), readyAt: ago(62), deliveredAt: ago(60), closedAt: ago(59) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1', deliveredBy: 'driver1' }, payment: paid(2100, 600) },
    { n: 10, status: 'closed', plate: 'BCD514', make: 'Volvo', model: 'XC90', color: 'Blue', times: { checkedInAt: ago(330), requestedAt: ago(96), claimedAt: ago(94), readyAt: ago(88), deliveredAt: ago(86), closedAt: ago(85) }, attendants: { checkedInBy: 'att1', claimedBy: 'att1', deliveredBy: 'att1' }, payment: paid(1500, 0) },
  ];

  const ticketOf = (spec: TicketSpec, keepToken?: string): Ticket =>
    ticketSchema.parse({
      id: uuid(spec.n),
      operatorId: OP,
      venueId: V1,
      jobType: 'valet',
      status: spec.status,
      source: 'staff',
      guest: { phoneE164: '+1317555' + String(1000 + spec.n), phoneLast4: String(1000 + spec.n).slice(-4), consentSms: true },
      vehicle: { plate: spec.plate, state: 'IN', make: spec.make, model: spec.model, color: spec.color },
      flags: { assistance: false, accessibleVehicle: false, photosSkipped: true, vip: spec.n === 7 },
      damageReportIds: spec.n === 1 ? [uuid(90)] : [],
      incidentIds: [],
      guestToken: keepToken ?? secretToken(),
      zoneId: 'A',
      keyTagId: `k${spec.n}`,
      times: spec.times,
      attendants: spec.attendants,
      ...(spec.payment ? { payment: spec.payment } : {}),
    });

  const tickets: Ticket[] = [];
  for (const spec of SPECS) {
    const path = `operators/${OP}/tickets/${uuid(spec.n)}`;
    const kept = await existingGuestToken(path);
    const t = ticketOf(spec, kept);
    tickets.push(t);
    await setDoc(path, t);
  }

  console.log(`[seed-project] ${KEY_TAG_COUNT} key tags...`);
  for (let n = 1; n <= KEY_TAG_COUNT; n++) {
    const onTicket = SPECS.find((sp) => sp.n === n && sp.status !== 'closed');
    const tag: KeyTag = keyTagSchema.parse({
      id: `k${n}`,
      operatorId: OP,
      value: `GS-${String(n).padStart(3, '0')}`,
      venueId: V1,
      status: onTicket ? 'assigned' : 'available',
      ...(onTicket ? { currentTicketId: uuid(onTicket.n) } : {}),
    });
    await setDoc(`operators/${OP}/keyTags/${tag.id}`, tag);
  }

  console.log('[seed-project] fleet, shift, damage report, incident...');
  const fleet: FleetVehicle[] = [
    fleetVehicleSchema.parse({ id: 'fleet1', operatorId: OP, plate: 'FLEET01', state: 'IN', make: 'Ford', model: 'Transit', color: 'White', capacity: 6, accessible: true, status: 'available' }),
    fleetVehicleSchema.parse({ id: 'fleet2', operatorId: OP, plate: 'FLEET02', state: 'IN', make: 'Chevrolet', model: 'Suburban', color: 'Black', capacity: 7, accessible: false, status: 'in_use', currentDriverUid: 'driver1' }),
  ];
  for (const v of fleet) await setDoc(`operators/${OP}/fleetVehicles/${v.id}`, v);

  const today = new Date().toISOString().slice(0, 10);
  const shift: Shift = shiftSchema.parse({
    id: `${today}-${V1}`,
    operatorId: OP,
    venueId: V1,
    date: today,
    startsAt: ago(360),
    endsAt: ago(-120),
    leadUid: 'lead1',
    status: 'open',
    assignments: [
      { uid: 'lead1', role: 'lead', startsAt: ago(360), endsAt: ago(-120), confirmed: true },
      { uid: 'att1', role: 'attendant', startsAt: ago(360), endsAt: ago(-120), confirmed: true },
      { uid: 'driver1', role: 'driver', startsAt: ago(300), endsAt: ago(-60), confirmed: false },
    ],
    assignedUids: ['lead1', 'att1', 'driver1'],
    notes: 'Dinner service — two attendants on the door.',
    source: { provider: 'internal' },
  });
  await setDoc(`operators/${OP}/shifts/${shift.id}`, shift);

  const damage: DamageReport = damageReportSchema.parse({
    id: uuid(90),
    operatorId: OP,
    ticketId: uuid(1),
    vehicleSnapshot: { plate: 'ABC123', make: 'Honda', model: 'Civic', color: 'Blue' },
    phase: 'check_in',
    diagramMarks: [{ panel: 'front_left_door', x: 0.4, y: 0.55, kind: 'scratch', preExisting: true, note: 'Present at drop-off' }],
    notes: 'Light scratch on the driver door, photographed at check-in.',
    createdBy: 'att1',
    createdAt: ago(95),
    photoCount: 0,
  });
  await setDoc(`operators/${OP}/damageReports/${damage.id}`, damage);

  const incident: Incident = incidentSchema.parse({
    id: uuid(91),
    operatorId: OP,
    venueId: V1,
    ticketId: uuid(5),
    type: 'property',
    description: 'Guest reported a cone knocked into the lane by an exiting vehicle. No vehicle damage.',
    photos: [],
    reportedBy: 'lead1',
    at: ago(45),
    status: 'open',
    witnesses: [],
  });
  await setDoc(`operators/${OP}/incidents/${incident.id}`, incident);

  console.log('[seed-project] verifying...');
  for (const s of STAFF) {
    const got = (await api(`${IDP}/accounts:lookup`, 'POST', { localId: [s.uid] })) as { users?: { customAttributes?: string }[] };
    const attrs = got.users?.[0]?.customAttributes;
    assert.ok(attrs, `${s.uid}: no custom claims`);
    // `claimsVersion` is deliberately excluded: the deployed `onUserWritten` trigger re-syncs claims
    // from the user document moments after this script writes it, bumping the version. Asserting on
    // it would make a correct seed fail purely on trigger timing. What must match is the identity
    // half — operator, roles, venues.
    const { claimsVersion, ...actual } = JSON.parse(attrs) as Record<string, unknown>;
    const expected: Record<string, unknown> = { ...claimsFor(s) };
    delete expected.claimsVersion;
    assert.ok(typeof claimsVersion === 'number', `${s.uid}: claimsVersion missing`);
    assert.deepEqual(actual, expected, `${s.uid}: claims mismatch`);
  }

  console.log('\n[seed-project] OK. Sign-in emails:');
  for (const s of STAFF) console.log(`  ${emailFor(s).padEnd(26)} ${s.roles.join(',').padEnd(14)} ${s.operatorId}`);
  console.log('\n[seed-project] guest ticket links (/t/<token>):');
  for (const t of tickets.filter((x) => x.status !== 'closed').slice(0, 4)) {
    console.log(`  ${t.guestToken}  ${t.status.padEnd(11)} ${t.vehicle.color ?? ''} ${t.vehicle.make ?? ''} ${t.vehicle.model ?? ''}`);
  }
}

main().catch((e: unknown) => {
  console.error('[seed-project] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
