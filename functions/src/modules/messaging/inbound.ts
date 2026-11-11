import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Ticket } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { rejectOversized } from '../../lib/requestSize.js';
import { P } from '../../lib/paths.js';
import { TwilioProvider } from './twilio.adapter.js';
import { requestVehicleHandler } from '../guest/requestVehicle.js';

const TOK = defineSecret('TWILIO_AUTH_TOKEN');
const OPEN = ['checked_in', 'requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered'];

// Ruling X: START must mirror STOP exactly — both the open tickets AND the durable guests/{uid}
// consent doc, in one batch, so consent round-trips STOP→START instead of START only reviving the
// per-ticket flag while the durable guest record stays opted out.
async function setSmsConsent(deps: Deps, from: string, openTickets: QueryDocumentSnapshot[], consentSms: boolean): Promise<void> {
  const b = deps.db.batch();
  for (const d of openTickets) b.update(d.ref, { 'guest.consentSms': consentSms });
  const g = await deps.db.collection('guests').where('phoneE164', '==', from).get();
  for (const d of g.docs) b.update(d.ref, { 'consent.sms': consentSms });
  await b.commit();
}

async function handleCommand(deps: Deps, from: string, body: string): Promise<string> {
  const open = await deps.db.collectionGroup('tickets').where('guest.phoneE164', '==', from).where('status', 'in', OPEN).get();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
    await setSmsConsent(deps, from, open.docs, false);
    return '<Response/>';
  }
  if (['START', 'UNSTOP', 'YES'].includes(body)) {
    await setSmsConsent(deps, from, open.docs, true);
    return '<Response><Message>You are subscribed again.</Message></Response>';
  }
  if (body === 'HELP' || body === 'INFO') {
    return '<Response><Message>Reply 1 to request your car. Reply STOP to opt out. Need a person? Use the link in your check-in text.</Message></Response>';
  }
  if (['1', 'CAR', 'READY', 'MY CAR'].includes(body)) {
    const latest = open.docs
      .map((d) => d.data() as Ticket)
      .filter((t) => t.jobType === 'valet' && t.status === 'checked_in')
      .sort((a, b2) => b2.times.checkedInAt.localeCompare(a.times.checkedInAt))[0];
    if (latest) {
      await requestVehicleHandler(deps, null, { token: latest.guestToken });
      return '<Response><Message>Got it — we are bringing your car around now.</Message></Response>';
    }
    return '<Response><Message>We could not find an active ticket for this number.</Message></Response>';
  }
  return '<Response><Message>Reply 1 to request your car, or use the link in your check-in text.</Message></Response>';
}

export async function inboundHandler(deps: Deps, i: { url: string; params: Record<string, string>; signature: string; authToken: string }): Promise<{ status: number; twiml?: string }> {
  if (!new TwilioProvider(null as never).verifyWebhook(i)) return { status: 403 };
  const from = i.params.From ?? '';
  const body = (i.params.Body ?? '').trim().toUpperCase();
  const sid = i.params.MessageSid ?? '';
  const key = deps.db.doc(P.processed('twilio_in', sid));
  if ((await key.get()).exists) return { status: 200, twiml: '<Response/>' };
  // Ruling D: the dedupe key is set AFTER the command work below succeeds, never before. A crash
  // mid-handling must not have already marked this event processed — Twilio retries on a 5xx, and
  // every command here (consent flip, vehicle request) is idempotent, so redelivery safely
  // completes the work instead of the event being silently dropped.
  try {
    const twiml = await handleCommand(deps, from, body);
    await key.set({ at: deps.now() });
    return { status: 200, twiml };
  } catch (e) {
    console.error('twilio inbound handling failed', { name: e instanceof Error ? e.name : typeof e });
    return { status: 500 };
  }
}

export const twilioInbound = onRequest({ secrets: [TOK] }, async (req, res) => {
  if (rejectOversized(req, res)) return; // Plan 8 Task 16: ≤1 MiB before signature verification
  const url = `https://${req.get('host')}${req.originalUrl}`;
  const out = await inboundHandler(makeDeps(), { url, params: req.body as Record<string, string>, signature: req.get('x-twilio-signature') ?? '', authToken: TOK.value() });
  res.status(out.status).type('text/xml').send(out.twiml ?? '');
});
