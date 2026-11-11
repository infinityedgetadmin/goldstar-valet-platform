/**
 * Seeds the Firebase emulators (Firestore + Auth) with the fixtures Task 7's Maestro flow
 * (`maestro/staff-daily-loop.yaml`, `goldstar-mobile` repo — a sibling checkout) needs to run
 * against a live emulator instead of mocks: the `goldstar` operator + `v1` venue (reusing
 * `functions/test/helpers.ts`'s own fixtures, the same ones the Functions test suite seeds),
 * two staff Auth+Firestore accounts with custom claims synced via the REAL
 * `syncClaimsHandler` (not reimplemented here), 20 key tags, and one pre-seeded `requested`
 * ticket.
 *
 * ## Why a pre-seeded `requested` ticket
 *
 * When this script was first written, `checked_in -> requested` had no staff-facing trigger in
 * `goldstar-mobile` at all — `ticket-card.tsx`'s `NEXT` map (reused by both the queue and ticket
 * screens) had no entry for `checked_in`, even though `VALET_RULES` already allowed the
 * transition for staff roles — so seeding a second ticket already in `requested` was the only
 * way to exercise the claim/retrieve/ready/deliver flow end-to-end without first driving an
 * unreachable hop. Ruling Z (2c Task 7 follow-up) closed that gap: `NEXT` now has a
 * `checked_in: { to: 'requested', label: 'Request car' }` entry, so that path is reachable from
 * the UI too. The seeded ticket stays anyway — not as a workaround any more, but as deliberate
 * emulator furniture: a second, distinct vehicle ("Ford", vs. the "Honda" the Maestro flow checks
 * in live) already sitting in `requested` gives the flow a ready-made second ticket to exercise
 * without spending steps on the checked-in-to-requested hop first, and doubles as a stand-in for
 * Plan 3's guest-initiated request path (QR/app), which this script doesn't attempt to seed.
 *
 * ## Idempotency
 *
 * Always wipes Firestore + Auth first (`wipe()`, the same helper `identity.test.ts` uses in
 * `beforeEach`) — safe to run repeatedly against the same emulator instance without
 * already-exists errors.
 *
 * ## Usage
 *
 * ```bash
 * npm run seed:emulator   # firebase emulators:exec — spins up, seeds, verifies, tears down.
 *                          # Good for CI/proof-of-correctness, NOT for an interactive Maestro
 *                          # run (the emulators exit with the script).
 *
 * # For an interactive run against goldstar-mobile (USE_EMULATORS=1), start long-lived
 * # emulators first, then seed them directly:
 * npm run emulators                       # terminal 1 — stays up
 * npx tsx scripts/seed-emulator.ts        # terminal 2 — seeds the already-running instance
 * ```
 */

// Firebase Admin's default `initializeApp()` (triggered by the first `functions/src/lib/app.ts`
// import below) reads these at call time — they MUST land in `process.env` before that module is
// ever evaluated. ESM `import` statements are hoisted above ordinary code regardless of source
// order, so the emulator-touching modules below are loaded via dynamic `import()` inside `main()`
// (which only runs after these assignments) rather than as static imports. `??=` defers to
// `firebase emulators:exec`'s own injected values when this runs through `npm run seed:emulator`;
// falls back to the same defaults `functions/test/setup.ts` and this repo's `firebase.json` use
// when run directly against a manually-started `npm run emulators`.
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
// Per-offset project id (carry #70): the wrapper exports GOLDSTAR_EMU_PROJECT_ID and GCLOUD_PROJECT
// together, so under `npm run seed:emulator` the `??=` is a no-op. The fallback chain only matters
// when this runs directly against a manually-started emulator at an offset.
process.env.GCLOUD_PROJECT ??= process.env.GOLDSTAR_EMU_PROJECT_ID ?? 'demo-goldstar';

import assert from 'node:assert/strict';
import { secretToken } from '../src/ids';
import { keyTagSchema, type KeyTag } from '../src/schemas/keyTag';
import { ticketSchema, type Ticket } from '../src/schemas/ticket';
import { userSchema, type User } from '../src/schemas/user';
// Type-only — erased at compile time, so these do NOT trigger the `functions/src/lib/app.ts`
// `initializeApp()` side effect the header comment above warns about; only the RUNTIME
// `await import(...)` calls inside `main()` need to stay deferred.
import type { Deps as SeedDeps } from '../functions/src/lib/deps';
import type { P as PathBuildersValue } from '../functions/src/lib/paths';
import type { syncClaimsHandler as syncClaimsHandlerValue } from '../functions/src/modules/identity/claims.handler';

const ATT_UID = 'att1';
const ATT_EMAIL = 'att1@goldstar.example.com';
const LEAD_UID = 'lead1';
const LEAD_EMAIL = 'lead1@goldstar.example.com';
const PASSWORD = 'password123';
// Demo accounts for the dashboard's owner-only and platform-admin surfaces (Integrations,
// Branding, Audit, Settings; Operators, Plans, Platform settings, Global audit). Same
// mechanism as every other seeded user: a user doc whose `roles` syncClaimsHandler copies
// into custom claims — `platform_admin` is a ROLES value, minted server-side only.
const OWNER_UID = 'owner1';
const OWNER_EMAIL = 'owner1@goldstar.example.com';
const PLATFORM_UID = 'platform1';
const PLATFORM_EMAIL = 'platform1@goldstar.example.com';

const KEY_TAG_COUNT = 20;
/** GS-V1-0002 (`k2`) is pre-assigned to the seeded walk-up ticket below; GS-V1-0001 (`k1`) stays
 * `available` — that's the tag the Maestro flow's live check-in step scans/enters manually. */
const WALKUP_KEY_TAG_INDEX = 2;

// Plan 5 Task 6 (maestro/drive-home.yaml): a second, distinct driver-role fixture — a drive-home
// job seeded already at `assigned`, with its primary/chase drivers and BOTH inspection reports
// pre-qualified. See `seedDriveHomeJob` below for why every field is shaped the way it is.
const PRIMARY_UID = 'primary1';
const PRIMARY_EMAIL = 'primary1@goldstar.example.com';
const CHASE_UID = 'chase1';
const CHASE_EMAIL = 'chase1@goldstar.example.com';
const JOB_TID = '01912345-7abc-7def-8123-456789bbbbbb';
const PRE_REPORT_ID = '01912345-7abc-7def-8123-456789cccccc';
const POST_REPORT_ID = '01912345-7abc-7def-8123-456789dddddd';

function keyTagValue(n: number): string {
  return `GS-V1-${String(n).padStart(4, '0')}`;
}

/** 64 lowercase-hex characters — satisfies `photoSchema.sha256`'s regex without pretending to be
 * a real digest (these are seed fixtures, never uploaded to Storage). */
function fakeSha256(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/**
 * Seeds `maestro/drive-home.yaml`'s (goldstar-mobile repo) fixtures: a `primary1`/`chase1`
 * driver pair and a drive-home job ticket already at `assigned` — the flow's real starting
 * screen (`AssignedScreen`, "Job assigned" / "Start") — with BOTH its pre-drive and post-drive
 * damage reports already qualifying, so a run of that flow never has to drive the actual photo-
 * capture screen (Maestro cannot operate the device camera).
 *
 * ## Why two reports are pre-seeded, not captured live
 *
 * `InspectionScreen`/`ArrivedScreen` gate `Start trip`/`Complete job` on `hasPreDriveReport`/
 * `hasPostDriveReport` (`goldstar-mobile`'s `use-job.ts`), which is derived from the qualifying
 * report's OWN `photos` SUBCOLLECTION reaching `MIN_PRE_DRIVE_PHOTOS` — never from the report
 * doc's `photoCount` field, which `createDamageReport` never sets client-side (that field is
 * Functions-owned: `onPhotoCreated`'s trigger increments it as each photo doc lands). The
 * SERVER-side gate (`functions/src/modules/dispatch/onJobWritten.ts`'s `hasQualifyingReport`,
 * which reverts an under-evidenced `in_transit`/`completed` write) reads the OPPOSITE field —
 * `photoCount` only, never the subcollection. Both fixtures are written here so either gate
 * passes regardless of which emulator profile is running this script:
 *   - `npm run seed:emulator` (`firebase emulators:exec --only firestore,auth,storage`, this
 *     script's own CI/proof-of-correctness gate) never starts the Functions emulator, so
 *     `onPhotoCreated` never fires — `photoCount` would stay `undefined` forever if this script
 *     relied on the trigger to set it. It is set directly, exactly like
 *     `onJobWritten.test.ts`'s own `seedDamageReport` helper does.
 *   - The interactive path (`npm run emulators` — a full `firebase emulators:start`, which DOES
 *     include Functions per `firebase.json`) WOULD additionally fire `onPhotoCreated` for each
 *     photo doc created below, incrementing `photoCount` further past the floor it's already
 *     set to here — harmless for a `>=` threshold check, just not exactly `4`.
 *
 * ## Why `payment` is omitted from the job ticket
 *
 * The flow's final step (`ArrivedScreen`'s "Complete job") writes `status: 'completed'`, which
 * `onJobWritten.ts`'s completion branch attempts to CAPTURE — but only
 * `if (after.payment?.status === 'authorized' && after.payment.lastIntentId)`. `getGateway()`
 * always constructs a REAL `StripeGateway` (verified against `functions/src/modules/payments/
 * registry.ts` — there is no local/mock payments provider), so a seeded `authorized` payment
 * would make the LIVE `onJobWritten` trigger attempt a genuine `stripe.paymentIntents.capture()`
 * call against a fabricated `lastIntentId` the moment a driver taps "Complete job" during an
 * interactive Maestro run. Payments are out of scope for this UI flow (covered by the platform's
 * own `checkout.test.ts`/`onJobWritten.test.ts` suites and the guest-web repo's own
 * Stripe-CLI-gated Playwright spec) — `payment` is left unset entirely, exactly like the
 * pre-existing `ticketDoc()` helper's own valet-ticket default, so that capture branch never
 * fires.
 *
 * ## Driver identity: two distinct uids, not one
 *
 * `job-flow-screen.tsx` renders the CHASE-specific screens (`FollowingScreen`/`ReturningScreen`)
 * only when `isChaseDriver && !isPrimaryDriver` — a single uid holding both roles would always
 * fall through to the PRIMARY branch instead (never actually exercising the chase UI at all), so
 * `primary1`/`chase1` are genuinely separate Auth users/`users/{uid}` docs/custom-claims syncs,
 * matching production's own distinct-driver requirement (`dispatchAssign` rejects
 * `chaseDriverUid === primaryDriverUid`) even though this script bypasses that callable to seed
 * the post-assignment state directly.
 */
type PathBuilders = typeof PathBuildersValue;
type SyncClaimsHandler = typeof syncClaimsHandlerValue;

async function seedDriveHomeJob(
  deps: SeedDeps,
  ctx: { OP: string; V1: string; NOW: string; P: PathBuilders; syncClaimsHandler: SyncClaimsHandler },
): Promise<void> {
  const { OP, V1, NOW, P } = ctx;

  console.log('[seed-emulator] creating drive-home driver accounts (primary1, chase1)...');
  await deps.auth.createUser({ uid: PRIMARY_UID, email: PRIMARY_EMAIL, password: PASSWORD });
  await deps.auth.createUser({ uid: CHASE_UID, email: CHASE_EMAIL, password: PASSWORD });
  const driverBase = {
    operatorId: OP,
    status: 'active' as const,
    eligibility: { driveHome: true, passengerRide: false, reasons: [] },
    payoutStatus: 'none' as const,
    fcmTokens: [],
    invitedAt: NOW,
    activatedAt: NOW,
    venueIds: [V1],
  };
  await deps.db.doc(P.user(OP, PRIMARY_UID)).set({ ...driverBase, uid: PRIMARY_UID, displayName: 'Primary One', email: PRIMARY_EMAIL, roles: ['driver'] });
  await deps.db.doc(P.user(OP, CHASE_UID)).set({ ...driverBase, uid: CHASE_UID, displayName: 'Chase One', email: CHASE_EMAIL, roles: ['driver'] });
  await ctx.syncClaimsHandler(deps, { operatorId: OP, uid: PRIMARY_UID });
  await ctx.syncClaimsHandler(deps, { operatorId: OP, uid: CHASE_UID });

  console.log('[seed-emulator] seeding a drive-home job (assigned; Silver Toyota Camry) for the Maestro drive-home flow...');
  await deps.db.doc(P.damage(OP, PRE_REPORT_ID)).set({
    id: PRE_REPORT_ID, operatorId: OP, ticketId: JOB_TID, vehicleSnapshot: { make: 'Toyota', model: 'Camry', color: 'Silver' },
    phase: 'pre_drive', diagramMarks: [], notes: 'Maestro fixture — pre-drive', createdBy: PRIMARY_UID, createdAt: NOW, photoCount: 4,
  });
  await deps.db.doc(P.damage(OP, POST_REPORT_ID)).set({
    id: POST_REPORT_ID, operatorId: OP, ticketId: JOB_TID, vehicleSnapshot: { make: 'Toyota', model: 'Camry', color: 'Silver' },
    phase: 'post_drive', diagramMarks: [], notes: 'Maestro fixture — post-drive', createdBy: PRIMARY_UID, createdAt: NOW, photoCount: 4,
  });
  for (const [reportId, stage] of [[PRE_REPORT_ID, 'pre'] as const, [POST_REPORT_ID, 'post'] as const]) {
    for (let i = 0; i < 4; i++) {
      const photoId = `${stage}-${i}`;
      await deps.db.doc(P.photo(OP, reportId, photoId)).set({
        id: photoId,
        storagePath: `operators/${OP}/tickets/${JOB_TID}/photos/${photoId}.jpg`,
        stage: (['wide', 'medium', 'close', 'diagram'] as const)[i],
        at: NOW,
        actorUid: PRIMARY_UID,
        deviceId: 'maestro-fixture',
        bytes: 250_000,
        width: 1200,
        height: 900,
        sha256: fakeSha256(i + (stage === 'pre' ? 0 : 100)),
      });
    }
  }

  const job = {
    id: JOB_TID,
    operatorId: OP,
    venueId: V1,
    jobType: 'drive_home' as const,
    status: 'assigned' as const,
    source: 'guest_web' as const,
    guest: { phoneE164: '+13175550177', phoneLast4: '0177', consentSms: true, name: 'Drive-Home Guest' },
    vehicle: { make: 'Toyota', model: 'Camry', color: 'Silver' },
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: { primaryDriverUid: PRIMARY_UID, chaseDriverUid: CHASE_UID },
    times: { checkedInAt: NOW, requestedAt: NOW, assignedAt: NOW },
    damageReportIds: [PRE_REPORT_ID, POST_REPORT_ID],
    incidentIds: [],
    guestToken: secretToken(),
    driveHome: {
      destination: { address: '742 Evergreen Terrace, Indianapolis, IN', geo: { lat: 39.79, lng: -86.15 } },
      quote: { base: 2500, distanceMeters: 8046, durationSec: 900, amount: 5750, breakdown: [{ label: 'Base', amount: 2500 }, { label: 'Distance + time', amount: 3250 }] },
      chase: { status: 'pending' as const },
    },
  };
  await deps.db.doc(P.ticket(OP, JOB_TID)).set(job);
}

// Plan 8 Task 15 (white-label): a SECOND operator, `valetb` — the one `goldstar-mobile`'s
// `config/operators/demo.json` (OPERATOR=demo, bundle base com.valetcob.valet) and the dashboard's
// `config/operators/demo.ts` brand as "Valet Co B". Seeded with its own venue and one lead so a
// demo-operator build signs in against the same emulator and sees NONE of goldstar's data —
// which is the whole point of seeding it: multi-tenant isolation is only demonstrable with two
// tenants. Branding here mirrors demo.json exactly (colors, display name, support phone).
const OP_B = 'valetb';
const VB1 = 'vb1';
const LEAD_B_UID = 'leadb1';
const LEAD_B_EMAIL = 'leadb1@valetcob.example.com';

async function seedSecondOperator(
  deps: SeedDeps,
  ctx: { NOW: string; P: PathBuilders; syncClaimsHandler: SyncClaimsHandler },
): Promise<void> {
  const { NOW, P, syncClaimsHandler } = ctx;
  console.log('[seed-emulator] seeding second operator "valetb" (Valet Co B) + venue "vb1" + leadb1 (Plan 8 Task 15)...');
  await deps.db.doc(P.operator(OP_B)).set({
    id: OP_B,
    name: 'Valet Co B',
    slug: OP_B,
    status: 'active',
    timezone: 'America/Indiana/Indianapolis',
    currency: 'USD',
    isSandbox: true,
    plan: 'standard',
    branding: { displayName: 'Valet Co B', primaryColor: '#1d4ed8', accentColor: '#f59e0b', supportPhone: '+15555550100' },
    modules: {
      payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [18, 20, 25], tipPolicy: 'deliverer' },
      messaging: { provider: 'twilio', messagingServiceSid: 'MG_b' },
      scheduling: { provider: 'internal' },
      vision: { provider: 'none' },
      accounting: { provider: 'csv' },
    },
    features: { driveHome: false, passengerRides: false, venuePortals: false, tapToPay: false, plateOcr: false, payouts: false },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'system',
  });
  await deps.db.doc(P.venue(OP_B, VB1)).set({
    id: VB1,
    operatorId: OP_B,
    name: 'Blue Harbor Hotel',
    type: 'hotel',
    status: 'active',
    address: { line1: '1 Harbor Way', city: 'Indianapolis', region: 'IN', postalCode: '46204', country: 'US' },
    geo: { lat: 39.77, lng: -86.16 },
    zones: [{ id: 'A', name: 'Front Drive' }],
    rates: {
      valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 2000 }], taxRateBps: 700, fees: [] },
      driveHome: { base: 2500, perMile: 250, perMinute: 50, minimum: 3900 },
      passengerRide: { base: 1000, perMile: 200, perMinute: 40, minimum: 1500 },
      validations: { allowPartial: true, maxAmount: 2000 },
    },
    sms: {},
    qr: { staticCheckoutEnabled: false },
    pushSlug: 'slug_vb1',
    contract: { model: 'per_ticket', perTicketFee: 250, taxRateBps: 0, terms: '', billingEmail: 'ap@valetcob.example.com', invoiceDay: 1 },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await deps.auth.createUser({ uid: LEAD_B_UID, email: LEAD_B_EMAIL, password: PASSWORD });
  const leadB: User = userSchema.parse({
    operatorId: OP_B,
    status: 'active',
    eligibility: { driveHome: false, passengerRide: false, reasons: [] },
    payoutStatus: 'none',
    fcmTokens: [],
    invitedAt: NOW,
    activatedAt: NOW,
    uid: LEAD_B_UID,
    displayName: 'Lead B',
    email: LEAD_B_EMAIL,
    roles: ['lead'],
    venueIds: [VB1],
  });
  await deps.db.doc(P.user(OP_B, LEAD_B_UID)).set(leadB);
  await syncClaimsHandler(deps, { operatorId: OP_B, uid: LEAD_B_UID });
}


/** Custom-claims assertion that ignores `claimsVersion`: against long-lived emulators the
 * `onUserWritten` trigger syncs claims too, racing the seed's own sync and bumping the version. */
function assertClaims(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>, label: string): void {
  assert.ok(actual, `${label}: no custom claims`);
  const { claimsVersion, ...rest } = actual;
  assert.ok(typeof claimsVersion === 'number' && claimsVersion >= 1, `${label}: claimsVersion missing`);
  assert.deepEqual(rest, expected, `${label} custom claims not synced correctly`);
}

async function main(): Promise<void> {
  const { testDeps, wipe, seedOperator, OP, V1, NOW } = await import('../functions/test/helpers');
  const { syncClaimsHandler } = await import('../functions/src/modules/identity/claims.handler');
  const { P } = await import('../functions/src/lib/paths');

  const deps = testDeps();

  console.log('[seed-emulator] wiping Firestore + Auth emulator state...');
  await wipe(deps);

  console.log('[seed-emulator] seeding operator "goldstar" + venue "v1" (St. Elmo, zone A)...');
  await seedOperator(deps);

  console.log('[seed-emulator] creating staff accounts (att1 attendant, lead1 lead, owner1 owner, platform1 platform_admin)...');
  await deps.auth.createUser({ uid: ATT_UID, email: ATT_EMAIL, password: PASSWORD });
  await deps.auth.createUser({ uid: LEAD_UID, email: LEAD_EMAIL, password: PASSWORD });
  await deps.auth.createUser({ uid: OWNER_UID, email: OWNER_EMAIL, password: PASSWORD });
  await deps.auth.createUser({ uid: PLATFORM_UID, email: PLATFORM_EMAIL, password: PASSWORD });

  const baseUser = {
    operatorId: OP,
    status: 'active' as const,
    eligibility: { driveHome: false, passengerRide: false, reasons: [] },
    payoutStatus: 'none' as const,
    fcmTokens: [],
    invitedAt: NOW,
    activatedAt: NOW,
  };
  const attUser: User = userSchema.parse({
    ...baseUser,
    uid: ATT_UID,
    displayName: 'Att One',
    email: ATT_EMAIL,
    roles: ['attendant'],
    venueIds: [V1],
  });
  const leadUser: User = userSchema.parse({
    ...baseUser,
    uid: LEAD_UID,
    displayName: 'Lead One',
    email: LEAD_EMAIL,
    roles: ['lead'],
    venueIds: [V1],
  });
  const ownerUser: User = userSchema.parse({ ...baseUser, uid: OWNER_UID, displayName: 'Owner One', email: OWNER_EMAIL, roles: ['owner'], venueIds: [V1] });
  const platformUser: User = userSchema.parse({ ...baseUser, uid: PLATFORM_UID, displayName: 'Platform One', email: PLATFORM_EMAIL, roles: ['platform_admin'], venueIds: [] });
  await deps.db.doc(P.user(OP, ATT_UID)).set(attUser);
  await deps.db.doc(P.user(OP, LEAD_UID)).set(leadUser);
  await deps.db.doc(P.user(OP, OWNER_UID)).set(ownerUser);
  await deps.db.doc(P.user(OP, PLATFORM_UID)).set(platformUser);

  console.log('[seed-emulator] syncing custom claims via syncClaimsHandler...');
  await syncClaimsHandler(deps, { operatorId: OP, uid: ATT_UID });
  await syncClaimsHandler(deps, { operatorId: OP, uid: LEAD_UID });
  await syncClaimsHandler(deps, { operatorId: OP, uid: OWNER_UID });
  await syncClaimsHandler(deps, { operatorId: OP, uid: PLATFORM_UID });

  console.log(`[seed-emulator] seeding ${KEY_TAG_COUNT} key tags (${keyTagValue(1)}..${keyTagValue(KEY_TAG_COUNT)})...`);
  const walkupTicketId = deps.newId();
  const walkupKeyTagId = `k${WALKUP_KEY_TAG_INDEX}`;
  for (let n = 1; n <= KEY_TAG_COUNT; n++) {
    const assignedToWalkup = n === WALKUP_KEY_TAG_INDEX;
    const tag: KeyTag = keyTagSchema.parse({
      id: `k${n}`,
      operatorId: OP,
      value: keyTagValue(n),
      venueId: V1,
      status: assignedToWalkup ? 'assigned' : 'available',
      ...(assignedToWalkup ? { currentTicketId: walkupTicketId } : {}),
    });
    await deps.db.doc(P.keyTag(OP, tag.id)).set(tag);
  }

  console.log('[seed-emulator] seeding a `requested` walk-up ticket (Ford) for the claim -> deliver leg...');
  const walkupTicket: Ticket = ticketSchema.parse({
    id: walkupTicketId,
    operatorId: OP,
    venueId: V1,
    jobType: 'valet',
    status: 'requested',
    source: 'staff',
    guest: { phoneE164: '+13175550199', phoneLast4: '0199', consentSms: true },
    vehicle: { make: 'Ford' },
    keyTagId: walkupKeyTagId,
    zoneId: 'A',
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: true, vip: false },
    attendants: { checkedInBy: ATT_UID },
    times: { checkedInAt: NOW, requestedAt: NOW },
    damageReportIds: [],
    incidentIds: [],
    guestToken: secretToken(),
  });
  await deps.db.doc(P.ticket(OP, walkupTicketId)).set(walkupTicket);

  await seedDriveHomeJob(deps, { OP, V1, NOW, P, syncClaimsHandler });
  await seedSecondOperator(deps, { NOW, P, syncClaimsHandler });

  console.log('[seed-emulator] verifying seeded state via the Admin SDK...');
  const [
    operatorSnap, venueSnap, attSnap, leadSnap, attAuth, leadAuth, k1Snap, k2Snap, walkupSnap,
    primaryAuth, chaseAuth, jobSnap, preReportSnap, postReportSnap, prePhotos, postPhotos,
  ] = await Promise.all([
    deps.db.doc(P.operator(OP)).get(),
    deps.db.doc(P.venue(OP, V1)).get(),
    deps.db.doc(P.user(OP, ATT_UID)).get(),
    deps.db.doc(P.user(OP, LEAD_UID)).get(),
    deps.auth.getUser(ATT_UID),
    deps.auth.getUser(LEAD_UID),
    deps.db.doc(P.keyTag(OP, 'k1')).get(),
    deps.db.doc(P.keyTag(OP, walkupKeyTagId)).get(),
    deps.db.doc(P.ticket(OP, walkupTicketId)).get(),
    deps.auth.getUser(PRIMARY_UID),
    deps.auth.getUser(CHASE_UID),
    deps.db.doc(P.ticket(OP, JOB_TID)).get(),
    deps.db.doc(P.damage(OP, PRE_REPORT_ID)).get(),
    deps.db.doc(P.damage(OP, POST_REPORT_ID)).get(),
    deps.db.collection(`operators/${OP}/damageReports/${PRE_REPORT_ID}/photos`).get(),
    deps.db.collection(`operators/${OP}/damageReports/${POST_REPORT_ID}/photos`).get(),
  ]);

  assert.ok(operatorSnap.exists, 'operator doc missing after seed');
  assert.ok(venueSnap.exists, 'venue doc missing after seed');
  assert.ok(attSnap.exists, 'att1 user doc missing after seed');
  assert.ok(leadSnap.exists, 'lead1 user doc missing after seed');
  assertClaims(attAuth.customClaims, { operatorId: OP, roles: ['attendant'], venueIds: [V1] }, 'att1');
  assertClaims(leadAuth.customClaims, { operatorId: OP, roles: ['lead'], venueIds: [V1] }, 'lead1');
  assert.equal(k1Snap.data()?.status, 'available', `${keyTagValue(1)} should stay available for the live check-in step`);
  assert.equal(k2Snap.data()?.status, 'assigned', `${keyTagValue(WALKUP_KEY_TAG_INDEX)} should be pre-assigned to the walk-up ticket`);
  assert.ok(walkupSnap.exists, 'walk-up ticket missing after seed');
  assert.equal(walkupSnap.data()?.status, 'requested', 'walk-up ticket should be seeded in requested status');
  const allKeyTags = await deps.db.collection(`operators/${OP}/keyTags`).get();
  assert.equal(allKeyTags.size, KEY_TAG_COUNT, `expected ${KEY_TAG_COUNT} key tags, found ${String(allKeyTags.size)}`);

  // Plan 5 Task 6 (maestro/drive-home.yaml) fixtures.
  assertClaims(primaryAuth.customClaims, { operatorId: OP, roles: ['driver'], venueIds: [V1] }, 'primary1');
  assertClaims(chaseAuth.customClaims, { operatorId: OP, roles: ['driver'], venueIds: [V1] }, 'chase1');
  assert.ok(jobSnap.exists, 'drive-home job ticket missing after seed');
  const jobView = jobSnap.data() as { status: string; attendants: { primaryDriverUid: string; chaseDriverUid: string }; payment?: unknown };
  assert.equal(jobView.status, 'assigned', 'drive-home job should be seeded already assigned');
  assert.equal(jobView.attendants.primaryDriverUid, PRIMARY_UID, 'drive-home job primaryDriverUid mismatch');
  assert.equal(jobView.attendants.chaseDriverUid, CHASE_UID, 'drive-home job chaseDriverUid mismatch');
  assert.equal(jobView.payment, undefined, 'drive-home job must NOT seed payment (would trigger a live Stripe capture call on Complete)');
  assert.ok(preReportSnap.exists && postReportSnap.exists, 'pre/post drive damage reports missing after seed');
  assert.ok((preReportSnap.data()?.photoCount ?? 0) >= 4, 'pre_drive report photoCount must satisfy the server-side onJobWritten gate');
  assert.ok((postReportSnap.data()?.photoCount ?? 0) >= 4, 'post_drive report photoCount must satisfy the server-side onJobWritten gate');
  assert.ok(prePhotos.size >= 4, 'pre_drive report must have >=4 photos in its OWN subcollection — the client-side hasPreDriveReport gate reads this, not photoCount');
  assert.ok(postPhotos.size >= 4, 'post_drive report must have >=4 photos in its OWN subcollection — the client-side hasPostDriveReport gate reads this, not photoCount');

  // Plan 8 Task 15: the second tenant exists and its lead's claims pin it to valetb, not goldstar.
  const [opBSnap, vb1Snap, leadBAuth] = await Promise.all([
    deps.db.doc(P.operator(OP_B)).get(),
    deps.db.doc(P.venue(OP_B, VB1)).get(),
    deps.auth.getUser(LEAD_B_UID),
  ]);
  const [ownerAuth, platformAuth] = await Promise.all([deps.auth.getUser(OWNER_UID), deps.auth.getUser(PLATFORM_UID)]);
  assertClaims(ownerAuth.customClaims, { operatorId: OP, roles: ['owner'], venueIds: [V1] }, 'owner1');
  // buildClaims omits `venueIds` when empty (claims.handler.ts) — a platform admin holds none.
  assertClaims(platformAuth.customClaims, { operatorId: OP, roles: ['platform_admin'] }, 'platform1');
  assert.ok(opBSnap.exists && vb1Snap.exists, 'valetb operator/venue missing after seed');
  assertClaims(leadBAuth.customClaims, { operatorId: OP_B, roles: ['lead'], venueIds: [VB1] }, 'leadb1');

  console.log('[seed-emulator] OK — operator, venue, att1/lead1 (claims synced), 20 key tags, the Ford walk-up ticket, and the primary1/chase1 drive-home job (both inspection reports pre-qualified) are all verified in the emulator.');
}

main().catch((e: unknown) => {
  console.error('[seed-emulator] failed:', e);
  process.exit(1);
});
