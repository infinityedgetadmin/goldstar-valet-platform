import { beforeEach, describe, expect, it } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { Operator } from '@goldstar/platform';
import { callerFrom, ipFrom, rejectExpiredAssumption, requireActiveOperator, type Caller } from './callable.js';
import { inviteHandler } from '../modules/identity/invite.js';
import { acceptHandler } from '../modules/identity/accept.js';
import { OP, seedOperator, testDeps, wipe } from '../../test/helpers.js';
import { P } from './paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

/**
 * A minimal fake `CallableRequest` covering exactly what `callerFrom` reads
 * (`req.auth`, `req.rawRequest.ip`) — cast through `unknown` since the real
 * `Request` type (a full `express.Request`) has far more required surface
 * than any fake needs to satisfy for these unit tests.
 */
function fakeRequest(
  over: { auth?: { uid: string; token: Record<string, unknown> }; ip?: string } = {},
): CallableRequest<unknown> {
  return {
    data: {},
    auth: over.auth ? { uid: over.auth.uid, token: over.auth.token, rawToken: 'x' } : undefined,
    rawRequest: { ip: over.ip ?? '127.0.0.1', headers: {} },
  } as unknown as CallableRequest<unknown>;
}

describe('Plan 8 Task 10 (#9, audit M3): assumed tokens expire at the callable layer too', () => {
  const NOW = Date.parse('2026-08-23T21:00:00.000Z');
  /** The PlatformError code a synchronous guard throws, or undefined when it does not throw. */
  const codeOf = (fn: () => void): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  it('callerFrom threads assumed/assumedUntil through, and omits them for an ordinary token', () => {
    const assumedReq = fakeRequest({ auth: { uid: 'pa1', token: { roles: ['platform_admin', 'admin'], operatorId: OP, assumed: true, assumedUntil: NOW + 1 } } });
    expect(callerFrom(assumedReq)).toMatchObject({ uid: 'pa1', assumed: true, assumedUntil: NOW + 1 });
    const plainReq = fakeRequest({ auth: { uid: 'u1', token: { roles: ['attendant'], operatorId: OP } } });
    const plain = callerFrom(plainReq);
    expect(Object.hasOwn(plain as object, 'assumed')).toBe(false);
    expect(Object.hasOwn(plain as object, 'assumedUntil')).toBe(false);
  });
  it('a live assumption passes; an expired one is permission_denied — the same instant the rules use', () => {
    const live: Caller = { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [], assumed: true, assumedUntil: NOW + 1 };
    expect(codeOf(() => { rejectExpiredAssumption(live, NOW); })).toBeUndefined();
    expect(codeOf(() => { rejectExpiredAssumption({ ...live, assumedUntil: NOW }, NOW); })).toBe('permission_denied');
    expect(codeOf(() => { rejectExpiredAssumption({ ...live, assumedUntil: NOW - 1 }, NOW); })).toBe('permission_denied');
  });
  it('an assumed token with no bound is malformed and treated as expired; a non-assumed token is never gated; an anonymous caller is untouched', () => {
    expect(codeOf(() => { rejectExpiredAssumption({ uid: 'pa1', roles: ['platform_admin'], venueIds: [], assumed: true }, NOW); })).toBe('permission_denied');
    expect(codeOf(() => { rejectExpiredAssumption({ uid: 'u1', operatorId: OP, roles: ['attendant'], venueIds: [], assumedUntil: NOW - 1 }, NOW); })).toBeUndefined();
    expect(codeOf(() => { rejectExpiredAssumption(null, NOW); })).toBeUndefined();
  });
});

describe('callerFrom', () => {
  it('an authenticated request resolves a Caller carrying uid/roles/venueIds/operatorId/phone/ip', () => {
    const req = fakeRequest({
      auth: { uid: 'u1', token: { roles: ['attendant'], venueIds: ['v1'], operatorId: OP, phone_number: '+13175550100' } },
      ip: '9.9.9.9',
    });
    expect(callerFrom(req)).toEqual({
      uid: 'u1',
      roles: ['attendant'],
      venueIds: ['v1'],
      operatorId: OP,
      phone: '+13175550100',
      ip: '9.9.9.9',
    });
  });

  // Regression (Task 5 fix round 1, Ruling J / task-5-review.md C1): a prior version of this diff
  // made an unauthenticated `allowAnonymous` call resolve a TRUTHY stub caller
  // (`{ uid: 'guest', roles: [], venueIds: [] }`) instead of `null`, which broke
  // `identityAcceptInvitation`'s `if (caller)` branch-selection for every real first-time invitee
  // (see the acceptHandler regression test below). Pinning the exact original behavior here so that
  // class of bug can't recur silently.
  it('an unauthenticated allowAnonymous request resolves null, not a truthy stub', () => {
    const req = fakeRequest();
    expect(callerFrom(req, { allowAnonymous: true })).toBeNull();
  });

  it('an unauthenticated non-anonymous request throws unauthenticated', () => {
    const req = fakeRequest();
    expect(() => callerFrom(req)).toThrow();
  });
});

describe('ipFrom', () => {
  function rawReq(over: { xff?: string | string[]; ip?: string } = {}): CallableRequest<unknown>['rawRequest'] {
    return {
      headers: over.xff !== undefined ? { 'x-forwarded-for': over.xff } : {},
      ip: over.ip ?? '10.0.0.1',
    } as unknown as CallableRequest<unknown>['rawRequest'];
  }

  // Fix round 2 (Ruling N): GCP appends exactly two entries — <real-client-ip>, <load-balancer-ip>
  // — to the END of whatever the client itself sent. A client can prepend an arbitrary number of
  // fabricated entries; the real client IP is always the SECOND-FROM-LAST, never the first.
  it('a client-fabricated prefix does not fool ipFrom — the real client IP (second-from-last) wins over attacker-controlled leading entries', () => {
    expect(ipFrom(rawReq({ xff: 'junk1, junk2, 203.0.113.7, 130.211.0.1' }))).toBe('203.0.113.7');
  });

  it('the exact two-entry case GCP produces for a client that sent no X-Forwarded-For of its own', () => {
    expect(ipFrom(rawReq({ xff: '203.0.113.7, 130.211.0.1' }))).toBe('203.0.113.7');
  });

  it('a single-entry header cannot be trusted as proxy-appended (GCP always contributes 2) and falls back to rawRequest.ip', () => {
    expect(ipFrom(rawReq({ xff: '203.0.113.7', ip: '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('falls back to rawRequest.ip when X-Forwarded-For is absent entirely (e.g. the local emulator, which has no proxy in front of it)', () => {
    expect(ipFrom(rawReq({ ip: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('trims surrounding whitespace around each comma-separated entry', () => {
    expect(ipFrom(rawReq({ xff: '  junk1  ,  203.0.113.7  ,  130.211.0.1  ' }))).toBe('203.0.113.7');
  });

  it('handles an array-valued X-Forwarded-For header (multiple header lines) the same way as a comma-joined string', () => {
    expect(ipFrom(rawReq({ xff: ['junk1', '203.0.113.7', '130.211.0.1'] }))).toBe('203.0.113.7');
  });
});

describe('requireActiveOperator (Ruling C-2)', () => {
  describe('full-fetch (no pre-fetched operator passed — the function does its own read)', () => {
    it('an active operator resolves and returns the fetched Operator', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      const op = await requireActiveOperator(deps, OP);
      expect(op.status).toBe('active');
    });

    it('a suspended operator throws failed_precondition', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
      await expect(requireActiveOperator(deps, OP)).rejects.toMatchObject({ code: 'failed_precondition' });
    });

    // Mirrors firestore.rules' inOperator() `.get('status', 'active')` semantics exactly — a missing
    // status field must not lock everyone out, only an explicit 'suspended' value denies.
    it('a missing status field does not throw — only an explicit "suspended" value does', async () => {
      const deps = testDeps();
      await seedOperator(deps);
      const snap = await deps.db.doc(P.operator(OP)).get();
      const withoutStatus = Object.fromEntries(Object.entries(snap.data() as Operator).filter(([k]) => k !== 'status'));
      await deps.db.doc(P.operator(OP)).set(withoutStatus);
      await expect(requireActiveOperator(deps, OP)).resolves.toMatchObject({ id: OP });
    });
  });

  describe('pre-fetched (an already-loaded Operator passed in — zero extra reads)', () => {
    it('a pre-fetched active operator resolves without any Firestore read', async () => {
      const deps = testDeps();
      const activeOperator = { id: OP, status: 'active' } as Operator;
      const op = await requireActiveOperator(deps, OP, activeOperator);
      expect(op).toBe(activeOperator); // same reference — proves no fetch happened, the passed object was returned as-is
    });

    it('a pre-fetched suspended operator throws failed_precondition without any Firestore read', async () => {
      const deps = testDeps();
      const suspendedOperator = { id: OP, status: 'suspended' } as Operator;
      await expect(requireActiveOperator(deps, OP, suspendedOperator)).rejects.toMatchObject({ code: 'failed_precondition' });
    });
  });
});

describe('Regression: callerFrom → acceptHandler (task-5-review.md C1, reproduced and pinned)', () => {
  it('a real unauthenticated request routes acceptHandler to the anonymous create-account branch, not the signed-in getUser branch', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const { token } = await inviteHandler(
      deps,
      { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] },
      { email: 'new@x.example.com', roles: ['attendant'], venueIds: ['v1'] },
    );
    // The exact request shape a real first-time invitee sends: no Firebase Auth session yet.
    const req = fakeRequest();
    const caller = callerFrom(req, { allowAnonymous: true });
    // Before this fix round, `caller` here was the truthy stub, `acceptHandler` took the `if
    // (caller)` branch, called `deps.auth.getUser('guest')`, and rejected with `auth/user-not-found`
    // — an opaque `internal` error to the client. With `callerFrom` reverted, `caller` is `null`,
    // `acceptHandler` takes the `else` (password/create-account) branch, and this resolves cleanly.
    const res = await acceptHandler(deps, caller, { token, password: 'Str0ngPassw0rd!', displayName: 'New Person' });
    expect(res).toMatchObject({ operatorId: OP, email: 'new@x.example.com' });
  });
});
