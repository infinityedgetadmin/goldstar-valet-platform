import { INTEGRATION_MANIFEST, PlatformError, type CallableOutput, type CallableParsedInput, type Operator, type Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { getScheduleProvider } from '../scheduling/registry.js';
import { getPms } from '../pms/registry.js';
import { getPos } from '../pos/registry.js';

const NOT_IMPLEMENTED_MESSAGE = 'health check not implemented for this provider yet';

/**
 * Fix round (Rulings AV/AC/AW): the PMS and POS branches, replacing the old blanket
 * not-implemented fallback for both modules.
 *
 * **Ruling AC** — the third state ("not configured") comes from the VENUE DOC, not the provider.
 * `getPms`/`getPos` already encode "absence of `venue.pms`/`venue.pos`" as their own
 * `failed_precondition` rejection (registry.ts's own doc comments) — that IS the ground truth, so
 * it's caught here and mapped 1:1 to a non-error result rather than re-deriving "configured?" from
 * a second source.
 *
 * **Ruling AW** — the probe goes through `getPms`/`getPos` DIRECTLY, never a hand-rolled generic
 * secret context. `getPos` resolves its own secretRef/keys internally (`toast_{venueId}` →
 * `{secretRef}_CLIENT_ID` etc.) — reusing the SCHEDULING branch's generic `ctx`-building pattern
 * here would read a DIFFERENT (and wrong) key shape than what production calls actually use,
 * silently manufacturing a health signal that doesn't match reality. Calling the registry function
 * itself is the only way the probe is guaranteed to read what production reads.
 *
 * **Ruling AV** (`pmsResult` only) — a PMS check can NEVER report `ok:false`. Ruling H: no live
 * PMS adapter exists (`MockPmsProvider` is the only implementation, never constructed in
 * production), so `getPms` returning at all — let alone a real failure — is not reachable in the
 * shipped code today. Any rejection that ISN'T the known "not configured" one still degrades to a
 * non-error result rather than `ok:false`, deliberately, not just for the one cause known today —
 * reporting "broken" for a platform limitation would be exactly the meaningless-red machine this
 * ruling exists to forbid. If `getPms` ever DOES resolve to a real provider (a live OPERA adapter
 * lands), that provider's own `healthCheck()` result passes through unmodified — the prohibition
 * targets manufactured red, not a real adapter's real answer.
 */
async function pmsResult(deps: Deps, operatorId: string, venue: Venue): Promise<{ ok: boolean; message?: string }> {
  try {
    const provider = await getPms(deps, operatorId, venue);
    return await provider.healthCheck();
  } catch (e) {
    if (e instanceof PlatformError && e.code === 'failed_precondition') return { ok: true, message: 'pms not configured for this venue' };
    return { ok: true, message: 'pms health check not yet available (no live adapter)' };
  }
}

/** POS, unlike PMS, has a real live adapter (Toast) — Ruling AV does not apply here. A genuine
 * failure (bad credentials, Toast itself down) IS reportable; only "not configured" is not. */
async function posResult(deps: Deps, operatorId: string, venue: Venue): Promise<{ ok: boolean; message?: string }> {
  try {
    const provider = await getPos(deps, operatorId, venue);
    return await provider.healthCheck();
  } catch (e) {
    if (e instanceof PlatformError && e.code === 'failed_precondition') return { ok: true, message: 'pos not configured for this venue' };
    return { ok: false, message: e instanceof PlatformError ? e.message : 'pos health check failed' };
  }
}

/**
 * Task 8/9 (task-89-report.md): `integrationsHealthCheck` was in the installed v0.3.8 contract
 * (`src/callables.ts`) with no Functions handler wired to it — this fills that gap.
 *
 * ## Role gate: mirrors `auditQuery`'s exactly, not `integrationsSetSecret`'s
 *
 * Ruling (task-8-brief.md controller note, carried into the brief this task executes): "health
 * check = inspect → platform_admin exemption per auditQuery". This is a read-only inspection (it
 * never moves money, never mutates config/secrets — only ever writes back a `health` status), so it
 * follows `auditQuery`'s two-part gate exactly: owner/admin/platform_admin may call it (wider than
 * `integrationsSetSecret`'s owner+platform_admin-only), and an assumed platform_admin session
 * (`roles: ['platform_admin', 'admin']`) is exempt from the active-operator gate — the same
 * "inspecting a suspended operator before deciding whether to reactivate it" case Ruling C-2 covers.
 *
 * ## Per-provider coverage: honest, not optimistic
 *
 * `scheduling`'s `internal` adapter, `pms` (`opera_cloud`), and `pos` (`toast`) now each have a
 * real branch — see `pmsResult`/`posResult`'s own doc comments for Rulings AV/AC/AW. Everything
 * else — `PaymentGateway` (stripe), `MessagingProvider` (twilio), `MapsProvider` (mapbox) have no
 * `healthCheck` method at all; `plate_recognizer` (vision) and `quickbooks_online`/`csv`
 * (accounting) have no adapter module yet (Plan 7/8 territory); `ical`/`when_i_work` (scheduling)
 * ARE real manifest entries but no registered `ScheduleProvider` — still gets the same honest
 * `{ ok: false, message: 'health check not implemented for this provider yet' }`, disclosed rather
 * than claimed as a real check.
 *
 * The "not configured" / "not yet available" THIRD state (Ruling AC/AV) is represented WITHIN the
 * existing boolean `ok` — `ok: true` paired with an explanatory `message` — rather than a new
 * output field, since `integrationsHealthCheck`'s contract (`src/callables.ts`, outside this
 * module) is `{ok: boolean, message?: string}` with no room for a third enum value. `true` reads
 * as "non-error" (nothing is broken), which is the correct badge color for both a genuinely
 * healthy check AND a not-applicable one; the message text is what distinguishes them, the same
 * way the ORIGINAL (wrong) implementation already relied on message text to carry this distinction
 * — this fix keeps that mechanism, only corrects which boolean value it's paired with. A real
 * contract change (an explicit third enum state) is a bigger, disclosed follow-up, not taken here
 * — flagged to the controller rather than done silently, since `src/callables.ts` sits outside
 * `modules/integrations/`.
 */
export async function integrationsHealthCheckHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'integrationsHealthCheck'>,
): Promise<CallableOutput<'integrationsHealthCheck'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'platform_admin'].includes(r))) throw err('permission_denied');
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  const manifestEntry = INTEGRATION_MANIFEST.find((m) => m.id === input.provider);
  if (!manifestEntry) throw err('invalid_argument', 'unknown provider'); // unreachable — provider is already INTEGRATION_IDS-narrowed by the zod input schema
  if (input.venueId && manifestEntry.scope !== 'venue') throw err('invalid_argument', 'provider is not venue-scoped');
  if (!input.venueId && manifestEntry.scope === 'venue') throw err('invalid_argument', 'venueId is required for this provider');

  const docId = input.venueId ? `${input.provider}_${input.venueId}` : input.provider;
  const integ = (await deps.db.doc(P.integration(c.operatorId, docId)).get()).data() as
    | { config?: Record<string, unknown>; secretRef?: string }
    | undefined;

  let result: { ok: boolean; message?: string };
  if (manifestEntry.module === 'scheduling') {
    try {
      const provider = getScheduleProvider(input.provider);
      // sync.ts's syncOperator builds its ctx.config the same way (`{ ...op.modules.scheduling.config,
      // ...integ.config }`) — but it's only ever called for `op.modules.scheduling.provider` itself, so
      // that merge is unconditionally correct there. Here `input.provider` can be ANY scheduling
      // manifest id, not just the operator's currently-active one — `operator.modules.scheduling.config`
      // is that ONE active provider's config, not a per-provider map, so it only belongs in the merge
      // when we're actually testing the active provider. Otherwise it would leak the active provider's
      // config into a health check for a different, inactive one.
      const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator;
      const moduleConfig = input.provider === op.modules.scheduling.provider ? (op.modules.scheduling.config ?? {}) : {};
      const ctx = {
        deps,
        operatorId: c.operatorId,
        config: { ...moduleConfig, ...(integ?.config ?? {}) },
        secret: (n: string) => deps.secrets.get(`${integ?.secretRef ?? c.operatorId.toUpperCase()}_${n}`),
      };
      result = await provider.healthCheck(ctx);
    } catch {
      // getScheduleProvider throws for a real-but-unregistered kind (ical/when_i_work) — not a
      // handler bug, just an adapter that doesn't exist yet. Honest, not thrown further.
      result = { ok: false, message: NOT_IMPLEMENTED_MESSAGE };
    }
  } else if (manifestEntry.module === 'pms' || manifestEntry.module === 'pos') {
    // `input.venueId` is guaranteed present here — both pms/pos manifest entries are
    // `scope: 'venue'`, already enforced by the venueId-required check above.
    const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId!)).get()).data() as Venue | undefined;
    if (!venue) throw err('not_found', 'venue');
    result = manifestEntry.module === 'pms' ? await pmsResult(deps, c.operatorId, venue) : await posResult(deps, c.operatorId, venue);
  } else {
    result = { ok: false, message: NOT_IMPLEMENTED_MESSAGE };
  }

  // m1 (final whole-branch review): a successful "Test connection" must NOT stamp `lastSyncAt` — this
  // handler never syncs anything, and borrowing sync.ts's WRITE SHAPE (`health`/`lastError*`) doesn't
  // mean borrowing its semantics too. Doing so let the card's "last synced" report a time when no
  // sync actually ran. Admin SDK write — bypasses firestore.rules' client-side lock on these fields.
  await deps.db.doc(P.integration(c.operatorId, docId)).set(
    {
      health: { ok: result.ok, ...(result.message ? { message: result.message } : {}) },
      ...(result.ok ? {} : { lastError: result.message ?? 'health check failed', lastErrorAt: deps.now() }),
    },
    { merge: true },
  );

  return result;
}

export const integrationsHealthCheck = defineCallable('integrationsHealthCheck', {}, integrationsHealthCheckHandler);
