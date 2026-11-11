import type { ChaseStatus } from '../domain/status';
const NEXT: Record<ChaseStatus, ChaseStatus | null> = { pending: 'following', following: 'returning_driver', returning_driver: 'done', done: null };
export function canTransitionChase(from: ChaseStatus, to: ChaseStatus): boolean { return NEXT[from] === to; }
