import type { Role } from '@goldstar/platform';
import { err } from '../../lib/errors.js';
import type { ExternalShift, ProviderContext, ScheduleProvider, SyncResult } from './port.js';
import { PermanentPushError } from './port.js';

export { PermanentPushError };

const LOGIN_URL = 'https://api.login.wheniwork.com/login';
const API_BASE = 'https://api.wheniwork.com';

/**
 * Ruling BC (fix round 2): matches `ToastPos.TIMEOUT_MS` exactly — an unbounded fetch to an
 * external API can hang a Cloud Function until the platform kills it, burning the retry budget on
 * one stuck call and delaying every subsequent punch. Exported so `pushClock.ts`'s claim TTL can
 * be DERIVED from this bound rather than guessed independently — see that file's own doc comment
 * for the worst-case chain this number feeds into.
 */
export const TIMEOUT_MS = 10_000;

interface WhenIWorkConfig {
  locationId: string;
  workplaceUserId?: string;
  venueMap: Record<string, string>;
  roleMap: Record<string, Role>;
}

function readConfig(config: Record<string, unknown>): WhenIWorkConfig {
  const workplaceUserId = config.workplaceUserId as string | undefined;
  return {
    locationId: config.locationId as string,
    ...(workplaceUserId ? { workplaceUserId } : {}),
    venueMap: (config.venueMap as Record<string, string> | undefined) ?? {},
    roleMap: (config.roleMap as Record<string, Role> | undefined) ?? {},
  };
}

/**
 * A raw shift object as returned by `GET /2/shifts` (⚠️ UNVERIFIED response shape — see the class
 * doc comment). Only the fields this adapter reads are typed.
 */
export interface WiwRawShift {
  id: number;
  user_id: number;
  location_id: number;
  position_id: number | null;
  site_id: number | null;
  /** RFC-2822-style, e.g. `"Mon, 08 May 2023 08:30:00 -0600"` — confirmed parseable by JS's
   * native `Date` constructor (verified against the real format, not assumed). */
  start_time: string;
  end_time: string;
  is_open?: boolean;
  notes?: string | null;
}

/**
 * Maps raw `/2/shifts` rows to `ExternalShift`s. Pure and network-free so the mapping logic
 * (the genuinely-new part of this task — see the class doc comment) is directly testable.
 *
 * Two DIFFERENT unmapped-config outcomes, disclosed design decision:
 * - An unmapped `site_id` (no `venueMap` entry) means Goldstar has NO IDEA which venue this shift
 *   belongs to — the shift is unrepresentable and is DROPPED entirely, reported into `errors`.
 * - An unmapped (or null) `position_id` (no `roleMap` entry) means the SHIFT is still real and
 *   belongs to a known venue — it is kept with `assignments: []` (the same "report, don't drop"
 *   doctrine `ical.adapter.ts`'s `matchBy: 'name'` and `upsertExternalShifts`'s unmatched-user
 *   handling both already use), reported into `errors` separately from the venue case.
 *
 * An `is_open` shift (unassigned — no one is scheduled onto it yet) is skipped silently: there is
 * nothing yet for Goldstar to represent, and reporting it as an "error" would be noise on every
 * sync for every operator's normal, unremarkable open shifts.
 */
export function mapWiwShifts(raw: WiwRawShift[], config: { venueMap: Record<string, string>; roleMap: Record<string, Role> }): { shifts: ExternalShift[]; errors: string[] } {
  const shifts: ExternalShift[] = [];
  const errors: string[] = [];

  for (const s of raw) {
    if (s.is_open) continue;

    const venueId = s.site_id !== null ? config.venueMap[String(s.site_id)] : undefined;
    if (!venueId) {
      errors.push(`unmapped site_id ${s.site_id} on shift ${s.id}`);
      continue;
    }

    const role = s.position_id !== null ? config.roleMap[String(s.position_id)] : undefined;
    if (!role) errors.push(`unmapped position_id ${s.position_id} on shift ${s.id}`);

    const start = new Date(s.start_time);
    const end = new Date(s.end_time);
    shifts.push({
      externalId: String(s.id),
      venueId,
      date: start.toISOString().slice(0, 10),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      assignments: role ? [{ externalUserId: String(s.user_id), role }] : [],
      ...(s.notes ? { notes: s.notes } : {}),
    });
  }

  return { shifts, errors };
}

/**
 * `WhenIWorkScheduleProvider` (Plan 7 Task 4). Rulings I and Z bind this adapter:
 *
 * - **Ruling I**: no webhook. The webhook signing scheme was never confirmed by Context7 (see
 *   `external-api-contracts.md` §3, "Context7 could NOT answer") — building `handleWebhook` would
 *   mean inventing an auth scheme, the exact incident the project notes already records.
 *   This adapter is polling (`sync`, via the existing `syncAllOperators` 15-minute schedule) plus
 *   an outbound clock push (`pushClockEvent`) only. `handleWebhook` is deliberately NOT
 *   implemented.
 * - **Ruling Z**: `GET /2/shifts`'s exact query-parameter names and `POST /2/times`'s exact body
 *   shape are UNCONFIRMED (`external-api-contracts.md` W2/W3) — built behind the port against the
 *   most plausible shape from the confirmed FILTER DIMENSIONS (`location_id`, `start`, `end` for
 *   shifts; `user_id`/a time reference for the push), exercised only through the injected
 *   `fetchFn` in tests, and marked `⚠️ UNVERIFIED (Ruling Z)` at each call site. No fixture FILES
 *   are recorded for either call (`test/fixtures/wheniwork/` does not exist) — a fixture is a
 *   frozen assertion, and freezing an unconfirmed contract would make a green suite misleading.
 *
 * Login (`POST https://api.login.wheniwork.com/login`, header `W-Key`, body `{email, password}`)
 * and the multi-workplace resolution (`GET /2/login?show_pending=true`) ARE built for real: both
 * are CONFIRMED shapes (manifest.ts's own comment, itself sourced from Context7 at the time the
 * `when_i_work` manifest entry was added) — not gated by Ruling Z.
 *
 * Token extraction is DEFENSIVE (disclosed residual uncertainty, same risk class as Ruling Z's two
 * gated calls even though no ruling named it explicitly): Context7 could describe the login
 * response only as "a person object containing a token", never a concrete field path. This probes
 * several plausible paths (`login.token`, `user.token`, `person.token`, a bare `token`) rather than
 * assuming one, and fails loudly (a reported error, not a thrown exception — mirroring every other
 * `sync()` failure mode) if none match.
 *
 * No token cache: unlike `ToastPos` (module-level cache, Ruling J — called repeatedly within one
 * host's check-lookup burst), this adapter is invoked at most once per operator per 15-minute sync
 * tick, or once per clock event push. A disclosed simplification, not an oversight — caching would
 * add state and a staleness bug surface for no measurable benefit at this call frequency.
 */
export class WhenIWorkScheduleProvider implements ScheduleProvider {
  kind = 'when_i_work';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /**
   * Ruling BC — matches `ToastPos`'s own `AbortController`/`TIMEOUT_MS` pattern exactly. Every
   * network call in this adapter goes through this, not `this.fetchFn` directly, so none of them
   * can hang the Cloud Function past `TIMEOUT_MS`. An abort surfaces as an ordinary `Error` (never
   * `PermanentPushError`) — a timeout is a blip, not a credential problem, and classifying it
   * permanent would stop retrying exactly when retrying is the correct response.
   */
  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`wheniwork request timed out after ${TIMEOUT_MS}ms: ${url}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractToken(body: unknown): string | undefined {
    const b = body as Record<string, unknown> | null;
    const candidates = [
      (b?.login as Record<string, unknown> | undefined)?.token,
      (b?.user as Record<string, unknown> | undefined)?.token,
      (b?.person as Record<string, unknown> | undefined)?.token,
      b?.token,
    ];
    const found = candidates.find((c) => typeof c === 'string' && c.length > 0);
    return found as string | undefined;
  }

  /**
   * Login + (when `workplaceUserId` isn't configured) multi-workplace resolution. Both confirmed
   * shapes — not Ruling-Z-gated. Returns the bearer token and the resolved `W-UserID` (if any).
   *
   * The error variant carries `permanent` (fix round 1, M1): `sync()` ignores it (a `SyncResult`
   * error is reported either way), but `pushClockEvent` needs it to pick `PermanentPushError` vs.
   * an ordinary `Error` — a login 401 (rotated/revoked credentials) is the single most common
   * LASTING failure this adapter will see, and before this fix it always threw the ordinary,
   * transient-classified `provider_unavailable`, so a bad credential retried silently to
   * exhaustion with nothing ever landing on `lastError`/`health`. Classification mirrors
   * `pushClockEvent`'s own response handling: 429/5xx transient, any other non-200 permanent — the
   * no-token-found and ambiguous-workplace cases are both permanent too, since neither can resolve
   * differently on a retry against the same credentials/config.
   *
   * Fix round 2 (Ruling BC): both fetches now go through `fetchWithTimeout`, and BOTH are wrapped
   * in a try/catch that converts a thrown network/timeout failure into this same `{error,
   * permanent}` return shape — `permanent: false`, since a blip is not a credential problem.
   * Before this, a thrown error from either fetch propagated straight out of `login()` uncaught,
   * which `sync()` and `healthCheck()` both silently assumed could never happen (they only ever
   * branch on `'error' in login`) — adding the timeout WITHOUT this fix would have introduced a
   * new uncaught-rejection path into two callers that were never built to expect one.
   */
  private async login(ctx: ProviderContext, config: WhenIWorkConfig): Promise<{ token: string; workplaceUserId?: string } | { error: string; permanent: boolean }> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'W-Key': ctx.secret('developerKey') },
        body: JSON.stringify({ email: ctx.secret('username'), password: ctx.secret('password') }),
      });
    } catch (e) {
      return { error: (e as Error).message, permanent: false };
    }
    if (res.status !== 200) {
      const permanent = !(res.status === 429 || res.status >= 500);
      return { error: `wheniwork login failed: HTTP ${res.status}`, permanent };
    }
    const token = this.extractToken(await res.json());
    if (!token) return { error: 'wheniwork login response carried no recognizable token', permanent: true };

    if (config.workplaceUserId) return { token, workplaceUserId: config.workplaceUserId };

    // Manifest's disclosed design (see the `when_i_work` entry's own comment): single-workplace
    // accounts omit `workplaceUserId`; the adapter resolves the sole entry itself, erroring only
    // when it finds more than one and none is configured. A network/timeout failure on this
    // OPTIONAL lookup degrades the same way a non-200 already does — proceed with the token alone,
    // no W-UserID — rather than failing the whole login over an enhancement.
    let pendingRes: Response;
    try {
      pendingRes = await this.fetchWithTimeout(`${API_BASE}/2/login?show_pending=true`, { headers: { 'W-Token': token } });
    } catch {
      return { token };
    }
    if (pendingRes.status !== 200) return { token };
    const pending = (await pendingRes.json()) as { users?: { id: number }[] };
    const users = pending.users ?? [];
    if (users.length === 0) return { token };
    if (users.length > 1) return { error: `wheniwork: ambiguous workplace (${users.length} found) — set workplaceUserId in config`, permanent: true };
    return { token, workplaceUserId: String(users[0]!.id) };
  }

  /**
   * ⚠️ UNVERIFIED (Ruling Z) — `GET /2/shifts`'s exact query-parameter names are not confirmed,
   * only the filter dimensions (`location_id`, and a start/end pair — named `start`/`end` here as
   * the most plausible guess, unconfirmed). Response ENVELOPE (`{shifts:[...], total, ...}`) is
   * better-sourced but the live round-trip as a whole is still unverified end-to-end.
   */
  async sync(ctx: ProviderContext, range: { from: string; to: string }): Promise<SyncResult> {
    const config = readConfig(ctx.config);
    const login = await this.login(ctx, config);
    if ('error' in login) return { upserted: 0, errors: [login.error], shifts: [] };

    const headers: Record<string, string> = { 'W-Token': login.token };
    if (login.workplaceUserId) headers['W-UserID'] = login.workplaceUserId;

    try {
      const url = new URL(`${API_BASE}/2/shifts`);
      url.searchParams.set('location_id', config.locationId);
      url.searchParams.set('start', range.from);
      url.searchParams.set('end', range.to);
      const res = await this.fetchWithTimeout(url.toString(), { headers });
      if (res.status !== 200) return { upserted: 0, errors: [`wheniwork shifts fetch failed: HTTP ${res.status}`], shifts: [] };
      const body = (await res.json()) as { shifts?: WiwRawShift[] } | WiwRawShift[];
      const raw = Array.isArray(body) ? body : (body.shifts ?? []);
      const { shifts, errors } = mapWiwShifts(raw, config);
      return { upserted: 0, errors, shifts };
    } catch (e) {
      return { upserted: 0, errors: [(e as Error).message], shifts: [] };
    }
  }

  /**
   * ⚠️ UNVERIFIED (Ruling Z) — `POST /2/times`'s body shape is not confirmed at all; only that
   * `/2/times` is the times/clock-records resource. Built from the confirmed filter dimensions
   * (`user_id`) plus the obvious fields a clock push needs (which shift, what kind of punch,
   * when) — best-guess shape, no fixture recorded.
   *
   * Throws `PermanentPushError` (Ruling AQ(b)) when `externalUserId` is missing — no WIW mapping
   * exists for this Goldstar user, which retrying can never fix — or on a non-429 4xx response
   * (bad credentials/malformed request). Any other failure (429, 5xx, network) throws an ordinary
   * `Error` so the caller's static retry fires.
   */
  async pushClockEvent(ctx: ProviderContext, e: { shiftExternalId: string; uid: string; externalUserId?: string; type: string; at: string }): Promise<void> {
    if (!e.externalUserId) throw new PermanentPushError(`no wheniwork externalUserId mapped for uid ${e.uid}`);
    const config = readConfig(ctx.config);
    const login = await this.login(ctx, config);
    if ('error' in login) {
      if (login.permanent) throw new PermanentPushError(login.error);
      throw err('provider_unavailable', login.error);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'W-Token': login.token };
    if (login.workplaceUserId) headers['W-UserID'] = login.workplaceUserId;

    // A thrown network/timeout failure here propagates uncaught — already correctly transient
    // (never PermanentPushError), matching every other blip this method treats as retryable.
    const res = await this.fetchWithTimeout(`${API_BASE}/2/times`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: e.externalUserId, shift_id: e.shiftExternalId, type: e.type, time: e.at }),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`wheniwork times push failed: HTTP ${res.status}`);
    if (res.status >= 400) throw new PermanentPushError(`wheniwork times push failed: HTTP ${res.status}`);
  }

  async healthCheck(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const config = readConfig(ctx.config);
    const login = await this.login(ctx, config);
    if ('error' in login) return { ok: false, message: login.error };
    return { ok: true };
  }
}
