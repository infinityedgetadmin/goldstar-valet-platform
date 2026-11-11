import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { makeDeps } from '../../lib/deps.js';
import { venueWrittenHandler } from './venue.handler.js';

// retry: true — every write venueWrittenHandler makes is idempotent (token generated only when
// absent; venuePublic .set()/.delete() both self-heal on redelivery), so a crash-then-redelivery
// converges to the same end state instead of leaving a venue without its static-checkout token.
export const onVenueWritten = onDocumentWritten({ document: 'operators/{op}/venues/{venueId}', retry: true }, async (event) => {
  const afterData: Record<string, unknown> | undefined = event.data?.after.data();
  const beforeData: Record<string, unknown> | null = event.data?.before.data() ?? null;
  await venueWrittenHandler(makeDeps(), { operatorId: event.params.op, venueId: event.params.venueId, before: beforeData, after: afterData });
});
