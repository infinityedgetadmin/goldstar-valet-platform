import { z } from 'zod';
import { JOB_TYPES } from './domain/status';
import { STAFF_ROLES } from './domain/roles';
import { INTEGRATION_IDS } from './integrations/manifest';
import { dayStringSchema, e164Schema, geoSchema, isoDateSchema, moneySchema, posCheckRefSchema, secretTokenSchema, uuidSchema } from './schemas/common';
import { operatorSchema } from './schemas/operator';
import { quoteSchema, ticketSchema, ticketStatusSchema } from './schemas/ticket';
import { transactionSchema } from './schemas/transaction';
import { auditLogEntrySchema } from './schemas/auditLogEntry';
import { venueMetricsSchema } from './schemas/metricsDaily';
const token = secretTokenSchema;
// Plan 4b Task 7: `analyticsSummary`'s v0.3.5-installed output (`{ tickets, retrievalP50,
// retrievalP90, tips, revenue, damageReports, claims }`, no venue breakdown, no previous-period
// comparison) predates the Reports/Executive dashboard's actual requirements (KPI tiles need
// value+delta vs. the previous period; the venue comparison table needs a per-venue breakdown) —
// it reads as a placeholder stub written before this task was scoped, not a deliberately narrow
// design. Widened here rather than left as-is and worked around client-side, since this callable
// has ZERO consumers yet anywhere in the dashboard repo (verified by grep) — there is no live
// caller whose contract this breaks. Disclosed in task-7-report.md.
//
// `hourly` is omitted from the summary shape (`.omit({hourly:true})`) — a 24-int histogram PER DAY
// in the range would bloat the payload for an executive quarter-view and nothing on the
// Reports/Executive pages charts it (the forecast page reads `metrics/forecast/weeks/*` directly,
// which already carries its own pre-aggregated `byWeekdayHour` grid — see `metricsForecast.ts`).
const venueMetricsSummary = venueMetricsSchema.omit({ hourly: true });
const INVITABLE_ROLES = [...STAFF_ROLES, 'venue_user'] as const;
const tipChoice = z.discriminatedUnion('kind', [z.object({ kind: z.literal('preset'), percent: z.number().int() }), z.object({ kind: z.literal('custom'), amount: moneySchema }), z.object({ kind: z.literal('none') })]);
const destination = z.object({ address: z.string().min(1), geo: geoSchema, placeId: z.string().optional() });
const checkout = z.object({ clientSecret: z.string(), publishableKey: z.string(), total: moneySchema, tip: moneySchema, customerId: z.string().optional(), ephemeralKey: z.string().optional() });
export const callables = {
  guestRequestVehicle: { input: z.object({ token }), output: z.object({ status: ticketStatusSchema }) },
  guestFlagAssistance: { input: z.object({ token, assistance: z.boolean() }), output: z.object({ ok: z.literal(true) }) },
  guestCreateCheckout: { input: z.object({ token, tip: tipChoice }), output: checkout },
  guestRequestDriveHome: { input: z.object({ token, destination }), output: z.object({ quote: quoteSchema, jobToken: token }) },
  guestConfirmDriveHome: { input: z.object({ token, termsVersion: z.string() }), output: checkout },
  guestRequestRide: { input: z.object({ token, pickup: z.object({ address: z.string().optional(), venueId: z.string().optional(), geo: geoSchema }), dropoff: destination, passengers: z.number().int().min(1).max(8), accessible: z.boolean() }), output: z.object({ quote: quoteSchema, jobToken: token }) },
  guestConfirmRide: { input: z.object({ token }), output: checkout },
  guestCancel: { input: z.object({ token, reason: z.string().min(1).max(200) }), output: z.object({ ok: z.literal(true) }) },
  guestLinkPhone: { input: z.object({}), output: z.object({ linked: z.number().int() }) },
  guestStaticCheckout: { input: z.object({ venueToken: z.string().min(20), plateLast4: z.string().length(4).optional(), tip: tipChoice }), output: checkout.extend({ ticketToken: token }) },
  guestSurvey: { input: z.object({ token, score: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }), output: z.object({ ok: z.literal(true) }) },
  guestListPaymentMethods: { input: z.object({}), output: z.object({ methods: z.array(z.object({ id: z.string(), brand: z.string(), last4: z.string(), expMonth: z.number(), expYear: z.number() })) }) },
  guestDetachPaymentMethod: { input: z.object({ id: z.string() }), output: z.object({ ok: z.literal(true) }) },
  guestSetupIntent: { input: z.object({}), output: z.object({ clientSecret: z.string(), customerId: z.string(), ephemeralKey: z.string(), publishableKey: z.string() }) },
  guestDeleteAccount: { input: z.object({ confirm: z.literal(true) }), output: z.object({ ok: z.literal(true) }) },
  guestEmailReceipt: { input: z.object({ ticketId: uuidSchema, email: z.string().email() }), output: z.object({ ok: z.literal(true) }) },
  mapsAutocomplete: { input: z.object({ query: z.string().min(2).max(120), sessionToken: z.string().min(8), proximity: geoSchema.optional() }), output: z.object({ suggestions: z.array(z.object({ id: z.string(), label: z.string(), geo: geoSchema.optional() })) }) },
  staffCreateCheckout: { input: z.object({ ticketId: uuidSchema, tip: tipChoice, method: z.enum(['in_app', 'tap_to_pay', 'reader']) }), output: checkout },
  staffCancelTicket: { input: z.object({ ticketId: uuidSchema, reason: z.string().min(1).max(200) }), output: z.object({ ok: z.literal(true) }) },
  staffRefund: { input: z.object({ ticketId: uuidSchema, amount: moneySchema.optional(), reason: z.string().min(1).max(200) }), output: z.object({ refundRef: z.string() }) },
  staffApplyValidation: { input: z.object({ ticketId: uuidSchema, code: z.string().regex(/^[A-Z0-9]{6}$/) }), output: z.object({ validationAmount: moneySchema }) },
  staffReverseRoomCharge: { input: z.object({ ticketId: uuidSchema, reason: z.string().min(1) }), output: z.object({ ok: z.literal(true) }) },
  // `email` is safe to return here: the caller already proved possession of the invitation
  // token, and the server has already bound the created/matched Auth account to that same
  // invitation email — this just saves the client a round trip to learn what it needs to
  // call signIn(email, password) with next.
  identityAcceptInvitation: { input: z.object({ token: z.string().min(20), password: z.string().min(10).optional(), displayName: z.string().min(1).optional() }), output: z.object({ uid: z.string(), operatorId: z.string(), email: z.string() }) },
  identityAssumeOperator: { input: z.object({ operatorId: z.string().min(1) }), output: z.object({ customToken: z.string() }) },
  identityInvite: { input: z.object({ email: z.string().email(), roles: z.array(z.enum(INVITABLE_ROLES)).min(1), venueIds: z.array(z.string()).default([]), displayName: z.string().optional() }), output: z.object({ inviteId: z.string() }) },
  identityRevokeInvitation: { input: z.object({ inviteId: z.string() }), output: z.object({ ok: z.literal(true) }) },
  platformCreateOperator: { input: operatorSchema.omit({ createdAt: true, updatedAt: true, createdBy: true, status: true }).extend({ ownerEmail: z.string().email(), ownerName: z.string().min(1) }), output: z.object({ operatorId: z.string(), inviteId: z.string() }) },
  platformSetOperatorStatus: { input: z.object({ operatorId: z.string(), status: z.enum(['onboarding', 'active', 'suspended']) }), output: z.object({ ok: z.literal(true) }) },
  auditQuery: { input: z.object({ from: isoDateSchema, to: isoDateSchema, action: z.string().optional(), actorUid: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }), output: z.object({ entries: z.array(auditLogEntrySchema) }) },
  dispatchAssign: { input: z.object({ ticketId: uuidSchema, primaryDriverUid: z.string().min(1), chaseDriverUid: z.string().optional(), fleetVehicleId: z.string().optional() }), output: z.object({ ok: z.literal(true) }) },
  dispatchQuote: { input: z.object({ ticketId: uuidSchema }), output: z.object({ quote: quoteSchema }) },
  terminalConnectionToken: { input: z.object({ venueId: z.string().min(1) }), output: z.object({ secret: z.string(), locationId: z.string() }) },
  connectOnboardingLink: { input: z.object({ kind: z.enum(['operator', 'worker']) }), output: z.object({ url: z.string().url() }) },
  connectAccountStatus: { input: z.object({ accountId: z.string().optional() }), output: z.object({ chargesEnabled: z.boolean(), payoutsEnabled: z.boolean(), requirementsDue: z.array(z.string()) }) },
  // Plan 8 Task 8 (v0.4.12): `knownGuest` — the returning-guest hint. When the read plate matches the
  // operator's most recent ticket for that plate, the callable returns only what the attendant needs
  // to greet a repeat guest: the phone's last four (never the number) and where they were last seen.
  // The 0.7 prefill threshold is the CLIENT's rule; the server always returns what it read.
  visionReadPlate: {
    input: z.object({ storagePath: z.string().min(1) }),
    output: z.object({
      plate: z.string().optional(), state: z.string().optional(), confidence: z.number().min(0).max(1),
      candidates: z.array(z.object({ plate: z.string(), confidence: z.number() })),
      knownGuest: z.object({ phoneLast4: z.string().length(4), lastVenueId: z.string(), lastVenueName: z.string().optional(), lastSeenAt: isoDateSchema }).optional(),
    }),
  },
  claimsGenerateBundle: { input: z.object({ claimId: uuidSchema }), output: z.object({ pdfPath: z.string(), zipPath: z.string() }) },
  /**
   * Host-portal request. Three kinds, three field groups — every added field is `.optional()` at
   * the contract level and made required by the HANDLER's `refine` for the kind that needs it,
   * because one flat input serves all three kinds.
   *
   * `eta`/`partySize`/`vip` (kind `pre_arrival`): `hostRequestSchema` — the stored document — has
   * carried these since Plan 1a, but this input did not, so zod's default strip mode silently
   * dropped them before the request ever left the browser. The dashboard folded them into `note`
   * as a stopgap; the re-vendor commit MUST delete that fold-in (`composePreArrivalNote` in
   * `pre-arrival-form.tsx`) and its tripwire test, which is written to start failing here.
   *
   * `dropoff`/`passengers`/`accessible` (kind `ride`): `rideDetailsSchema` requires `pickup.geo`,
   * `dropoff.{address,geo}`, `passengers`, `accessible` and `billTo`. Verified by parsing a
   * minimal passenger_ride ticket against `ticketSchema`: with `dropoff` alone it still fails on
   * `ride.passengers` and `ride.accessible`, so all three fields are needed to construct a
   * schema-valid ticket. `pickup` needs no input field (the handler derives `{venueId, geo}` from
   * the venue's own required geo) and `billTo` is a handler constant (`'venue'`).
   *
   * Ruling R: `passengers` and `accessible` get NO defaults. Defaulting `passengers` to 1 invents
   * a party size that drives vehicle assignment and possibly the quote — a host requesting a ride
   * for six would get a ticket saying one. `accessible: false` is the worse of the two: it reads
   * as "absence of a stated need", but it is the field that decides whether a
   * wheelchair-accessible vehicle is dispatched, and a wrong default strands a person at a curb.
   */
  venueHostRequest: { input: z.object({ venueId: z.string().min(1), kind: z.enum(['car', 'pre_arrival', 'ride']), table: z.string().optional(), phoneLast4: z.string().length(4).optional(), phoneE164: e164Schema.optional(), name: z.string().optional(), note: z.string().max(200).optional(), eta: z.string().optional(), partySize: z.number().int().min(1).max(50).optional(), vip: z.boolean().optional(), dropoff: z.object({ address: z.string().min(1), geo: geoSchema }).optional(), passengers: z.number().int().min(1).max(8).optional(), accessible: z.boolean().optional() }), output: z.object({ hostRequestId: z.string(), ticketId: uuidSchema.optional() }) },
  venueIssueValidation: { input: z.object({ venueId: z.string().min(1), type: z.enum(['full', 'partial', 'comp', 'rate']), amount: moneySchema.optional(), rateId: z.string().optional(), ticketId: uuidSchema.optional() }), output: z.object({ code: z.string() }) },
  venueGenerateKeyTags: { input: z.object({ venueId: z.string(), count: z.number().int().min(1).max(500), prefix: z.string().regex(/^[A-Z0-9]{2,6}$/) }), output: z.object({ batchId: z.string(), values: z.array(z.string()) }) },
  shiftsCorrectClock: { input: z.object({ shiftId: z.string(), uid: z.string(), type: z.enum(['in', 'out', 'break_start', 'break_end']), at: isoDateSchema, note: z.string().min(1).max(200) }), output: z.object({ eventId: uuidSchema }) },
  ticketsSearch: { input: z.object({ venueId: z.string().optional(), status: ticketStatusSchema.optional(), jobType: z.enum(JOB_TYPES).optional(), from: isoDateSchema, to: isoDateSchema, plate: z.string().optional(), phoneLast4: z.string().length(4).optional(), includeArchived: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), output: z.object({ tickets: z.array(ticketSchema), nextCursor: z.string().optional() }) },
  ticketsRevealPhone: { input: z.object({ ticketId: uuidSchema, reason: z.string().min(1).max(200) }), output: z.object({ phoneE164: e164Schema }) },
  paymentsSearch: { input: z.object({ venueId: z.string().optional(), from: isoDateSchema, to: isoDateSchema, status: z.enum(['pending', 'authorized', 'succeeded', 'failed', 'refunded']).optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }), output: z.object({ transactions: z.array(transactionSchema), nextCursor: z.string().optional() }) },
  integrationsSetSecret: { input: z.object({ provider: z.enum(INTEGRATION_IDS), name: z.string().regex(/^[a-zA-Z0-9_]+$/), value: z.string().min(1), venueId: z.string().optional() }), output: z.object({ secretRef: z.string() }) },
  integrationsHealthCheck: { input: z.object({ provider: z.enum(INTEGRATION_IDS), venueId: z.string().optional() }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  pmsLookup: { input: z.object({ venueId: z.string().min(1), name: z.string().optional(), room: z.string().optional() }), output: z.object({ reservations: z.array(z.object({ reservationRef: z.string(), guestName: z.string(), room: z.string(), noPost: z.boolean() })) }) },
  /**
   * v0.4.3 (fix-round L3): the output is a DISCRIMINATED UNION, not two optionals — the old shape
   * admitted a `{}` resolve, which both clients' `fallback === 'card'` discriminators would read
   * as SUCCESS. Discriminate on the `fallback` branch; do NOT key success on `postingRef`
   * presence — that inversion double-charges.
   *
   * Error discrimination (Ruling AY): `toHttpsError` carries `e.code` as the wire MESSAGE, so
   * clients can never tell one failed_precondition from another by message. Where a client
   * legitimately needs to discriminate, `details.reason` crosses intact — this callable emits:
   * `reason: 'no_post'` (the reservation refuses charges; per venue.pms.noPostBehavior) and
   * `reason: 'already_charged_other_reservation'` (a crash-retry named a different reservation —
   * the charge SUCCEEDED against the original one; do not re-attempt). Scoped narrowly on
   * purpose: reasons are added only where a client must branch, never blanket-retrofitted.
   */
  pmsPostRoomCharge: { input: z.object({ ticketId: uuidSchema, reservationRef: z.string(), room: z.string() }), output: z.union([z.object({ postingRef: z.string().min(1) }), z.object({ fallback: z.literal('card') })]) },
  // `checkRef` is an OPAQUE, provider-minted token — see `posCheckRefSchema` in schemas/common.ts
  // for why it is deliberately a string and not an { orderGuid, checkGuid } pair. Clients only
  // ever round-trip it from `posFindCheck`'s output; nothing parses it.
  //
  // NOTE for `posFindCheck`: Toast has NO table filter and no open-checks filter. `table` here is
  // satisfied by the adapter fetching the business date's orders (`GET /orders/v2/ordersBulk` —
  // `/orders/v2/orders` is DEPRECATED and returns bare GUID strings) and matching client-side.
  // Verified against doc.toasttab.com; see external-api-contracts.md §2.
  // Ruling AJ (0.4.1): the original `{venueId, checkRef, amount}` shape could not satisfy Ruling F
  // (no validation identifier -> nothing to redeem through the shared guard) and carried
  // CLIENT-SUPPLIED MONEY with no maxAmount bound or issued code behind it — an unbounded
  // discount primitive. Now the POS twin of staffApplyValidation: the server resolves the
  // validation by (venueId, code), computes the amount at redemption (Ruling O) from the
  // ticket's current base, redeems through the shared guard, THEN pushes the discount.
  // `venueId` stays explicit (the §9.1 gate is specified against input.venueId — deriving it
  // from the ticket would make the enforcement point implicit); `ticketId` is required (no
  // base to compute from without it).
  posApplyValidation: { input: z.object({ venueId: z.string().min(1), checkRef: posCheckRefSchema, code: z.string().regex(/^[A-Z0-9]{6}$/), ticketId: uuidSchema }), output: z.object({ ok: z.literal(true) }) },
  posFindCheck: { input: z.object({ venueId: z.string(), table: z.string().optional(), checkRef: posCheckRefSchema.optional() }), output: z.object({ checks: z.array(z.object({ checkRef: posCheckRefSchema, table: z.string().optional(), total: moneySchema, openedAt: isoDateSchema })) }) },
  posAddValetCharge: { input: z.object({ venueId: z.string(), checkRef: posCheckRefSchema, ticketId: uuidSchema }), output: z.object({ ok: z.literal(true) }) },
  schedulingSyncNow: { input: z.object({}), output: z.object({ upserted: z.number().int(), errors: z.array(z.string()) }) },
  accountingExport: { input: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }), output: z.object({ downloadPath: z.string() }) },
  invoicesSend: { input: z.object({ invoiceId: z.string() }), output: z.object({ ok: z.literal(true) }) },
  invoicesMarkPaid: { input: z.object({ invoiceId: z.string(), paidAt: isoDateSchema.optional() }), output: z.object({ ok: z.literal(true) }) },
  /**
   * v0.4.5, Ruling AB: invoice PDFs reach venue hosts via THIS callable — a signed/tokened
   * download URL minted server-side after verifying `invoice.venueId` against the caller's venue
   * claim — never via a storage-rules match (the rules sit at the expression ceiling in the hot
   * path, and the callable boundary is §9.1's enforcement point). Shaped like accountingExport's
   * `downloadPath`.
   */
  invoicePdfUrl: { input: z.object({ invoiceId: z.string() }), output: z.object({ downloadPath: z.string() }) },
  // `from`/`to` are day strings (`YYYY-MM-DD`, inclusive both ends), matching `metrics/daily/days/{day}`'s
  // own keying — this callable aggregates a range of already-computed daily rollups, not raw ticket
  // timestamps. `venueId` narrows both `venues` (to just that one entry) and `operator` (mirrors the
  // single venue's own totals, for a tile layer that always reads `operator` regardless of filter
  // state). `previousPeriod` is the immediately preceding period of the SAME day-count, ending the day
  // before `from` — computed server-side so `kpi-tiles.tsx` never has to issue a second round trip
  // just to render a delta.
  analyticsSummary: {
    input: z.object({ from: dayStringSchema, to: dayStringSchema, venueId: z.string().optional() }),
    output: z.object({
      from: dayStringSchema, to: dayStringSchema,
      operator: venueMetricsSummary, venues: z.record(z.string(), venueMetricsSummary),
      // `venues` here (Task 7, third pass — task-7-report.md): the Executive page's "growth
      // signals" (venue types with the biggest tips/retrieval improvement) need a PER-VENUE
      // current-vs-previous comparison, not just the operator-wide one. The handler already
      // computes this internally (`aggregatePeriod` returns `{operator, venues}` for both periods)
      // — this only exposes what was already being thrown away.
      previousPeriod: z.object({ from: dayStringSchema, to: dayStringSchema, operator: venueMetricsSummary, venues: z.record(z.string(), venueMetricsSummary) }),
      // Carry #44's read path. The venue portal's Reports page used to read
      // `operators/{op}/metrics/daily/days` DIRECTLY and pick `d.venues[venueId]` client-side —
      // so every other venue's bucket AND the operator-wide aggregate crossed the wire to one
      // hotel's front desk. A client cannot partially read a document, so the fix has to be a
      // server-filtered source; this callable already is one (`aggregatePeriod` restricts to the
      // named venue), it was only missing the SHAPES that page needs.
      //
      // `metrics` is `venueMetricsSchema`, not `venueMetricsSummary`: the per-day entries are the
      // rollup's own already-computed per-day numbers, unaggregated, so there is no new shape to
      // invent — and `hourly` (which the summary omits, being meaningless once averaged across a
      // range) comes with it, which is what the peak-hours heatmap needs.
      //
      // Deliberately a SIBLING field rather than fields added to `venueMetricsSummary`: that type
      // is shared by `operator`, `venues` and both `previousPeriod` buckets, so widening it would
      // add 24 hourly numbers per venue per period to every existing consumer — the executive
      // page pulls a summary for every venue — to serve one page that needs a different shape
      // anyway. This way the change is purely additive and no current caller's payload moves.
      //
      // Scoped exactly like the rest of the output: with `venueId` set each entry is THAT venue's
      // metrics for that day; unset, it is the day's operator bucket. A venue-scoped caller never
      // receives another venue's numbers.
      days: z.array(z.object({ day: dayStringSchema, metrics: venueMetricsSchema })),
    }),
  },
} as const;
export type CallableName = keyof typeof callables;
/** The raw shape a caller may send, before Zod defaults are applied (fields with `.default()` are optional). */
export type CallableInput<N extends CallableName> = z.input<(typeof callables)[N]['input']>;
/** The shape after `.parse()`, with defaults applied. */
export type CallableParsedInput<N extends CallableName> = z.output<(typeof callables)[N]['input']>;
export type CallableOutput<N extends CallableName> = z.infer<(typeof callables)[N]['output']>;
