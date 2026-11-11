import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { callables, type CallableName, type CallableOutput, type CallableParsedInput, type Operator, type Role } from '@goldstar/platform';
import { makeDeps, type Deps } from './deps.js';
import { err, toHttpsError } from './errors.js';
import { P } from './paths.js';

export interface Caller {
  uid: string;
  operatorId?: string;
  roles: Role[];
  venueIds: string[];
  phone?: string;
  ip?: string;
  /** Plan 8 Task 10 (#9, audit M3): minted by identity/assume.ts on a platform admin's assumed token. */
  assumed?: boolean;
  /** ms since epoch — the same field and comparison firestore.rules' notExpiredAssumption() uses. */
  assumedUntil?: number;
}

export function callerFrom(req: CallableRequest<unknown>, opts: { allowAnonymous?: boolean } = {}): Caller | null {
  if (!req.auth) {
    if (opts.allowAnonymous) return null;
    throw err('unauthenticated');
  }
  const t = req.auth.token as Record<string, unknown>;
  const operatorId = typeof t.operatorId === 'string' ? t.operatorId : undefined;
  const phone = typeof t.phone_number === 'string' ? t.phone_number : undefined;
  const ip = req.rawRequest.ip;
  const assumed = t.assumed === true ? true : undefined;
  const assumedUntil = typeof t.assumedUntil === 'number' ? t.assumedUntil : undefined;
  return {
    uid: req.auth.uid,
    roles: Array.isArray(t.roles) ? (t.roles as Role[]) : [],
    venueIds: Array.isArray(t.venueIds) ? (t.venueIds as string[]) : [],
    ...(operatorId !== undefined ? { operatorId } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(ip !== undefined ? { ip } : {}),
    ...(assumed !== undefined ? { assumed } : {}),
    ...(assumedUntil !== undefined ? { assumedUntil } : {}),
  };
}

/**
 * Plan 8 Task 10 (#9, security audit M3): the callable-side half of the rules' notExpiredAssumption().
 * identity/assume.ts mints a platform admin an operator-scoped token with `assumed: true` and a one-hour
 * `assumedUntil`; firestore.rules and storage.rules both hard-stop direct writes at that instant, but
 * callables run on the Admin SDK and never saw the field — an assumed token stayed money-capable for
 * the token's full TTL. Called once, in defineCallable, so every callable honours the window without
 * each one remembering to (unlike requireActiveOperator, which has no shared choke point).
 *
 * An assumed token with NO assumedUntil is treated as expired: assume.ts always writes both, so a
 * token carrying `assumed` without a bound is malformed, and a guard that fails open on a missing
 * field is the shape this audit exists to catch.
 */
export function rejectExpiredAssumption(c: Caller | null, nowMs: number): void {
  if (!c?.assumed) return;
  if (c.assumedUntil === undefined || c.assumedUntil <= nowMs) throw err('permission_denied', 'assumption expired');
}

/**
 * Resolves the caller's IP from a raw HTTPS callable request, independent of
 * `callerFrom`/`Caller` — added (Task 5 fix round 1, Ruling J) after a truthy
 * anonymous-caller stub broke `identityAcceptInvitation`'s `if (caller)`
 * branch-selection (see task-5-review.md, C1). `callerFrom` is reverted to
 * its exact original null-returning behavior for `allowAnonymous` + no auth;
 * callables that need an IP for unauthenticated callers (e.g.
 * `guestStaticCheckout`'s per-IP rate limit) get it from this instead,
 * threaded through `Deps.callerIp` by `defineCallable` below — never from
 * `Caller`. (Not a new handler parameter: see `Deps.callerIp`'s own comment
 * for why a generically-threaded 4th argument doesn't work here.)
 *
 * Ruling K: `CallableRequest.rawRequest` is a plain `express.Request`
 * (`firebase-functions`'s own `Request` interface just extends
 * `express.Request`, adding `rawBody` — see
 * `node_modules/firebase-functions/lib/common/providers/https.d.ts`).
 * Express's own `req.ip` getter (`node_modules/express/lib/request.js`)
 * only honors `X-Forwarded-For` when the app's `trust proxy` setting is
 * configured; it defaults to `false` (`express/lib/application.js`:
 * `this.set('trust proxy', false)`), and neither `firebase-functions`'s v2
 * https provider nor this repo configures it — confirmed by grepping both
 * for any `trust proxy`/`app.set` call and finding none. The actual Express
 * server Gen 2 Cloud Functions run inside
 * (`@google-cloud/functions-framework`) is injected at deploy time and
 * isn't present in this repo's `node_modules`, so whether IT sets `trust
 * proxy` could not be verified from source here.
 *
 * Cloud Run's front end (which Gen 2 Cloud Functions run on) terminates the
 * client TLS connection and forwards to the container over an internal
 * hop. Reading `X-Forwarded-For` directly sidesteps the unverified Express
 * trust-proxy question above: the header is present on the wire regardless
 * of whether the app trusts it for `req.ip` purposes.
 *
 * **Fix round 2 (Ruling N) — corrects a wrong claim from fix round 1.**
 * That version took the FIRST (leftmost) entry, on the claim that GCP
 * "prepends" the client's real IP there. That's backwards, and exploitable:
 * GCP's documented behavior (Cloud Load Balancing / Cloud Run) is to
 * APPEND exactly two entries — `<real-client-ip>, <load-balancer-ip>` — to
 * the END of whatever `X-Forwarded-For` value the client itself sent. The
 * client fully controls every entry before those last two. Taking the
 * leftmost entry therefore returns attacker-chosen junk whenever a client
 * sends a fabricated header with a fake first entry — trivially defeating
 * `static:${ip}`'s 10-per-10-minute cap, since a fresh fabricated prefix
 * buckets into a fresh rate-limit key every single request.
 *
 * Fixed: with 2+ comma-separated entries, take the SECOND-FROM-LAST — the
 * real client IP GCP appended. The LAST entry is GCP's own load-balancer
 * IP; anything the client prepended shifts further left as more hops are
 * added and can never land in the second-from-last slot, no matter how
 * many junk entries it sends. A single-entry header (or no header at all)
 * can't be trusted as proxy-appended at all — GCP's own two entries would
 * make it 2+ — so that case falls back to `rawRequest.ip` instead of
 * trusting client-supplied content outright.
 *
 * `rawRequest.ip` itself is genuinely correct in the fallback case: the
 * local Functions emulator has no proxy in front of it at all, so
 * `x-forwarded-for` is genuinely unset there and the request really does
 * originate at `req.socket.remoteAddress` (127.0.0.1/::1), which `req.ip`
 * reads directly with no trust-proxy dependency either way.
 *
 * **The second-from-last position is GCP's documented behavior, not
 * something observed firsthand from this environment** (no network access
 * to a deployed function here) — recommend confirming by logging
 * `rawRequest.headers['x-forwarded-for']` against a real browser request
 * once deployed (task-5-review.md's M2 finding, still open).
 */
export function ipFrom(rawRequest: CallableRequest<unknown>['rawRequest']): string | undefined {
  const raw = rawRequest.headers['x-forwarded-for'];
  // Normalizes both possible header shapes (a single comma-joined string, or — defensively, since
  // the type allows it — an array of header lines, each itself possibly comma-joined) into one
  // ordered list of hops.
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (entries.length >= 2) return entries[entries.length - 2];
  return rawRequest.ip;
}

export function requireRole(c: Caller | null, roles: Role[]): Caller {
  if (!c) throw err('unauthenticated');
  if (!c.roles.some((r) => roles.includes(r))) throw err('permission_denied');
  return c;
}

export function requireOperator(c: Caller | null): Caller & { operatorId: string } {
  if (!c) throw err('unauthenticated');
  if (!c.operatorId) throw err('permission_denied', 'no operator');
  return c as Caller & { operatorId: string };
}

/**
 * Ruling C-2: the rules-boundary fix (firestore.rules' inOperator()) only stops a suspended
 * operator's staff from touching FIRESTORE directly — it says nothing about a staff-scoped callable,
 * which runs on the Admin SDK and bypasses security rules entirely. The re-review caught this: a
 * suspended operator's staff could still hit money-moving callables (refunds, checkout captures,
 * terminal tokens) even though their direct Firestore reads/writes were already denied. This is the
 * callable-side half of the same gate, called explicitly from each staff-scoped callable (there is no
 * single choke point on this side the way inOperator()/staffOf() are on the rules side — every
 * callable already does its own requireOperator() + role check, so this joins that same call site).
 *
 * Mirrors firestore.rules' inOperator() gate exactly: only an EXPLICIT 'suspended' status denies —
 * missing/any-other status passes. `operator`, when passed, is a caller-already-fetched Operator (its
 * own `.status` is used directly, no second read) — several staff callables (terminalConnectionToken,
 * connectOnboardingLink, schedulingSyncNow, staffCreateCheckout via runCheckout's new optional
 * parameter) already fetch the Operator doc for other reasons, so this stays a zero-extra-read check
 * for them; callables that don't otherwise need the Operator (staffRefund, staffCancelTicket,
 * auditQuery) get exactly one added read.
 *
 * `failed_precondition` (not a new PlatformErrorCode): maps to `errors.notReady` → "That isn't
 * available right now." in the dashboard/mobile copy maps — accurate, generic-enough client-safe
 * copy for a caller who has no reason to know their operator was administratively suspended.
 */
export async function requireActiveOperator(deps: Deps, operatorId: string, operator?: Operator): Promise<Operator> {
  const op = operator ?? ((await deps.db.doc(P.operator(operatorId)).get()).data() as Operator);
  // Matches every other handler's `.data() as Operator` cast convention (terminal.ts, connect.ts,
  // scheduling/sync.ts, checkout.ts all do the same unguarded cast) — a valid operatorId claim always
  // has a real operator doc (operators/{op} is never deletable — firestore.rules' `allow delete: if
  // false`), so no defensive undefined-check here either.
  if (op.status === 'suspended') throw err('failed_precondition', 'operator suspended');
  return op;
}

export function defineCallable<N extends CallableName>(
  name: N,
  opts: { allowAnonymous?: boolean; secrets?: string[]; enforceAppCheck?: boolean },
  handler: (deps: Deps, caller: Caller | null, input: CallableParsedInput<N>) => Promise<CallableOutput<N>>,
) {
  // NOTE: this line's `enforceAppCheck: opts.enforceAppCheck ?? true` text is
  // grep-matched verbatim by scripts/check-appcheck.sh's deploy gate — if you
  // change this line, update that script's pattern in the same commit.
  return onCall({ secrets: opts.secrets ?? [], enforceAppCheck: opts.enforceAppCheck ?? true, consumeAppCheckToken: false }, async (req) => {
    // callerIp (not a new handler parameter — see Deps.callerIp's own comment for why): resolved
    // once here via `ipFrom` and threaded through `Deps`, so `defineCallable`'s handler type stays
    // untouched (3 params, exactly as before this fix round) and every existing handler — including
    // ones with their own extra positional parameters, like `mapsAutocompleteHandler`'s `maps` DI
    // default — is unaffected. Conditionally spread (not `{ callerIp: ipFrom(...) }` directly): this
    // repo's tsconfig sets `exactOptionalPropertyTypes`, under which an optional field must be
    // OMITTED, not explicitly set to `undefined`.
    const callerIp = ipFrom(req.rawRequest);
    const deps = makeDeps({ ...(callerIp !== undefined ? { callerIp } : {}) });
    try {
      const caller = callerFrom(req, { allowAnonymous: opts.allowAnonymous ?? false });
      rejectExpiredAssumption(caller, Date.now());
      const parsed = callables[name].input.safeParse(req.data);
      if (!parsed.success) throw err('invalid_argument', 'invalid input', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
      const out = await handler(deps, caller, parsed.data);
      return callables[name].output.parse(out);
    } catch (e) {
      throw toHttpsError(e);
    }
  });
}
