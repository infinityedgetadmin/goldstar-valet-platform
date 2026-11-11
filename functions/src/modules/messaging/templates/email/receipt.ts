import { z } from 'zod';
import { CHARGE_LABELS, currencySchema, moneySchema } from '@goldstar/platform';
import { BRAND_TEXT_SECONDARY, button, emailShell, escapeHtml, formatMoney, httpsUrlSchema, oneLine } from './shell.js';

// Plan 6 (guest account, guestEmailReceipt): a guest-requested EMAIL copy of a ticket's payment
// receipt — distinct from the automatic 'receipt' SMS template (messaging/templates.ts, sent by
// applyEvent.ts on transition-to-paid). `operatorName` is part of this schema (not just merged in by
// email.ts's buildEmailVars) because sendEmailHandler validates the FULL merged vars object against
// this schema — same convention as invoice.ts/claim-update.ts, both of which declare it too.
export const receiptEmailVarsSchema = z.object({
  operatorName: z.string().min(1),
  venueName: z.string().min(1),
  ticketRef: z.string().min(1),
  paidAt: z.string().min(1),
  base: moneySchema,
  tip: moneySchema,
  tax: moneySchema,
  fees: moneySchema,
  total: moneySchema,
  currency: currencySchema,
  receiptUrl: httpsUrlSchema.optional(),
  // Carried fix (Plan 7 T3 window): the base line used to read "Valet" for EVERY job type, so a
  // drive-home or ride guest was told their trip fare was valet. Optional so already-queued
  // outboundMessages docs (and any producer not yet threading it) stay schema-valid — absent
  // falls back to 'Valet', which was the only behavior before.
  jobType: z.enum(['valet', 'drive_home', 'passenger_ride']).optional(),
});
export type ReceiptEmailVars = z.infer<typeof receiptEmailVarsSchema>;

function formatPaidAt(iso: string): string {
  const d = new Date(iso);
  // A malformed/unparseable date must never throw inside a render path — fall back to the raw
  // string rather than surfacing 'Invalid Date' or throwing out of Intl/toLocaleDateString.
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function lineRow(label: string, cents: number, currency: string): string {
  return `<tr>
<td style="padding:6px 0;font-size:14px;">${escapeHtml(label)}</td>
<td style="padding:6px 0;font-size:14px;text-align:right;">${escapeHtml(formatMoney(cents, currency))}</td>
</tr>`;
}

export function receiptEmail(vars: ReceiptEmailVars): { subject: string; html: string } {
  const operatorName = escapeHtml(vars.operatorName);
  const venueName = escapeHtml(vars.venueName);
  const subject = oneLine(`Your ${vars.operatorName} receipt — ${vars.venueName}`);
  const rows = [
    // Ruling AN: the base-line label comes from the shared CHARGE_LABELS map — goldstar-mobile's
    // chargeLabel() consumes the same constant, so the two surfaces cannot drift apart again.
    lineRow(CHARGE_LABELS[vars.jobType ?? 'valet'], vars.base, vars.currency),
    lineRow('Tip', vars.tip, vars.currency),
    lineRow('Tax', vars.tax, vars.currency),
    ...(vars.fees > 0 ? [lineRow('Fees', vars.fees, vars.currency)] : []),
  ].join('');
  const ctaHtml = vars.receiptUrl ? `<div style="margin:24px 0;">${button(vars.receiptUrl, 'View Full Receipt')}</div>` : '';
  const bodyHtml = `
<p style="margin:0 0 16px;">Hello,</p>
<p style="margin:0 0 16px;">Here's your receipt for <strong>${venueName}</strong> on <strong>${escapeHtml(formatPaidAt(vars.paidAt))}</strong>.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;font-family:Helvetica,Arial,sans-serif;">
${rows}
<tr>
<td style="padding:8px 0 0;font-size:14px;font-weight:700;border-top:1px solid #e5e7eb;">Total</td>
<td style="padding:8px 0 0;font-size:14px;font-weight:700;text-align:right;border-top:1px solid #e5e7eb;">${escapeHtml(formatMoney(vars.total, vars.currency))}</td>
</tr>
</table>
${ctaHtml}
<p style="margin:24px 0 0;font-size:13px;color:${BRAND_TEXT_SECONDARY};">Ticket reference: ${escapeHtml(vars.ticketRef)} &middot; ${operatorName}</p>`;
  return { subject, html: emailShell({ preheader: subject, bodyHtml }) };
}
