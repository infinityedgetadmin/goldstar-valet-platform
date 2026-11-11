import { z } from 'zod';
import { BRAND_TEXT_SECONDARY, button, emailShell, escapeHtml, httpsUrlSchema, oneLine } from './shell.js';

export const invitationEmailVarsSchema = z.object({
  token: z.string().min(1),
  operatorName: z.string().min(1),
  inviteeName: z.string().min(1).optional(),
  acceptUrl: httpsUrlSchema,
});
export type InvitationEmailVars = z.infer<typeof invitationEmailVarsSchema>;

/**
 * Verified real production staff-app URL scheme — re-derived from the mobile repo, not assumed.
 * goldstar-mobile/config/operators/goldstar.json sets `scheme: "goldstarvalet"`; goldstar-mobile/env.js's
 * `build.SCHEME` formula is `${operator.scheme}${APP_TARGET === 'staff' ? 'staff' : ''}${suffix}`,
 * where `suffix = APP_ENV === 'production' ? '' : '.' + (staging ? 'staging' : 'dev')`. For the real
 * production staff build (APP_TARGET='staff', APP_ENV='production') that's `goldstarvalet` + `staff` +
 * `''` = `goldstarvaletstaff` — the brief's original guess turns out to be exactly right, confirmed
 * independently here rather than taken on faith.
 */
const STAFF_APP_SCHEME = 'goldstarvaletstaff';

/** Invite tokens (invite.ts's `randomBytes(24).toString('base64url')`) are already URL-safe —
 * `encodeURIComponent` is defensive belt-and-suspenders, not because base64url needs escaping. */
function deepLinkFor(token: string): string {
  return `${STAFF_APP_SCHEME}://accept-invite?token=${encodeURIComponent(token)}`;
}

export function invitationEmail(vars: InvitationEmailVars): { subject: string; html: string } {
  const operatorName = escapeHtml(vars.operatorName);
  const greeting = vars.inviteeName ? `Hi ${escapeHtml(vars.inviteeName)},` : 'Hello,';
  const deepLink = deepLinkFor(vars.token);
  const subject = oneLine(`You're invited to join ${vars.operatorName} on Goldstar Valet`);
  const bodyHtml = `
<p style="margin:0 0 16px;">${greeting}</p>
<p style="margin:0 0 16px;"><strong>${operatorName}</strong> has invited you to join their team on Goldstar Valet. Accept the invitation below to set up your account and get started.</p>
<div style="margin:28px 0;">${button(vars.acceptUrl, 'Accept Invitation')}</div>
<p style="margin:0 0 8px;font-size:13px;color:${BRAND_TEXT_SECONDARY};">Already have the Goldstar Valet Staff app installed on your phone? <a href="${escapeHtml(deepLink)}" style="color:${BRAND_TEXT_SECONDARY};text-decoration:underline;">Open it directly</a> to accept from there instead.</p>
<p style="margin:24px 0 0;font-size:13px;color:${BRAND_TEXT_SECONDARY};">This invitation link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.</p>`;
  return { subject, html: emailShell({ preheader: `${vars.operatorName} invited you to join their team on Goldstar Valet.`, bodyHtml }) };
}
