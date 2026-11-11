export const ROLES = ['platform_admin', 'owner', 'admin', 'lead', 'attendant', 'driver', 'venue_user', 'guest'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES = ['owner', 'admin', 'lead', 'attendant', 'driver'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];
export function isStaffRole(r: string): r is StaffRole { return (STAFF_ROLES as readonly string[]).includes(r); }
export const MANAGER_ROLES = ['owner', 'admin', 'lead'] as const satisfies readonly Role[];
