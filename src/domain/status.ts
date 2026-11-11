export const JOB_TYPES = ['valet', 'drive_home', 'passenger_ride'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Guest-facing label for each job type's base charge line ("what am I paying for"). EXACTLY these
 * three strings on the charge line and on guest-facing job labels, no variants (Ruling AZ) —
 * operator-facing copy is OUT of scope and may differ deliberately: goldstar-transportation's
 * ticket filter dropdown says "Passenger ride" where this says "Ride", which is correct for a
 * filter and would be wrong on a receipt.
 *
 * Ruling AN: exported from the contracts
 * package because BOTH surfaces that render this copy consume it — the platform's receipt email
 * template and goldstar-mobile's chargeLabel() (on its next re-vendor). Each side previously
 * hardcoded its own copy with a comment promising to stay in sync; nothing mechanical enforced it,
 * so an edit to either side passed every test in both repos while the app and the email disagreed.
 * One shared constant makes that divergence impossible rather than separately tested-against.
 */
export const CHARGE_LABELS = {
  valet: 'Valet',
  drive_home: 'Drive home',
  passenger_ride: 'Ride',
} as const satisfies Record<JobType, string>;

export const VALET_STATUSES = ['checked_in', 'requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered', 'closed', 'cancelled'] as const;
export type ValetStatus = (typeof VALET_STATUSES)[number];

export const DRIVE_HOME_STATUSES = ['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'completed', 'closed', 'cancelled'] as const;
export type DriveHomeStatus = (typeof DRIVE_HOME_STATUSES)[number];

export const RIDE_STATUSES = ['requested', 'quoted', 'confirmed', 'assigned', 'en_route_to_pickup', 'arrived_pickup', 'in_transit', 'arrived', 'completed', 'closed', 'cancelled'] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

export const CHASE_STATUSES = ['pending', 'following', 'returning_driver', 'done'] as const;
export type ChaseStatus = (typeof CHASE_STATUSES)[number];

export type TicketStatus = ValetStatus | DriveHomeStatus | RideStatus;

export const TICKET_STATUSES = ['checked_in', 'requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered', 'closed', 'cancelled', 'quoted', 'confirmed', 'assigned', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'completed', 'en_route_to_pickup', 'arrived_pickup'] as const satisfies readonly TicketStatus[];

export const TERMINAL_STATUSES: readonly TicketStatus[] = ['closed', 'cancelled'];
export const ACTIVE_VALET_STATUSES: readonly ValetStatus[] = ['checked_in', 'requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered'];
