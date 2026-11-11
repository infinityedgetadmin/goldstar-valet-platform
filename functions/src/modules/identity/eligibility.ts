import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { DocumentReference } from 'firebase-admin/firestore';
import type { Credentials, Eligibility, PlatformConfig, Role } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { managerUidsFor } from '../notifications/topics.js';

/**
 * Pure eligibility rule (task-6-brief.md, given verbatim — modulo the schema-truth reconciliation
 * disclosed in task-6-report.md: the brief's own snippet already matches `credentialsSchema` /
 * `eligibilitySchema` field-for-field, so no adaptation was needed).
 *
 * `driveHome` requires the `driver` role, an unexpired license, an unexpired insurance policy, and
 * an approved background check. `passengerRide` additionally requires every operator-configured ride
 * endorsement (`platform/config.rideEndorsements`, default `[]`) to be present on the user's
 * `endorsements` — but only gets its OWN reason (`missing_ride_endorsement`) when every driveHome
 * check already passed; a driver failing driveHome never also fails passengerRide for the same
 * missing endorsement (that would double-count the same underlying gaps as two different reasons).
 * "Expiring within 1 day" counts as already expired (`soon`, not `now`) — a credential that lapses
 * mid-shift shouldn't have shown as eligible when the shift started.
 */
export function computeEligibility(u: { roles: Role[]; credentials?: Partial<Credentials> }, now: string, rideEndorsements: string[] = []): Eligibility {
  const reasons: string[] = [];
  const c = u.credentials ?? {};
  const soon = new Date(Date.parse(now) + 86_400_000).toISOString();
  if (!u.roles.includes('driver')) reasons.push('missing_driver_role');
  if (!c.licenseExpiresAt) reasons.push('license_missing');
  else if (c.licenseExpiresAt < soon) reasons.push('license_expired');
  if (!c.insuranceExpiresAt) reasons.push('insurance_missing');
  else if (c.insuranceExpiresAt < soon) reasons.push('insurance_expired');
  if (c.backgroundCheck?.status !== 'approved') reasons.push('background_not_approved');
  const base = reasons.length === 0;
  const rideOk = base && rideEndorsements.every((e) => (c.endorsements ?? []).includes(e));
  if (base && !rideOk) reasons.push('missing_ride_endorsement');
  return { driveHome: base, passengerRide: rideOk, reasons };
}

interface UserDoc {
  roles: Role[];
  credentials?: Partial<Credentials>;
  eligibility?: Eligibility;
  status?: string;
  displayName?: string;
}

async function rideEndorsementsFrom(deps: Deps): Promise<string[]> {
  const snap = await deps.db.doc('platform/config').get();
  return (snap.data() as PlatformConfig | undefined)?.rideEndorsements ?? [];
}

/**
 * Recomputes and writes ONE user's `eligibility` via the Admin SDK (bypasses `firestore.rules`'
 * `unchanged(['eligibility', ...])` client-write lock — this is the only writer of that field).
 * Called from `onUserWritten` (`claims.ts`) whenever `roles`/`credentials` changed, and from the
 * daily `recomputeEligibility` sweep below. A no-op write is skipped so re-running this against an
 * already-correct doc never re-triggers `onUserWritten` for nothing.
 */
export async function recomputeEligibilityHandler(deps: Deps, e: { operatorId: string; uid: string }): Promise<void> {
  const ref = deps.db.doc(P.user(e.operatorId, e.uid));
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data() as UserDoc;
  const rideEndorsements = await rideEndorsementsFrom(deps);
  // exactOptionalPropertyTypes: conditional spread (not `credentials: d.credentials` directly) — an
  // optional field must be OMITTED when absent, not explicitly set to `undefined` (repo convention,
  // e.g. checkout.ts's CheckoutInput construction).
  const eligibility = computeEligibility({ roles: d.roles, ...(d.credentials !== undefined ? { credentials: d.credentials } : {}) }, deps.now(), rideEndorsements);
  if (JSON.stringify(eligibility) === JSON.stringify(d.eligibility)) return;
  await ref.update({ eligibility });
}

const EXPIRY_THRESHOLDS = [30, 7, 1] as const;
type ExpiryField = 'license' | 'insurance';

function daysUntil(dateIso: string, now: string): number {
  return Math.ceil((Date.parse(dateIso) - Date.parse(now)) / 86_400_000);
}

/**
 * Enqueues an expiry warning through two pipelines: a topic push per venue and one
 * `outboundMessages` doc per active admin (`channel: 'email'` — `messaging/sender.ts`'s
 * `sendOutboundHandler` explicitly skips non-`'sms'` channel docs; per that file's own comment this
 * is Plan 4b's dashboard email sender's queue to consume, not this repo's).
 *
 * PUSH TARGET (notification fix round, ruled): this used to publish to `admins_{operatorId}` —
 * a topic with ZERO subscribers anywhere (swept all three repos: mobile's `registerFcmToken`
 * subscribes only `venue_{op}_{venueId}` and `leads_{op}_{venueId}`; the dashboard subscribes to
 * no FCM topics; nothing server-side subscribes), so every send "succeeded" into the void and no
 * human was ever told a driver's credential is lapsing. It now targets the ONLY manager-reaching
 * topic family that exists: `leads_{op}_{venueId}` — which is venue-scoped by the mobile
 * subscription's own design (a manager subscribes with an active venue), so an operator-scoped
 * credential expiry FANS OUT to every venue's leads topic; a manager on shift anywhere hears it.
 * Reaching on-shift managers is strictly better than reaching no one. The durable surface —
 * a dashboard row that persists until resolved, plus email — is the real fix and is carried as a
 * Plan 8 item; the email leg below already covers admins durably in the meantime.
 *
 * Deterministic ids (`credential_{uid}_{field}_{days}[_{venueId}]`) + `.create()` + swallow
 * `ALREADY_EXISTS` (code 6) — this repo's universal dedupe convention (`incident.handler.ts`,
 * `push.ts`'s `smsFallback`) — so a redelivered/re-run sweep never double-notifies for the same
 * user/field/threshold-day.
 */
async function notifyExpiring(deps: Deps, e: { operatorId: string; uid: string; displayName: string; field: ExpiryField; expiresAt: string }): Promise<boolean> {
  const days = daysUntil(e.expiresAt, deps.now());
  if (!(EXPIRY_THRESHOLDS as readonly number[]).includes(days)) return false;
  const swallowExists = (err: unknown) => {
    if ((err as { code?: number }).code !== 6) throw err;
  };
  const pushId = `credential_${e.uid}_${e.field}_${days}`;
  const data: Record<string, string> = { operatorId: e.operatorId, uid: e.uid, displayName: e.displayName, field: e.field, days: String(days) };
  // Plan 8 Task 12 (carry #15): delivered PER MANAGER UID — every active owner/admin/lead of the
  // operator, once each. This replaces Ruling BL's fan-out to every venue's `leads_` topic (which
  // reached a lead at three venues three times and, being a topic, could be joined by any app
  // instance that read a venue doc) and closes Ruling BM's deferred scoping question the simple way:
  // credential expiry is operator-wide compliance, so its audience is the operator's managers.
  const uids = await managerUidsFor(deps, e.operatorId, null);
  await Promise.all(
    uids.map((uid) =>
      deps.db
        .doc(`pushEvents/${pushId}_${uid}`)
        .create({ id: `${pushId}_${uid}`, operatorId: e.operatorId, ticketId: '', kind: 'credential.expiring', data, toUid: uid, status: 'queued', createdAt: deps.now() })
        .catch(swallowExists),
    ),
  );

  const admins = await deps.db.collection(`operators/${e.operatorId}/users`).where('roles', 'array-contains-any', ['owner', 'admin']).where('status', '==', 'active').get();
  await Promise.all(
    admins.docs
      // M1 (final whole-branch review): `notificationPrefs.emailCredentials` was written by the
      // settings page (T8) but never read by any sender — the toggle was a placebo. Absent (field
      // never set, or the whole `notificationPrefs` object never written) defaults to on, matching
      // every admin's behavior before the settings page existed.
      .filter((a) => (a.data() as { notificationPrefs?: { emailCredentials?: boolean } }).notificationPrefs?.emailCredentials !== false)
      .map((a) => {
        const admin = a.data() as { email: string };
        const id = `${pushId}_${a.id}`;
        return deps.db
          .doc(P.outbound(id))
          .create({
            id,
            channel: 'email',
            operatorId: e.operatorId,
            template: 'credentialExpiring',
            to: admin.email,
            vars: { displayName: e.displayName, field: e.field, days, expiresAt: e.expiresAt },
            status: 'queued',
            attempts: 0,
            createdAt: deps.now(),
          })
          .catch(swallowExists);
      }),
  );
  return true;
}

type SweepUser = UserDoc & { operatorId: string; uid: string };
type SweepTxResult = { kind: 'missing' } | { kind: 'inactive' } | { kind: 'unchanged'; data: SweepUser } | { kind: 'recomputed'; data: SweepUser };

/**
 * Fix round 1 (task-6-review.md Major 1): the OLD version computed eligibility from `d.data()` — the
 * `collectionGroup('users')` query's own snapshot, taken once at the START of the sweep — then wrote
 * `eligibility` unconditionally, with no re-check against the document's CURRENT state. A concurrent
 * `onUserWritten`-driven recompute (a real credential edit landing between the sweep's query and this
 * document's turn in the loop) could get silently clobbered by the sweep's later write of its own
 * now-stale computation — and because the sweep's write only touches `eligibility` (not
 * `roles`/`credentials`), `onUserWritten`'s own guard would never re-trigger a correction; the stale
 * value would persist until the NEXT day's sweep.
 *
 * Fixed by moving the read inside a transaction: `tx.get(d.ref)` re-reads the document's state
 * immediately before this attempt's write, and Firestore's optimistic concurrency control detects a
 * conflicting write that lands between this transaction's read and its commit, automatically retrying
 * the whole callback (so a retry always recomputes from FRESH data) — same mechanism, same testing
 * convention (a real concurrent `Promise.all`, not a synthetic hook) as `generateKeyTags.ts`'s
 * transactional numbering fix (task-5-review.md M1). If every retry attempt (the SDK's default is 5)
 * still can't land a consistent write, the `catch` below counts it `skipped` rather than throwing —
 * fail-safe: the next scheduled sweep run, or (far more likely) the very edit that's still racing this
 * one, already has or will have its own fresh-read `recomputeEligibilityHandler` write the correct
 * value, so silently skipping this document for one pass is strictly safer than either crashing the
 * whole sweep or committing a stale write.
 */
async function sweepOneUser(deps: Deps, ref: DocumentReference, rideEndorsements: string[]): Promise<SweepTxResult> {
  return deps.db.runTransaction(async (tx): Promise<SweepTxResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'missing' };
    const data = snap.data() as SweepUser;
    if (data.status !== 'active') return { kind: 'inactive' }; // changed since the query ran — not this sweep's concern
    const eligibility = computeEligibility({ roles: data.roles, ...(data.credentials !== undefined ? { credentials: data.credentials } : {}) }, deps.now(), rideEndorsements);
    if (JSON.stringify(eligibility) === JSON.stringify(data.eligibility)) return { kind: 'unchanged', data };
    tx.update(ref, { eligibility });
    return { kind: 'recomputed', data: { ...data, eligibility } };
  });
}

/**
 * Daily sweep (task-6-brief.md): recomputes `eligibility` for every active user across every
 * operator, and fires 30/7/1-day expiry warnings for license/insurance. `collectionGroup('users')`
 * needs the `COLLECTION_GROUP`-scope `status` index added to `firestore.indexes.json` alongside this
 * change (mirrors `archive.ts`/`refund.ts`'s own added collection-group indexes for the same reason).
 * `backgroundCheck`/`endorsements` have no expiry DATE on the schema (status-only, array-only) so
 * they're excluded from the expiry-warning half — `computeEligibility` still catches a
 * never-approved/rejected background check via `background_not_approved`, just not as a
 * countdown-to-expiry warning.
 *
 * Expiry notifications also read from the transaction's OWN fresh `data` (see `sweepOneUser`), not
 * the outer query snapshot — the same staleness risk Major 1 fixed for `eligibility` applies equally
 * to notifying off a credential value that's already been superseded by a concurrent edit.
 */
export async function recomputeEligibilitySweep(deps: Deps): Promise<{ recomputed: number; notified: number; skipped: number }> {
  const rideEndorsements = await rideEndorsementsFrom(deps);
  const q = await deps.db.collectionGroup('users').where('status', '==', 'active').get();
  let recomputed = 0;
  let notified = 0;
  let skipped = 0;
  for (const d of q.docs) {
    let result: SweepTxResult;
    try {
      result = await sweepOneUser(deps, d.ref, rideEndorsements);
    } catch {
      skipped++;
      continue;
    }
    if (result.kind === 'missing' || result.kind === 'inactive') continue;
    if (result.kind === 'recomputed') recomputed++;

    const data = result.data;
    // `expiresAt` is a required (union-with-undefined) key here, not an optional one — sidesteps
    // exactOptionalPropertyTypes without needing a conditional spread for a value checked immediately below.
    const fields: { field: ExpiryField; expiresAt: string | undefined }[] = [
      { field: 'license', expiresAt: data.credentials?.licenseExpiresAt },
      { field: 'insurance', expiresAt: data.credentials?.insuranceExpiresAt },
    ];
    for (const f of fields) {
      if (!f.expiresAt) continue;
      const sent = await notifyExpiring(deps, { operatorId: data.operatorId, uid: data.uid, displayName: data.displayName ?? 'A staff member', field: f.field, expiresAt: f.expiresAt });
      if (sent) notified++;
    }
  }
  return { recomputed, notified, skipped };
}

export const recomputeEligibility = onSchedule({ schedule: 'every day 04:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await recomputeEligibilitySweep(makeDeps());
});
