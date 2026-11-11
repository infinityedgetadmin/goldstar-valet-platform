import type { CallableParsedInput, CallableOutput, Ticket } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { resolveToken } from '../guest/token.js';
import { rateLimit } from '../guest/rateLimit.js';
import { runCheckout } from '../payments/checkout.js';

const DRIVE_HOME_TERMS_VERSION = 'drive-home-v1';

/**
 * Resolves the JOB ticket by its own `jobToken` (`token` here — every subsequent guest call for a
 * job uses the job's token, not the parent ticket's). From `quoted`: rejects an expired quote
 * (`failed_precondition('quote_expired')` — client re-requests via `guestRequestDriveHome` for a
 * fresh one) and a `termsVersion` mismatch, then records acceptance and transitions to `confirmed`.
 * From `confirmed` already (a reload/retry after the FIRST call's status write landed but its
 * checkout step didn't — or simply a duplicate submit): re-runs the checkout step idempotently
 * without re-attempting the (now illegal) quoted→confirmed transition — this is what makes "resume a
 * still-valid quote/confirm after a page reload" (P3 carry) actually work end to end, since
 * `runCheckout` itself already tolerates being called again against a `pending`/`failed` intent.
 * Manual-capture (`priceTicket` returns `capture:'manual'` for any non-valet ticket) — the guest's
 * card is authorized here, captured later on job completion (`dispatch/onJobWritten.ts`).
 */
export async function guestConfirmDriveHomeHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'guestConfirmDriveHome'>,
): Promise<CallableOutput<'guestConfirmDriveHome'>> {
  const { operatorId, ticketRef, ticket } = await resolveToken(deps, input.token);
  await rateLimit(deps, `guest:${input.token}`, 20, 60);
  if (ticket.jobType !== 'drive_home') throw err('invalid_argument', 'not a drive_home job');
  if (input.termsVersion !== DRIVE_HOME_TERMS_VERSION) throw err('invalid_argument', 'unsupported termsVersion');

  let merged: Ticket = ticket;
  if (ticket.status === 'quoted') {
    const quote = ticket.driveHome?.quote;
    if (!quote?.expiresAt || quote.expiresAt < deps.now()) throw err('failed_precondition', 'quote_expired');
    // H1(a): no canTransition() role check here on purpose. quoted->confirmed no longer lists
    // 'guest' in DRIVE_HOME_RULES (src/state/driveHome.ts) — a direct client write is blocked by
    // firestore.rules — but this callable's authorization was never that role check anyway: it's
    // resolveToken() (proof of possessing this ticket's guest token) plus the status branch this
    // block is already inside (quoted here, confirmed handled below), which fully and correctly
    // gates from/to on its own.
    const now = deps.now();
    await ticketRef.update({ status: 'confirmed', 'driveHome.termsAcceptedAt': now, 'driveHome.termsVersion': input.termsVersion });
    merged = { ...ticket, status: 'confirmed', driveHome: { ...ticket.driveHome!, termsAcceptedAt: now, termsVersion: input.termsVersion } };
    await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.confirmDriveHome', target: ticket.id, after: { termsVersion: input.termsVersion } });
  } else if (ticket.status !== 'confirmed') {
    throw err('ticket_invalid_transition');
  }
  return runCheckout(deps, operatorId, merged, { kind: 'none' }, caller?.roles.includes('guest') ? 'in_app' : 'web', caller?.uid ?? 'guest');
}

export const guestConfirmDriveHome = defineCallable('guestConfirmDriveHome', { allowAnonymous: true, secrets: ['STRIPE_SECRET_KEY'] }, guestConfirmDriveHomeHandler);
