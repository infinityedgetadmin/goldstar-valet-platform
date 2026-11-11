import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PmsReservation } from '../src/modules/pms/port.js';

/**
 * MOCK SEED data (invented, not recorded — Ruling H: recording an OHIP response would freeze an
 * unverified contract) shared by every PMS test file. Lives in test/, not src/: a fixture read
 * must never compile into dist.
 */
export const MOCK_RESERVATIONS = (
  JSON.parse(readFileSync(join(__dirname, 'fixtures/pms-mock.json'), 'utf8')) as { reservations: PmsReservation[] }
).reservations;
