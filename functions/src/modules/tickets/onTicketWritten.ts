import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { makeDeps } from '../../lib/deps.js';
import { ticketWrittenHandler } from './ticket.handler.js';

/**
 * Recursion guard: ticketWrittenHandler itself writes back to the ticket doc (computed metrics,
 * refund flag), which re-triggers this same onDocumentWritten function. Skip re-processing when
 * nothing the handler actually reacts to (status, times, payment, vehicle) has changed — this is
 * what stops that from looping forever. `!after` covers deletes (e.g. the archive job's batch
 * delete); `!before` always processes (create).
 */
export function shouldProcessTicketWrite(before: Record<string, unknown> | null, after: Record<string, unknown> | undefined): boolean {
  if (!after) return false;
  if (!before) return true;
  return !(
    before.status === after.status &&
    JSON.stringify(before.times) === JSON.stringify(after.times) &&
    JSON.stringify(before.payment) === JSON.stringify(after.payment) &&
    JSON.stringify(before.vehicle) === JSON.stringify(after.vehicle)
  );
}

// retry: true — every side effect below is idempotent (deterministic outbound/push doc ids + .create()
// dedupe, metrics undefined-guards, full projection regen), so a crash-then-redelivery self-heals
// instead of silently dropping a guest notification (finding 4).
export const onTicketWritten = onDocumentWritten({ document: 'operators/{op}/tickets/{ticketId}', retry: true }, async (event) => {
  const afterData: Record<string, unknown> | undefined = event.data?.after.data();
  const beforeData: Record<string, unknown> | null = event.data?.before.data() ?? null;
  if (!afterData || !shouldProcessTicketWrite(beforeData, afterData)) return;
  await ticketWrittenHandler(makeDeps(), { operatorId: event.params.op, ticketId: event.params.ticketId, before: beforeData, after: afterData });
});
