/**
 * Owner-demo seed: the base emulator seed (seed-emulator.ts, unchanged) plus a demo layer that
 * puts realistic data behind EVERY page of the staff app, guest app, operator dashboard, venue
 * portal and guest web pages. The demo layer is built by the pure, unit-tested builders in
 * scripts/demo/ (dataset.test.ts checks every document against its schema and that every state
 * is represented); this file only writes it into running emulators and verifies the result.
 *
 * Run against LONG-LIVED emulators (Functions included, so triggers build the guest-ticket and
 * venue-pay projections, and the emulator-only demo providers in functions/.env.demo-goldstar
 * answer plate OCR, SMS/email, hotel PMS and POS):
 *
 *   npm run emulators                 # terminal 1 (project demo-goldstar, offset 0)
 *   npm run seed:demo                 # terminal 2
 *
 * Every timestamp is relative to "now", so re-seed before each demo; the base seed wipes Firestore
 * and Auth first, so re-running never duplicates anything.
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
process.env.GCLOUD_PROJECT ??= process.env.GOLDSTAR_EMU_PROJECT_ID ?? 'demo-goldstar';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_WALKUP_VEHICLE, DEMO_PASSWORD, GUEST_PHONE, OP } from './demo/constants';
import { buildDemoDataset } from './demo/dataset';
import { EVENT_CHECKOUT_TOKEN } from './demo/places';
import type { DemoAuthUser, SeedDoc } from './demo/types';
// Type-only: erased at compile time, so it does not trigger functions/src/lib/app.ts's
// initializeApp() before the emulator env vars above are set (same pattern as seed-emulator.ts).
import type { Deps } from '../functions/src/lib/deps';

/** The base seed pins its timestamps here (functions/test/helpers.ts NOW); the demo re-times them. */
const BASE_SEED_NOW = '2026-08-23T21:00:00.000Z';
const BATCH_LIMIT = 400;
/** Triggers (projections, claims sync, job gates) run asynchronously after each write. */
const TRIGGER_SETTLE_MS = 8_000;

/** This package is ESM (no __dirname); resolve sibling files from the module URL. */
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

const log = (msg: string): void => {
  console.log(`[seed-demo] ${msg}`);
};

/**
 * Storage buckets the apps read in the emulator. The dashboard's e2e/dev config uses
 * <project>.appspot.com; the mobile dev placeholder plist uses <project>.firebasestorage.app.
 * Uploading to both keeps photos visible in every surface.
 */
function demoBuckets(projectId: string): string[] {
  return [`${projectId}.appspot.com`, `${projectId}.firebasestorage.app`];
}

function runBaseSeed(): void {
  log('running the base emulator seed (wipes Firestore + Auth, then seeds the fixtures the Maestro/e2e flows rely on)...');
  const result = spawnSync('npx', ['tsx', join(SCRIPTS_DIR, 'seed-emulator.ts')], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`base seed failed (exit ${String(result.status)})`);
}

async function main(): Promise<void> {
  runBaseSeed();

  const { testDeps } = await import('../functions/test/helpers');
  const { syncClaimsHandler } = await import('../functions/src/modules/identity/claims.handler');
  const deps = testDeps();
  const projectId = process.env.GCLOUD_PROJECT ?? 'demo-goldstar';
  const dataset = buildDemoDataset(new Date());

  log(`creating ${dataset.authUsers.length} demo accounts...`);
  for (const u of dataset.authUsers) await upsertAuthUser(deps.auth, u);

  log(`writing ${dataset.docs.length} documents in trigger-safe order...`);
  await writeDocs(deps.db, dataset.docs);

  // Staff claims come from the user docs, exactly as for base-seed staff (operatorId, roles,
  // venueIds, claimsVersion). onUserWritten would also sync them; doing it here means the accounts
  // are usable the moment this script finishes.
  for (const u of dataset.authUsers) {
    if (u.operatorId) await syncClaimsHandler(deps, { operatorId: u.operatorId, uid: u.uid });
  }

  log(`uploading ${dataset.storage.length} photos to ${demoBuckets(projectId).join(' and ')}...`);
  for (const bucketName of demoBuckets(projectId)) {
    const bucket = deps.storage.bucket(bucketName);
    for (const obj of dataset.storage) {
      await bucket.file(obj.path).save(readFileSync(join(SCRIPTS_DIR, 'demo', 'photos', obj.source)), { contentType: obj.contentType, resumable: false });
    }
  }

  await retimeBaseTickets(deps.db);

  log(`waiting ${TRIGGER_SETTLE_MS / 1000}s for triggers to settle...`);
  await new Promise((r) => setTimeout(r, TRIGGER_SETTLE_MS));
  await verify(deps, dataset.expectedTicketStatuses, dataset.refs.guestActiveToken, projectId, dataset.authUsers);

  log('OK. Demo logins (emulator only), password is the seed PASSWORD:');
  for (const uid of ['owner1', 'admin1', 'lead1', 'att1', 'primary1', 'venue1', 'hotel1', 'platform1']) log(`  ${uid}@goldstar.example.com`);
  log(`  guest app: phone ${GUEST_PHONE} (Auth emulator code at http://127.0.0.1:9099/emulator/v1/projects/${projectId}/verificationCodes)`);
  log(`  guest ticket page: /t/${dataset.refs.guestActiveToken}   static pay page: /pay/${EVENT_CHECKOUT_TOKEN}`);
}

async function upsertAuthUser(auth: Deps['auth'], u: DemoAuthUser): Promise<void> {
  const props = {
    displayName: u.displayName,
    ...(u.email ? { email: u.email, password: DEMO_PASSWORD } : {}),
    ...(u.phoneNumber ? { phoneNumber: u.phoneNumber } : {}),
  };
  try {
    await auth.createUser({ uid: u.uid, ...props });
  } catch (e: unknown) {
    if ((e as { code?: string }).code !== 'auth/uid-already-exists') throw e;
    await auth.updateUser(u.uid, props);
  }
  if (u.claims) await auth.setCustomUserClaims(u.uid, u.claims);
}

async function writeDocs(db: Deps['db'], docs: SeedDoc[]): Promise<void> {
  // One kind at a time (docs arrive already ordered by orderForWrite), so a kind's triggers see
  // everything it depends on.
  let i = 0;
  while (i < docs.length) {
    const kind = docs[i]?.kind;
    const batch = db.batch();
    let n = 0;
    while (i < docs.length && docs[i]?.kind === kind && n < BATCH_LIMIT) {
      const d = docs[i];
      if (d) batch.set(db.doc(d.path), d.data);
      i++;
      n++;
    }
    await batch.commit();
  }
}

/**
 * The base seed's walk-up Ford (requested) and drive-home job (assigned) carry 2026-08-23
 * timestamps, which made the queue read "61d waiting". Shift them to "just now", keeping status,
 * ids and everything the Maestro flows assert on.
 */
async function retimeBaseTickets(db: Deps['db']): Promise<void> {
  const snap = await db.collection(`operators/${OP}/tickets`).where('times.checkedInAt', '==', BASE_SEED_NOW).get();
  const now = Date.now();
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();
  for (const doc of snap.docs) {
    const data = doc.data() as { times?: Record<string, string>; vehicle?: { make?: string; plate?: string } };
    const times = data.times ?? {};
    const shifted: Record<string, string> = {};
    // checkedInAt 75 min ago, requestedAt 1 min ago (fresh SLA), any job milestones a few
    // minutes apart in the order they were recorded.
    Object.keys(times).forEach((key, i) => {
      shifted[key] = at(key === 'checkedInAt' ? 75 : key === 'requestedAt' ? 1 : 30 - i * 3);
    });
    // The walk-up names only its make; give it a full car (see BASE_WALKUP_VEHICLE).
    const bareWalkup = data.vehicle?.make === BASE_WALKUP_VEHICLE.make && data.vehicle.plate === undefined;
    await doc.ref.update({ times: shifted, ...(bareWalkup ? { vehicle: { ...data.vehicle, ...BASE_WALKUP_VEHICLE } } : {}) });
  }
  log(`re-timed ${snap.size} base-seed ticket(s) to the current time.`);
}

async function verify(deps: Deps, expected: Record<string, string>, guestToken: string, projectId: string, authUsers: DemoAuthUser[]): Promise<void> {
  // 1. No trigger reverted or advanced a seeded state (e.g. the drive-home photo gates).
  const drift: string[] = [];
  for (const [path, status] of Object.entries(expected)) {
    const snap = await deps.db.doc(path).get();
    const actual = (snap.data() as { status?: string } | undefined)?.status;
    if (actual !== status) drift.push(`${path}: expected ${status}, found ${String(actual)}`);
  }
  assert.deepEqual(drift, [], `triggers changed seeded ticket states:\n${drift.join('\n')}`);

  // 2. Staff claims and the phone guest's claims are in place.
  for (const u of authUsers) {
    const user = await deps.auth.getUser(u.uid);
    if (!u.operatorId) {
      assert.deepEqual(user.customClaims?.roles, ['guest'], `${u.uid} is missing the guest role claim`);
      continue;
    }
    // syncClaimsHandler deliberately strips a suspended user's operator claim (they can no longer
    // sign in to staff surfaces), so the suspended demo persona must have NONE.
    const userDoc = (await deps.db.doc(`operators/${u.operatorId}/users/${u.uid}`).get()).data() as { status?: string } | undefined;
    const status = userDoc?.status;
    if (status === 'suspended') assert.equal(user.customClaims?.operatorId, undefined, `${u.uid} is suspended but still has an operator claim`);
    else assert.equal(user.customClaims?.operatorId, u.operatorId, `${u.uid} has no operator claim`);
  }

  // 3. Trigger-built projections exist (they need the Functions emulator to be running).
  const [guestTicket, venuePublic] = await Promise.all([deps.db.doc(`guestTickets/${guestToken}`).get(), deps.db.doc(`venuePublic/${EVENT_CHECKOUT_TOKEN}`).get()]);
  if (!guestTicket.exists || !venuePublic.exists) {
    throw new Error('guest-ticket / venue-pay projections are missing: is the Functions emulator running (npm run emulators, not seed:emulator)?');
  }

  // 4. Photos are readable in both buckets.
  for (const bucketName of demoBuckets(projectId)) {
    const [files] = await deps.storage.bucket(bucketName).getFiles({ prefix: `operators/${OP}/` });
    assert.ok(files.length > 0, `no demo photos found in ${bucketName}`);
  }
  log(`verified ${Object.keys(expected).length} ticket states, ${authUsers.length} accounts, both projections and photo storage.`);
}

main().catch((e: unknown) => {
  console.error('[seed-demo] failed:', e);
  process.exit(1);
});
