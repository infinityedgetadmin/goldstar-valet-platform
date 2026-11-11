import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import type { Operator, Venue } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { type EmailProvider, sendEmailHandler } from './email.js';
import { PermanentSendError } from './errors.js';
import type { MessagingProvider } from './port.js';
import { getMessaging } from './registry.js';
import { renderTemplate } from './templates.js';

const SID = defineSecret('TWILIO_ACCOUNT_SID');
const TOK = defineSecret('TWILIO_AUTH_TOKEN');
const RESEND_KEY = defineSecret('RESEND_API_KEY');

/**
 * `emailProvider` is a 4th, independently-optional test-injection param rather than folding both
 * channels' overrides into one `providers` object — that would force every one of messaging.test.ts's
 * existing `sendOutboundHandler(deps, id, new TwilioProvider(fake))` call sites (established across
 * 279 passing tests before this change) to switch to a wrapper shape for no behavioral gain, since a
 * doc is always exactly one channel and so only ever needs one override supplied at a time.
 */
export async function sendOutboundHandler(deps: Deps, id: string, provider?: MessagingProvider, emailProvider?: EmailProvider): Promise<void> {
  const ref = deps.db.doc(P.outbound(id));
  const m = (await ref.get()).data() as
    | { channel: string; operatorId: string; venueId?: string; to: string; template: string; vars: Record<string, unknown>; status: string; attempts: number }
    | undefined;
  if (!m || !['sms', 'email'].includes(m.channel) || !['queued', 'retry', 'sending'].includes(m.status)) return;
  // Lease before calling the provider: a crash after send but before the status write must not
  // resend on retry. A live (unexpired) lease blocks a concurrent invocation; an expired one is
  // re-claimed and retried (see retryOutboundMessages' stale-lease sweep below).
  const leased = await deps.db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as { status: string; leaseUntil?: string } | undefined;
    if (!cur) return false;
    if (cur.status === 'sending' && cur.leaseUntil && cur.leaseUntil > deps.now()) return false;
    tx.update(ref, { status: 'sending', leaseUntil: new Date(Date.parse(deps.now()) + 120_000).toISOString() });
    return true;
  });
  if (!leased) return;
  const op = (await deps.db.doc(P.operator(m.operatorId)).get()).data() as Operator;
  const attempts = m.attempts + 1;
  try {
    let providerRef: string;
    if (m.channel === 'email') {
      ({ providerRef } = await sendEmailHandler(deps, { to: m.to, template: m.template, vars: m.vars }, op.branding.displayName, emailProvider));
    } else {
      const venueSms = m.venueId ? ((await deps.db.doc(P.venue(m.operatorId, m.venueId)).get()).data() as Venue | undefined)?.sms ?? {} : {};
      const body = renderTemplate(m.template, { operator: op.branding.displayName, ...m.vars }, venueSms);
      // exactOptionalPropertyTypes: op.modules.messaging's zod-inferred optional fields are typed
      // `T | undefined` (the key can be omitted OR explicitly undefined); the port's
      // OperatorMessagingConfig declares them plain-optional (`?: T`, no explicit undefined). Build
      // the value with conditional spreads instead of passing the zod object straight through — same
      // convention as checkout.ts's CheckoutInput construction.
      const config = {
        ...(op.modules.messaging.messagingServiceSid !== undefined ? { messagingServiceSid: op.modules.messaging.messagingServiceSid } : {}),
        ...(op.modules.messaging.fromNumber !== undefined ? { fromNumber: op.modules.messaging.fromNumber } : {}),
      };
      const statusCallbackUrl = process.env.TWILIO_STATUS_URL;
      ({ providerRef } = await (provider ?? getMessaging(deps, op)).send({ to: m.to, body, config, ...(statusCallbackUrl !== undefined ? { statusCallbackUrl } : {}) }));
    }
    await ref.update({ status: 'sent', providerRef, attempts, sentAt: deps.now() });
  } catch (e) {
    // A PermanentSendError (email.ts's renderEmail — unknown template or zod-rejected vars) is a
    // deterministic producer bug: no number of retries can ever succeed, only a code/data fix can. It
    // fails on the very first attempt instead of burning ~15 minutes through the transient-failure
    // backoff cycle below (Task 1 review, Finding M3). Every other throw (a real Resend/Twilio outage,
    // a network blip) is presumed transient and keeps the existing backoff-then-fail-at-5 behavior.
    const failed = e instanceof PermanentSendError || attempts >= 5;
    await ref.update({
      status: failed ? 'failed' : 'retry',
      leaseUntil: null,
      attempts,
      lastError: (e as Error).message.slice(0, 200),
      retryAt: new Date(Date.parse(deps.now()) + Math.min(3600, 30 * 2 ** attempts) * 1000).toISOString(),
    });
  }
}

export const onOutboundMessageCreated = onDocumentCreated({ document: 'outboundMessages/{id}', secrets: [SID, TOK, RESEND_KEY] }, async (event) => {
  await sendOutboundHandler(makeDeps(), event.params.id);
});

export const retryOutboundMessages = onSchedule({ schedule: 'every 5 minutes', secrets: [SID, TOK, RESEND_KEY] }, async () => {
  const deps = makeDeps();
  const q = await deps.db.collection('outboundMessages').where('status', '==', 'retry').where('retryAt', '<=', deps.now()).limit(50).get();
  for (const d of q.docs) await sendOutboundHandler(deps, d.id);
  const stale = await deps.db.collection('outboundMessages').where('status', '==', 'sending').where('leaseUntil', '<=', deps.now()).limit(50).get();
  for (const d of stale.docs) await sendOutboundHandler(deps, d.id);
});
