import { z } from 'zod';
import { uuidSchema } from './common';
export const keyTagSchema = z.object({
  id: z.string().min(1), operatorId: z.string().min(1), value: z.string().min(4).max(64), venueId: z.string().min(1), status: z.enum(['available', 'assigned', 'lost', 'retired']), currentTicketId: z.string().optional(), printedBatchId: z.string().optional(),
  // Plan 2b (contracts v0.3.5, finding 13): firestore.rules' custody-coupled keyTags update
  // (`onlyChanged(['status', 'currentTicketId', 'lastCustodyEventId'])`) and commit.ts both
  // write this field on assign/release — it was missing from the contract entirely, so a
  // non-strict parse in any Functions/dashboard consumer would silently strip it. Points at the
  // custodyEvents/{eventId} doc (on the referenced ticket) that most recently changed this tag's
  // custody state; optional because a freshly-created (never assigned) tag has none yet.
  lastCustodyEventId: uuidSchema.optional(),
});
export type KeyTag = z.infer<typeof keyTagSchema>;
