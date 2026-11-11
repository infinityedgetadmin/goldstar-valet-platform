import type { JobType, TicketStatus, ValetStatus, DriveHomeStatus, RideStatus } from '../domain/status';
import { DRIVE_HOME_RULES } from './driveHome';
import { RIDE_RULES } from './ride';
import { evaluate, type TransitionInput, type TransitionResult, type TransitionRule } from './types';
import { VALET_RULES } from './valet';
export { canTransitionChase } from './chase';
export { MIN_PRE_DRIVE_PHOTOS } from './types';
export type { TransitionContext, TransitionInput, TransitionResult } from './types';

function rulesFor(jobType: JobType): readonly TransitionRule<string>[] {
  switch (jobType) {
    case 'valet': return VALET_RULES;
    case 'drive_home': return DRIVE_HOME_RULES;
    case 'passenger_ride': return RIDE_RULES;
  }
}
export function canTransition(input: TransitionInput): TransitionResult {
  return evaluate(rulesFor(input.jobType), input.from, input.to, input.roles, input.ctx ?? {});
}
export function nextStatuses(jobType: JobType, from: TicketStatus | null): TicketStatus[] {
  return rulesFor(jobType).filter((r) => r.from === from).map((r) => r.to as TicketStatus);
}
export function initialStatus(jobType: JobType): ValetStatus | DriveHomeStatus | RideStatus { return jobType === 'valet' ? 'checked_in' : 'requested'; }
