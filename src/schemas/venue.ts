import { z } from 'zod';
import { addressSchema, e164Schema, geoSchema, moneySchema, timestampsSchema } from './common';
export const VENUE_TYPES = ['restaurant', 'hotel', 'event', 'other'] as const;
export const rateItemSchema = z.object({ id: z.string().min(1), label: z.string().min(1), amount: moneySchema, upToMinutes: z.number().int().positive().optional() });
export const feeSchema = z.object({ id: z.string().min(1), label: z.string().min(1), amount: moneySchema });
export const valetRatesSchema = z.object({ model: z.enum(['flat', 'hourly', 'tiered', 'overnight']), items: z.array(rateItemSchema).min(1), taxRateBps: z.number().int().min(0).max(3000), fees: z.array(feeSchema) });
export const tripRatesSchema = z.object({ base: moneySchema, perMile: moneySchema, perMinute: moneySchema, minimum: moneySchema });
export const venueRatesSchema = z.object({ valet: valetRatesSchema, driveHome: tripRatesSchema, passengerRide: tripRatesSchema, validations: z.object({ allowPartial: z.boolean(), maxAmount: moneySchema }) });
export const venueSmsSchema = z.object({ welcome: z.string().max(320).optional(), ready: z.string().max(320).optional(), survey: z.string().max(320).optional(), driveHomeAssigned: z.string().max(320).optional(), rideAssigned: z.string().max(320).optional() });
export const venueSchema = z.object({
  id: z.string().min(1), operatorId: z.string().min(1), name: z.string().min(1), type: z.enum(VENUE_TYPES), status: z.enum(['active', 'inactive']),
  address: addressSchema, geo: geoSchema, phone: e164Schema.optional(),
  zones: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), capacity: z.number().int().positive().optional() })).refine((z) => new Set(z.map((x) => x.id)).size === z.length, 'zone ids must be unique'),
  rates: venueRatesSchema, sms: venueSmsSchema, qr: z.object({ staticCheckoutEnabled: z.boolean(), staticCheckoutToken: z.string().optional() }),
  pms: z.object({ provider: z.literal('opera_cloud'), hotelId: z.string().min(1), noPostBehavior: z.enum(['block', 'fallback_card']), chargeCode: z.string().min(1) }).optional(),
  // `valetItemGroupGuid` is `valetItemGuid`'s mandatory partner, not a nicety: Toast's
  // add-selection endpoint (POST /orders/{orderGuid}/checks/{checkGuid}/selections) requires BOTH
  // the menu item's GUID and its containing menu group's GUID in the MenuItemSelection body, so
  // the item GUID alone cannot add the valet line. Kept optional to match `valetItemGuid` (a venue
  // that never adds valet charges to a check configures neither); `addCharge` must fail
  // `failed_precondition` when one is set without the other.
  //
  // `validationDiscountGuid` MUST reference an OPEN-AMOUNT (variable) discount in Toast. Toast
  // carries an arbitrary validation value as `appliedDiscounts[].discountAmount`, which a
  // fixed-value discount IGNORES — so a fixed one silently applies its own amount instead of the
  // validation's, and every partial validation is wrong by a venue-configured constant with no
  // error surfaced anywhere. Verified against doc.toasttab.com.
  pos: z.object({ provider: z.literal('toast'), restaurantGuid: z.string().min(1), validationDiscountGuid: z.string().optional(), valetItemGuid: z.string().optional(), valetItemGroupGuid: z.string().optional() }).optional(),
  // `qboItemId` is the QuickBooks **Item** (a service item, e.g. "Valet Services") every invoice
  // line references: QBO requires `Line[].SalesItemLineDetail.ItemRef` on every sales line, so
  // without it no invoice can be created at all. Distinct from the operator-level
  // `incomeAccountId` in the quickbooks_online manifest entry — an Account is what an Item POSTS
  // TO, and cannot be referenced by a line in its place. Both ids are resolved-or-created on
  // demand by `syncInvoices` and written back here.
  accounting: z.object({ qboCustomerId: z.string().optional(), qboItemId: z.string().optional() }).optional(),
  stripeLocationId: z.string().optional(), timezone: z.string().optional(),
  // Plan 8 Task 12 (carry #15, contracts v0.4.10): the venue's push-topic slug — a 128-bit random
  // value minted server-side by the venue trigger (exactly like `qr.staticCheckoutToken`), never by
  // a client, and client-immutable in firestore.rules. FCM topic SUBSCRIPTION is client-unrestricted,
  // so a topic named after raw ids (`venue_{op}_{venueId}`) could be joined by any app instance that
  // guessed an operator and venue id; `venue_{pushSlug}` can only be joined by a client that can read
  // this document, which the rules already scope to the venue's own staff. Optional only for the
  // instant between a client create and the trigger's first write.
  pushSlug: z.string().optional(),
  brandingOverride: z.object({ displayName: z.string().optional(), logoLightPath: z.string().optional() }).optional(),
  // v0.4.5 (Ruling BF): the contract's FIGURES — absent before, so invoice generation had no
  // numbers to bill (the fourth listed-the-fields-but-not-their-sufficiency gap of Plan 7). The
  // active model's figure is REQUIRED and foreign figures are REJECTED (venueIssueValidation's
  // strictness: money configuration is never a suggestion — a flat contract carrying a stray
  // revShareBps is how a venue gets billed on a rule nobody chose). `taxRateBps` is what
  // Goldstar charges the VENUE — deliberately not venue.rates.valet.taxRateBps (guest pricing).
  contract: z
    .object({
      model: z.enum(['per_ticket', 'flat', 'rev_share']),
      perTicketFee: moneySchema.optional(),
      flatMonthly: moneySchema.optional(),
      revShareBps: z.number().int().min(0).max(10000).optional(),
      taxRateBps: z.number().int().min(0).max(3000).default(0),
      terms: z.string(),
      billingEmail: z.string().email(),
      invoiceDay: z.number().int().min(1).max(28),
    })
    .superRefine((c, ctx) => {
      const figureFor = { per_ticket: 'perTicketFee', flat: 'flatMonthly', rev_share: 'revShareBps' } as const;
      const own = figureFor[c.model];
      // v0.4.8: every issue carries a `path` naming the figure it is about. Without one the issue
      // lands on the contract OBJECT, and a form bound field-by-field (react-hook-form + zodResolver)
      // renders nothing — which is exactly how the dashboard's venue form came to reject every
      // submit under v0.4.6 with no visible error (Plan 8 carry #69's second half). A cross-field
      // rule that cannot say which field is wrong is not surfaceable by any consumer.
      if (c[own] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [own], message: `${own} required for a ${c.model} contract` });
      for (const [model, figure] of Object.entries(figureFor)) {
        if (model !== c.model && c[figure as keyof typeof c] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [figure], message: `${figure} is only valid for a ${model} contract` });
      }
    }),
}).merge(timestampsSchema);
export type Venue = z.infer<typeof venueSchema>;
export type VenueRates = z.infer<typeof venueRatesSchema>;
export type ValetRates = z.infer<typeof valetRatesSchema>;
