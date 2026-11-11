import { HttpsError } from 'firebase-functions/v2/https';
import { PlatformError, type PlatformErrorCode } from '@goldstar/platform';

const MAP: Record<PlatformErrorCode, HttpsError['code']> = {
  unauthenticated: 'unauthenticated',
  permission_denied: 'permission-denied',
  not_found: 'not-found',
  invalid_argument: 'invalid-argument',
  failed_precondition: 'failed-precondition',
  already_exists: 'already-exists',
  rate_limited: 'resource-exhausted',
  ticket_invalid_transition: 'failed-precondition',
  ticket_closed: 'failed-precondition',
  guest_token_expired: 'not-found',
  payment_failed: 'aborted',
  payment_already_paid: 'already-exists',
  driver_not_eligible: 'failed-precondition',
  provider_unavailable: 'unavailable',
  internal: 'internal',
};

export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof PlatformError) return new HttpsError(MAP[e.code], e.code, { code: e.code, ...(e.details ?? {}) });
  // Never log message/stack/the raw error object here: several handlers operate on paths whose
  // segment IS a secret (guest capability tokens — see resolveToken/rateLimit), and Firestore/gRPC
  // error strings can carry the offending resource path. Only the error's constructor name and the
  // (always-'internal') mapped code are safe to log for an unrecognized exception shape.
  console.error('unhandled callable error', { name: e instanceof Error ? e.name : typeof e, code: 'internal' });
  return new HttpsError('internal', 'internal', { code: 'internal' });
}

export const err = (code: PlatformErrorCode, message?: string, details?: Record<string, unknown>) =>
  new PlatformError(code, message, details);
