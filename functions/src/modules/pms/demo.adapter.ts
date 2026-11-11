import { MockPmsProvider } from './mock.adapter.js';
import type { PmsReservation } from './port.js';

/**
 * In-house guests the hotel venue "has" during an emulator demo (lib/demoProviders.ts). Invented
 * names and rooms, not real people. One reservation is `noPost` so the folio-refuses-charges path
 * (block, or fall back to card, per `venue.pms.noPostBehavior`) can be shown too.
 */
export const DEMO_PMS_RESERVATIONS: readonly PmsReservation[] = [
  { reservationRef: 'demo_res_1204', guestName: 'Avery Collins', room: '1204', noPost: false },
  { reservationRef: 'demo_res_0817', guestName: 'Jordan Patel', room: '817', noPost: false },
  { reservationRef: 'demo_res_1530', guestName: 'Morgan Reyes', room: '1530', noPost: true },
];

let instance: MockPmsProvider | null = null;

/**
 * One MockPmsProvider per Functions-emulator worker process, so a charge posted by one call can be
 * reversed by a later call in the same process. Workers do not share memory: a reversal served by
 * a different worker than the original posting gets the mock's honest `not_found` for that posting
 * ref. That is acceptable for a demo; the seeded reservations themselves are identical everywhere.
 */
export function demoPms(): MockPmsProvider {
  instance ??= new MockPmsProvider(DEMO_PMS_RESERVATIONS.map((r) => ({ ...r })));
  return instance;
}
