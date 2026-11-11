import type { CallableParsedInput, CallableOutput, Validation, Venue } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { requireVenueUser } from '../venue/hostRequest.js';
import { redeemValidation } from '../venue/validation.js';
import { getPos } from './registry.js';
import { PROVIDER_CLAIM_TTL_MS } from '../../lib/providerClaim.js';

/**
 * Validation-side POS push state — Admin-SDK-only fields on the validation doc (the
 * `deletedPhoneHash` precedent: not part of the published `Validation` type, read back through
 * this local shape). Written by THIS handler only.
 */
interface PosPushFields {
  posPush?: { checkRef: string; status: 'pending' | 'pushed' | 'failed'; at: string };
}

// Shared claim-takeover TTL — canonical rationale in lib/providerClaim.ts.

/**
 * `posApplyValidation` (Plan 7 Task 3, Rulings F + AJ): the venue host applies a validation to
 * the guest's restaurant check — the POS-side twin of `staffApplyValidation`, and per Ruling F
 * the two are MUTUALLY EXCLUSIVE terminal states for one code, both flowing through the ONE
 * shared guard (`venue/validation.ts`'s `redeemValidation` — never a second implementation).
 *
 * Ruling AJ closed the original contract's two holes: the input now carries the CODE (so there
 * is something to redeem) and the TICKET (so Ruling O has a base to compute from), and the
 * amount is SERVER-COMPUTED by the guard — the old client-supplied `amount` was an unbounded
 * discount primitive with no issued code behind it.
 *
 * ORDERING (Ruling AJ: "choose the failure you can retry over the one you can't unwind"):
 * guard FIRST, POS push SECOND. Push-first's failure mode is a discount applied AND the code
 * still redeemable at the stand — the exact double-benefit Ruling F exists to prevent, and it
 * cannot be unwound. Guard-first's failure mode is a redeemed validation whose push didn't
 * confirm — retryable: the `posPush` marker written on the validation records the outcome, and
 * a RETRY of this callable that finds the validation already redeemed BY THIS FLOW for THIS
 * check (redemption source 'pos' via the processedEvents marker, matching checkRef, push not
 * 'pushed') retries ONLY the push instead of dying on 'already redeemed'. A code redeemed at
 * the STAND (or for a different check) still rejects — the mutual exclusion is never relaxed.
 *
 * T3 review H1: the claim `posPush {checkRef, status:'pending'}` is written INSIDE the
 * redemption transaction (redeemValidation's extraValidationFields), so the push is CLAIMED
 * before it is ever attempted. That closes both proven holes of the shipped version, where
 * `posPush === undefined` qualified for retry with the checkRef binding skipped: a concurrent
 * duplicate call during an in-flight push landed a SECOND discount, and a crash-state retry
 * naming a DIFFERENT check pushed there. Now `undefined` is never retryable (this flow's own
 * redemptions always carry the claim), the checkRef binds unconditionally, and a fresh
 * `pending` refuses the duplicate while a stale one (see PROVIDER_CLAIM_TTL_MS) admits the genuine
 * crash retry.
 *
 * The push itself is the Ruling Y UNVERIFIED Toast call — see toast.adapter.ts; this flow is
 * proven end-to-end against MockPosProvider.
 */
export async function posApplyValidationHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'posApplyValidation'>,
): Promise<CallableOutput<'posApplyValidation'>> {
  const c = requireVenueUser(caller, input.venueId);
  await requireActiveOperator(deps, c.operatorId);

  const venue = (await deps.db.doc(P.venue(c.operatorId, input.venueId)).get()).data() as Venue | undefined;
  if (!venue) throw err('not_found', 'venue');

  // Same venue-scoped, oracle-free lookup as staffApplyValidation: a foreign or fabricated code
  // reads identically as not_found.
  const match = await deps.db
    .collection(`operators/${c.operatorId}/validations`)
    .where('venueId', '==', input.venueId)
    .where('code', '==', input.code)
    .limit(1)
    .get();
  const validation = match.docs[0]?.data() as (Validation & PosPushFields) | undefined;
  if (!validation) throw err('not_found', 'validation');

  const validationRef = deps.db.doc(P.validation(c.operatorId, validation.id));
  let amount: number;
  if (validation.redeemedTicketId) {
    // Retry path — legitimate ONLY when this exact flow already redeemed this code for this
    // ticket+check and the push never confirmed. Anything else keeps the hard mutual exclusion.
    const marker = (await deps.db.doc(`processedEvents/val_${validation.id}`).get()).data() as
      | { ticketId?: string; source?: string }
      | undefined;
    // M1 (T2/T3 fix round): the gate AND the re-claim run in ONE transaction against a FRESH
    // read. The H1 fix claimed the push atomically on the FRESH path but the retry path still
    // read-gated-and-pushed without re-taking the claim, so two concurrent retries after a
    // failed push both qualified and both pushed — H1's exact outcome one state deeper (and the
    // stale-pending state had the same hole). Now the winner's `pending` write makes the loser's
    // transaction retry re-read it as fresh and land on the same 'push in progress' the primary
    // race produces. The marker read stays outside the transaction — it is immutable after its
    // `.create`.
    amount = await deps.db.runTransaction(async (tx) => {
      const fresh = (await tx.get(validationRef)).data() as (Validation & PosPushFields) | undefined;
      if (!fresh) throw err('not_found', 'validation');
      const posPush = fresh.posPush;
      // H1: this flow's own redemptions ALWAYS carry the posPush claim (written in the redemption
      // transaction), so `undefined` is never a retryable state, and the checkRef binding holds
      // unconditionally — a retry naming a different check is 'already redeemed', full stop.
      const isOwnRedemption =
        fresh.redeemedTicketId === input.ticketId &&
        marker?.source === 'pos' &&
        marker.ticketId === input.ticketId;
      if (!isOwnRedemption || posPush === undefined || posPush.checkRef !== input.checkRef || posPush.status === 'pushed') {
        throw err('failed_precondition', 'validation already redeemed');
      }
      if (posPush.status === 'pending' && Date.parse(posPush.at) > Date.parse(deps.now()) - PROVIDER_CLAIM_TTL_MS) {
        // A FRESH pending claim is an in-flight push — the double-click race. Refuse the duplicate;
        // the first call will confirm or mark failed, and only a STALE pending (crash) may retry.
        throw err('failed_precondition', 'push in progress');
      }
      if (fresh.redemption === undefined) throw err('failed_precondition', 'validation already redeemed');
      tx.update(validationRef, { posPush: { checkRef: input.checkRef, status: 'pending', at: deps.now() } });
      return fresh.redemption.amount;
    });
  } else {
    ({ validationAmount: amount } = await redeemValidation(deps, {
      operatorId: c.operatorId,
      validationId: validation.id,
      ticketId: input.ticketId,
      actorUid: c.uid,
      source: 'pos',
      // H1: claim the push atomically with the redemption — see the header comment.
      extraValidationFields: { posPush: { checkRef: input.checkRef, status: 'pending', at: deps.now() } },
    }));
  }

  try {
    const pos = await getPos(deps, c.operatorId, venue);
    await pos.applyValidation({ checkRef: input.checkRef, amount, reason: input.code });
    await validationRef.update({ posPush: { checkRef: input.checkRef, status: 'pushed', at: deps.now() } });
  } catch (e) {
    // The redemption stands (terminal, exactly-once); the push is what failed. Record it so the
    // retry path above re-attempts ONLY the push, and surface the provider error to the host.
    await validationRef.update({ posPush: { checkRef: input.checkRef, status: 'failed', at: deps.now() } });
    throw e;
  }

  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'pos.applyValidation', target: validation.id, after: { ticketId: input.ticketId, checkRef: input.checkRef, amount } });
  return { ok: true };
}

export const posApplyValidation = defineCallable('posApplyValidation', {}, posApplyValidationHandler);
