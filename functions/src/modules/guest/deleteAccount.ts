import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import type { CallableParsedInput, CallableOutput, Guest } from '@goldstar/platform';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { getPlatformGateway } from '../payments/registry.js';
import { paginateGuestTickets } from './ticketsByGuest.js';

const TICKET_UNLINK_PAGE_SIZE = 500; // Firestore's own batch-write ceiling

/**
 * Fix round 2 (task-platform-review.md, M1): the earlier version of this handler overwrote
 * `phoneE164` with the one-way hash directly, and detected "already anonymized" by checking that
 * the stored value no longer parsed as `e164Schema` — which meant EVERY deleted account's guest doc
 * became a PERMANENT structural violator of `guestSchema` (`phoneE164: e164Schema`, required, not
 * optional). A future consumer that validates a fetched `guests/{uid}` doc against `guestSchema`
 * (an export tool, an admin audit script, a new callable) would throw on every deleted account,
 * forever. Fixed: the hash moves to a DISTINCT field (`deletedPhoneHash`, not part of the published
 * `Guest` type — an Admin-SDK-only marker, same "extra field the schema doesn't know about, and
 * doesn't need to" pattern as `claimsVersion`/`claimsSyncedAt` on `operators/{op}/users/{uid}`,
 * neither of which is in `guestSchema`'s sibling `userSchema` either), `phoneE164` gets overwritten
 * with a schema-VALID sentinel instead (still never a usable real number), and re-run detection is
 * keyed off a dedicated `deletedAt` marker — never off the phone field's format.
 */

// Schema-valid placeholder — passes e164Schema (`/^\+[1-9]\d{6,14}$/`) but is never a real,
// dialable number. Same "documented sentinel, theoretical/accepted collision, display-only"
// reasoning as ticketBaseSchema's `phoneLast4: '0000'` (Ruling Q) — Firestore has no uniqueness
// constraint on this field, and nothing here ever uses it to look up or contact anyone.
const DELETED_PHONE_SENTINEL = '+10000000000';

// One-way hash for the guest's phone number on delete — same primitive as identity/invite.ts's
// hashToken (createHash('sha256').update(...).digest('hex')), applied here instead of a reversible
// encryption so the retained value can never be turned back into a real phone number even with the
// platform's own keys. Written to `deletedPhoneHash`, never back into `phoneE164` (see the block
// comment above).
function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

// `deletedAt`/`deletedPhoneHash` are Admin-SDK-only markers, deliberately not part of the published
// `Guest` type (no contracts-package change in this task) — this local type is how this file reads
// them back safely off a fetched doc.
type DeletedGuestFields = { deletedAt?: string; deletedPhoneHash?: string };

/**
 * Fix round 1 ruling (task-platform-report.md): DETACH every attached CARD PaymentMethod on the
 * customer, but KEEP the Stripe Customer object itself and `guests/{uid}.stripeCustomerId`. A
 * delete-account request must leave no USABLE stored card data behind — a detached PaymentMethod
 * can't be charged or listed back to anyone — while the Customer carries the charge/refund/dispute
 * history that transactions/tickets still reference; deleting it would orphan real financial
 * records the same way clearing the ticket-side phoneE164/phoneLast4 would orphan operator records
 * (see the comment on that decision below). Best-effort: a Stripe failure on any single PM must
 * not abort the rest of account deletion — logged (name only, never the raw error — same
 * PII/secrets discipline as errors.ts's toHttpsError) and counted, not thrown.
 *
 * Fix round 2 (task-platform-review.md, M2): corrected from an earlier, overstated "every one of
 * the customer's PaymentMethods" — `listPaymentMethods` (payments/port.ts, stripe.adapter.ts) is
 * hardcoded to `type: 'card'`, matching task-4-brief.md's spec for the guest-facing list callable
 * it's shared with (guestListPaymentMethods). Nothing in this app's own flows can attach a non-card
 * PaymentMethod today (guestSetupIntent also hardcodes `payment_method_types: ['card']`), so this
 * is low-risk in practice, but a bank-account/SEPA-debit PM attached some other way would survive
 * account deletion untouched. Not fixed here (would need a dedicated non-card-shaped port method,
 * not a one-line change) — flagged in task-platform-report.md for the ledger.
 */
async function detachAllPaymentMethods(deps: Deps, customerId: string): Promise<{ detached: number; failures: number }> {
  const gw = getPlatformGateway(deps);
  const methods = await gw.listPaymentMethods({ customerId });
  let detached = 0;
  let failures = 0;
  for (const m of methods) {
    try {
      await gw.detachPaymentMethod({ id: m.id });
      detached++;
    } catch (e) {
      failures++;
      console.error('guestDeleteAccount: payment method detach failed', { name: e instanceof Error ? e.name : typeof e });
    }
  }
  return { detached, failures };
}

// Plan 6 (guest account): irreversible self-service account deletion. Ordering matters throughout —
// anonymize the guest doc, detach payment methods, and unlink tickets FIRST (all idempotent, see
// below), delete the Firebase Auth user LAST (per brief) so a crash between steps always leaves the
// account in a state where a retry (this handler invoked again with the same uid) can safely finish
// the job rather than one where the Auth user is already gone but the guest doc/tickets/cards still
// carry live data.
//
// Deliberately NOT cleared: `stripeCustomerId` and `lastOperatorId` on the guest doc, and the Stripe
// Customer object itself (see detachAllPaymentMethods' own comment for the Stripe-side reasoning).
// The brief's explicit clear-list is name/savedVehicles/savedAddresses/needs/fcmTokens + the phone
// hash — this still isn't fully my call; flagged in task-platform-report.md for review either way.
export async function guestDeleteAccountHandler(
  deps: Deps,
  caller: Caller | null,
  _input: CallableParsedInput<'guestDeleteAccount'>,
  // DI default, same convention as maps/autocomplete.ts's `maps` parameter — lets a test exercise
  // the pagination path itself (paginateGuestTickets, ticketsByGuest.ts) with a small page size
  // instead of needing to seed 500+ real ticket docs to cross the real ceiling.
  ticketUnlinkPageSize: number = TICKET_UNLINK_PAGE_SIZE,
): Promise<CallableOutput<'guestDeleteAccount'>> {
  void _input; // {confirm: true} — confirmation is enforced structurally by the callable's own zod input schema (z.literal(true)), nothing further to check here
  const c = requireRole(caller, ['guest']);
  const gRef = deps.db.doc(P.guest(c.uid));
  const gSnap = await gRef.get();
  const g = gSnap.data() as (Guest & DeletedGuestFields) | undefined;
  // Re-run safety: a second invocation for the same uid (e.g. a client retry after a network error on
  // the FIRST call's response, well before the Auth user is actually gone) must not re-hash an
  // already-hashed value or throw on an already-cleared doc. `g` can only be undefined if the guest
  // doc was somehow never created — `guests/{uid}` is never deletable (firestore.rules `allow delete:
  // if false`), so once created it always exists; guard anyway rather than assume. Keyed off the
  // explicit `deletedAt` marker (Fix round 2, M1) — never off the phone field's format.
  const alreadyAnonymized = !g || g.deletedAt !== undefined;
  if (!alreadyAnonymized) {
    await gRef.update({
      phoneE164: DELETED_PHONE_SENTINEL,
      deletedPhoneHash: hashPhone(g.phoneE164),
      deletedAt: deps.now(),
      name: FieldValue.delete(),
      savedVehicles: [],
      savedAddresses: [],
      needs: FieldValue.delete(),
      fcmTokens: [],
      updatedAt: deps.now(),
    });
  }
  // Unconditional (not gated on `alreadyAnonymized`) — naturally idempotent on a re-run: Stripe just
  // reports zero remaining PaymentMethods for a customer whose cards were already detached.
  const { detached, failures } = g?.stripeCustomerId ? await detachAllPaymentMethods(deps, g.stripeCustomerId) : { detached: 0, failures: 0 };
  // Unlink every ticket this guest ever had (not just open ones — a closed/cancelled ticket that still
  // carries `guest.uid` after the Auth user is deleted is a dangling reference no rule/query expects).
  // `guest.uid` removed via FieldValue.delete() rather than set to a sentinel; `guest.phoneE164`/
  // `guest.phoneLast4` on the TICKET (a separate field from the guest doc's own phoneE164 above) are
  // left untouched — per the brief's explicit retention call: operators need those for their own
  // records (a valet ticket's contemporaneous contact info) independent of the guest account's
  // continued existence. Paginated via ticketsByGuest.ts's shared cursor walk with NO maxPages
  // ceiling — a delete-account request is a legal-obligation completion, not a best-effort sweep, so
  // this loops until every matching ticket (however many) is unlinked, however many pages that takes.
  const ticketsUnlinked = await paginateGuestTickets(deps, c.uid, { pageSize: ticketUnlinkPageSize }, async (docs) => {
    const batch = deps.db.batch();
    for (const d of docs) batch.update(d.ref, { 'guest.uid': FieldValue.delete() });
    await batch.commit();
    return docs.length;
  });
  // Delete the Firebase Auth user LAST among the destructive data-mutation steps (brief) — still
  // true here; only the AUDIT write (a log, not resumable state) moves to after this, per the
  // Fix round 5 correction below. `authUserDeletedByThisCall` is `true` only when THIS invocation's
  // own `deleteUser` call actually removed the user; `auth/user-not-found` means an EARLIER
  // invocation already did it (the only reliable "someone else already finished this" signal — see
  // that fix's comment on `shouldAudit` just below). Every other Auth error still propagates.
  let authUserDeletedByThisCall = false;
  try {
    await deps.auth.deleteUser(c.uid);
    authUserDeletedByThisCall = true;
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e;
  }
  /**
   * Fix round 5 (task-platform-review.md, re-review of N1): the ORIGINAL N1 fix gated the audit
   * write on `ticketsUnlinked`/`detached`/`failures` alone — counts that conflate "nothing NEW to
   * do this call" with "the whole operation, including the audit, was already fully completed by
   * an earlier call." That's wrong: a crash that lands after the LAST real Firestore/Stripe write
   * but before `deleteUser()` leaves `alreadyAnonymized: true` and every count at 0 on the
   * RESUMING call — which then goes on to perform the actual, first-time, irreversible Auth
   * deletion above — and the old gate skipped its audit row. A completed deletion with zero audit
   * rows, permanently, for a legal-obligation operation, in a directly-reachable crash window.
   * Empirically verified against the emulator by the round 2-4 re-reviewer.
   *
   * Fixed: `authUserDeletedByThisCall` (whether THIS call's own `deleteUser` attempt is the one
   * that actually removed the user, vs. finding it already gone) is now ALSO an audit trigger,
   * alongside the pre-existing count checks — never a replacement for them, only ORed in. The
   * true no-op case (skip audit) now requires ALL of: the guest doc was already anonymized before
   * this call, no ticket/payment-method work happened this call, AND the Auth user was already
   * gone before this call (so `deleteUser` merely confirmed that, rather than performing it).
   */
  /**
   * N2 (owed from an earlier wave, named here): a RESIDUAL unaudited window survives the fix
   * above, and it is narrow but real. A crash landing strictly BETWEEN `deleteUser()` returning
   * and `audit()` committing leaves the Auth user deleted with no audit row — and no later call
   * can recover it. The resuming invocation's `deleteUser` throws `auth/user-not-found`, so
   * `authUserDeletedByThisCall` is FALSE; the guest doc is already anonymized and every count is
   * 0; `shouldAudit` is therefore false and the row is never written. The one signal that a
   * deletion happened was consumed by the call that crashed.
   *
   * Not fixed here because the honest fix is a durable intent record (write an "intending to
   * delete" marker before `deleteUser`, clear it after the audit, and have a sweeper finish
   * orphans) — that is a design change, not a comment. Accepted for now because the window is a
   * single process death inside a sub-second gap, and the failure is a MISSING audit row rather
   * than an incorrect one: nothing asserts a deletion that did not happen, which is the direction
   * that matters for M1's reasoning about trusting this log.
   */
  const shouldAudit = authUserDeletedByThisCall || !alreadyAnonymized || ticketsUnlinked > 0 || detached > 0 || failures > 0;
  if (shouldAudit) {
    await audit(deps, { actorUid: c.uid, action: 'guest.deleteAccount', target: c.uid, after: { ticketsUnlinked, paymentMethodsDetached: detached, paymentMethodDetachFailures: failures } });
  }
  return { ok: true };
}

export const guestDeleteAccount = defineCallable('guestDeleteAccount', { secrets: ['STRIPE_SECRET_KEY'] }, guestDeleteAccountHandler);
