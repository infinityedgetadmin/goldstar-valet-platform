export const PLATFORM_ERROR_CODES = [
  'unauthenticated', 'permission_denied', 'not_found', 'invalid_argument', 'failed_precondition', 'already_exists',
  'rate_limited', 'ticket_invalid_transition', 'ticket_closed', 'guest_token_expired', 'payment_failed', 'payment_already_paid',
  'driver_not_eligible', 'provider_unavailable', 'internal',
] as const;
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

export class PlatformError extends Error {
  constructor(public readonly code: PlatformErrorCode, message?: string, public readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'PlatformError';
  }
}
/** Copy keys clients map to user-facing strings. Never show `message` to users. */
export const ERROR_COPY_KEY: Record<PlatformErrorCode, string> = {
  unauthenticated: 'errors.signInRequired', permission_denied: 'errors.notAllowed', not_found: 'errors.notFound',
  invalid_argument: 'errors.invalidInput', failed_precondition: 'errors.notReady', already_exists: 'errors.alreadyExists',
  rate_limited: 'errors.slowDown', ticket_invalid_transition: 'errors.ticketState', ticket_closed: 'errors.ticketClosed',
  guest_token_expired: 'errors.linkExpired', payment_failed: 'errors.paymentFailed', payment_already_paid: 'errors.alreadyPaid',
  driver_not_eligible: 'errors.driverNotEligible', provider_unavailable: 'errors.serviceUnavailable', internal: 'errors.generic',
};
