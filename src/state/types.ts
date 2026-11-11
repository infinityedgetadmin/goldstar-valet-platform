import type { Role } from '../domain/roles';
import type { JobType, TicketStatus } from '../domain/status';
/** Minimum photo count for a damageReports doc to count as satisfying a pre-drive (or post-drive) inspection. */
export const MIN_PRE_DRIVE_PHOTOS = 4;
export interface TransitionContext {
  isClaimant?: boolean;
  /** True iff a damageReports doc with phase 'pre_drive' and >= MIN_PRE_DRIVE_PHOTOS photos exists for this ticket. */
  hasPreDriveReport?: boolean;
  /** True iff a damageReports doc with phase 'post_drive' and >= MIN_PRE_DRIVE_PHOTOS photos exists for this ticket. */
  hasPostDriveReport?: boolean;
  hasKeysReturnedEvent?: boolean;
  primaryEligible?: boolean; chaseEligible?: boolean;
  /** True iff a fleet vehicle is assigned and, when the ride's accessible flag is set, that vehicle is accessible. */
  hasFleetVehicle?: boolean;
  cancelReason?: string;
}
export type TransitionResult = { ok: true } | { ok: false; reason: 'unknown_transition' | 'role_not_allowed' | 'missing_requirement'; requirement?: string };
export interface TransitionRule<S extends string> {
  from: S | null; to: S;
  roles: readonly Role[];                       // roles allowed regardless of claimant
  claimantRoles?: readonly Role[];              // roles allowed only when ctx.isClaimant
  requires?: (ctx: TransitionContext) => string | null; // returns missing requirement name or null
}
export interface TransitionInput { jobType: JobType; from: TicketStatus | null; to: TicketStatus; roles: readonly Role[]; ctx?: TransitionContext }
export function evaluate<S extends string>(rules: readonly TransitionRule<S>[], from: S | null, to: S, roles: readonly Role[], ctx: TransitionContext): TransitionResult {
  const rule = rules.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: 'unknown_transition' };
  const roleOk = roles.some((r) => rule.roles.includes(r)) || (ctx.isClaimant === true && roles.some((r) => rule.claimantRoles?.includes(r)));
  if (!roleOk) return { ok: false, reason: 'role_not_allowed' };
  const missing = rule.requires?.(ctx) ?? null;
  if (missing) return { ok: false, reason: 'missing_requirement', requirement: missing };
  return { ok: true };
}
