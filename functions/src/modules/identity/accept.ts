import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { hashToken } from './invite.js';
import { syncClaimsHandler } from './claims.handler.js';

interface InvitationData {
  email: string;
  operatorId: string;
  roles: string[];
  venueIds: string[];
  displayName: string | null;
  expiresAt: string;
  acceptedAt: string | null;
}

function invitationQuery(deps: Deps, token: string) {
  return deps.db.collection('invitations').where('tokenHash', '==', hashToken(token)).limit(1);
}

export async function acceptHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'identityAcceptInvitation'>): Promise<CallableOutput<'identityAcceptInvitation'>> {
  // Pre-transaction read: locates the invitation and its email so we can (a) bind an already-signed-in
  // caller's uid to the invited email (Ruling G) and (b) resolve/create the Auth user for the anonymous
  // accept path — Auth calls cannot happen inside a Firestore transaction. Fails fast on the same error
  // codes a stale/expired/used invitation would raise below, before touching Auth at all.
  const preQ = await invitationQuery(deps, input.token).get();
  const preDoc = preQ.docs[0];
  if (!preDoc) throw err('not_found', 'invitation');
  const preInv = preDoc.data() as InvitationData;
  if (preInv.acceptedAt) throw err('already_exists', 'invitation used');
  if (preInv.expiresAt < deps.now()) throw err('failed_precondition', 'invitation expired');
  // final-review.md F3 / Ruling G-4a: an invite issued before its operator was suspended must not
  // still be acceptable afterward — accepting creates a user doc and syncs claims under a suspended
  // operator (rules then deny that user's data access, but the account gets minted regardless). No
  // platform_admin exemption here: this resolves the INVITE's operator, not the (often anonymous,
  // pre-account) caller's own — there's no synthetic-caller onboarding path to protect on this side,
  // unlike inviteHandler's platform_admin exemption in invite.ts.
  await requireActiveOperator(deps, preInv.operatorId);

  let uid: string;
  if (caller) {
    const record = await deps.auth.getUser(caller.uid);
    if (!record.email || record.email.toLowerCase() !== preInv.email) throw err('permission_denied', 'invitation email mismatch');
    uid = caller.uid;
  } else {
    if (!input.password) throw err('invalid_argument', 'password required');
    const existing = await deps.auth.getUserByEmail(preInv.email).catch(() => null);
    uid = existing ? existing.uid : (await deps.auth.createUser({ email: preInv.email, password: input.password, displayName: input.displayName ?? preInv.displayName })).uid;
  }

  // Single-use enforcement by construction: re-read + re-check + write happen atomically inside the
  // transaction. Two concurrent accepts on the same token both pass the pre-check above, but Firestore
  // serializes their transactions — the loser's attempt re-reads the (by-then) accepted invitation and
  // throws already_exists from inside the transaction callback, which propagates as a rejected promise.
  const result = await deps.db.runTransaction(async (tx) => {
    const txQ = await tx.get(invitationQuery(deps, input.token));
    const txDoc = txQ.docs[0];
    if (!txDoc) throw err('not_found', 'invitation');
    const inv = txDoc.data() as InvitationData;
    if (inv.acceptedAt) throw err('already_exists', 'invitation used');
    if (inv.expiresAt < deps.now()) throw err('failed_precondition', 'invitation expired');
    tx.update(txDoc.ref, { acceptedAt: deps.now(), acceptedUid: uid });
    tx.set(
      deps.db.doc(P.user(inv.operatorId, uid)),
      {
        uid,
        operatorId: inv.operatorId,
        displayName: input.displayName ?? inv.displayName ?? inv.email,
        email: inv.email,
        roles: inv.roles,
        venueIds: inv.venueIds,
        status: 'active',
        fcmTokens: [],
        invitedAt: deps.now(),
        activatedAt: deps.now(),
        eligibility: { driveHome: false, passengerRide: false, reasons: [] },
        payoutStatus: 'none',
      },
      { merge: true },
    );
    return { operatorId: inv.operatorId, invitationId: txDoc.id, email: inv.email };
  });

  await syncClaimsHandler(deps, { operatorId: result.operatorId, uid });
  await audit(deps, { operatorId: result.operatorId, actorUid: uid, action: 'identity.acceptInvitation', target: result.invitationId });
  return { uid, operatorId: result.operatorId, email: result.email };
}

export const identityAcceptInvitation = defineCallable('identityAcceptInvitation', { allowAnonymous: true }, acceptHandler);
