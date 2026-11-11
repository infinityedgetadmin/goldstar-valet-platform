import { secretToken, type CallableParsedInput, type CallableOutput, type Operator, type Ticket, type Venue } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from './rateLimit.js';
import { resolveVenueToken } from './token.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
import { runCheckout } from '../payments/checkout.js';

export async function staticCheckoutHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'guestStaticCheckout'>,
): Promise<CallableOutput<'guestStaticCheckout'>> {
  // resolveVenueToken before rateLimit — same "resolve before writing anything" shape as
  // resolveToken/guestCheckoutHandler (1c Ruling M): an unknown venueToken fails not_found without
  // ever writing a rateLimits doc, and never echoes venue data back to the caller (no enumeration).
  // venueToken's 20+ char entropy makes brute-forcing one impractical regardless of ordering — the
  // IP rate limit below exists to cap repeat abuse of a KNOWN valid token (public signage) from one
  // IP, not to defend against guessing.
  const { operatorId, venueId } = await resolveVenueToken(deps, input.venueToken);
  // deps.callerIp (Fix round 1, Ruling J) — not caller.ip. `callerFrom` always returns `null` for a
  // real unauthenticated `allowAnonymous` call (guest_web never sends a Firebase Auth token), so
  // `caller` carries no IP in production; `defineCallable` resolves the IP once via `ipFrom` and
  // threads it through `Deps` instead — see `Deps.callerIp`'s own comment for why not a stub Caller.
  await rateLimit(deps, `static:${deps.callerIp ?? 'unknown'}`, 10, 600);
  const [opSnap, venueSnap] = await Promise.all([deps.db.doc(P.operator(operatorId)).get(), deps.db.doc(P.venue(operatorId, venueId)).get()]);
  const op = opSnap.data() as Operator;
  const venue = venueSnap.data() as Venue;
  // Ruling L: a preset tip that isn't one of the operator's actual configured presets must fail
  // loudly here, not silently. `priceTicket`/`computeTip` (payments/pricing.ts) key off
  // `op.modules.payments.tipPresets` — the operator's REAL config, not `venuePublic.tipPresets` (a
  // separate, Functions-written projection this handler never reads) — and `computeTip` returns 0
  // for an off-list preset percent with no error (documented in tip-selector.tsx's `defaultTip`
  // JSDoc, web repo). Left unchecked, a guest could preview a nonzero tip on the page and be
  // silently charged $0 tip on submit. `kind: 'custom'`/`'none'` don't reference presets at all —
  // nothing to validate for those.
  if (input.tip.kind === 'preset' && !op.modules.payments.tipPresets.includes(input.tip.percent)) {
    throw err('invalid_argument', 'tip preset not offered by this operator');
  }
  // Ruling M: static checkout is only meaningful for a flat-rate venue — `computeValetPrice`'s
  // 'hourly'/'tiered' branches both still return a plausible-looking number when `checkedInAt === at`
  // (as it always is here: the ticket is created and priced in the same instant), but a silently
  // wrong one ('hourly' bills exactly one hour; 'tiered' always resolves the lowest tier) rather than
  // an error. 'overnight' prices identically to 'flat' (same `items[0].amount`, no duration
  // dependence) but is excluded too — it's a distinct operator-intent signal from 'flat' that this
  // task was never asked to treat as static-checkout-eligible.
  if (venue.rates.valet.model !== 'flat') {
    throw err('failed_precondition', 'static checkout requires flat valet pricing');
  }
  const now = deps.now();
  // Each call is a NEW ticket by design — this is the product: every guest at the venue pays for
  // their own car off the same public QR/link, so there is no existing ticket to look up or reuse.
  const ticket: Ticket = {
    id: deps.newId(),
    operatorId,
    venueId,
    jobType: 'valet',
    status: 'checked_in',
    source: 'guest_web',
    // phoneLast4 '0000' sentinel + consentSms:false: the documented no-phone representation
    // (ticket.ts schema comment, Ruling Q) — a static-checkout guest never gives a phone number.
    guest: { phoneLast4: '0000', consentSms: false },
    vehicle: input.plateLast4 !== undefined ? { plate: input.plateLast4 } : {},
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: {},
    times: { checkedInAt: now },
    damageReportIds: [],
    incidentIds: [],
    guestToken: secretToken(),
  };
  await deps.db.doc(P.ticket(operatorId, ticket.id)).set(ticket);
  // Seeds guestTickets/{guestToken} so /t/{ticketToken} has a projection to redirect into the
  // instant this returns — mirrors seedTicket's create-then-ticketWrittenHandler pattern used
  // throughout guest.test.ts / checkout.test.ts.
  await ticketWrittenHandler(deps, { operatorId, ticketId: ticket.id, before: null, after: ticket });
  // Flat valet pricing, no duration: computeValetPrice's 'flat' branch always prices at
  // rates.valet.items[0].amount regardless of checkedInAt→now elapsed time, so reusing the same
  // runCheckout/priceTicket path as every other checkout needs no special-casing here.
  const result = await runCheckout(deps, operatorId, ticket, input.tip, 'web', caller?.uid ?? 'guest');
  // deps.callerIp (not caller?.ip) — same reasoning as the rateLimit call above.
  await audit(deps, { operatorId, actorUid: caller?.uid ?? 'guest', action: 'guest.staticCheckout', target: ticket.id, ...(deps.callerIp ? { ip: deps.callerIp } : {}) });
  return { ...result, ticketToken: ticket.guestToken };
}

export const guestStaticCheckout = defineCallable('guestStaticCheckout', { allowAnonymous: true, secrets: ['STRIPE_SECRET_KEY'] }, staticCheckoutHandler);
