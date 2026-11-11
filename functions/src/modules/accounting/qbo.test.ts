import { beforeEach, expect, it, vi } from 'vitest';
import type { IntegrationToken } from '@goldstar/platform';
import { NOW, OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { getQboAccessToken } from './qboToken.js';
import { QboAccountingProvider } from './qbo.adapter.js';

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

const CREDS = { clientId: 'cid', clientSecret: 'csecret' };
const TOKEN_DOC: IntegrationToken = {
  provider: 'quickbooks_online',
  refreshToken: 'rt_1',
  refreshTokenExpiresAt: '2026-11-20T00:00:00.000Z',
  realmId: 'realm1',
  rotatedAt: NOW,
  rotationCount: 3,
};

/** Fake fetch capturing calls; programmable per-URL responders. */
function makeFetch(responder: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch signature
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
    const r = responder(u, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const REFRESH_OK = {
  token_type: 'bearer',
  access_token: 'at_new',
  refresh_token: 'rt_2',
  expires_in: 3600,
  x_refresh_token_expires_in: 8_640_000,
};

// ---------- token rotation (the ruling that reshaped the brief) ----------

it('ROTATION: a refresh consumes rt_1, stores the ROTATED rt_2 + expiries in the token doc, and increments rotationCount', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).set(TOKEN_DOC);
  const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: REFRESH_OK }));

  const out = await getQboAccessToken(deps, OP, CREDS, fetchFn);
  expect(out).toEqual({ accessToken: 'at_new', realmId: 'realm1' });

  // The wire contract, verified via Context7: Basic(clientId:clientSecret) + form body.
  expect(calls[0]!.url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
  const init = calls[0]!.init!;
  expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  expect(init.body as string).toBe('grant_type=refresh_token&refresh_token=rt_1');

  const doc = (await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).get()).data() as IntegrationToken;
  expect(doc.refreshToken).toBe('rt_2'); // ROTATED — the old design kept rt_1 and broke on the second refresh
  expect(doc.rotationCount).toBe(4);
  expect(doc.accessToken).toBe('at_new');
  expect(Date.parse(doc.refreshTokenExpiresAt)).toBe(Date.parse(NOW) + 8_640_000 * 1000);
});

it('a live cached access token short-circuits — no wire call at all', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).set({ ...TOKEN_DOC, accessToken: 'at_live', accessTokenExpiresAt: '2026-08-23T22:30:00.000Z' });
  const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: REFRESH_OK }));
  const out = await getQboAccessToken(deps, OP, CREDS, fetchFn);
  expect(out.accessToken).toBe('at_live');
  expect(calls).toHaveLength(0);
});

it("CONCURRENCY (first-writer-wins): a refresher whose consumed token was already rotated away does NOT overwrite the winner's doc", async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const tokenRef = deps.db.doc(P.integrationToken(OP, 'quickbooks_online'));
  await tokenRef.set(TOKEN_DOC);
  // The winner commits between our HTTP call and our transaction: the fetch itself advances the
  // doc to the winner's state, so our refresher consumed an rt_1 that is stale by tx time.
  const winner = { ...TOKEN_DOC, refreshToken: 'rt_winner', accessToken: 'at_winner', accessTokenExpiresAt: '2026-08-23T22:30:00.000Z', rotationCount: 9 };
  const flipFetch = (async () => {
    await tokenRef.set(winner);
    return new Response(JSON.stringify(REFRESH_OK), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const out = await getQboAccessToken(deps, OP, CREDS, flipFetch);
  // The tx loses (doc advanced past what we consumed) → the handler CONVERGES on the winner's
  // stored token rather than returning a token whose rotation was discarded.
  expect(out.accessToken).toBe('at_winner');
  // The doc keeps the WINNER's rotation — ours is discarded, never orphaning their refresh token.
  const doc = (await tokenRef.get()).data() as IntegrationToken;
  expect(doc.refreshToken).toBe('rt_winner');
  expect(doc.rotationCount).toBe(9);
});

it('invalid_grant (the concurrent LOSER at Intuit): re-reads the doc and uses the winner’s stored access token instead of wedging', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const tokenRef = deps.db.doc(P.integrationToken(OP, 'quickbooks_online'));
  await tokenRef.set(TOKEN_DOC);
  const flipFetch = (async () => {
    await tokenRef.set({ ...TOKEN_DOC, refreshToken: 'rt_winner', accessToken: 'at_winner', accessTokenExpiresAt: '2026-08-23T22:30:00.000Z' });
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const out = await getQboAccessToken(deps, OP, CREDS, flipFetch);
  expect(out.accessToken).toBe('at_winner');
});

it('never connected → failed_precondition naming the consent flow; a dead 400 with no winner → re-authorize', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  const { fetchFn } = makeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  await expect(getQboAccessToken(deps, OP, CREDS, fetchFn)).rejects.toMatchObject({ code: 'failed_precondition' });
  await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).set(TOKEN_DOC);
  await expect(getQboAccessToken(deps, OP, CREDS, fetchFn)).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- the QBO provider ----------

function provider(deps: ReturnType<typeof testDeps>, fetchFn: typeof fetch) {
  return new QboAccountingProvider(deps, fetchFn, { operatorId: OP, realmId: 'realm1', incomeAccountId: '79', clientId: 'cid', clientSecret: 'csecret', sandbox: false });
}

async function seedInvoiceDoc(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.invoice(OP, 'inv_v1_2026-07')).set({
    id: 'inv_v1_2026-07',
    operatorId: OP,
    venueId: V1,
    period: '2026-07',
    lines: [{ label: 'Valet service — per ticket', quantity: 412, unitAmount: 250, amount: 103_000 }],
    subtotal: 103_000,
    tax: 7210,
    total: 110_210,
    currency: 'USD',
    status: 'draft',
    createdAt: NOW,
    ...over,
  });
}

/** Live token so the provider never hits the refresh path in these tests. */
async function seedLiveToken(deps: ReturnType<typeof testDeps>) {
  await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).set({ ...TOKEN_DOC, accessToken: 'at_live', accessTokenExpiresAt: '2026-08-23T22:30:00.000Z' });
}

it('MONEY: syncInvoices posts the verified payload with DECIMAL DOLLARS — both directions of the crossing pinned', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedLiveToken(deps);
  await seedInvoiceDoc(deps);
  // Venue already linked — no customer/item calls needed.
  await deps.db.doc(P.venue(OP, V1)).update({ accounting: { qboCustomerId: 'C9', qboItemId: 'I7' } });
  const bodies: unknown[] = [];
  const { fetchFn } = makeFetch((url, init) => {
    if (url.includes('/invoice')) {
      bodies.push(JSON.parse(init!.body as string));
      return { status: 200, body: { Invoice: { Id: 'QI1' } } };
    }
    return { status: 200, body: {} };
  });

  const out = await provider(deps, fetchFn).syncInvoices({ operatorId: OP, invoiceIds: ['inv_v1_2026-07'] });
  expect(out).toEqual({ synced: 1, errors: [] });

  // 103000 cents → 1030.00 dollars; 250 cents → 2.50. An unconverted push is a 100x error.
  expect(bodies[0]).toEqual({
    CustomerRef: { value: 'C9' },
    TxnDate: '2026-07-01',
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1030, Description: 'Valet service — per ticket', SalesItemLineDetail: { ItemRef: { value: 'I7' }, Qty: 412, UnitPrice: 2.5 } }],
  });

  const inv = (await deps.db.doc(P.invoice(OP, 'inv_v1_2026-07')).get()).data() as { qbo?: { invoiceId: string } };
  expect(inv.qbo?.invoiceId).toBe('QI1');
});

it('IDEMPOTENT: an invoice already carrying qbo.invoiceId is skipped — no second QBO invoice, not an error', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedLiveToken(deps);
  await seedInvoiceDoc(deps, { qbo: { invoiceId: 'QI1', syncedAt: NOW } });
  const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: {} }));
  const out = await provider(deps, fetchFn).syncInvoices({ operatorId: OP, invoiceIds: ['inv_v1_2026-07'] });
  expect(out).toEqual({ synced: 0, errors: [] });
  expect(calls.filter((c) => c.url.includes('/invoice'))).toHaveLength(0);
});

it('NAMING: adopt-or-suffix — adopts a single query match; on fault 6240 with no match, suffixes #2; persists ids on the venue; NEVER renames', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedLiveToken(deps);
  await seedInvoiceDoc(deps);
  const posted: string[] = [];
  const { fetchFn } = makeFetch((url, init) => {
    if (url.includes('/query')) {
      const q = decodeURIComponent(url).replace(/\+/g, ' '); // URLSearchParams re-serializes spaces as '+'
      // Customer: base name exists exactly once → ADOPT. Item: nothing queryable ever → suffix path.
      if (q.includes('FROM Customer') && !q.includes('#')) return { status: 200, body: { QueryResponse: { Customer: [{ Id: 'C_ADOPTED' }] } } };
      return { status: 200, body: { QueryResponse: {} } };
    }
    if (url.includes('/item')) {
      const body = JSON.parse(init!.body as string) as { Name: string };
      posted.push(body.Name);
      // First create hits the inactive-holder fault; the #2 create succeeds.
      if (!body.Name.includes('#')) return { status: 400, body: { Fault: { Error: [{ code: '6240' }] } } };
      return { status: 200, body: { Item: { Id: 'I_2' } } };
    }
    if (url.includes('/invoice')) return { status: 200, body: { Invoice: { Id: 'QI1' } } };
    return { status: 200, body: {} };
  });

  const out = await provider(deps, fetchFn).syncInvoices({ operatorId: OP, invoiceIds: ['inv_v1_2026-07'] });
  expect(out.errors).toEqual([]);
  expect(posted).toEqual([`Valet service (${V1.slice(0, 8)})`, `Valet service (${V1.slice(0, 8)}) #2`]);
  const venue = (await deps.db.doc(P.venue(OP, V1)).get()).data() as { accounting?: { qboCustomerId?: string; qboItemId?: string } };
  expect(venue.accounting).toMatchObject({ qboCustomerId: 'C_ADOPTED', qboItemId: 'I_2' });

  // NEVER rename: a second sync with the ids persisted makes no naming calls at all.
  await seedInvoiceDoc(deps, { id: 'inv_v1_2026-08', period: '2026-08' });
  await deps.db.doc(P.invoice(OP, 'inv_v1_2026-08')).set({ ...(await deps.db.doc(P.invoice(OP, 'inv_v1_2026-07')).get()).data()!, id: 'inv_v1_2026-08', qbo: undefined }, { merge: false });
  const before = posted.length;
  await provider(deps, fetchFn).syncInvoices({ operatorId: OP, invoiceIds: ['inv_v1_2026-08'] });
  expect(posted.length).toBe(before);
});

it('ISOLATION: one bad invoice collects a sanitized error and never aborts the rest', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await seedLiveToken(deps);
  await seedInvoiceDoc(deps);
  await deps.db.doc(P.venue(OP, V1)).update({ accounting: { qboCustomerId: 'C9', qboItemId: 'I7' } });
  const { fetchFn } = makeFetch((url) => (url.includes('/invoice') ? { status: 200, body: { Invoice: { Id: 'QI1' } } } : { status: 200, body: {} }));
  const out = await provider(deps, fetchFn).syncInvoices({ operatorId: OP, invoiceIds: ['nope', 'inv_v1_2026-07'] });
  expect(out.synced).toBe(1);
  expect(out.errors).toEqual(['nope: not found']);
});
