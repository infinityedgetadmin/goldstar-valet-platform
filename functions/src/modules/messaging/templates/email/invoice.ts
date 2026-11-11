import { z } from 'zod';
import { currencySchema, moneySchema } from '@goldstar/platform';
import { BRAND_TEXT_SECONDARY, button, emailShell, escapeHtml, formatMoney, httpsUrlSchema, oneLine } from './shell.js';

// Mirrors invoiceSchema's `lines` shape (@goldstar/platform, src/schemas/invoice.ts): label, quantity,
// unitAmount (money, cents), amount (money, cents) — amount is the pre-computed line total, not
// re-derived here, matching how the schema itself stores it (not `quantity * unitAmount`).
// `moneySchema`/`currencySchema` imported from @goldstar/platform rather than reinvented — see
// claim-update.ts's comment (Task 1 review, Finding M2) for why the reinvented version was wrong.
const invoiceLineSchema = z.object({ label: z.string().min(1), quantity: z.number(), unitAmount: moneySchema, amount: moneySchema });

export const invoiceEmailVarsSchema = z.object({
  operatorName: z.string().min(1),
  venueName: z.string().min(1),
  invoiceId: z.string().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  lines: z.array(invoiceLineSchema).min(1),
  subtotal: moneySchema,
  tax: moneySchema,
  total: moneySchema,
  currency: currencySchema,
  dueDate: z.string().min(1).optional(),
  portalUrl: httpsUrlSchema.optional(),
});
export type InvoiceEmailVars = z.infer<typeof invoiceEmailVarsSchema>;

function formatPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function lineRow(l: z.infer<typeof invoiceLineSchema>, currency: string): string {
  return `<tr>
<td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;">${escapeHtml(l.label)}</td>
<td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;text-align:right;">${l.quantity}</td>
<td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;text-align:right;">${escapeHtml(formatMoney(l.unitAmount, currency))}</td>
<td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;text-align:right;">${escapeHtml(formatMoney(l.amount, currency))}</td>
</tr>`;
}

function summaryRow(label: string, cents: number, currency: string, bold = false): string {
  const weight = bold ? '700' : '400';
  return `<tr>
<td colspan="3" style="padding:6px 0;font-size:14px;text-align:right;font-weight:${weight};">${escapeHtml(label)}</td>
<td style="padding:6px 0;font-size:14px;text-align:right;font-weight:${weight};">${escapeHtml(formatMoney(cents, currency))}</td>
</tr>`;
}

export function invoiceEmail(vars: InvoiceEmailVars): { subject: string; html: string } {
  const operatorName = escapeHtml(vars.operatorName);
  const venueName = escapeHtml(vars.venueName);
  const periodLabel = formatPeriod(vars.period);
  const subject = oneLine(`Your ${vars.operatorName} invoice for ${periodLabel} is ready`);
  const rows = vars.lines.map((l) => lineRow(l, vars.currency)).join('');
  const dueHtml = vars.dueDate ? `<p style="margin:0 0 16px;font-size:14px;">Due date: <strong>${escapeHtml(vars.dueDate)}</strong></p>` : '';
  const ctaHtml = vars.portalUrl ? `<div style="margin:24px 0;">${button(vars.portalUrl, 'View & Pay Invoice')}</div>` : '';
  const bodyHtml = `
<p style="margin:0 0 16px;">Hello,</p>
<p style="margin:0 0 16px;">Your <strong>${operatorName}</strong> invoice for <strong>${venueName}</strong> — <strong>${escapeHtml(periodLabel)}</strong> — is ready.</p>
${dueHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;font-family:Helvetica,Arial,sans-serif;">
<tr>
<td style="padding:0 0 8px;font-size:12px;color:${BRAND_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.04em;">Item</td>
<td style="padding:0 0 8px;font-size:12px;color:${BRAND_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.04em;text-align:right;">Qty</td>
<td style="padding:0 0 8px;font-size:12px;color:${BRAND_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.04em;text-align:right;">Unit</td>
<td style="padding:0 0 8px;font-size:12px;color:${BRAND_TEXT_SECONDARY};text-transform:uppercase;letter-spacing:0.04em;text-align:right;">Amount</td>
</tr>
${rows}
${summaryRow('Subtotal', vars.subtotal, vars.currency)}
${summaryRow('Tax', vars.tax, vars.currency)}
${summaryRow('Total', vars.total, vars.currency, true)}
</table>
${ctaHtml}
<p style="margin:24px 0 0;font-size:13px;color:${BRAND_TEXT_SECONDARY};">Invoice reference: ${escapeHtml(vars.invoiceId)}</p>`;
  return { subject, html: emailShell({ preheader: subject, bodyHtml }) };
}
