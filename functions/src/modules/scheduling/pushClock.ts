import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';
import { operatorSchema, type ClockEvent, type Shift } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { getScheduleProvider } from './registry.js';
import { PermanentPushError } from './port.js';
import { TIMEOUT_MS } from './wheniwork.adapter.js';

export interface ClockEventCreateEvent {
  operatorId: string;
  shiftId: string;
  eventId: string;
  event: ClockEvent;
  /** The CloudEvent's own `.time` (ISO) — when the triggering write actually happened, per the
   * CloudEvents spec ("when this event occurred", confirmed against firebase-functions' own
   * `CloudEvent` type declaration). Stable across a retry redelivery of the SAME event, unlike any
   * field read off the document itself — this is what the age-based give-up (fix round 1, M1) is
   * measured against. */
  occurredAt: string;
}

/**
 * Ruling AQ(b) / fix round 1, M1 — two SEPARATE thresholds for two SEPARATE decisions, split per
 * review feedback rather than conflated into one number:
 *
 * - `REPORT_AFTER_MS` (~2 minutes) is what makes "a failure that keeps failing must surface on the
 *   integration doc" hold EARLY — reported once a transient error has survived past an ordinary
 *   few-seconds retry cycle, but still RETHROWN so the trigger keeps retrying. Visibility costs
 *   nothing (the status self-clears on the NEXT SCHEDULED SYNC — `syncOperator`'s 15-minute run
 *   unconditionally overwrites `health`; a push's own success never writes `health` itself, so
 *   recovery is on that order, not the next successful punch) and this guarantee does NOT depend
 *   on knowing the platform's actual retry window.
 * - `GIVE_UP_AFTER_MS` (1 hour) is what stops an infinite retry loop — by this point it's already
 *   reported, and retrying further buys nothing.
 *
 * **The platform's actual maximum retry duration for a boolean `retry: true` Firestore trigger is
 * UNCONFIRMED** — `firebase-functions`' own docs publish one for `onSchedule`'s separate,
 * fine-grained retry config, but not for this boolean flag. That is exactly WHY reporting is split
 * off from giving up: if the real window turns out shorter than `GIVE_UP_AFTER_MS`, the report at
 * `REPORT_AFTER_MS` has already fired and nothing dies silently — the guarantee doesn't wait on a
 * number nobody can currently size.
 */
const REPORT_AFTER_MS = 2 * 60 * 1000;
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;

async function reportPersistentFailure(deps: Deps, operatorId: string, message: string): Promise<void> {
  await deps.db
    .doc(P.integration(operatorId, 'when_i_work'))
    .set({ lastError: message.slice(0, 300), lastErrorAt: deps.now(), health: { ok: false } }, { merge: true });
}

/**
 * Admin-SDK-only fields on the clockEvent doc — NOT part of the published `clockEventSchema`,
 * read back through this local shape. Written by THIS handler only. Same precedent as
 * `pos/applyValidation.ts`'s own `PosPushFields`/`posPush` (transcribed, not redesigned — see
 * `claimPush`'s own doc comment).
 */
interface PushClaimFields {
  pushClaim?: { status: 'pending' | 'pushed' | 'failed'; at: string };
}

/**
 * Ruling BC / fix round 2, N1 (the reviewer's nit, upgraded to a fix): the push is claimed
 * TRANSACTIONALLY before it is ever attempted, mirroring `pos/applyValidation.ts`'s own
 * `posPush {status,at}` pattern — this IS that mechanism, transcribed, not a new design. Without
 * it, two overlapping deliveries of the SAME create event (platform-driven overlapping
 * redelivery — not the user-reachable double-click race POS's version closes) would both pass the
 * earlier, non-transactional `pushedToProviderAt` read and both call the provider, double-punching
 * the timesheet.
 *
 * `PUSH_CLAIM_TTL_MS`'s worst-case chain, spelled out because the next person changing a timeout
 * needs to see what depends on it: `pushClockEvent` in `wheniwork.adapter.ts` chains up to THREE
 * sequential `fetchWithTimeout` calls — the login POST, the optional multi-workplace GET (when
 * `workplaceUserId` isn't configured), and the `/2/times` POST itself — each bounded by that
 * file's own `TIMEOUT_MS`. `3 * TIMEOUT_MS` = 30s worst case. The TTL gives that the SAME ~3x
 * headroom `lib/providerClaim.ts`'s shared `PROVIDER_CLAIM_TTL_MS` gives its own ~20s (2-call)
 * worst case, scaled up for the extra call: `3 * 30s` = 90s. A `pending` claim younger than this
 * is genuinely in-flight (refuse — the duplicate delivery backs off); one older is a crash (admit
 * the retry).
 *
 * NOT folded into `PROVIDER_CLAIM_TTL_MS` — same principle (transacted claim, TTL from a bounded
 * operation), different value for a different reason (a 3-call chain, not 2). `lib/providerClaim.ts`'s
 * own doc comment already names `pushClock.ts`'s retry-reporting thresholds as deliberate
 * non-members; this is the second, symmetric half of that same boundary — a claim TTL that
 * legitimately differs, not one that was merely never noticed.
 */
const PUSH_CLAIM_TTL_MS = 3 * (3 * TIMEOUT_MS);

/**
 * `'claimed'` — no prior claim (or a resolved `'failed'` one): an ordinary attempt, first try or a
 * genuinely-known-failed retry, nothing unknowable about it.
 * `'claimed-stale-retry'` — a `'pending'` claim existed but outlived `PUSH_CLAIM_TTL_MS`: the
 * earlier attempt crashed, but WHETHER its own external call reached WIW before it died is
 * unknowable (no idempotency key on their side to check) — see Ruling BE at the call site.
 * `'in-flight'` / `'already-done'` — don't push at all.
 */
type ClaimResult = 'claimed' | 'claimed-stale-retry' | 'in-flight' | 'already-done';

async function claimPush(deps: Deps, ref: DocumentReference): Promise<ClaimResult> {
  return deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.data() as (ClockEvent & PushClaimFields) | undefined;
    if (data?.pushedToProviderAt) return 'already-done'; // belt-and-suspenders against the earlier plain read's own small race window
    const claim = data?.pushClaim;
    if (claim?.status === 'pending') {
      const claimAgeMs = Date.parse(deps.now()) - Date.parse(claim.at);
      if (claimAgeMs < PUSH_CLAIM_TTL_MS) return 'in-flight'; // genuinely in-flight elsewhere — back off, don't double-push
      txn.update(ref, { pushClaim: { status: 'pending', at: deps.now() } });
      return 'claimed-stale-retry';
    }
    txn.update(ref, { pushClaim: { status: 'pending', at: deps.now() } });
    return 'claimed';
  });
}

/**
 * `onClockEventCreated` — Plan 7 Task 4, Ruling AQ. Pushes a clock punch to When I Work when the
 * operator has it configured to receive them. Precedent for shape: `tipPool.ts`'s `onShiftWritten`
 * (`onDocumentCreated`/`onDocumentWritten`-style thin trigger delegating to a directly-testable
 * handler; `retry: true`; idempotent writes).
 *
 * ## Gating order (cheapest checks first, each an unconditional silent return — never a thrown
 * error for "not configured", matching Ruling AC's doctrine `syncOperator` already follows for
 * `provider === 'internal'`):
 *
 * 1. **Correction sentinel** (Ruling AQ(c)) — `correctClockHandler` stamps `deviceId:
 *    'dashboard-correction'` on every event it writes. `correctClock.ts`'s own endpoint is
 *    unverified (Ruling Z doesn't cover it, but no amendment endpoint has been confirmed either),
 *    so an unfiltered push would send a correction as a SECOND punch rather than an amendment,
 *    corrupting payroll data. Corrected times need MANUAL reconciliation in WIW until an amendment
 *    endpoint is verified — this is also recorded on the external-gate list (task-4-report.md).
 * 2. **Idempotency marker** (Ruling AQ(b)) — `pushedToProviderAt` already set means a prior
 *    invocation already pushed this event successfully; a retried invocation of THIS trigger must
 *    not double-push the same punch. **Read fresh from the doc, never from `e.event`** (fix round
 *    1, H1): `onDocumentCreated`'s payload is the CREATION-time snapshot, bound to the triggering
 *    write — a retry redelivers that identical payload, and `pushedToProviderAt` is written by
 *    THIS SAME handler strictly AFTER that snapshot was captured (a partial failure — the push
 *    succeeded but the stamp write or the audit call after it then failed — is exactly the case
 *    this gate exists to protect), so the payload can never carry it on any invocation, first or
 *    retried. Every other marker in this codebase is read fresh from Firestore for exactly this
 *    reason; this was the one that wasn't.
 * 3. **Provider/pushClock gate** (Ruling AQ(a)) — read the operator's scheduling config, merged
 *    with the `when_i_work` integration doc's own config exactly the way `syncOperator` builds its
 *    own `ctx.config` (the integration doc is genuinely where `pushClock` lives per the manifest's
 *    `when_i_work` schema — the operator-level `modules.scheduling.config` is a smaller override
 *    base, same relationship `sync.ts` already has). Return silently unless the provider is
 *    `when_i_work` AND the merged config's `pushClock` is `true`.
 * 4. **Shift-source gate** (a necessary precondition Ruling AQ's text didn't explicitly name,
 *    disclosed rather than assumed): a clock event's shift might be an `internal`-sourced shift
 *    even while the operator's ACTIVE provider is `when_i_work` (historical or manually-created
 *    shifts) — there is no WIW-side shift to reference for `shiftExternalId` in that case, so
 *    nothing can be pushed. Silent return, not an error, for the same "not configured for this"
 *    reason as the other gates.
 *
 * ## Permanent vs. transient (Ruling AQ(b), corrected in fix round 1 — M1)
 *
 * `ScheduleProvider.pushClockEvent` throws `PermanentPushError` for a failure retrying can never
 * fix (bad credentials, malformed request, no WIW user mapping) — caught here, reported onto the
 * integration doc's `lastError`/`health` (mirroring `syncOperator`'s own catch-and-report shape),
 * NOT rethrown, immediately.
 *
 * Any OTHER error (network, 5xx, rate-limit) propagates so the trigger's own static `retry: true`
 * fires — but NOT forever silently. Ruling AQ(b), stated precisely: **a failure that keeps failing
 * must surface on the integration doc regardless of its class.** Measured from `occurredAt` (the
 * CloudEvent's own `.time` — stable across every redelivery of the same event, unlike anything read
 * off the document), a transient error past `REPORT_AFTER_MS` is reported onto `lastError`/`health`
 * but STILL rethrown (retries continue); past `GIVE_UP_AFTER_MS` it's reported again and swallowed
 * instead of rethrown. Under `REPORT_AFTER_MS`, nothing is reported yet — writing on every
 * few-seconds retry cycle would make `health.ok` flicker false on hiccups a retry is about to
 * resolve on its own. See the constants' own doc comment for why these are two numbers, not one.
 *
 * `pushedToProviderAt` is stamped ONLY after `pushClockEvent` resolves without throwing.
 */
export async function pushClockEventHandler(deps: Deps, e: ClockEventCreateEvent): Promise<void> {
  if (e.event.deviceId === 'dashboard-correction') return;

  const clockEventRef = deps.db.doc(P.clockEvent(e.operatorId, e.shiftId, e.eventId));
  const currentEventSnap = await clockEventRef.get();
  const currentEvent = currentEventSnap.data() as ClockEvent | undefined;
  if (currentEvent?.pushedToProviderAt) return;

  // L1: schema-validated, log-and-skip — matching onClaimWritten.ts's own convention — rather than
  // an unguarded cast. A malformed (or missing) operator doc would otherwise throw a raw
  // TypeError, uncaught, inside a `retry: true` trigger: a silent infinite retry loop that
  // compounds M1's "failures must surface" requirement rather than satisfying it.
  const opSnap = await deps.db.doc(P.operator(e.operatorId)).get();
  const parsedOp = operatorSchema.safeParse(opSnap.data());
  if (!parsedOp.success) {
    console.error('onClockEventCreated: operator schema parse failed', { operatorId: e.operatorId, eventId: e.eventId });
    return;
  }
  const op = parsedOp.data;
  if (op.modules.scheduling.provider !== 'when_i_work') return;

  const integSnap = await deps.db.doc(P.integration(e.operatorId, 'when_i_work')).get();
  const integ = integSnap.data() as { config?: Record<string, unknown>; secretRef?: string } | undefined;
  const config = { ...(op.modules.scheduling.config ?? {}), ...(integ?.config ?? {}) };
  if (config.pushClock !== true) return;

  const shiftSnap = await deps.db.doc(P.shift(e.operatorId, e.shiftId)).get();
  const shift = shiftSnap.data() as Shift | undefined;
  if (!shift || shift.source.provider !== 'when_i_work' || !shift.source.externalId) return;

  const userSnap = await deps.db.doc(P.user(e.operatorId, e.event.uid)).get();
  const externalUserId = (userSnap.data() as { externalIds?: Record<string, string> } | undefined)?.externalIds?.['when_i_work'];

  const ctx = { deps, operatorId: e.operatorId, config, secret: (n: string) => deps.secrets.get(`${integ?.secretRef ?? e.operatorId.toUpperCase()}_${n}`) };
  const provider = getScheduleProvider('when_i_work');
  if (!provider.pushClockEvent) return; // defensive — when_i_work always implements it; the port makes it optional for providers with no push capability

  // N1: claim BEFORE attempting — see claimPush's own doc comment. Placed after every gate above
  // so a claim field is never written onto an event that doesn't even qualify for a push.
  const claimResult = await claimPush(deps, clockEventRef);
  if (claimResult === 'in-flight' || claimResult === 'already-done') return;
  if (claimResult === 'claimed-stale-retry') {
    // Ruling BE: the earlier (crashed) attempt's own outcome is unknowable — WIW has no
    // idempotency key to check whether its external call landed before it died. Pushing anyway is
    // right (the common case is it genuinely didn't land), but doing so SILENTLY turns an
    // unknowable state into an INVISIBLE duplicate. Report before attempting, regardless of how
    // this retry itself turns out, so a human can go verify and delete a duplicate if one exists.
    await reportPersistentFailure(
      deps,
      e.operatorId,
      `wheniwork clock push: retrying event ${e.eventId} (shift ${e.shiftId}) after a stale in-flight claim — a previous attempt may have succeeded before we recorded it. Verify this punch in When I Work.`,
    );
  }

  try {
    await provider.pushClockEvent(ctx, {
      shiftExternalId: shift.source.externalId,
      uid: e.event.uid,
      ...(externalUserId ? { externalUserId } : {}),
      type: e.event.type,
      at: e.event.at,
    });
  } catch (thrown) {
    // N1: release the claim to 'failed' on EVERY failure exit, including the still-retrying
    // transient case below — not just the terminal ones. Otherwise a legitimate Eventarc retry
    // (which usually happens within seconds) would be blocked behind its own prior 'pending'
    // claim until PUSH_CLAIM_TTL_MS expires, defeating retry for no reason. Best-effort: a failure
    // to write this must not mask the real error being classified/reported/rethrown below.
    await clockEventRef.update({ pushClaim: { status: 'failed', at: deps.now() } }).catch(() => {});

    if (thrown instanceof PermanentPushError) {
      await reportPersistentFailure(deps, e.operatorId, thrown.message);
      return;
    }
    // M1: report/give-up split (see the constants' own doc comment for why these are two numbers).
    const ageMs = Date.parse(deps.now()) - Date.parse(e.occurredAt);
    if (ageMs > REPORT_AFTER_MS) {
      const stillRetrying = ageMs <= GIVE_UP_AFTER_MS;
      const message = stillRetrying
        ? `wheniwork clock push still failing after ${Math.round(ageMs / 60_000)}min, still retrying — last error: ${(thrown as Error).message}`
        : `wheniwork clock push retried for over ${Math.round(GIVE_UP_AFTER_MS / 60_000)}min without success, giving up — last error: ${(thrown as Error).message}`;
      await reportPersistentFailure(deps, e.operatorId, message);
      if (!stillRetrying) return;
    }
    throw thrown; // propagate so the trigger's static retry: true fires
  }

  await clockEventRef.update({ pushedToProviderAt: deps.now(), pushClaim: { status: 'pushed', at: deps.now() } });
  await audit(deps, {
    operatorId: e.operatorId,
    actorUid: 'system',
    action: 'scheduling.pushClockEvent',
    target: e.eventId,
    after: { shiftId: e.shiftId, type: e.event.type },
  });
}

export const onClockEventCreated = onDocumentCreated({ document: 'operators/{op}/shifts/{shiftId}/clockEvents/{eventId}', retry: true }, async (event) => {
  const data = event.data?.data() as ClockEvent | undefined;
  if (!data) return;
  await pushClockEventHandler(makeDeps(), {
    operatorId: event.params.op,
    shiftId: event.params.shiftId,
    eventId: event.params.eventId,
    event: data,
    occurredAt: event.time,
  });
});
