import { z } from 'zod';
import { accent, brand, surface, text } from '@goldstar/platform/tokens';

// Brand hex values pulled directly from @goldstar/platform's design tokens (src/tokens/colors.ts,
// published at the `@goldstar/platform/tokens` subpath export) — never hand-typed, so a future
// rebrand only has to change one place. brand[500] is the same '#ab6034' bronze the dashboard/mobile
// primary color uses; accent[500] is the '#ffc30c' gold.
export const BRAND_PRIMARY = brand[500];
export const BRAND_PRIMARY_DARK = brand[700];
export const BRAND_ACCENT = accent[500];
export const BRAND_TEXT = text.primary;
export const BRAND_TEXT_SECONDARY = text.secondary;
export const BRAND_SURFACE = surface.secondary;
export const BRAND_WHITE = surface.primary;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value being interpolated into an email's HTML body. Every template var that can carry
 * guest/staff-supplied text (names, notes, free-text descriptions) MUST be passed through this
 * before landing in `bodyHtml` — these strings ultimately originate from public-facing forms
 * (identity invite `displayName`, claim `guestContact.name`/`description`, etc.), and an HTML email
 * client will render unescaped markup, not just fail to escape it like a plain-text channel would. */
export function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Collapses a string to one line for use in an email `subject` — defends against header-injection
 * style tricks (embedded \r\n) from the same guest/staff-supplied strings escapeHtml protects the
 * body from. Subjects are plain text, so this — not escapeHtml — is the right guard here. */
export function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

/** moneySchema (@goldstar/platform) stores amounts as non-negative integer cents; currencySchema is
 * a 3-letter ISO 4217 code. Shared by claim-update and invoice, the two templates that render money. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/**
 * `z.string().url()` alone accepts any scheme the WHATWG URL parser recognizes, including
 * `javascript:`/`data:` — `escapeHtml`/`button()` HTML-entity-escape a URL's characters, not its
 * scheme, so an unrestricted `.url()` field would still render as a clickable
 * `<a href="javascript:...">`. Every template field that becomes an `href` (`acceptUrl`, `portalUrl`)
 * uses this instead — restricts to `https://` at the validation boundary (Task 1 review, Minor-2).
 */
export const httpsUrlSchema = z
  .string()
  .url()
  .refine((v) => v.startsWith('https://'), { message: 'must be an https:// URL' });

/** Table-based CTA button — email clients (Outlook desktop in particular) don't reliably support
 * padding/border-radius on a plain `<a>`, so the button is a 1x1 table cell instead. */
export function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background:${BRAND_PRIMARY};"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:${BRAND_WHITE};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a></td></tr></table>`;
}

/** Full HTML document for a transactional email — table-based layout, 600px content column, inline
 * styles only (email clients strip/ignore `<style>` blocks and most CSS properties on classes).
 * `bodyHtml` is trusted, already-composed markup from a template's own escapeHtml calls — this
 * function does not escape it. */
export function emailShell(i: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"></head>
<body style="margin:0;padding:0;background:${BRAND_SURFACE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(i.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_SURFACE};padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${BRAND_WHITE};border-radius:12px;overflow:hidden;">
<tr><td style="background:${BRAND_PRIMARY_DARK};padding:24px 32px;">
<span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${BRAND_WHITE};">Goldstar Valet</span>
</td></tr>
<tr><td style="padding:32px;font-family:Helvetica,Arial,sans-serif;color:${BRAND_TEXT};font-size:15px;line-height:1.6;">
${i.bodyHtml}
</td></tr>
<tr><td style="padding:20px 32px;background:${BRAND_SURFACE};font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${BRAND_TEXT_SECONDARY};border-top:1px solid #e5e7eb;">
Goldstar Valet &middot; Indianapolis, IN
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
