import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { FieldValue } from 'firebase-admin/firestore';
import type { JobType } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

// staged and pre_drive_inspection intentionally have no entry here — they fall through to
// copyFor's generic `Status: {status}` fallback (Ruling AD: not guest-facing enough to word).
const COPY: Record<string, { title: string; body: string }> = {
  requested: { title: 'Request received', body: 'We are bringing your car around.' },
  claimed: { title: 'An attendant is on it', body: 'Your car is being retrieved.' },
  retrieving: { title: 'Retrieving your car', body: 'Almost there.' },
  ready: { title: 'Your car is ready', body: 'Head to the valet stand.' },
  delivered: { title: 'Enjoy your drive', body: 'Thanks for choosing us.' },
  assigned: { title: 'Driver assigned', body: 'Your driver is on the way.' },
  arrived: { title: 'Your driver has arrived', body: 'Meet them at the pickup point.' },
  completed: { title: 'Trip complete', body: 'Thank you.' },
  cancelled: { title: 'Cancelled', body: 'Your request was cancelled.' },
  quoted: { title: 'Your quote is ready', body: 'Review your fare and confirm to book.' },
  confirmed: { title: 'Ride confirmed', body: 'We have your booking. Sit tight.' },
  en_route_to_guest: { title: 'Driver on the way', body: 'Your driver is heading to you now.' },
  in_transit: { title: 'You are on your way', body: 'Sit back and enjoy the ride.' },
  en_route_to_pickup: { title: 'Driver en route', body: 'Your driver is on the way to pick you up.' },
  arrived_pickup: { title: 'Your driver has arrived', body: 'Head outside to meet them.' },
  closed: { title: 'Thanks for riding with us', body: 'We hope to see you again soon.' },
};

// Mirrors INCIDENT_TYPES in @goldstar/platform's incident schema; kept as a local label map (not
// imported) since this is display copy, not a contract the two packages need to stay bit-for-bit
// in sync on — an unrecognized/future type just falls back to the generic 'Incident' label below.
const INCIDENT_TYPE_LABELS: Record<string, string> = {
  damage: 'Damage', injury: 'Injury', theft: 'Theft', altercation: 'Altercation', near_miss: 'Near miss', property: 'Property', other: 'Incident',
};

export function copyFor(kind: string, data: Record<string, string>): { title: string; body: string } {
  if (kind === 'ticket.status') return COPY[data.status ?? ''] ?? { title: 'Update', body: `Status: ${data.status ?? ''}` };
  if (kind === 'venue.request') return { title: 'New request', body: 'A guest requested their car.' };
  // Plan 7 T1: venueHostRequest kind pre_arrival pushes topic venue_{op}_{venueId}.
  if (kind === 'venue.pre_arrival') {
    const bits = [data.eta ? `ETA ${data.eta}` : '', data.partySize ? `party of ${data.partySize}` : '', data.vip ? 'VIP' : ''].filter(Boolean).join(', ');
    return { title: 'Pre-arrival', body: `${data.name || 'A guest'} is on the way${bits ? ` — ${bits}` : ''}.` };
  }
  // Plan 5 T2 — dispatch/assign.ts pushes both drivers on assignment; dispatch/onJobWritten.ts pushes
  // the primary driver when a pre_drive_inspection→in_transit attempt is reverted for a missing/
  // insufficient inspection report.
  if (kind === 'dispatch.assigned') {
    return { title: 'New job assigned', body: data.role === 'chase' ? 'You are the chase driver on a new drive-home job.' : 'You have a new job — check the app for pickup details.' };
  }
  if (kind === 'dispatch.revert_in_transit') return { title: 'Inspection required', body: 'Complete the pre-drive inspection (4 photos) before starting.' };
  // Fix round 1 (Critical #1) — mirrors dispatch.revert_in_transit for a completed->arrived revert.
  if (kind === 'dispatch.revert_completed') return { title: 'Inspection required', body: 'Complete the post-drive inspection (4 photos) to finish this trip.' };
  if (kind === 'incident.created') {
    const label = INCIDENT_TYPE_LABELS[data.type ?? ''] ?? 'Incident';
    const venue = data.venue || 'your venue';
    return { title: `${label} reported at ${venue}`, body: data.ref ? `Ref: ${data.ref}` : 'Tap to view details.' };
  }
  if (kind === 'credential.expiring') {
    const fieldLabel = data.field === 'insurance' ? 'Insurance' : 'License';
    const name = data.displayName || 'A staff member';
    const days = data.days ?? '';
    return { title: `${fieldLabel} expiring soon`, body: `${name}'s ${fieldLabel.toLowerCase()} expires in ${days} day${days === '1' ? '' : 's'}.` };
  }
  return { title: 'Goldstar', body: 'You have an update.' };
}

interface PushEvent {
  operatorId: string;
  ticketId: string;
  kind: string;
  data: Record<string, string>;
  toUid?: string;
  toTopic?: string;
  status: string;
}

export async function sendPushHandler(deps: Deps, id: string, messaging: { send(m: Message): Promise<string> } = getMessaging()): Promise<void> {
  const ref = deps.db.doc(`pushEvents/${id}`);
  const ev = (await ref.get()).data() as PushEvent | undefined;
  if (!ev || ev.status !== 'queued') return;
  const n = copyFor(ev.kind, ev.data);
  // `kind` rides inside `data` on every send (mobile fix round): `copyFor` consumes it server-side
  // for the rendered copy, but the DEVICE needs it too — it is the only field that says what a
  // notification IS, and without it the client receives rendered copy plus an untagged bag of ids
  // and cannot route the tap (no producer puts `kind` inside `data` itself: assign.ts sends
  // {ticketId, role}, onJobWritten {ticketId}, ticket.handler {ticketId, status}, hostRequest
  // {venueId}). FCM data values must be strings; `ev.kind` already is.
  const sendData = { ...ev.data, kind: ev.kind };
  if (ev.toTopic) {
    try {
      await messaging.send({ topic: ev.toTopic, notification: n, data: sendData });
    } catch (e) {
      // Name-only — never the raw message (may embed the topic/token). Rethrow: this leaves the
      // event 'queued' so retry:true's redelivery is what actually recovers a transient failure;
      // swallowing here would silently drop the notification instead.
      console.error('push send failed (topic)', { name: e instanceof Error ? e.name : typeof e });
      throw e;
    }
    await ref.update({ status: 'sent', sentAt: deps.now() });
    return;
  }
  if (!ev.toUid) {
    await ref.update({ status: 'skipped' });
    return;
  }
  const guestRef = deps.db.doc(P.guest(ev.toUid));
  const userRef = deps.db.doc(P.user(ev.operatorId, ev.toUid));
  const [g, u] = await Promise.all([guestRef.get(), userRef.get()]);
  const target = g.exists ? guestRef : u.exists ? userRef : null;
  const data = target ? ((target === guestRef ? g : u).data() as { fcmTokens?: string[]; consent?: { push?: boolean } } | undefined) : undefined;
  const tokens: string[] = data?.fcmTokens ?? [];
  // Ruling AN (1d final review, finding 7): a guest who disabled push but still has registered tokens
  // must not get pushed anyway — treat consent.push === false exactly like tokens-empty (skip + SMS
  // fallback, which after Ruling AM's fix is dedupe-safe against the trigger's own SMS). `consent` only
  // exists on the guest doc's shape; a staff `u` doc has none, so this never affects staff-targeted
  // pushes (Plan 2b).
  const pushOptedOut = data?.consent?.push === false;
  if (tokens.length === 0 || !target || pushOptedOut) {
    // Ruling AA: fallback BEFORE the terminal status write. A crash between these two lines leaves
    // the pushEvent 'queued' — retry:true redelivery re-runs everything (a duplicate fallback SMS
    // dedupes via .create's code-6 swallow); the alternative order risks the crash landing between
    // 'skipped' and the fallback enqueue, which would strand the guest with neither push nor SMS.
    await smsFallback(deps, ev);
    await ref.update({ status: 'skipped' });
    return;
  }
  // Ruling AD: sends are independent per token and prune ops target different tokens, so run them
  // concurrently (repo standard: Promise.all over independent awaits, not a sequential loop).
  const results = await Promise.all(
    tokens.map(async (token) => {
      try {
        await messaging.send({ token, notification: n, data: sendData, apns: { payload: { aps: { sound: 'default' } } } });
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'messaging/registration-token-not-registered') {
          await target.update({ fcmTokens: FieldValue.arrayRemove(token) });
        } else {
          // Name+code only — never the raw message (may embed the token). Not rethrown: one bad
          // token must not block delivery to the guest's other devices.
          console.error('push send failed (token)', { name: e instanceof Error ? e.name : typeof e, code });
        }
        return false;
      }
    }),
  );
  const ok = results.filter(Boolean).length;
  // Ruling AA: same before-terminal-write ordering as the tokens-empty branch above.
  if (ok === 0) await smsFallback(deps, ev);
  await ref.update({ status: ok > 0 ? 'sent' : 'failed', sentAt: deps.now(), delivered: ok });
}

/** Guests without a working push token still get the SMS the ticket trigger skipped (Plan 1c prefers push). */
async function smsFallback(deps: Deps, ev: PushEvent): Promise<void> {
  if (ev.kind !== 'ticket.status' || !ev.ticketId || !ev.toUid) return;
  const t = (await deps.db.doc(P.ticket(ev.operatorId, ev.ticketId)).get()).data() as
    | { guest: { phoneE164?: string; consentSms: boolean }; venueId: string; guestToken: string; status: string; jobType: JobType }
    | undefined;
  if (!t?.guest.consentSms || !t.guest.phoneE164) return;
  // Mirrors the 1c ticket trigger's own template choice for `assigned` (ticket.handler.ts's
  // enqueueSms call): drive-home jobs get `driveHomeAssigned`, ride jobs get `rideAssigned`. This
  // fallback must pick the same template the trigger would have queued, not hardcode one variant.
  const template = t.status === 'ready' ? 'ready' : t.status === 'assigned' ? (t.jobType === 'drive_home' ? 'driveHomeAssigned' : 'rideAssigned') : t.status === 'closed' ? 'survey' : null;
  if (!template) return;
  // Ruling AM (1d final review, finding 6): SAME deterministic id as ticket.handler.ts's enqueueSms
  // (`${ticketId}_${template}`, no `_fallback` suffix). The old disjoint id space was exactly what
  // defeated the `.create()` dedupe between the trigger's direct SMS and this push-triggered fallback
  // — both docs got created, both sent, for every guest with a uid but no working push token. Sharing
  // the id makes "trigger already sent it" and "fallback is sending it" collide into one doc by
  // construction, in every ordering.
  const id = `${ev.ticketId}_${template}`;
  const link = `https://${process.env.GUEST_HOST ?? 'app.goldstar.example.com'}/t/${t.guestToken}`;
  await deps.db
    .doc(P.outbound(id))
    // .create() (not .set) — same redelivery-safety reasoning as ticket.handler.ts's enqueueSms /
    // enqueuePush: a redelivered/duplicate push-event invocation for the same ticket+template must
    // not reset an in-flight/already-sent fallback SMS back to status:'queued', attempts:0. Swallow
    // ALREADY_EXISTS (code 6) as a no-op.
    .create({ id, channel: 'sms', operatorId: ev.operatorId, venueId: t.venueId, ticketId: ev.ticketId, to: t.guest.phoneE164, template, vars: { link }, status: 'queued', attempts: 0, createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

// retry: true — sendPushHandler's every side effect is idempotent (deterministic fallback-SMS doc id
// + .create() dedupe, token-prune is naturally re-runnable, and the handler no-ops once status has
// left 'queued'), so a crash-then-redelivery self-heals instead of silently dropping a guest
// notification (same reasoning as onTicketWritten.ts's retry:true).
export const onPushEventCreated = onDocumentCreated({ document: 'pushEvents/{id}', retry: true }, async (event) => {
  await sendPushHandler(makeDeps(), event.params.id);
});
