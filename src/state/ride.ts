import type { RideStatus } from '../domain/status';
import type { TransitionRule } from './types';
const M = ['owner', 'admin', 'lead'] as const;
const SYS = ['platform_admin'] as const;
const reason = (c: { cancelReason?: string }) => (c.cancelReason?.trim() ? null : 'cancelReason');
export const RIDE_RULES: readonly TransitionRule<RideStatus>[] = [
  { from: null, to: 'requested', roles: ['guest', 'attendant', 'lead', 'admin', 'owner', 'venue_user'] },
  { from: 'requested', to: 'quoted', roles: SYS },
  // H1(a): guest/venue_user are intentionally NOT in this list — a direct client write of
  // quoted->confirmed would skip payment authorization entirely. The only legitimate path is
  // guestConfirmRide (functions/src/modules/dispatch/confirmRide.ts), which authorizes via
  // resolveToken() + its own quoted/confirmed status branch and no longer relies on this array.
  { from: 'quoted', to: 'confirmed', roles: M },
  { from: 'confirmed', to: 'assigned', roles: [...M, ...SYS], requires: (c) => (c.primaryEligible && c.hasFleetVehicle ? null : 'eligible_driver_and_vehicle') },
  { from: 'assigned', to: 'en_route_to_pickup', roles: M, claimantRoles: ['driver'] },
  { from: 'en_route_to_pickup', to: 'arrived_pickup', roles: M, claimantRoles: ['driver'] },
  { from: 'arrived_pickup', to: 'in_transit', roles: M, claimantRoles: ['driver'] },
  { from: 'in_transit', to: 'arrived', roles: M, claimantRoles: ['driver'] },
  { from: 'arrived', to: 'completed', roles: M, claimantRoles: ['driver'] },
  { from: 'completed', to: 'closed', roles: [...M, ...SYS] },
  ...(['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_pickup', 'arrived_pickup'] as const).map((from) => ({ from, to: 'cancelled' as const, roles: [...M, 'guest', 'venue_user'] as const, requires: reason })),
  ...(['in_transit', 'arrived'] as const).map((from) => ({ from, to: 'cancelled' as const, roles: M, requires: reason })),
];
