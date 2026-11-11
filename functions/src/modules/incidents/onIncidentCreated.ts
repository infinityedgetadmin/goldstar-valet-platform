import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { makeDeps } from '../../lib/deps.js';
import { incidentCreatedHandler } from './incident.handler.js';

// retry: true — incidentCreatedHandler's only side effect is the deterministic-id pushEvents
// .create() (dedupe via ALREADY_EXISTS swallow), so a crash-then-redelivery self-heals instead of
// silently dropping the leads notification (same reasoning as onTicketWritten.ts / push.ts's
// onPushEventCreated).
export const onIncidentCreated = onDocumentCreated({ document: 'operators/{op}/incidents/{incidentId}', retry: true }, async (event) => {
  const data = event.data?.data();
  if (!data) return;
  await incidentCreatedHandler(makeDeps(), { operatorId: event.params.op, incidentId: event.params.incidentId, data });
});
