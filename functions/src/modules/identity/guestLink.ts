import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

const OPEN = [
  'checked_in', 'requested', 'claimed', 'retrieving', 'staged', 'ready', 'delivered', 'quoted', 'confirmed',
  'assigned', 'en_route_to_guest', 'pre_drive_inspection', 'in_transit', 'arrived', 'en_route_to_pickup',
  'arrived_pickup', 'completed',
];

export async function guestLinkHandler(deps: Deps, caller: Caller | null, _input: CallableParsedInput<'guestLinkPhone'>): Promise<CallableOutput<'guestLinkPhone'>> {
  void _input;
  if (!caller) throw err('unauthenticated');
  const { uid, phone } = caller;
  if (!phone) throw err('failed_precondition', 'phone not verified');
  // Self-bootstrapping gate (no Identity-Platform blocking function required): require a verified
  // phone claim, and deny any caller carrying an operatorId claim or any role other than 'guest' —
  // operator staff must never link or be handed the guest role. A caller that clears both checks has
  // no other claims by construction, so it's safe to mint roles:['guest'] outright below without
  // merging/preserving anything.
  const extraRoles = caller.roles.filter((r) => r !== 'guest');
  if (caller.operatorId || extraRoles.length > 0) throw err('permission_denied');
  if (!caller.roles.includes('guest')) {
    await deps.auth.setCustomUserClaims(uid, { roles: ['guest'], claimsVersion: 1 });
  }
  const q = await deps.db.collectionGroup('tickets').where('guest.phoneE164', '==', phone).where('status', 'in', OPEN.slice(0, 30)).get();
  let linked = 0;
  let lastOperatorId: string | undefined;
  const batch = deps.db.batch();
  for (const d of q.docs) {
    const data = d.data() as { guest?: { uid?: string }; operatorId?: string };
    // Skip tickets already bound to a guest uid — whether that's this guest (no-op) or a different one
    // (someone else's claim; never overwrite it). Only unbound tickets get linked.
    if (data.guest?.uid) continue;
    batch.update(d.ref, { 'guest.uid': uid });
    linked++;
    lastOperatorId = data.operatorId;
  }
  // Ruling AP (priority fix): the previous single `{merge:true}` set explicitly provided `consent`,
  // `savedVehicles`, and `fcmTokens` on EVERY call — and the mobile app calls this from its
  // onAuthStateChanged handler, which fires on every cold launch with a restored session, not just
  // on fresh sign-in. `{merge:true}` merges maps key-by-key and treats arrays as atomic, so every
  // launch (1) wiped the guest's saved vehicles, (2) dropped every other device's FCM token, and
  // (3) silently re-opted an opted-OUT guest back into SMS — TCPA exposure, the worst of the three.
  // Fix is split ownership of the write, NOT an already-linked guard at the call site (that would
  // leave the destructive write live for any legitimate repeat caller):
  //  - `.create()` + swallow ALREADY_EXISTS (code 6, the repo's universal convention — see
  //    eligibility.ts) seeds the guest-owned fields exactly once, at first link. `push: false` in
  //    the defaults: unlike SMS — where handing over a verified phone number to receive ticket
  //    updates IS a real act of consent — push needs an OS permission grant the app hasn't asked
  //    for yet; the app flips it when the guest actually accepts the prompt.
  //  - the batch then merges ONLY what a (re)link genuinely owns each call: phoneE164,
  //    lastOperatorId, updatedAt. Guest-owned fields are never mentioned again.
  const guestRef = deps.db.doc(P.guest(uid));
  await guestRef
    .create({ phoneE164: phone, fcmTokens: [], savedVehicles: [], consent: { sms: true, push: false }, updatedAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
  batch.set(
    guestRef,
    { phoneE164: phone, ...(lastOperatorId ? { lastOperatorId } : {}), updatedAt: deps.now() },
    { merge: true },
  );
  await batch.commit();
  await audit(deps, { actorUid: uid, action: 'guest.linkPhone', target: uid, after: { linked }, ...(lastOperatorId ? { operatorId: lastOperatorId } : {}) });
  return { linked };
}

export const guestLinkPhone = defineCallable('guestLinkPhone', {}, guestLinkHandler);
