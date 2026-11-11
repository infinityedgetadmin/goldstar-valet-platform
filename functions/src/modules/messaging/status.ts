import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { rejectOversized } from '../../lib/requestSize.js';
import { P } from '../../lib/paths.js';
import { TwilioProvider } from './twilio.adapter.js';

const TOK = defineSecret('TWILIO_AUTH_TOKEN');

// Twilio's outbound SMS status callback progression is queued → sending → sent → one of these three
// terminal states (twilio SDK's MessageStatus type). Once a message reaches one, nothing later in the
// (out-of-order-deliverable) callback sequence should overwrite it — Ruling AV, finding 15.
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'undelivered', 'failed']);

export async function statusHandler(deps: Deps, i: { url: string; params: Record<string, string>; signature: string; authToken: string }): Promise<{ status: number }> {
  if (!new TwilioProvider(null as never).verifyWebhook(i)) return { status: 403 };
  const sid = i.params.MessageSid ?? '';
  const messageStatus = i.params.MessageStatus ?? '';
  // Ruling AV (plan-specified): dedupe on (MessageSid, MessageStatus) — Twilio's own delivery
  // guarantee is at-least-once, so the SAME status callback can be redelivered; without this, a
  // redelivered 'delivered' callback is harmless (idempotent overwrite) but a redelivered EARLIER-stage
  // callback arriving after a later one already landed would otherwise be caught only by the
  // terminal-status guard below, not by true dedupe.
  const dedupeKey = deps.db.doc(P.processed('twilio', `${sid}_${messageStatus}`));
  if ((await dedupeKey.get()).exists) return { status: 204 };
  const q = await deps.db.collection('outboundMessages').where('providerRef', '==', sid).limit(1).get();
  if (!q.empty) {
    const doc = q.docs[0]!;
    const curStatus = (doc.data() as { deliveryStatus?: string }).deliveryStatus;
    // A late/out-of-order EARLIER-STAGE status (queued/sending/sent) arriving after the message
    // already reached a terminal state (e.g. 'delivered') must not regress the display field back to
    // an earlier stage. A terminal status is always recorded even over another terminal status (the
    // last terminal callback wins) — only a non-terminal status is blocked once terminal is reached.
    const incomingIsTerminal = TERMINAL_DELIVERY_STATUSES.has(messageStatus);
    const curIsTerminal = TERMINAL_DELIVERY_STATUSES.has(curStatus ?? '');
    if (!curIsTerminal || incomingIsTerminal) {
      await doc.ref.update({ deliveryStatus: messageStatus, deliveryUpdatedAt: deps.now(), ...(i.params.ErrorCode ? { deliveryError: i.params.ErrorCode } : {}) });
    }
  }
  await dedupeKey.set({ at: deps.now() });
  return { status: 204 };
}

export const twilioStatus = onRequest({ secrets: [TOK] }, async (req, res) => {
  if (rejectOversized(req, res)) return; // Plan 8 Task 16: ≤1 MiB before signature verification
  const url = `https://${req.get('host')}${req.originalUrl}`;
  const out = await statusHandler(makeDeps(), { url, params: req.body as Record<string, string>, signature: req.get('x-twilio-signature') ?? '', authToken: TOK.value() });
  res.status(out.status).send('');
});
