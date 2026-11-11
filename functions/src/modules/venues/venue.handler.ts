import { secretToken, type Operator, type Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

export interface VenueWrittenEvent {
  operatorId: string;
  venueId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | undefined;
}

/**
 * Plan 4a T5 — venuePublic writer. Carries three Plan-3 contract obligations forward (binding
 * controller ruling, non-negotiable):
 *  1. Projection shape matches guest_web's local `VenuePublic` interface (lib/public/firebase.ts,
 *     verified against that repo directly, since `@goldstar/platform@0.3.5` does not export a
 *     venuePublic schema): `{ operatorId, venueId, venueName, branding (display-ready — the same
 *     displayName/primaryColor/accentColor/logoUrl?/supportPhone? shape guest ticket projections
 *     use, resolved the way tickets/projection.ts's `buildProjection` does — NOT `OperatorBranding`
 *     storage paths), rates.valet, tipPresets }`.
 *  2. tipPresets is sourced from `op.modules.payments.tipPresets` — the operator's real payments
 *     config — NEVER from anything venue-level. `guestStaticCheckout`'s Ruling L pre-validates a
 *     guest's chosen preset tip against this same source; any divergence here would let a guest
 *     preview one set of presets and be validated against another, silently zeroing a tip that
 *     looked valid on the page.
 *  3. Ruling M: only ever write/enable the projection when `venue.rates.valet.model === 'flat'` —
 *     `guestStaticCheckoutHandler` throws `failed_precondition` for anything else, so minting a
 *     token + projection for a non-flat venue would produce a guest-facing QR code that leads to a
 *     dead callable. When `staticCheckoutEnabled` flips false, or the model stops being 'flat', the
 *     `venuePublic` doc is deleted — a stale public projection is an information leak (venue name,
 *     branding, live rates) that a since-revoked/never-eligible QR code should not still resolve to.
 *
 * Token minting is idempotent by construction: the venue doc's own `qr.staticCheckoutToken` is only
 * ever written once (generated only when absent), so a re-fired trigger (recursion from this
 * handler's own `.update()`, or an unrelated field edit) never rotates it. That `.update()` only
 * happens on the very first write that lacks a token, which is also the only Firestore write this
 * handler makes to the venue doc itself — nothing here re-fires itself a second time, so no explicit
 * recursion guard (unlike `tickets/onTicketWritten.ts`'s `shouldProcessTicketWrite`) is needed.
 */
export async function venueWrittenHandler(deps: Deps, e: VenueWrittenEvent): Promise<void> {
  // N3 (final-review.md, platform fix wave): checked on the RAW pre-cast event data (`Record<string,
  // unknown>`), not on the `Venue`-typed value below — venue docs aren't shape-validated by
  // firestore.rules, so a hand-written/malformed doc missing `qr` entirely would otherwise throw once
  // cast to `Venue` (whose TS type claims `qr` is always present — checking on the CAST value trips
  // @typescript-eslint/no-unnecessary-condition even though the cast itself is unchecked, since TS has
  // no way to know the runtime doc might not match). An uncaught throw in a Firestore trigger sets
  // `retry: true`, and Cloud Functions keeps re-delivering the same event for up to 7 days. Every
  // schema-valid write this codebase makes (venue create's default, this handler's own token-mint
  // below) always includes `qr` — this guard is pure robustness against an out-of-band write, not a
  // path the dashboard can reach. Log an identifier only (never the raw doc), then return cleanly —
  // same "log a count/identifier, never content" + log-and-return convention as
  // incident.handler.ts's schema-parse-failed path, so this doesn't become a silent retry loop either.
  if (e.after && !e.after.qr) {
    console.error('onVenueWritten: venue doc missing qr', { operatorId: e.operatorId, venueId: e.venueId });
    return;
  }
  // Sign-off micro-fix round (final-review.md "Re-review (final wave)"): same guard, same raw-data
  // reasoning, for `rates.valet` — dereferenced below at `venue.rates.valet.model` (the eligibility
  // check) and again at the projection write's `rates: { valet: venue.rates.valet }`. A malformed
  // doc missing `rates` (or `rates.valet`) entirely would otherwise throw there, same 7-day retry
  // failure mode the `qr` guard above closes.
  const rawRates = e.after?.rates as { valet?: unknown } | undefined;
  if (e.after && !rawRates?.valet) {
    console.error('onVenueWritten: venue doc missing rates.valet', { operatorId: e.operatorId, venueId: e.venueId });
    return;
  }

  const after = e.after as unknown as Venue | undefined;

  if (!after) {
    // Venue deleted (firestore.rules allows isOwner()/platform_admin to delete venues). Clean up
    // any projection that existed under the venue's own token — same leak-prevention reasoning as
    // the disable branch below, just triggered by the venue itself disappearing rather than a field
    // flip. `before` is guaranteed present on a delete event, but (same N3 reasoning as above) not
    // necessarily shape-valid — derived from the raw pre-cast data with an explicitly partial `qr`,
    // not the strict `Venue`-typed `before` below, so a malformed doc just means nothing to clean up
    // (Firestore `.delete()` on an already-missing doc is a silent no-op either way) rather than a throw.
    const staleToken = (e.before as { qr?: { staticCheckoutToken?: string } } | null)?.qr?.staticCheckoutToken;
    if (staleToken) await deps.db.doc(P.venuePublic(staleToken)).delete();
    return;
  }

  let token = after.qr.staticCheckoutToken;
  // Plan 8 Task 12 (carry #15): the push-topic slug is minted here for the same reason and with the
  // same idempotence as the QR token — generated only when absent, so a re-fired trigger never
  // rotates it (a rotation would silently unsubscribe every device on shift). Both land in ONE
  // update when both are missing, so a fresh venue costs one write and one re-fire, not two.
  let pushSlug = after.pushSlug;
  const mint: Record<string, string> = {};
  if (!token) { token = secretToken(); mint['qr.staticCheckoutToken'] = token; }
  if (!pushSlug) { pushSlug = secretToken(); mint.pushSlug = pushSlug; }
  if (Object.keys(mint).length > 0) await deps.db.doc(P.venue(e.operatorId, e.venueId)).update({ ...mint, updatedAt: deps.now() });
  const venue: Venue = { ...after, pushSlug, qr: { ...after.qr, staticCheckoutToken: token } };
  const eligible = venue.qr.staticCheckoutEnabled && venue.rates.valet.model === 'flat';

  if (!eligible) {
    // Idempotent no-op when no projection exists yet (never-enabled venue, or a non-flat venue that
    // was never eligible in the first place) — Firestore .delete() on a missing doc succeeds silently.
    await deps.db.doc(P.venuePublic(token)).delete();
    return;
  }

  const opSnap = await deps.db.doc(P.operator(e.operatorId)).get();
  const op = opSnap.data() as Operator;
  await deps.db.doc(P.venuePublic(token)).set({
    operatorId: e.operatorId,
    venueId: e.venueId,
    venueName: venue.brandingOverride?.displayName ?? venue.name,
    branding: {
      displayName: op.branding.displayName,
      primaryColor: op.branding.primaryColor,
      accentColor: op.branding.accentColor,
      ...(op.branding.supportPhone ? { supportPhone: op.branding.supportPhone } : {}),
    },
    rates: { valet: venue.rates.valet },
    tipPresets: op.modules.payments.tipPresets,
  });
}
