import { expect, it } from 'vitest';
import { DRIVE_HOME_STATUSES, RIDE_STATUSES, TICKET_STATUSES, VALET_STATUSES } from './status';

it('TICKET_STATUSES has no duplicates and is set-equal to the union of valet, drive-home, and ride statuses', () => {
  expect(new Set(TICKET_STATUSES).size).toBe(TICKET_STATUSES.length);

  const union = new Set([...VALET_STATUSES, ...DRIVE_HOME_STATUSES, ...RIDE_STATUSES]);
  const ticketSet = new Set(TICKET_STATUSES);

  for (const s of union) {
    expect(ticketSet).toContain(s);
  }
  for (const s of ticketSet) {
    expect(union).toContain(s);
  }
});
