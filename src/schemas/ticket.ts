import { z } from 'zod';
import { CHASE_STATUSES, DRIVE_HOME_STATUSES, JOB_TYPES, RIDE_STATUSES, TICKET_STATUSES, VALET_STATUSES, type JobType, type TicketStatus } from '../domain/status';
import { initialStatus } from '../state/index';
import { currencySchema, e164Schema, geoSchema, isoDateSchema, moneySchema, secretTokenSchema, uuidSchema } from './common';
export const CUSTODY_ACTIONS = ['checked_in', 'keys_stored', 'parked', 'keys_taken', 'moved', 'retrieved', 'staged', 'delivered', 'keys_returned', 'pre_drive_inspection', 'post_drive_inspection', 'handoff_to_chase', 'note'] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export const paymentStateSchema = z.object({
  status: z.enum(['none', 'pending', 'authorized', 'paid', 'refunded', 'failed', 'room_charged', 'venue_billed']), base: moneySchema, tip: moneySchema, tax: moneySchema, fees: moneySchema, total: moneySchema, currency: currencySchema,
  validationId: z.string().optional(), validationAmount: moneySchema.optional(), lastIntentId: z.string().optional(), billTo: z.enum(['guest', 'venue', 'room']), pmsPostingRef: z.string().optional(),
  method: z.enum(['web', 'in_app', 'tap_to_pay', 'reader', 'pms', 'pos', 'invoice']).optional(),
  refundRequested: z.boolean().optional(), refundInProgress: z.boolean().optional(), refundAttempts: z.number().int().optional(), refundRetryAt: isoDateSchema.optional(),
  paidAt: isoDateSchema.optional(), lastRefundRef: z.string().optional(), capturedAt: isoDateSchema.optional(),
  // Ruling AH (1d final review, finding 1): persisted with refundRequested:true in the SAME write by
  // every producer (staffRefund, the ticket-cancel trigger, staffCancel) so a concurrent trigger fire
  // or a post-failure retry reads the SAME amount/reason/nonce the original request specified, instead
  // of racing an amount-less re-entry into a full refund. refundRequestId is the idempotency nonce
  // (refund_{ticketId}_{refundRequestId}); refundAmount/refundReason are optional (unset = full refund
  // at the default reason).
  refundRequestId: z.string().optional(), refundAmount: moneySchema.optional(), refundReason: z.string().optional(),
  // Already written by the refund claim/backoff machinery (functions/src/modules/payments/refund.ts)
  // but missing from the contract until now — added for type accuracy, not new behavior.
  refundClaimedAt: isoDateSchema.optional(), refundLastError: z.string().optional(),
});
export const quoteSchema = z.object({ base: moneySchema, distanceMeters: z.number().nonnegative(), durationSec: z.number().nonnegative(), amount: moneySchema, breakdown: z.array(z.object({ label: z.string(), amount: moneySchema })), expiresAt: isoDateSchema.optional() });
// The full driveHome/ride sub-documents (server reads); the create-time variants below omit `quote`,
// which is server-computed and must never be trusted from a client-supplied create payload.
const driveHomeDetailsSchema = z.object({ destination: z.object({ address: z.string().min(1), geo: geoSchema, placeId: z.string().optional() }), quote: quoteSchema.optional(), termsAcceptedAt: isoDateSchema.optional(), termsVersion: z.string().optional(), route: z.string().optional(), etaAt: isoDateSchema.optional(), chase: z.object({ status: z.enum(CHASE_STATUSES) }) });
const driveHomeCreateSchema = driveHomeDetailsSchema.omit({ quote: true }).strict();
const rideDetailsSchema = z.object({ pickup: z.object({ address: z.string().optional(), venueId: z.string().optional(), geo: geoSchema }), dropoff: z.object({ address: z.string().min(1), geo: geoSchema }), passengers: z.number().int().min(1).max(8), accessible: z.boolean(), quote: quoteSchema.optional(), billTo: z.enum(['guest', 'venue', 'room']), route: z.string().optional(), etaAt: isoDateSchema.optional() });
const rideCreateSchema = rideDetailsSchema.omit({ quote: true }).strict();
export const ticketBaseSchema = z.object({
  id: uuidSchema, operatorId: z.string().min(1), venueId: z.string().min(1),
  // RESTORED in v0.4.11. v0.4.7 deleted this on a "zero writers/readers" claim that was false: the
  // mobile check-in commit (goldstar-mobile src/features/check-in/commit.ts) writes the open shift's
  // id onto every ticket it creates, and its strict create-schema parse would have failed every such
  // check-in the moment mobile re-vendored. Still no READER anywhere (tipPool windows by deliveredAt
  // on purpose); it is the ticket->shift audit linkage. Deleting a field a shipping client writes
  // has to start at the client, then the schema - never the other way round.
  shiftId: z.string().optional(),
  jobType: z.enum(JOB_TYPES), status: ticketStatusSchema,
  source: z.enum(['staff', 'guest_web', 'guest_app', 'host_portal', 'pms']),
  // `guest.phoneLast4` is REQUIRED (no `.optional()`) — there is deliberately no representation
  // of "guest has no phone" at the contract/rules level. Plan 2b's staff no-phone flow (guest
  // opts out of SMS entirely, QR-only pickup) satisfies this with the documented sentinel
  // `'0000'` (passes `.length(4)` and firestore.rules' `d.guest.phoneLast4.size() == 4` as-is —
  // zero contract change). Ruling Q (contracts v0.3.5, finding 2): a real product decision on
  // whether phoneLast4 should become optional is still open; until then `'0000'` is the only
  // client-side representation and MUST NOT collide with a real last-4 (Firestore has no
  // uniqueness constraint on this field, so a genuine guest phone ending 0000 is a theoretical,
  // accepted collision — display-only, never used to look up or contact the guest).
  guest: z.object({ uid: z.string().optional(), phoneE164: e164Schema.optional(), phoneLast4: z.string().length(4), name: z.string().max(80).optional(), consentSms: z.boolean(), room: z.string().optional(), reservationRef: z.string().optional() }),
  vehicle: z.object({ plate: z.string().max(12).optional(), state: z.string().length(2).optional(), make: z.string().max(40).optional(), model: z.string().max(40).optional(), color: z.string().max(24).optional(), notes: z.string().max(500).optional(), fleetVehicleId: z.string().optional() }),
  keyTagId: z.string().optional(), zoneId: z.string().optional(), spotLabel: z.string().max(20).optional(),
  lastCustodyEventId: uuidSchema.optional(), parentTicketId: uuidSchema.optional(),
  flags: z.object({ assistance: z.boolean(), accessibleVehicle: z.boolean(), photosSkipped: z.boolean(), photosSkippedReason: z.string().max(200).optional(), vip: z.boolean(), inAndOut: z.boolean().optional() }),
  attendants: z.object({ checkedInBy: z.string().optional(), claimedBy: z.string().optional(), deliveredBy: z.string().optional(), primaryDriverUid: z.string().optional(), chaseDriverUid: z.string().optional(), chaseVehicleId: z.string().optional() }),
  times: z.object({ checkedInAt: isoDateSchema, requestedAt: isoDateSchema.optional(), claimedAt: isoDateSchema.optional(), stagedAt: isoDateSchema.optional(), readyAt: isoDateSchema.optional(), deliveredAt: isoDateSchema.optional(), closedAt: isoDateSchema.optional(), cancelledAt: isoDateSchema.optional(), assignedAt: isoDateSchema.optional(), enRouteAt: isoDateSchema.optional(), inspectionAt: isoDateSchema.optional(), inTransitAt: isoDateSchema.optional(), arrivedAt: isoDateSchema.optional(), completedAt: isoDateSchema.optional() }),
  damageReportIds: z.array(z.string()).default([]), incidentIds: z.array(z.string()).default([]),
  guestToken: secretTokenSchema,
  driveHome: driveHomeDetailsSchema.optional(),
  ride: rideDetailsSchema.optional(),
  hostRequest: z.object({ table: z.string().optional(), requestedBy: z.string(), note: z.string().max(200).optional() }).optional(),
  cancelReason: z.string().max(200).optional(),
});
// `pmsChargeSeq` (v0.4.4, Ruling BB): the room-charge GENERATION counter, absent = 0. At the ticket
// ROOT, not inside `payment` — Ruling BA's reversal deletes `payment` back to absent, and the counter
// must survive that reset or the next charge's deterministic ids (`pmsCharge_{t}_{seq}`,
// `pmsReverse_{t}_{seq}`, tx `pms_{t}_{seq}`) collide with generation 0's. A counter (not a
// timestamp/random id) keeps crash-retry idempotency WITHIN a generation while generations stay distinct.
export const ticketServerFieldsSchema = z.object({ payment: paymentStateSchema, pmsChargeSeq: z.number().int().min(0), metrics: z.object({ retrievalSec: z.number().int().optional(), readyToDeliverSec: z.number().int().optional(), tripSec: z.number().int().optional(), tripMeters: z.number().int().optional() }) });
const JOB_TYPE_STATUSES: Record<JobType, readonly TicketStatus[]> = { valet: VALET_STATUSES, drive_home: DRIVE_HOME_STATUSES, passenger_ride: RIDE_STATUSES };
export const ticketSchema = ticketBaseSchema.merge(ticketServerFieldsSchema.partial()).refine(
  (data) => JOB_TYPE_STATUSES[data.jobType].includes(data.status),
  "status must belong to the ticket's jobType status list",
);
const ticketCreateBaseSchema = ticketBaseSchema.omit({ driveHome: true, ride: true, cancelReason: true }).extend({
  driveHome: driveHomeCreateSchema.optional(),
  ride: rideCreateSchema.optional(),
});
// Plan 5 T2 fix round 1 (review N2): this schema's own `superRefine` below still asserts
// `status === initialStatus(jobType)` on create — 'requested' for drive_home/passenger_ride — which
// `functions/src/modules/dispatch/{requestDriveHome,requestRide}.ts` deliberately does NOT produce:
// those handlers create a job ticket already at 'quoted' (skipping a transient, quote-less
// 'requested' write no reader could ever observe — see their own comments). `ticketCreateSchema` is
// not invoked anywhere in `functions/src` today (confirmed by grep — only this package's own tests
// exercise it), so nothing breaks at runtime, but a FUTURE consumer (mobile/dashboard/web) that
// validates a freshly-created job ticket against this schema would get a false failure. Left
// unchanged rather than loosened, since "what status is a client-originated create allowed to write"
// and "what status can Functions construct a doc at directly" are legitimately different questions —
// this is a documentation gap, not a schema bug.
export const ticketCreateSchema = ticketCreateBaseSchema.strict().superRefine((data, ctx) => {
  const allowed = JOB_TYPE_STATUSES[data.jobType];
  if (!allowed.includes(data.status)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `status must be one of ${allowed.join(', ')} for jobType '${data.jobType}'` });
    return;
  }
  const expected = initialStatus(data.jobType);
  if (data.status !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `status must be '${expected}' on create for jobType '${data.jobType}'` });
  }
});
export const SERVER_ONLY_TICKET_FIELDS = ['payment', 'metrics', 'driveHome.quote', 'ride.quote'] as const;
export const IMMUTABLE_TICKET_FIELDS = ['id', 'operatorId', 'venueId', 'jobType', 'guestToken', 'source'] as const;
export const custodyEventSchema = z.object({ id: uuidSchema, actorUid: z.string().min(1), action: z.enum(CUSTODY_ACTIONS), at: isoDateSchema, geo: geoSchema.optional(), deviceId: z.string().min(1), note: z.string().max(500).optional(), zoneId: z.string().optional(), spotLabel: z.string().optional() });
export type Ticket = z.infer<typeof ticketSchema>;
export type TicketCreate = z.infer<typeof ticketCreateSchema>;
export type CustodyEvent = z.infer<typeof custodyEventSchema>;
export type PaymentState = z.infer<typeof paymentStateSchema>;
export type Quote = z.infer<typeof quoteSchema>;
