import { beforeEach, expect, it, vi } from 'vitest';
import type { Caller } from '../../lib/callable.js';
import type { Invoice } from '@goldstar/platform';
import { NOW, OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { billingClock, generateInvoicesHandler, invoicesMarkPaidHandler, invoicesSendHandler, qboKeepAliveHandler } from './invoices.js';
import { writePeriodCsvs } from './csv.adapter.js';
import { accountingExportHandler } from './export.js';

const ADMIN: Caller = { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] };
const ATT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

// NOW is 2026-08-23 in America/Indiana/Indianapolis (EDT) → previous period 2026-07.
const PERIOD = '2026-07';

/** Seeds the venue's contract WITH the proposed v0.4.5 figures and its invoiceDay = today. */
async function seedBillableVenue(deps: ReturnType<typeof testDeps>, contractOver: Record<string, unknown> = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.venue(OP, V1)).update({
    contract: { model: 'per_ticket', perTicketFee: 250, taxRateBps: 700, terms: '', billingEmail: 'ap@x.example.com', invoiceDay: 23, ...contractOver },
  });
}

function periodTicket(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    operatorId: OP,
    venueId: V1,
    jobType: 'valet',
    status: 'closed',
    source: 'staff',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
    vehicle: { plate: 'ABC123', state: 'IN' },
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: { checkedInBy: 'att1' },
    times: { checkedInAt: '2026-07-10T18:00:00.000Z', closedAt: '2026-07-10T21:00:00.000Z' },
    damageReportIds: [],
    incidentIds: [],
    guestToken: 'AbCdEfGhIjKlMnOpQrStUv',
    ...over,
  };
}

it('GUARD: the archive cutoff must exceed the oldest un-invoiced billable ticket — a comment does not survive someone tuning the cutoff for storage cost', async () => {
  const { ARCHIVE_CUTOFF_DAYS } = await import('../tickets/archive.js');
  // Worst case: a ticket checked in on the 1st of a 31-day month, invoiced on invoiceDay 28 of
  // the NEXT month (31 + 28 = 59 days old), plus slack for a failed run retried across days.
  const OLDEST_BILLABLE_DAYS = 31 + 28 + 3;
  expect(
    ARCHIVE_CUTOFF_DAYS,
    `ARCHIVE_CUTOFF_DAYS (${ARCHIVE_CUTOFF_DAYS}) must stay > ${OLDEST_BILLABLE_DAYS}: generateInvoices bills from the LIVE tickets collection, and a shorter cutoff archives period tickets before they are invoiced — invoices silently UNDERCOUNT (venues underbilled with no error anywhere)`,
  ).toBeGreaterThan(OLDEST_BILLABLE_DAYS);
});

it('billingClock: day-of-month and previous period resolve in the OPERATOR timezone, across a year boundary', () => {
  // 2026-01-01T02:00Z is still 2025-12-31 in Indianapolis (EST, UTC-5).
  expect(billingClock('2026-01-01T02:00:00.000Z', 'America/Indiana/Indianapolis')).toEqual({ dayOfMonth: 31, previousPeriod: '2025-11' });
  // …and already January 1 in UTC → previous period December.
  expect(billingClock('2026-01-01T02:00:00.000Z', 'UTC')).toEqual({ dayOfMonth: 1, previousPeriod: '2025-12' });
  expect(billingClock(NOW, 'America/Indiana/Indianapolis').previousPeriod).toBe(PERIOD);
});

it('MONEY: generateInvoices bills LAST period only (polarity: ledger reads then) — draft invoice with exact per_ticket math, PDF written, audited', async () => {
  const deps = testDeps();
  await seedBillableVenue(deps);
  // Three period tickets, one cancelled (not billable), one from THIS month (out of period).
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a1')).set(periodTicket('01912345-7abc-7def-8123-4567890000a1'));
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a2')).set(periodTicket('01912345-7abc-7def-8123-4567890000a2'));
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a3')).set(periodTicket('01912345-7abc-7def-8123-4567890000a3', { status: 'cancelled', times: { checkedInAt: '2026-07-11T18:00:00.000Z', cancelledAt: '2026-07-11T19:00:00.000Z' } }));
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a4')).set(periodTicket('01912345-7abc-7def-8123-4567890000a4', { times: { checkedInAt: '2026-08-10T18:00:00.000Z' }, status: 'checked_in' }));
  // Ruling BF (a): a venue-billed RIDE in the period must NOT count — it already generated its
  // own venue-billed transaction, and counting it here would bill the venue TWICE for one service.
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a5')).set(periodTicket('01912345-7abc-7def-8123-4567890000a5', {
    jobType: 'passenger_ride', status: 'completed', parentTicketId: '01912345-7abc-7def-8123-456789fffff0',
    ride: { pickup: { geo: { lat: 1, lng: 2 } }, dropoff: { address: 'x', geo: { lat: 3, lng: 4 } }, passengers: 1, accessible: false, billTo: 'venue' },
  }));

  const out = await generateInvoicesHandler(deps);
  expect(out).toEqual({ generated: 1, errors: [] });

  const inv = (await deps.db.doc(P.invoice(OP, `inv_${V1}_${PERIOD}`)).get()).data() as Invoice;
  // 2 billable tickets × 250 = 500; 7% tax = 35; total 535.
  expect(inv.lines).toEqual([{ label: 'Valet service — per ticket', quantity: 2, unitAmount: 250, amount: 500 }]);
  expect(inv).toMatchObject({ subtotal: 500, tax: 35, total: 535, status: 'draft', period: PERIOD, currency: 'USD', pdfPath: `operators/${OP}/exports/invoices/inv_${V1}_${PERIOD}.pdf` });
  expect(inv.total).toBe(inv.subtotal + inv.tax);
  // T5 closeout: the figures USED are stamped on the artifact — a disputed invoice shows the
  // rate it was billed at, not just amounts a reader must reverse-engineer.
  expect((inv as Invoice & { figures?: unknown }).figures).toEqual({ model: 'per_ticket', perTicketFee: 250, taxRateBps: 700 });

  const [pdf] = await deps.storage.bucket().file(inv.pdfPath!).download();
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'accounting.generateInvoice').get();
  expect(logs.size).toBe(1);
});

it('IDEMPOTENT: a re-run generates nothing new and never re-renders over the existing invoice', async () => {
  const deps = testDeps();
  await seedBillableVenue(deps);
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a1')).set(periodTicket('01912345-7abc-7def-8123-4567890000a1'));
  expect((await generateInvoicesHandler(deps)).generated).toBe(1);
  const before = (await deps.db.doc(P.invoice(OP, `inv_${V1}_${PERIOD}`)).get()).data() as Invoice;
  expect((await generateInvoicesHandler(deps)).generated).toBe(0);
  const after = (await deps.db.doc(P.invoice(OP, `inv_${V1}_${PERIOD}`)).get()).data() as Invoice;
  expect(after).toEqual(before);
});

it('ISOLATION: a venue whose contract is missing its figures collects a named error; a not-due venue is skipped silently', async () => {
  const deps = testDeps();
  await seedBillableVenue(deps, { perTicketFee: undefined }); // due today, but figure-less
  const out = await generateInvoicesHandler(deps);
  expect(out.generated).toBe(0);
  expect(out.errors).toEqual([`inv_${V1}_${PERIOD}: failed_precondition`]);

  await deps.db.doc(P.venue(OP, V1)).update({ 'contract.invoiceDay': 5 }); // not today
  expect(await generateInvoicesHandler(deps)).toEqual({ generated: 0, errors: [] });
});

it('rev_share (Ruling BF b): shares BASE only — tips are staff income, tax remitted, fees pass-through — net of the proportional base portion of refunds', async () => {
  const deps = testDeps();
  await seedBillableVenue(deps, { model: 'rev_share', perTicketFee: undefined, revShareBps: 1000, taxRateBps: 0 });
  const tx = (id: string, over: Record<string, unknown>) => ({
    id, operatorId: OP, venueId: V1, ticketId: '01912345-7abc-7def-8123-4567890000a1', provider: 'stripe', providerRef: `pi_${id}`,
    kind: 'charge', status: 'succeeded', base: 0, tip: 0, tax: 0, fees: 0, total: 0, currency: 'USD', method: 'web', at: '2026-07-15T12:00:00.000Z', refunds: [], ...over,
  });
  // t1: base 8000 inside a 10000 total — the 1500 tip and 500 tax must NOT be shared.
  await deps.db.doc(P.tx(OP, 't1')).set(tx('t1', { base: 8000, tip: 1500, tax: 500, total: 10_000 }));
  // t2: fully refunded — proportional base portion 4000 → contributes 0.
  await deps.db.doc(P.tx(OP, 't2')).set(tx('t2', { base: 4000, tip: 800, tax: 200, total: 5000, status: 'refunded', refunds: [{ refundRef: 'r1', amount: 5000, at: '2026-07-16T12:00:00.000Z', reason: 'x' }] }));
  // t5: HALF refunded — refundedBase = 2500 × 4000/5000 = 2000 → contributes 2000.
  await deps.db.doc(P.tx(OP, 't5')).set(tx('t5', { base: 4000, tip: 800, tax: 200, total: 5000, refunds: [{ refundRef: 'r2', amount: 2500, at: '2026-07-16T12:00:00.000Z', reason: 'y' }] }));
  await deps.db.doc(P.tx(OP, 't3')).set(tx('t3', { base: 9999, total: 9999, status: 'failed' })); // never counts
  await deps.db.doc(P.tx(OP, 't4')).set(tx('t4', { base: 7777, total: 7777, at: '2026-08-01T12:00:00.000Z' })); // out of period

  await generateInvoicesHandler(deps);
  const inv = (await deps.db.doc(P.invoice(OP, `inv_${V1}_${PERIOD}`)).get()).data() as Invoice;
  // shareable base = 8000 + 0 + 2000 = 10000; 10% = 1000. (Gross would have been 12600 — the
  // difference IS the tip/tax that must never be shared.)
  expect(inv.lines[0]).toMatchObject({ unitAmount: 1000, amount: 1000 });
  expect(inv.total).toBe(1000);
});

// ---------- send / mark paid ----------

async function seedDraftInvoice(deps: ReturnType<typeof testDeps>) {
  await seedBillableVenue(deps);
  await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-4567890000a1')).set(periodTicket('01912345-7abc-7def-8123-4567890000a1'));
  await generateInvoicesHandler(deps);
  return `inv_${V1}_${PERIOD}`;
}

it('SEND: queues the invoice email to contract.billingEmail with schema-valid vars, flips draft → sent, dedupes the same-day double-click', async () => {
  const deps = testDeps();
  const invoiceId = await seedDraftInvoice(deps);

  const out = await invoicesSendHandler(deps, ADMIN, { invoiceId });
  expect(out).toEqual({ ok: true });

  const day = NOW.slice(0, 10);
  const outbound = (await deps.db.doc(P.outbound(`invoice_${invoiceId}_${day}`)).get()).data()!;
  expect(outbound).toMatchObject({ channel: 'email', to: 'ap@x.example.com', template: 'invoice', status: 'queued' });
  // Contract-checked vars: parse against the REAL email schema (sender injects operatorName).
  const { invoiceEmailVarsSchema } = await import('../messaging/templates/email/invoice.js');
  expect(invoiceEmailVarsSchema.safeParse({ ...(outbound.vars as Record<string, unknown>), operatorName: 'Goldstar' }).success).toBe(true);

  const inv = (await deps.db.doc(P.invoice(OP, invoiceId)).get()).data() as Invoice;
  expect(inv.status).toBe('sent');
  expect(inv.sentAt).toBe(NOW);

  // Same-day double-click: one email, still ok.
  await invoicesSendHandler(deps, ADMIN, { invoiceId });
  const emails = await deps.db.collection('outboundMessages').where('template', '==', 'invoice').get();
  expect(emails.size).toBe(1);
});

it('SEND guards: attendant denied; unknown invoice not_found; paid/void not sendable', async () => {
  const deps = testDeps();
  const invoiceId = await seedDraftInvoice(deps);
  await expect(invoicesSendHandler(deps, ATT, { invoiceId })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(invoicesSendHandler(deps, ADMIN, { invoiceId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  await deps.db.doc(P.invoice(OP, invoiceId)).update({ status: 'void' });
  await expect(invoicesSendHandler(deps, ADMIN, { invoiceId })).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('MARK PAID: draft|sent → paid with the given (or now) paidAt; paid/void rejected; attendant denied', async () => {
  const deps = testDeps();
  const invoiceId = await seedDraftInvoice(deps);
  await expect(invoicesMarkPaidHandler(deps, ATT, { invoiceId })).rejects.toMatchObject({ code: 'permission_denied' });
  await invoicesMarkPaidHandler(deps, ADMIN, { invoiceId, paidAt: '2026-08-20T00:00:00.000Z' });
  const inv = (await deps.db.doc(P.invoice(OP, invoiceId)).get()).data() as Invoice;
  expect(inv).toMatchObject({ status: 'paid', paidAt: '2026-08-20T00:00:00.000Z' });
  await expect(invoicesMarkPaidHandler(deps, ADMIN, { invoiceId })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- export ----------

it('EXPORT: writes both CSVs + a zip, returns a download URL, audits; attendant denied', async () => {
  const deps = testDeps();
  await seedDraftInvoice(deps);
  await expect(accountingExportHandler(deps, ATT, { period: PERIOD })).rejects.toMatchObject({ code: 'permission_denied' });

  const out = await accountingExportHandler(deps, ADMIN, { period: PERIOD });
  expect(out.downloadPath).toContain(`export-${PERIOD}.zip`);
  expect(out.downloadPath).toContain('token=');
  const [zip] = await deps.storage.bucket().file(`operators/${OP}/exports/export-${PERIOD}.zip`).download();
  expect(zip.subarray(0, 2).toString()).toBe('PK'); // zip magic
  const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'accounting.export').get();
  expect(logs.size).toBe(1);
});

it('CSV CONTENT: exact rows for seeded transactions, quoting included (the brief step-1 criterion)', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await deps.db.doc(P.tx(OP, 't1')).set({
    id: 't1', operatorId: OP, venueId: V1, ticketId: '01912345-7abc-7def-8123-4567890000a1', provider: 'stripe', providerRef: 'pi_1',
    kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', method: 'web',
    at: '2026-07-15T12:00:00.000Z', refunds: [{ refundRef: 'r1', amount: 500, at: '2026-07-16T12:00:00.000Z', reason: 'has,comma' }], destinationAccountId: 'acct_1',
  });
  await writePeriodCsvs(deps, OP, PERIOD);
  const [csv] = await deps.storage.bucket().file(`operators/${OP}/exports/transactions-${PERIOD}.csv`).download();
  expect(csv.toString()).toBe(
    'date,ticket,venue,method,base,tip,tax,fees,total,refunds,destination_account\n' +
      `2026-07-15T12:00:00.000Z,01912345-7abc-7def-8123-4567890000a1,${V1},web,1500,300,105,0,1905,500,acct_1\n`,
  );
});

// ---------- invoicePdfUrl (Ruling AB) ----------

it('AB: venue_user at the venue and admin both get the PDF URL; a FOREIGN venue_user is denied; no pdf → failed_precondition', async () => {
  const deps = testDeps();
  const invoiceId = await seedDraftInvoice(deps);
  const HOST: Caller = { uid: 'host1', operatorId: OP, roles: ['venue_user'], venueIds: [V1] };
  const FOREIGN: Caller = { uid: 'host2', operatorId: OP, roles: ['venue_user'], venueIds: ['v-other'] };

  const { invoicePdfUrlHandler } = await import('./invoices.js');
  const forHost = await invoicePdfUrlHandler(deps, HOST, { invoiceId });
  expect(forHost.downloadPath).toContain(`inv_${V1}_${PERIOD}.pdf`);
  expect(forHost.downloadPath).toContain('token=');
  expect((await invoicePdfUrlHandler(deps, ADMIN, { invoiceId })).downloadPath).toContain('token=');
  await expect(invoicePdfUrlHandler(deps, FOREIGN, { invoiceId })).rejects.toMatchObject({ code: 'permission_denied' });

  await deps.db.doc(P.invoice(OP, invoiceId)).update({ pdfPath: (await import('firebase-admin/firestore')).FieldValue.delete() });
  await expect(invoicePdfUrlHandler(deps, HOST, { invoiceId })).rejects.toMatchObject({ code: 'failed_precondition' });
});

// ---------- keep-alive ----------

it('KEEP-ALIVE: rotates a token inside the 20-day window, skips healthy and unconnected operators, and never lets one failure starve the loop', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  // Inside the window (expires in 10 days):
  await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).set({
    provider: 'quickbooks_online', refreshToken: 'rt_old',
    refreshTokenExpiresAt: new Date(Date.parse(NOW) + 10 * 86_400_000).toISOString(),
    rotatedAt: NOW, rotationCount: 1,
  });
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch signature
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
    return new Response(JSON.stringify({ token_type: 'bearer', access_token: 'at_ka', refresh_token: 'rt_ka', expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  expect(await qboKeepAliveHandler(deps, fetchFn)).toEqual({ refreshed: 1 });
  expect(calls).toHaveLength(1);
  const doc = (await deps.db.doc(P.integrationToken(OP, 'quickbooks_online')).get()).data()!;
  expect(doc.refreshToken).toBe('rt_ka');

  // Now healthy (rotated far into the future) — nothing to do.
  expect(await qboKeepAliveHandler(deps, fetchFn)).toEqual({ refreshed: 0 });
  expect(calls).toHaveLength(1);
});
