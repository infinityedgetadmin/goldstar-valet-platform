import { Resend } from 'resend';
import type { z } from 'zod';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { demoResendClient } from './demo.adapter.js';
import { PermanentSendError } from './errors.js';
import { claimUpdateEmail, claimUpdateEmailVarsSchema } from './templates/email/claim-update.js';
import { credentialExpiryEmail, credentialExpiryEmailVarsSchema } from './templates/email/credential-expiry.js';
import { invitationEmail, invitationEmailVarsSchema } from './templates/email/invitation.js';
import { invoiceEmail, invoiceEmailVarsSchema } from './templates/email/invoice.js';
import { receiptEmail, receiptEmailVarsSchema } from './templates/email/receipt.js';

export interface EmailProvider {
  send(i: { to: string; subject: string; html: string; from: string }): Promise<{ providerRef: string }>;
}

/**
 * Minimal structural slice of the `resend` package's `Resend` class (v6.24.0 — verified against the
 * INSTALLED package's `dist/index.d.mts`, not memory) that `ResendProvider` needs. Mirrors
 * twilioClient.ts's `TwilioLike` pattern: a real `Resend` instance satisfies this (its `emails.send`
 * accepts a wider `CreateEmailOptions` superset of `{from,to,subject,html}`), and tests substitute a
 * `FakeResend` (functions/test/fakes/resend.ts) without touching the network. Unlike Twilio's SDK,
 * `resend.emails.send` does NOT throw on a provider-side failure — it always resolves, returning
 * `{ data, error }` (one of the two is always null). `ResendProvider.send` below converts that into
 * the throw-based contract every other channel (and sender.ts's shared retry/backoff catch) expects.
 */
export type ResendLike = {
  emails: {
    send: (p: { from: string; to: string; subject: string; html: string }) => Promise<{ data: { id: string } | null; error: { message: string; name?: string; statusCode?: number | null } | null }>;
  };
};

/**
 * m3 (final whole-branch review): before this, EVERY Resend send failure — including a deterministic
 * "you typo'd the recipient" or "that from-domain isn't verified" — was thrown as a plain `Error`,
 * burning sender.ts's full 5-attempt/~15min backoff cycle before finally landing on `failed`. The
 * installed SDK (`resend` v6.24.0, `dist/index.d.mts`'s `ErrorResponse`/`RESEND_ERROR_CODE_KEY`
 * union — verified against the installed package, not memory, per this repo's Context7 rule) always
 * returns a `name` discriminator on `error`, one of a fixed 21-value enum. This is the deterministic
 * 4xx-class subset — retrying the IDENTICAL request/config can never succeed, only a code/data/secret
 * fix can (same "producer bug" framing `parseVars`'s `PermanentSendError` above already uses).
 *
 * Deliberately EXCLUDED (stay transient — a plain `Error`, still eligible for the backoff cycle):
 * - `concurrent_idempotent_requests` — a race, not a deterministic failure; the OTHER in-flight
 *   request may have already succeeded, and simply retrying can genuinely resolve differently.
 * - `monthly_quota_exceeded` / `daily_quota_exceeded` / `rate_limit_exceeded` (429) — 429 means
 *   "back off and retry", which is exactly what sender.ts's existing cycle already does; treating
 *   these as permanent would turn a temporary account-state condition into a dropped email.
 * - `security_error` (451) — Resend's own docs say "contact support for more information"; genuinely
 *   ambiguous, not a "your data was wrong" signal, so it stays on the transient/retry path.
 * - `application_error` / `internal_server_error` (500) — ordinary transient server-side failures.
 */
const PERMANENT_RESEND_ERROR_NAMES = new Set<string>([
  'invalid_idempotency_key',
  'validation_error',
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'not_found',
  'method_not_allowed',
  'invalid_idempotent_request',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_access',
  'invalid_parameter',
  'invalid_region',
  'missing_required_field',
]);

export class ResendProvider implements EmailProvider {
  constructor(private readonly c: ResendLike) {}

  async send(i: { to: string; subject: string; html: string; from: string }): Promise<{ providerRef: string }> {
    const { data, error } = await this.c.emails.send({ from: i.from, to: i.to, subject: i.subject, html: i.html });
    if (error) {
      if (error.name !== undefined && PERMANENT_RESEND_ERROR_NAMES.has(error.name)) throw new PermanentSendError(error.message);
      throw new Error(error.message);
    }
    if (!data) throw new Error('resend: email accepted but no id returned');
    return { providerRef: data.id };
  }
}

// Nit (final whole-branch review): pins the FIRST `RESEND_API_KEY` value seen for this instance's
// entire lifetime — a rotated secret has no effect until the Function instance recycles (a cold
// start, a new deploy, or GCFv2's own instance churn), not on the next invocation. Harmless today
// (no key-rotation flow exists yet); worth revisiting if one is added — the module-level cache would
// need to key on the secret's value, not just "have we ever seen one".
let cachedResend: Resend | null = null;
function resendClient(apiKey: string): Resend {
  if (!cachedResend) cachedResend = new Resend(apiKey);
  return cachedResend;
}

/** Real (non-test) EmailProvider — email has no per-operator provider selection (unlike
 * modules.messaging.provider for SMS), so this is a plain factory, not a registry.ts-style switch:
 * every operator's transactional/alert email goes through the same platform Resend account. */
export function getEmail(deps: Deps): EmailProvider {
  // Emulator-only demo switch: the real adapter over an in-process client, and no Resend key is
  // read (lib/demoProviders.ts, ./demo.adapter.ts).
  if (demoProvidersEnabled()) return new ResendProvider(demoResendClient());
  return new ResendProvider(resendClient(deps.secrets.get('RESEND_API_KEY')));
}

/**
 * A missing/mistyped `template` name or a `vars` shape that fails its zod schema are both
 * deterministic producer bugs, not transient failures — no amount of retrying fixes them, only a
 * code/data fix can (Task 1 review, Finding M3). Both are raised as `PermanentSendError` so
 * sender.ts's shared catch can skip the transient-failure backoff cycle and fail the doc immediately.
 */
function parseVars<T>(schema: z.ZodType<T>, vars: Record<string, unknown>, template: string): T {
  const result = schema.safeParse(vars);
  if (!result.success) throw new PermanentSendError(`invalid vars for email template '${template}': ${result.error.message}`);
  return result.data;
}

export function renderEmail(template: string, vars: Record<string, unknown>): { subject: string; html: string } {
  switch (template) {
    case 'invitation':
      return invitationEmail(parseVars(invitationEmailVarsSchema, vars, template));
    // Dispatch key is the producer's real `template` string (identity/eligibility.ts's
    // notifyExpiring), not the credential-expiry.ts filename — see that template's own comment.
    case 'credentialExpiring':
      return credentialExpiryEmail(parseVars(credentialExpiryEmailVarsSchema, vars, template));
    case 'claimUpdate':
      return claimUpdateEmail(parseVars(claimUpdateEmailVarsSchema, vars, template));
    case 'invoice':
      return invoiceEmail(parseVars(invoiceEmailVarsSchema, vars, template));
    // Plan 6 (guest account, guestEmailReceipt) — distinct dispatch key from the SMS-only 'receipt'
    // template in messaging/templates.ts (different registry entirely: renderTemplate vs. renderEmail).
    case 'receipt':
      return receiptEmail(parseVars(receiptEmailVarsSchema, vars, template));
    default:
      throw new PermanentSendError(`unknown email template: ${template}`);
  }
}

const DEFAULT_EMAIL_FROM = 'Goldstar Valet <noreply@goldstar-mgmt.example.com>';
const DEFAULT_DASHBOARD_HOST = 'app.goldstar.example.com';

/**
 * Assembles a template's render vars from the outbound doc's stored `vars` plus context
 * `sendOutboundHandler` already has in hand (the operator's display name — every email template
 * takes `operatorName`, but no producer stores it on the doc itself, same as SMS's `renderTemplate`
 * merging in `operator: op.branding.displayName` at send time rather than at queue time).
 *
 * `invitation` gets one more derived field: identityInvite's `inviteHandler` (functions/src/modules/
 * identity/invite.ts) only stores `{ token, operatorId }` in `vars` — it has no reason to know the
 * email's URL shape. `acceptUrl` is derived here from `token` + `DASHBOARD_HOST`, mirroring
 * connect.ts's `process.env.DASHBOARD_HOST ?? 'app.goldstar.example.com'` fallback. A caller
 * that already supplies `acceptUrl` (e.g. this file's own tests) is left alone.
 */
function buildEmailVars(template: string, vars: Record<string, unknown>, operatorName: string): Record<string, unknown> {
  const merged: Record<string, unknown> = { operatorName, ...vars };
  if (template === 'invitation' && typeof vars.token === 'string' && merged.acceptUrl === undefined) {
    const host = process.env.DASHBOARD_HOST ?? DEFAULT_DASHBOARD_HOST;
    merged.acceptUrl = `https://${host}/accept-invite?token=${encodeURIComponent(vars.token)}`;
  }
  return merged;
}

/** Renders and sends one outboundMessages email doc. Mirrors the SMS branch's
 * `(provider ?? getMessaging(deps, op)).send(...)` call shape in sender.ts exactly — a single async
 * call resolving to `{ providerRef }` or throwing — so sendOutboundHandler's existing try/catch
 * (lease release, attempts/backoff, retry vs. failed) governs both channels unchanged. */
export async function sendEmailHandler(
  deps: Deps,
  m: { to: string; template: string; vars: Record<string, unknown> },
  operatorName: string,
  provider?: EmailProvider,
): Promise<{ providerRef: string }> {
  const vars = buildEmailVars(m.template, m.vars, operatorName);
  const { subject, html } = renderEmail(m.template, vars);
  const from = process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM;
  return (provider ?? getEmail(deps)).send({ to: m.to, subject, html, from });
}
