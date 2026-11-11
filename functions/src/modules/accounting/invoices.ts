import PDFDocument from 'pdfkit';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { CallableParsedInput, CallableOutput, Invoice, IntegrationToken, Operator, Ticket, Transaction, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { requireVenueUserOrStaff } from '../../lib/venueAccess.js';
import { computeInvoiceAmounts, figuresFrom, type PeriodActivity } from './invoiceMath.js';
import { periodBounds } from './csv.adapter.js';
import { saveWithDownloadUrl, downloadUrlFor } from './storage.js';
import { getQboAccessToken } from './qboToken.js';

/** Money formatting for the PDF — integer cents in, "$12.50" out. Display only. */
function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Day-of-month and previous `YYYY-MM` period in the OPERATOR's timezone (Ruling AL heritage: never UTC-assume wall-clock facts). */
export function billingClock(nowIso: string, timeZone: string): { dayOfMonth: number; previousPeriod: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowIso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const y = get('year');
  const m = get('month');
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return { dayOfMonth: get('day'), previousPeriod: `${prevY}-${String(prevM).padStart(2, '0')}` };
}

/**
 * Renders the invoice PDF (operator branding header, venue, period, lines table, totals) and
 * returns the buffer. Display-only — every number is formatted from the ALREADY-COMPUTED
 * integer-cents Invoice; nothing here does arithmetic.
 */
export function renderInvoicePdf(invoice: Invoice, operator: Operator, venue: Venue, taxRateBps?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    doc.fontSize(20).text(operator.branding.displayName, { continued: false });
    doc.fontSize(10).fillColor('#666666').text(`Invoice ${invoice.id} — ${invoice.period}`);
    doc.moveDown().fillColor('#000000').fontSize(12).text(venue.name);
    doc.fontSize(10).fillColor('#666666').text(`Billing period: ${invoice.period}`).moveDown();

    doc.fillColor('#000000').fontSize(10);
    for (const line of invoice.lines) {
      doc.text(`${line.label}  —  ${line.quantity} × ${fmtMoney(line.unitAmount, invoice.currency)}  =  ${fmtMoney(line.amount, invoice.currency)}`);
    }
    doc.moveDown();
    doc.text(`Subtotal: ${fmtMoney(invoice.subtotal, invoice.currency)}`);
    doc.text(`Tax${taxRateBps !== undefined ? ` (${(taxRateBps / 100).toFixed(2)}%)` : ''}: ${fmtMoney(invoice.tax, invoice.currency)}`);
    doc.fontSize(12).text(`Total: ${fmtMoney(invoice.total, invoice.currency)}`);
    doc.end();
  });
}

/**
 * `generateInvoices` core (Plan 7 Task 5): for every active operator, for every venue whose
 * `contract.invoiceDay` is TODAY in the operator's timezone, generate the PREVIOUS month's
 * invoice as a draft with its PDF.
 *
 * POLARITY (the rule this function exists to honor): the line amounts are LEDGER — computed
 * over period-bounded queries (tickets by `times.checkedInAt`, transactions by `at`, both
 * single-field ranges, grouped by venue in code) — a snapshot of the period AS IT WAS. The
 * only live reads are guards (does the invoice already exist).
 *
 * BILLABLE SOURCE COUPLING, load-bearing AND GUARDED: billables come from the LIVE tickets
 * collection, which is safe only while `tickets/archive.ts`'s ARCHIVE_CUTOFF_DAYS (90) exceeds
 * the oldest instant a billable ticket can still be un-invoiced (~62 days). The inequality is
 * asserted by a test in invoices.test.ts — tuning the cutoff below the floor fails loudly with
 * the undercount named instead of silently under-billing.
 *
 * Idempotent per (venue, period): deterministic id `inv_{venueId}_{period}` + an existence
 * check before any work + `.create` (code-6 swallow) as the backstop — a re-run or a
 * concurrent duplicate run never produces a second invoice or re-renders the PDF over a sent
 * one. Per-venue failures (e.g. a contract missing its figures) collect into `errors` and
 * never abort the other venues.
 */
export async function generateInvoicesHandler(deps: Deps): Promise<{ generated: number; errors: string[] }> {
  let generated = 0;
  const errors: string[] = [];
  const ops = await deps.db.collection('operators').where('status', '==', 'active').get();
  for (const opDoc of ops.docs) {
    const op = opDoc.data() as Operator;
    const { dayOfMonth, previousPeriod: period } = billingClock(deps.now(), op.timezone);
    const venues = await deps.db.collection(`operators/${op.id}/venues`).get();
    const due = venues.docs.map((d) => d.data() as Venue).filter((v) => v.contract.invoiceDay === dayOfMonth);
    if (due.length === 0) continue;

    const { start, end } = periodBounds(period);
    const [ticketSnap, txSnap] = await Promise.all([
      deps.db.collection(`operators/${op.id}/tickets`).where('times.checkedInAt', '>=', start).where('times.checkedInAt', '<', end).get(),
      deps.db.collection(`operators/${op.id}/transactions`).where('at', '>=', start).where('at', '<', end).get(),
    ]);
    const activityByVenue = new Map<string, PeriodActivity>();
    const activity = (venueId: string) => {
      let a = activityByVenue.get(venueId);
      if (!a) {
        a = { ticketCount: 0, shareableBase: 0 };
        activityByVenue.set(venueId, a);
      }
      return a;
    };
    for (const d of ticketSnap.docs) {
      const t = d.data() as Ticket;
      // Ruling BF (a): VALET only — a venue-billed job already generates its own venue-billed
      // transaction; counting it here too would bill the venue twice for one service.
      if (t.jobType === 'valet' && t.status !== 'cancelled') activity(t.venueId).ticketCount++;
    }
    for (const d of txSnap.docs) {
      const t = d.data() as Transaction;
      if (t.status === 'succeeded' || t.status === 'refunded') {
        // Ruling BF (b): base only — tips are staff income, tax is remitted, fees pass through.
        // Refunds carry no base split, so the base portion is attributed PROPORTIONALLY
        // (refundedTotal × base/total) — a decision, documented as one.
        const refundedTotal = t.refunds.reduce((s, r) => s + r.amount, 0);
        const refundedBase = t.total > 0 ? Math.round((refundedTotal * t.base) / t.total) : 0;
        activity(t.venueId).shareableBase += t.base - refundedBase;
      }
    }

    for (const venue of due) {
      const id = `inv_${venue.id}_${period}`;
      try {
        const ref = deps.db.doc(P.invoice(op.id, id));
        if ((await ref.get()).exists) continue; // idempotent re-run
        const figures = figuresFrom(venue.contract);
        const amounts = computeInvoiceAmounts(figures, activityByVenue.get(venue.id) ?? { ticketCount: 0, shareableBase: 0 });
        const invoice: Invoice = {
          id,
          operatorId: op.id,
          venueId: venue.id,
          period,
          ...amounts,
          currency: op.currency,
          status: 'draft',
          createdAt: deps.now(),
        };
        // T5 closeout ruling: the figures actually USED are stamped on the invoice doc — a wrong
        // rate becomes visible on the artifact itself (billed at 4.50 when the contract says
        // 4.00) instead of requiring someone to reconstruct contract state at generation time.
        // Unpublished Admin-side field (posPush/qbo precedent); period-frozen contract terms —
        // the real fix — is the named Plan 8 item.
        const pdfPath = `operators/${op.id}/exports/invoices/${id}.pdf`;
        const pdf = await renderInvoicePdf({ ...invoice, pdfPath }, op, venue, figures.taxRateBps);
        await saveWithDownloadUrl(deps, pdfPath, pdf, 'application/pdf');
        await ref.create({ ...invoice, pdfPath, figures }).catch((e: unknown) => {
          if ((e as { code?: number }).code !== 6) throw e; // concurrent duplicate run — first writer wins
        });
        await audit(deps, { operatorId: op.id, actorUid: 'system', action: 'accounting.generateInvoice', target: id, after: { venueId: venue.id, period, total: invoice.total } });
        generated++;
      } catch (e) {
        // Sanitized per-venue failure — a contract missing its figures (failed_precondition)
        // must not silence every other venue's invoice.
        errors.push(`${id}: ${(e as { code?: string }).code ?? 'error'}`);
      }
    }
  }
  return { generated, errors };
}

export const generateInvoices = onSchedule({ schedule: 'every day 04:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await generateInvoicesHandler(makeDeps());
});

const INVOICE_ADMIN_ROLES = ['owner', 'admin', 'platform_admin'];

/**
 * `invoicesSend`: queues the invoice email to the venue's `contract.billingEmail` (through the
 * outboundMessages pipeline — the sender injects operatorName and validates the full vars
 * against `invoiceEmailVarsSchema`) and flips draft → sent. `portalUrl` carries the PDF's
 * download-token URL (https in production; the emulator's http URL never reaches the sender in
 * tests, which assert the queued doc). Outbox id is deterministic per (invoice, calendar day):
 * a double-click queues once; a deliberate next-day resend queues again.
 */
export async function invoicesSendHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'invoicesSend'>): Promise<CallableOutput<'invoicesSend'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => INVOICE_ADMIN_ROLES.includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);
  const ref = deps.db.doc(P.invoice(c.operatorId, input.invoiceId));
  const invoice = (await ref.get()).data() as Invoice | undefined;
  if (!invoice) throw err('not_found', 'invoice');
  if (invoice.status !== 'draft' && invoice.status !== 'sent') throw err('failed_precondition', 'invoice is not sendable');
  const venue = (await deps.db.doc(P.venue(c.operatorId, invoice.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');

  const portalUrl = invoice.pdfPath ? await downloadUrlFor(deps, invoice.pdfPath) : undefined;
  const vars = {
    venueName: venue.name,
    invoiceId: invoice.id,
    period: invoice.period,
    lines: invoice.lines,
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    currency: invoice.currency,
    ...(portalUrl?.startsWith('https://') ? { portalUrl } : {}),
  };
  const day = deps.now().slice(0, 10);
  const outboxId = `invoice_${invoice.id}_${day}`;
  await deps.db
    .doc(P.outbound(outboxId))
    .create({ id: outboxId, channel: 'email', operatorId: c.operatorId, venueId: invoice.venueId, ticketId: '', to: venue.contract.billingEmail, template: 'invoice', vars, status: 'queued', attempts: 0, createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e; // same-day double-click — one email
    });
  await ref.update({ status: 'sent', sentAt: deps.now() });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'accounting.invoiceSend', target: invoice.id, after: { venueId: invoice.venueId } });
  return { ok: true };
}

export const invoicesSend = defineCallable('invoicesSend', {}, invoicesSendHandler);

/** `invoicesMarkPaid`: draft|sent → paid (a check can arrive before the email went out). */
export async function invoicesMarkPaidHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'invoicesMarkPaid'>): Promise<CallableOutput<'invoicesMarkPaid'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => INVOICE_ADMIN_ROLES.includes(r))) throw err('permission_denied');
  await requireActiveOperator(deps, c.operatorId);
  const ref = deps.db.doc(P.invoice(c.operatorId, input.invoiceId));
  const invoice = (await ref.get()).data() as Invoice | undefined;
  if (!invoice) throw err('not_found', 'invoice');
  if (invoice.status !== 'draft' && invoice.status !== 'sent') throw err('failed_precondition', 'invoice is not payable');
  await ref.update({ status: 'paid', paidAt: input.paidAt ?? deps.now() });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'accounting.invoiceMarkPaid', target: invoice.id, after: { paidAt: input.paidAt ?? deps.now() } });
  return { ok: true };
}

export const invoicesMarkPaid = defineCallable('invoicesMarkPaid', {}, invoicesMarkPaidHandler);

/**
 * `invoicePdfUrl` (v0.4.5, Ruling AB): the venue host's path to an invoice PDF — a callable that
 * verifies `invoice.venueId` against the caller's claim server-side (the §9.1 enforcement
 * point), never a storage-rules match (the rules sit at the expression ceiling in the hot
 * path). The dual gate admits the hotel/venue portal's venue_user AND operator staff (the
 * dashboard invoices page) — same shape as the PMS callables. Returns the PDF's download-token
 * capability URL (see storage.ts for the signed-URL deviation note).
 */
export async function invoicePdfUrlHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'invoicePdfUrl'>): Promise<CallableOutput<'invoicePdfUrl'>> {
  const pre = requireOperator(caller);
  await requireActiveOperator(deps, pre.operatorId);
  const invoice = (await deps.db.doc(P.invoice(pre.operatorId, input.invoiceId)).get()).data() as Invoice | undefined;
  if (!invoice) throw err('not_found', 'invoice');
  await requireVenueUserOrStaff(deps, caller, invoice.venueId);
  if (!invoice.pdfPath) throw err('failed_precondition', 'invoice has no pdf');
  return { downloadPath: await downloadUrlFor(deps, invoice.pdfPath) };
}

export const invoicePdfUrl = defineCallable('invoicePdfUrl', {}, invoicePdfUrlHandler);

/** Refresh QBO tokens well before the 100-day refresh-token expiry for operators gone quiet. */
const KEEP_ALIVE_WINDOW_MS = 20 * 86_400_000;

/**
 * QBO keep-alive (the token-model ruling's second half): a quiet operator — no invoices for a
 * quarter — must not silently pass Intuit's 100-day refresh-token expiry, after which the only
 * recovery is a human re-authorizing through OAuth consent. Iterates operators directly (small
 * collection) rather than a collectionGroup over integrationTokens — no new index surface.
 */
export async function qboKeepAliveHandler(deps: Deps, fetchFn: typeof fetch = fetch): Promise<{ refreshed: number }> {
  let refreshed = 0;
  const ops = await deps.db.collection('operators').get();
  for (const opDoc of ops.docs) {
    const op = opDoc.data() as Operator;
    const token = (await deps.db.doc(P.integrationToken(op.id, 'quickbooks_online')).get()).data() as IntegrationToken | undefined;
    if (!token?.refreshToken) continue;
    if (Date.parse(token.refreshTokenExpiresAt) - Date.parse(deps.now()) > KEEP_ALIVE_WINDOW_MS) continue;
    try {
      const integ = (await deps.db.doc(P.integration(op.id, 'quickbooks_online')).get()).data() as { secretRef?: string } | undefined;
      const secretRef = integ?.secretRef ?? `${op.id.toUpperCase()}_QBO`;
      // Force a rotation by clearing the cached access token first — getQboAccessToken refreshes
      // (and rotates) only when the access token is stale, and a keep-alive's whole job is the
      // rotation.
      await deps.db.doc(P.integrationToken(op.id, 'quickbooks_online')).update({ accessToken: null });
      await getQboAccessToken(deps, op.id, { clientId: deps.secrets.get(`${secretRef}_CLIENT_ID`), clientSecret: deps.secrets.get(`${secretRef}_CLIENT_SECRET`) }, fetchFn);
      refreshed++;
    } catch {
      // Surfaced via the integration doc by the next health check; a keep-alive must never throw
      // its way out of the loop and starve the remaining operators.
    }
  }
  return { refreshed };
}

export const qboTokenKeepAlive = onSchedule({ schedule: 'every day 05:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await qboKeepAliveHandler(makeDeps());
});
