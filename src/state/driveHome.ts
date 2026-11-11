import type { DriveHomeStatus } from '../domain/status';
import type { TransitionRule } from './types';
const M = ['owner', 'admin', 'lead'] as const;
const SYS = ['platform_admin'] as const;
const reason = (c: { cancelReason?: string }) => (c.cancelReason?.trim() ? null : 'cancelReason');
export const DRIVE_HOME_RULES: readonly TransitionRule<DriveHomeStatus>[] = [
  { from: null, to: 'requested', roles: ['guest', 'attendant', 'lead', 'admin', 'owner', 'venue_user'] },
  { from: 'requested', to: 'quoted', roles: SYS },
  // H1(a): guest is intentionally NOT in this list — a direct client write of quoted->confirmed
  // would skip payment authorization entirely. The only legitimate path is guestConfirmDriveHome
  // (functions/src/modules/dispatch/confirmDriveHome.ts), which authorizes via resolveToken() +
  // its own quoted/confirmed status branch and no longer relies on this array for that check.
  { from: 'quoted', to: 'confirmed', roles: M },
  { from: 'confirmed', to: 'assigned', roles: [...M, ...SYS], requires: (c) => (c.primaryEligible && c.chaseEligible ? null : 'eligible_drivers') },
  { from: 'assigned', to: 'en_route_to_guest', roles: M, claimantRoles: ['driver'] },
  { from: 'en_route_to_guest', to: 'pre_drive_inspection', roles: M, claimantRoles: ['driver'] },
  { from: 'pre_drive_inspection', to: 'in_transit', roles: M, claimantRoles: ['driver'], requires: (c) => (c.hasPreDriveReport ? null : 'pre_drive_report') },
  { from: 'in_transit', to: 'arrived', roles: M, claimantRoles: ['driver'] },
  { from: 'arrived', to: 'completed', roles: M, claimantRoles: ['driver'], requires: (c) => (c.hasPostDriveReport ? null : 'post_drive_report') },
  { from: 'completed', to: 'closed', roles: [...M, ...SYS] },
  ...(['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_guest', 'pre_drive_inspection'] as const).map((from) => ({ from, to: 'cancelled' as const, roles: [...M, 'guest'] as const, requires: reason })),
  ...(['in_transit', 'arrived'] as const).map((from) => ({ from, to: 'cancelled' as const, roles: M, requires: reason })),
];
