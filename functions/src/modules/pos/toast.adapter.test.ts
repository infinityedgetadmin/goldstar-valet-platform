import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToastPos, __clearToastOrdersCache, __clearToastTokenCache } from './toast.adapter.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/toast', name), 'utf8')) as unknown;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Fixture-serving fetch: login + ordersBulk + add-selection are the VERIFIED calls (Ruling Y —
 * the apply-discount route deliberately has NO fixture and no route test here; its flow is
 * proven against MockPosProvider at the handler level once the callable lands). */
function makeFetch(overrides: { ordersPages?: unknown[][] } = {}) {
  const calls: Recorded[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch signature
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body !== undefined ? { body: JSON.parse(init.body as string) } : {}),
    };
    calls.push(rec);
    if (url.includes('/authentication/v1/authentication/login')) {
      return new Response(JSON.stringify(fixture('login.json')), { status: 200 });
    }
    if (url.includes('/orders/v2/ordersBulk')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const pages: unknown[][] = overrides.ordersPages ?? [fixture('orders-bulk.json') as unknown[]];
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    }
    if (/\/orders\/v2\/orders\/[0-9a-f-]+\/checks\/[0-9a-f-]+\/selections$/.test(url)) {
      return new Response(JSON.stringify(fixture('add-selection.json')), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const CONFIG = { clientId: 'cid', clientSecret: 'csecret', restaurantGuid: 'rest-guid-1' };
const GUIDS = { validationDiscountGuid: 'disc-guid', valetItemGuid: 'item-guid', valetItemGroupGuid: 'group-guid' };
const OPEN_REF = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';

let nowMs = Date.parse('2026-08-30T20:00:00.000Z');
const now = () => nowMs;

beforeEach(() => {
  __clearToastOrdersCache();
  __clearToastTokenCache();
  nowMs = Date.parse('2026-08-30T20:00:00.000Z');
});

describe('ToastPos auth (verified)', () => {
  it('logs in with the THIRD required field, reads the NESTED token, and caches it for the stated 86400s', async () => {
    const { fetchFn, calls } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);

    await pos.findCheck({});
    // L2: the registry constructs a NEW ToastPos per invocation, so the cache is only real if it
    // survives across INSTANCES — a per-instance field made this very assertion pin a property
    // production could never exhibit. Second lookup through a fresh instance:
    await new ToastPos(fetchFn, CONFIG, GUIDS, now).findCheck({ table: '12' });

    const logins = calls.filter((c) => c.url.includes('/authentication/'));
    expect(logins).toHaveLength(1); // cached — one login across both lookups, across instances
    expect(logins[0]!.body).toEqual({ clientId: 'cid', clientSecret: 'csecret', userAccessType: 'TOAST_MACHINE_CLIENT' });

    const authed = calls.find((c) => c.url.includes('/ordersBulk'))!;
    expect(authed.headers.Authorization).toBe('Bearer test-access-token-abc123');
    expect(authed.headers['Toast-Restaurant-External-ID']).toBe('rest-guid-1');
  });

  it('re-logs-in once the cached token passes its expiry window', async () => {
    const { fetchFn, calls } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);
    await pos.findCheck({});
    nowMs += 86400 * 1000; // past expiresIn − safety margin, and past the orders cache TTL
    await pos.findCheck({});
    expect(calls.filter((c) => c.url.includes('/authentication/'))).toHaveLength(2);
  });
});

describe('ToastPos findCheck (verified: ordersBulk)', () => {
  it('uses ordersBulk (never the deprecated /orders list), pages until a short page, and caches per venue', async () => {
    const order: unknown = (fixture('orders-bulk.json') as unknown[])[0];
    const fullPage = Array.from({ length: 100 }, () => order);
    const { fetchFn, calls } = makeFetch({ ordersPages: [fullPage, [order]] });
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);

    await pos.findCheck({});
    const bulkCalls = calls.filter((c) => c.url.includes('/ordersBulk'));
    expect(bulkCalls).toHaveLength(2); // page 1 full -> page 2 short -> stop
    expect(bulkCalls[0]!.url).toContain('pageSize=100');
    expect(calls.some((c) => /\/orders\/v2\/orders\?/.test(c.url))).toBe(false);

    // Ruling J: a second lookup inside the TTL re-uses the cache — no third bulk fetch.
    await pos.findCheck({ table: '12' });
    expect(calls.filter((c) => c.url.includes('/ordersBulk'))).toHaveLength(2);

    // and re-fetches once the TTL lapses
    nowMs += 61_000;
    await pos.findCheck({});
    expect(calls.filter((c) => c.url.includes('/ordersBulk')).length).toBeGreaterThan(2);
  });

  it('MONEY: returns open checks only, with totals converted from Toast decimal DOLLARS to integer cents, and an opaque minted checkRef', async () => {
    const { fetchFn } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);

    const { checks } = await pos.findCheck({});
    // closed check filtered; voided order's check filtered
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({ checkRef: OPEN_REF, table: 'Table 12', total: 9125, openedAt: '2026-08-30T19:05:00.000+0000' });
  });

  it('matches what the host typed against tabName and displayNumber, case-insensitively', async () => {
    const { fetchFn } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);
    expect((await pos.findCheck({ table: 'table 12' })).checks).toHaveLength(1);
    expect((await pos.findCheck({ table: '12' })).checks).toHaveLength(1); // displayNumber
    expect((await pos.findCheck({ table: '99' })).checks).toHaveLength(0);
  });

  it('rejects a checkRef this adapter did not mint', async () => {
    const { fetchFn } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);
    await expect(pos.findCheck({ checkRef: 'mock:1' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(pos.applyValidation({ checkRef: 'not-a-ref', amount: 100, reason: 'X' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('ToastPos addCharge (verified: add-selection)', () => {
  it('POSTs both guids in the path with itemGroup.guid alongside item.guid, price in decimal dollars', async () => {
    const { fetchFn, calls } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);

    await pos.addCharge({ checkRef: OPEN_REF, item: { name: 'Valet parking', amount: 1605 } });

    const call = calls.find((c) => c.url.endsWith('/selections'))!;
    expect(call.url).toContain('/orders/v2/orders/11111111-1111-1111-1111-111111111111/checks/22222222-2222-2222-2222-222222222222/selections');
    expect(call.body).toEqual([
      { entityType: 'MenuItemSelection', itemGroup: { guid: 'group-guid' }, item: { guid: 'item-guid' }, quantity: 1, price: 16.05 },
    ]);
  });

  it('fails honestly when the valet item guids are not configured — never posts a guessed item', async () => {
    const { fetchFn, calls } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, {}, now);
    await expect(pos.addCharge({ checkRef: OPEN_REF, item: { name: 'Valet parking', amount: 1605 } })).rejects.toMatchObject({ code: 'failed_precondition' });
    expect(calls).toHaveLength(0);
  });
});

describe('ToastPos applyValidation (RULING Y: live route unverified — no fixture, no route test)', () => {
  it('fails honestly when the validation discount guid is not configured — never sends a guessed discount', async () => {
    const { fetchFn, calls } = makeFetch();
    const pos = new ToastPos(fetchFn, CONFIG, {}, now);
    await expect(pos.applyValidation({ checkRef: OPEN_REF, amount: 700, reason: 'AB23CD' })).rejects.toMatchObject({ code: 'failed_precondition' });
    expect(calls).toHaveLength(0);
  });
});

describe('ToastPos error mapping', () => {
  it('maps a provider failure to provider_unavailable with the status only — never the response body', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- fetch signature
    const fetchFn = (async () => new Response('secret-laden provider error body', { status: 503 })) as typeof fetch;
    const pos = new ToastPos(fetchFn, CONFIG, GUIDS, now);
    await expect(pos.findCheck({})).rejects.toMatchObject({ code: 'provider_unavailable', message: 'toast 503' });
  });

  it('healthCheck reports ok on a successful login and a generic failure otherwise', async () => {
    const { fetchFn } = makeFetch();
    expect(await new ToastPos(fetchFn, CONFIG, GUIDS, now).healthCheck()).toEqual({ ok: true });
    // eslint-disable-next-line @typescript-eslint/require-await -- fetch signature
    const failing = (async () => new Response('x', { status: 401 })) as typeof fetch;
    expect(await new ToastPos(failing, CONFIG, GUIDS, now).healthCheck()).toEqual({ ok: false, message: 'toast authentication failed' });
  });
});
