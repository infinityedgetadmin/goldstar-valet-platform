import { describe, expect, it } from 'vitest';
import * as pkg from './index';

/** Symbols the rest of the platform (Functions, dashboard, mobile) is known to depend on by name. */
const MUST_EXPORT = [
  'canTransition', 'nextStatuses', 'initialStatus',
  'ticketCreateSchema', 'ticketSchema', 'custodyEventSchema', 'damageReportSchema', 'photoSchema',
  'computeValetPrice', 'computeTip', 'computeTripQuote',
  'callables', 'QUERIES', 'INTEGRATION_MANIFEST',
  'uuidv7', 'secretToken', 'PlatformError', 'ERROR_COPY_KEY', 'TICKET_STATUSES', 'MIN_PRE_DRIVE_PHOTOS',
  'auditLogEntrySchema', 'outboundMessageSchema',
  'CHARGE_LABELS',
] as const satisfies readonly (keyof typeof pkg)[];

describe('package root barrel', () => {
  for (const name of MUST_EXPORT) {
    it(`exports ${name}`, () => {
      expect(pkg[name]).toBeDefined();
    });
  }
});
