import { z } from 'zod';
import { isoDateSchema } from '@goldstar/platform';
import { emailShell, escapeHtml, oneLine } from './shell.js';

export const credentialExpiryEmailVarsSchema = z.object({
  operatorName: z.string().min(1),
  displayName: z.string().min(1),
  field: z.enum(['license', 'insurance']),
  days: z.number().int(),
  // isoDateSchema (@goldstar/platform) — matches the real producer's field type (eligibility.ts's
  // Credential.expiresAt) and rejects a non-ISO string at the validation boundary instead of letting
  // it silently render as the literal text "Invalid Date" below (Task 1 review, Minor-1).
  expiresAt: isoDateSchema,
});
export type CredentialExpiryEmailVars = z.infer<typeof credentialExpiryEmailVarsSchema>;

const FIELD_LABEL: Record<CredentialExpiryEmailVars['field'], string> = { license: "driver's license", insurance: 'insurance' };

/** Dispatch key is `credentialExpiring` (not `credential-expiry`) — it must match the literal
 * `template` string identity/eligibility.ts's `notifyExpiring` already writes onto real outboundMessages
 * docs (functions/src/modules/identity/eligibility.ts:115). The file is named credential-expiry.ts per
 * the task brief; the dispatch key in email.ts's renderEmail switch is the producer's real string. */
export function credentialExpiryEmail(vars: CredentialExpiryEmailVars): { subject: string; html: string } {
  const fieldLabel = FIELD_LABEL[vars.field];
  const dayWord = vars.days === 1 ? 'day' : 'days';
  const displayName = escapeHtml(vars.displayName);
  const operatorName = escapeHtml(vars.operatorName);
  // expiresAt is a server-computed isoDateSchema value (eligibility.ts), not guest/staff-entered
  // free text, but it's still escaped here for defense-in-depth consistency with every other
  // interpolated value in this file.
  const expiresDate = escapeHtml(
    new Date(vars.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
  );
  const subject = oneLine(`Action needed: ${vars.displayName}'s ${fieldLabel} expires in ${vars.days} ${dayWord}`);
  const bodyHtml = `
<p style="margin:0 0 16px;">Hi there,</p>
<p style="margin:0 0 16px;"><strong>${displayName}</strong>'s ${fieldLabel} on file with <strong>${operatorName}</strong> expires on <strong>${expiresDate}</strong> — that's in ${vars.days} ${dayWord}.</p>
<p style="margin:0 0 16px;">Please follow up with them to renew it before it expires. An expired ${fieldLabel} can make them ineligible for certain shift assignments until it's updated.</p>`;
  return { subject, html: emailShell({ preheader: subject, bodyHtml }) };
}
