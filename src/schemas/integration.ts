import { z } from 'zod';
import { isoDateSchema } from './common';
export const integrationSchema = z.object({
  provider: z.string().min(1),
  status: z.enum(['configured', 'active', 'error', 'disabled']).default('configured'),
  config: z.record(z.string(), z.unknown()).default({}),
  secretRef: z.string().optional(), lastSyncAt: isoDateSchema.optional(),
  lastError: z.string().optional(), lastErrorAt: isoDateSchema.optional(),
  health: z.object({ ok: z.boolean(), message: z.string().optional(), errors: z.array(z.string()).optional() }).optional(),
});
export type Integration = z.infer<typeof integrationSchema>;

/**
 * Mutable OAuth state for an integration whose refresh credential ROTATES — today only
 * QuickBooks Online, whose every refresh returns a NEW refresh token and invalidates the old.
 *
 * Kept OUT of `integrations/{provider}` because that document is client-readable by operator
 * admins (`firestore.rules`), and a refresh token is a bearer credential: anyone holding it can
 * mint access tokens for the operator's entire accounting file until it is revoked. This lives at
 * `operators/{op}/integrationTokens/{provider}`, which no client role may read — not even
 * platform_admin, since nothing in any UI needs its value and the blast radius of a leak is the
 * whole QuickBooks company.
 *
 * `refreshToken` MUST be written in the SAME TRANSACTION that consumes the previous one. If the
 * process dies between "Intuit issued a new token" and "we stored it", the integration is
 * permanently broken and needs a human to re-authorize through the OAuth consent screen — there
 * is no programmatic recovery.
 *
 * `refreshTokenExpiresAt` is Intuit's `x_refresh_token_expires_in` (100 days) resolved to an
 * absolute instant. A scheduled keep-alive must refresh well before it, so an operator who
 * invoices monthly and then goes quiet for a quarter does not silently pass it.
 */
export const integrationTokenSchema = z.object({
  provider: z.string().min(1),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: isoDateSchema,
  accessToken: z.string().optional(),
  accessTokenExpiresAt: isoDateSchema.optional(),
  realmId: z.string().optional(),
  rotatedAt: isoDateSchema,
  /** Increments on every successful rotation. A gap here is the signature of a lost write. */
  rotationCount: z.number().int().min(0).default(0),
});
export type IntegrationToken = z.infer<typeof integrationTokenSchema>;
