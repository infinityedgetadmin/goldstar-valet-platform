import { incidentSchema } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { managerUidsFor } from '../notifications/topics.js';

export interface IncidentCreatedEvent {
  operatorId: string;
  incidentId: string;
  data: Record<string, unknown>;
}

/**
 * Fires on `operators/{op}/incidents/{incidentId}` create. Enqueues a topic push
 * (`leads_{operatorId}_{venueId}`) via the shared `pushEvents` pipeline (Plan 1d's
 * `sendPushHandler` renders the actual notification from `kind: 'incident.created'`).
 */
export async function incidentCreatedHandler(deps: Deps, e: IncidentCreatedEvent): Promise<void> {
  const parsed = incidentSchema.safeParse(e.data);
  if (!parsed.success) {
    // Never log the raw doc — it may carry witness names/contacts or an injury/theft description.
    // Same "log a count/identifier, never content" convention as auditQuery's malformed-entry drop.
    console.error('onIncidentCreated: schema parse failed', { operatorId: e.operatorId, incidentId: e.incidentId });
    return;
  }
  const incident = parsed.data;
  const ticketPromise = incident.ticketId ? deps.db.doc(P.ticket(e.operatorId, incident.ticketId)).get() : null;
  const [venueSnap, ticketSnap] = await Promise.all([deps.db.doc(P.venue(e.operatorId, incident.venueId)).get(), ticketPromise]);
  const venueName = (venueSnap.data() as { name?: string } | undefined)?.name ?? incident.venueId;
  // Ref prefers the linked ticket's plate — already visible to leads on the ticket board, so this
  // adds no PII beyond what they already see — and falls back to a short ticket id when there's no
  // plate on file. No ref at all when the incident isn't linked to a ticket.
  const ref = incident.ticketId ? (ticketSnap?.data() as { vehicle?: { plate?: string } } | undefined)?.vehicle?.plate ?? incident.ticketId.slice(0, 8) : undefined;
  // Plan 8 Task 12 (carry #15): delivered PER MANAGER UID, not to a `leads_{op}_{venueId}` topic.
  // FCM topic subscription is client-unrestricted and attendants can read the venue doc, so no
  // topic name — slugged or not — can be made lead-only. Resolving the venue's managers here and
  // sending to each uid's own tokens is the only delivery FCM can actually restrict.
  const uids = await managerUidsFor(deps, e.operatorId, incident.venueId);
  const data: Record<string, string> = { incidentId: e.incidentId, operatorId: e.operatorId, venueId: incident.venueId, type: incident.type, venue: venueName, ...(ref ? { ref } : {}) };
  // Deterministic id per (incident, uid) derived from the trigger's own path param so a
  // Firestore-redelivered invocation lands on the same pushEvents docs — the .create() dedupes via
  // ALREADY_EXISTS, same mechanics as ticket.handler.ts's enqueuePush/enqueueSms.
  await Promise.all(
    uids.map((uid) => {
      const docId = `incident_${e.incidentId}_${uid}`;
      return deps.db
        .doc(`pushEvents/${docId}`)
        .create({ id: docId, operatorId: e.operatorId, ticketId: incident.ticketId ?? '', kind: 'incident.created', data, toUid: uid, status: 'queued', createdAt: deps.now() })
        .catch((err: unknown) => {
          if ((err as { code?: number }).code !== 6) throw err;
        });
    }),
  );
}
