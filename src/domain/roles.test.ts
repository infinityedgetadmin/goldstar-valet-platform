import { expect, it } from 'vitest';
import { ROLES, STAFF_ROLES, isStaffRole } from './roles';
it('staff roles exclude guest and venue_user', () => {
  expect(STAFF_ROLES).toEqual(['owner', 'admin', 'lead', 'attendant', 'driver']);
  expect(isStaffRole('guest')).toBe(false);
  expect(isStaffRole('lead')).toBe(true);
  expect(ROLES).toHaveLength(8);
});
