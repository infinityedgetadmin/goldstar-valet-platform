import { z } from 'zod';
import { currencySchema, moneySchema } from '@goldstar/platform';
import { BRAND_TEXT_SECONDARY, button, emailShell, escapeHtml, formatMoney, httpsUrlSchema, oneLine } from './shell.js';

// Mirrors claimSchema's `status` enum (@goldstar/platform, src/schemas/claim.ts) — kept as a local
// literal union rather than importing the zod enum directly so this template has no runtime
// dependency on which claim-producing task (not yet built) ends up queuing these emails. Unlike the
// status enum, `moneySchema`/`currencySchema` below are domain-neutral (schemas/common.ts, not
// claim-specific) — importing them creates no such coupling, so they're imported directly rather than
// reinvented (Task 1 review, Finding M2: the reinvented `z.string().length(3)` currency check admitted
// non-ISO values like 'usd' or '123' that passed validation here but threw a RangeError later, inside
// `formatMoney`'s `Intl.NumberFormat`, at render time instead of failing cleanly at `.parse()`).
const CLAIM_STATUSES = ['intake', 'under_review', 'accepted', 'denied', 'settled'] as const;

export const claimUpdateEmailVarsSchema = z.object({
  operatorName: z.string().min(1),
  guestName: z.string().min(1).optional(),
  claimId: z.string().min(1),
  status: z.enum(CLAIM_STATUSES),
  notes: z.string().min(1).optional(),
  amountCents: moneySchema.optional(),
  currency: currencySchema.optional(),
  portalUrl: httpsUrlSchema.optional(),
});
export type ClaimUpdateEmailVars = z.infer<typeof claimUpdateEmailVarsSchema>;

const STATUS_COPY: Record<ClaimUpdateEmailVars['status'], { headline: string; detail: string }> = {
  intake: { headline: "We've received your damage claim", detail: "It's now in our system and will be reviewed by our team shortly." },
  under_review: { headline: 'Your damage claim is under review', detail: "Our team is looking into the details you provided. We'll follow up as soon as a decision is made." },
  accepted: { headline: 'Your damage claim has been accepted', detail: "We've accepted your claim. See the details below for next steps." },
  denied: { headline: 'Your damage claim has been denied', detail: 'After careful review, we were unable to approve your claim. If you have questions, please reach out to us directly.' },
  settled: { headline: 'Your damage claim has been settled', detail: 'Your claim is now closed. Details of the settlement are below.' },
};

export function claimUpdateEmail(vars: ClaimUpdateEmailVars): { subject: string; html: string } {
  const operatorName = escapeHtml(vars.operatorName);
  const greeting = vars.guestName ? `Hi ${escapeHtml(vars.guestName)},` : 'Hello,';
  const copy = STATUS_COPY[vars.status];
  const subject = oneLine(`${copy.headline} — ${vars.operatorName}`);
  const amountHtml =
    vars.amountCents !== undefined && vars.currency !== undefined
      ? `<p style="margin:0 0 16px;">Settlement amount: <strong>${escapeHtml(formatMoney(vars.amountCents, vars.currency))}</strong></p>`
      : '';
  const notesHtml = vars.notes ? `<p style="margin:0 0 16px;padding:12px 16px;background:#f4f2f1;border-radius:8px;font-size:14px;">${escapeHtml(vars.notes)}</p>` : '';
  const ctaHtml = vars.portalUrl ? `<div style="margin:24px 0;">${button(vars.portalUrl, 'View Claim Details')}</div>` : '';
  const bodyHtml = `
<p style="margin:0 0 16px;">${greeting}</p>
<p style="margin:0 0 16px;"><strong>${copy.headline}.</strong> ${copy.detail}</p>
${amountHtml}
${notesHtml}
${ctaHtml}
<p style="margin:24px 0 0;font-size:13px;color:${BRAND_TEXT_SECONDARY};">Claim reference: ${escapeHtml(vars.claimId)} &middot; ${operatorName}</p>`;
  return { subject, html: emailShell({ preheader: subject, bodyHtml }) };
}
