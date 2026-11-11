import { beforeEach, expect, it, vi } from 'vitest';
import type { Role } from '@goldstar/platform';
import { WhenIWorkScheduleProvider, mapWiwShifts, PermanentPushError, TIMEOUT_MS, type WiwRawShift } from './wheniwork.adapter.js';
import { OP, testDeps, wipe } from '../../../test/helpers.js';
import type { ProviderContext } from './port.js';

function ctx(config: Record<string, unknown>): ProviderContext {
  return {
    deps: testDeps(),
    operatorId: OP,
    config,
    secret: (n: string) => ({ developerKey: 'dev-key-x', username: 'ops@goldstar.example.com', password: 'pw-x' })[n] ?? `secret:${n}`,
  };
}

const BASE_CONFIG: { locationId: string; workplaceUserId: string; venueMap: Record<string, string>; roleMap: Record<string, Role> } = {
  locationId: '111',
  workplaceUserId: '999',
  venueMap: { '501': 'v1' },
  roleMap: { '7': 'lead', '8': 'attendant' },
};

beforeEach(async () => {
  await wipe(testDeps());
});

// ---- mapWiwShifts (pure mapping logic — no network) ----

it('mapWiwShifts maps a fully-specified WIW shift to an ExternalShift', () => {
  const raw: WiwRawShift[] = [
    { id: 4001, user_id: 55, location_id: 111, position_id: 8, site_id: 501, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: false, notes: 'bring cones' },
  ];
  const { shifts, errors } = mapWiwShifts(raw, BASE_CONFIG);

  expect(errors).toEqual([]);
  expect(shifts).toEqual([
    {
      externalId: '4001',
      venueId: 'v1',
      date: '2023-05-08',
      startsAt: '2023-05-08T14:30:00.000Z',
      endsAt: '2023-05-08T22:30:00.000Z',
      assignments: [{ externalUserId: '55', role: 'attendant' }],
      notes: 'bring cones',
    },
  ]);
});

it('mapWiwShifts drops the shift and reports an error when site_id has no venueMap entry', () => {
  const raw: WiwRawShift[] = [
    { id: 4002, user_id: 55, location_id: 111, position_id: 8, site_id: 999, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: false },
  ];
  const { shifts, errors } = mapWiwShifts(raw, BASE_CONFIG);

  expect(shifts).toEqual([]);
  expect(errors).toEqual(['unmapped site_id 999 on shift 4002']);
});

it('mapWiwShifts keeps the shift with no assignment when position_id has no roleMap entry, and reports it', () => {
  const raw: WiwRawShift[] = [
    { id: 4003, user_id: 55, location_id: 111, position_id: 12, site_id: 501, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: false },
  ];
  const { shifts, errors } = mapWiwShifts(raw, BASE_CONFIG);

  expect(shifts).toHaveLength(1);
  expect(shifts[0]!.assignments).toEqual([]);
  expect(errors).toEqual(['unmapped position_id 12 on shift 4003']);
});

it('mapWiwShifts treats a null position_id the same as an unmapped one', () => {
  const raw: WiwRawShift[] = [
    { id: 4004, user_id: 55, location_id: 111, position_id: null, site_id: 501, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: false },
  ];
  const { shifts, errors } = mapWiwShifts(raw, BASE_CONFIG);

  expect(shifts[0]!.assignments).toEqual([]);
  expect(errors).toEqual(['unmapped position_id null on shift 4004']);
});

it('mapWiwShifts silently skips an open (unassigned) shift', () => {
  const raw: WiwRawShift[] = [
    { id: 4005, user_id: 0, location_id: 111, position_id: 8, site_id: 501, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: true },
  ];
  const { shifts, errors } = mapWiwShifts(raw, BASE_CONFIG);

  expect(shifts).toEqual([]);
  expect(errors).toEqual([]);
});

// ---- WhenIWorkScheduleProvider.sync() (login + live shift fetch, mocked transport) ----

it('sync logs in against the confirmed host/header/body shape, then fetches shifts and maps them', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.startsWith('https://api.login.wheniwork.com/login')) {
      return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    }
    if (url.includes('/2/shifts')) {
      return new Response(
        JSON.stringify({
          shifts: [{ id: 4001, user_id: 55, location_id: 111, position_id: 8, site_id: 501, start_time: 'Mon, 08 May 2023 08:30:00 -0600', end_time: 'Mon, 08 May 2023 16:30:00 -0600', is_open: false }],
          total: 1,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const provider = new WhenIWorkScheduleProvider(fetchFn);
  const result = await provider.sync(ctx(BASE_CONFIG), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.errors).toEqual([]);
  expect(result.shifts).toHaveLength(1);
  expect(result.shifts[0]!.externalId).toBe('4001');

  const loginCall = calls.find((c) => c.url.startsWith('https://api.login.wheniwork.com/login'))!;
  expect((loginCall.init!.headers as Record<string, string>)['W-Key']).toBe('dev-key-x');
  expect(JSON.parse(loginCall.init!.body as string)).toEqual({ email: 'ops@goldstar.example.com', password: 'pw-x' });

  const shiftsCall = calls.find((c) => c.url.includes('/2/shifts'))!;
  expect((shiftsCall.init!.headers as Record<string, string>)['W-Token']).toBe('jwt-abc');
  expect((shiftsCall.init!.headers as Record<string, string>)['W-UserID']).toBe('999');
});

it('sync reports a login failure as a SyncResult error rather than throwing', async () => {
  const fetchFn = (() => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const result = await provider.sync(ctx(BASE_CONFIG), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.shifts).toEqual([]);
  expect(result.errors).toEqual(['wheniwork login failed: HTTP 401']);
});

it.each([
  [{ login: { token: 'jwt-1' } }, 'jwt-1'],
  [{ user: { token: 'jwt-2' } }, 'jwt-2'],
  [{ person: { token: 'jwt-3' } }, 'jwt-3'],
  [{ token: 'jwt-4' }, 'jwt-4'],
])('sync extracts the login token defensively from %j', async (body, expectedToken) => {
  let capturedToken: string | undefined;
  const fetchFn = ((url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify(body), { status: 200 });
    capturedToken = (init!.headers as Record<string, string>)['W-Token'];
    return new Response(JSON.stringify({ shifts: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new WhenIWorkScheduleProvider(fetchFn);
  const result = await provider.sync(ctx(BASE_CONFIG), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.errors).toEqual([]);
  expect(capturedToken).toBe(expectedToken);
});

it('sync reports a SyncResult error when the login response carries no token at any known path', async () => {
  const fetchFn = (() => new Response(JSON.stringify({ unrelated: 'field' }), { status: 200 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const result = await provider.sync(ctx(BASE_CONFIG), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.shifts).toEqual([]);
  expect(result.errors).toEqual(['wheniwork login response carried no recognizable token']);
});

it('sync auto-resolves a single workplace via GET /2/login?show_pending=true when workplaceUserId is not configured', async () => {
  const calls: string[] = [];
  const configNoWorkplace = { ...BASE_CONFIG, workplaceUserId: undefined };
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    if (url.includes('show_pending=true')) return new Response(JSON.stringify({ users: [{ id: 777 }] }), { status: 200 });
    if (url.includes('/2/shifts')) {
      expect((init!.headers as Record<string, string>)['W-UserID']).toBe('777');
      return new Response(JSON.stringify({ shifts: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const provider = new WhenIWorkScheduleProvider(fetchFn);
  const result = await provider.sync(ctx(configNoWorkplace), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.errors).toEqual([]);
  expect(calls.some((u) => u.includes('show_pending=true'))).toBe(true);
});

it('sync reports an error when workplaceUserId is unset and more than one workplace is found', async () => {
  const configNoWorkplace = { ...BASE_CONFIG, workplaceUserId: undefined };
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    if (url.includes('show_pending=true')) return new Response(JSON.stringify({ users: [{ id: 777 }, { id: 778 }] }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const provider = new WhenIWorkScheduleProvider(fetchFn);
  const result = await provider.sync(ctx(configNoWorkplace), { from: '2023-05-01', to: '2023-05-15' });

  expect(result.shifts).toEqual([]);
  expect(result.errors).toEqual(['wheniwork: ambiguous workplace (2 found) — set workplaceUserId in config']);
});

// ---- pushClockEvent (Ruling AQ(b): transient vs. PermanentPushError) ----

it('pushClockEvent posts the push to /2/times and resolves on success', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new WhenIWorkScheduleProvider(fetchFn);
  await provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' });

  const pushCall = calls.find((c) => c.url.includes('/2/times'))!;
  expect(pushCall.init!.method).toBe('POST');
  expect(JSON.parse(pushCall.init!.body as string)).toMatchObject({ user_id: '55', shift_id: '4001', type: 'in', time: '2023-05-08T14:30:00.000Z' });
});

it('pushClockEvent throws PermanentPushError when externalUserId is missing', async () => {
  const fetchFn = (() => new Response('', { status: 200 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  await expect(
    provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', type: 'in', at: '2023-05-08T14:30:00.000Z' }),
  ).rejects.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws PermanentPushError when LOGIN fails with a non-429 4xx — e.g. rotated/revoked credentials (M1)', async () => {
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  await expect(
    provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' }),
  ).rejects.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws an ordinary Error (not PermanentPushError) when LOGIN itself returns a 5xx — transient (M1)', async () => {
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response('server error', { status: 503 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const promise = provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' });
  await expect(promise).rejects.toThrow();
  await expect(promise).rejects.not.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws PermanentPushError when login succeeds but is ambiguous (multiple workplaces, none configured) — M1', async () => {
  const configNoWorkplace = { ...BASE_CONFIG, workplaceUserId: undefined };
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    if (url.includes('show_pending=true')) return new Response(JSON.stringify({ users: [{ id: 777 }, { id: 778 }] }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  await expect(
    provider.pushClockEvent(ctx(configNoWorkplace), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' }),
  ).rejects.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws PermanentPushError when the login response carries no recognizable token — N3', async () => {
  const fetchFn = (() => new Response(JSON.stringify({ unrelated: 'field' }), { status: 200 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  await expect(
    provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' }),
  ).rejects.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws PermanentPushError on a 4xx (non-429) response', async () => {
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    return new Response('bad request', { status: 400 });
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  await expect(
    provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' }),
  ).rejects.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws an ordinary Error (not PermanentPushError) on a 429 response, so the caller retries', async () => {
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    return new Response('rate limited', { status: 429 });
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const promise = provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' });
  await expect(promise).rejects.toThrow();
  await expect(promise).rejects.not.toBeInstanceOf(PermanentPushError);
});

it('pushClockEvent throws an ordinary Error on a 5xx response, so the caller retries', async () => {
  const fetchFn = ((url: string) => {
    if (url.startsWith('https://api.login.wheniwork.com/login')) return new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 });
    return new Response('server error', { status: 503 });
  }) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const promise = provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' });
  await expect(promise).rejects.toThrow();
  await expect(promise).rejects.not.toBeInstanceOf(PermanentPushError);
});

// ---- request timeout (Ruling BC: AbortController, matching Toast's TIMEOUT_MS pattern) ----

/** A fetchFn that never resolves on its own — only reacts to the AbortSignal `fetchWithTimeout`
 * is expected to pass through, mirroring what a real hung TCP connection looks like from the
 * caller's side. If the production code never wires up an AbortController, this hangs forever
 * (bounded by each test's own short timeout below, so a still-missing timeout fails fast and
 * legibly rather than eating the suite's default per-test budget). */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as unknown as typeof fetch;
}

it(
  'sync reports a login request timeout as a SyncResult error rather than throwing or hanging',
  async () => {
    vi.useFakeTimers();
    try {
      const provider = new WhenIWorkScheduleProvider(hangingFetch());
      const resultPromise = provider.sync(ctx(BASE_CONFIG), { from: '2023-05-01', to: '2023-05-15' });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const result = await resultPromise;
      expect(result.shifts).toEqual([]);
      expect(result.errors[0]).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  },
  2000,
);

it(
  'pushClockEvent throws an ordinary Error (not PermanentPushError) on a login request timeout — transient, retries',
  async () => {
    vi.useFakeTimers();
    try {
      const provider = new WhenIWorkScheduleProvider(hangingFetch());
      const promise = provider.pushClockEvent(ctx(BASE_CONFIG), { shiftExternalId: '4001', uid: 'u1', externalUserId: '55', type: 'in', at: '2023-05-08T14:30:00.000Z' });
      // Attach the rejection observer BEFORE advancing timers — `promise` settles (rejects)
      // synchronously inside `advanceTimersByTimeAsync`, and an unobserved rejection at that
      // point is flagged by Node as unhandled even though it's observed moments later.
      const throwsAssertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await throwsAssertion;
      await expect(promise).rejects.not.toBeInstanceOf(PermanentPushError);
    } finally {
      vi.useRealTimers();
    }
  },
  2000,
);

it(
  'healthCheck resolves ok:false with a timeout message on a login request timeout',
  async () => {
    vi.useFakeTimers();
    try {
      const provider = new WhenIWorkScheduleProvider(hangingFetch());
      const promise = provider.healthCheck(ctx(BASE_CONFIG));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  },
  2000,
);

// ---- healthCheck ----

it('healthCheck resolves ok:true when login succeeds', async () => {
  const fetchFn = (() => new Response(JSON.stringify({ login: { token: 'jwt-abc' } }), { status: 200 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const result = await provider.healthCheck(ctx(BASE_CONFIG));

  expect(result).toEqual({ ok: true });
});

it('healthCheck resolves ok:false with a message when login fails', async () => {
  const fetchFn = (() => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  const provider = new WhenIWorkScheduleProvider(fetchFn);

  const result = await provider.healthCheck(ctx(BASE_CONFIG));

  expect(result.ok).toBe(false);
  expect(result.message).toBeTruthy();
});
