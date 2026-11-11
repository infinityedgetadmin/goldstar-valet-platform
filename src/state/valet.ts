import { ACTIVE_VALET_STATUSES, type ValetStatus } from '../domain/status';
import type { TransitionRule } from './types';
const M = ['owner', 'admin', 'lead'] as const;           // managers
const MA = ['owner', 'admin', 'lead', 'attendant'] as const;
const reason = (c: { cancelReason?: string }) => (c.cancelReason && c.cancelReason.trim().length > 0 ? null : 'cancelReason');
export const VALET_RULES: readonly TransitionRule<ValetStatus>[] = [
  { from: null, to: 'checked_in', roles: MA },
  { from: 'checked_in', to: 'requested', roles: [...MA, 'guest', 'venue_user', 'platform_admin'] },
  { from: 'requested', to: 'claimed', roles: MA },
  { from: 'requested', to: 'staged', roles: MA },
  { from: 'requested', to: 'checked_in', roles: M },
  { from: 'claimed', to: 'retrieving', roles: M, claimantRoles: ['attendant', 'driver'] },
  { from: 'retrieving', to: 'ready', roles: M, claimantRoles: ['attendant', 'driver'] },
  // no claimantRoles gate: a staged car may have been pre-staged from a host pre-arrival with no claimant, so any venue attendant may mark it ready
  { from: 'staged', to: 'ready', roles: MA },
  { from: 'retrieving', to: 'staged', roles: M, claimantRoles: ['attendant', 'driver'] },
  { from: 'ready', to: 'delivered', roles: M, claimantRoles: ['attendant', 'driver'], requires: (c) => (c.hasKeysReturnedEvent ? null : 'keys_returned') },
  { from: 'delivered', to: 'closed', roles: [...MA, 'platform_admin'] },
  ...ACTIVE_VALET_STATUSES.map((from) => ({ from, to: 'cancelled' as const, roles: M, requires: reason })),
];
