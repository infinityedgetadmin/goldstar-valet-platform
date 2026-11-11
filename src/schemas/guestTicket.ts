import { z } from 'zod';
import { JOB_TYPES } from '../domain/status';
import { currencySchema, geoSchema, hexColorSchema, isoDateSchema, moneySchema, secretTokenSchema, uuidSchema } from './common';
import { quoteSchema, ticketStatusSchema } from './ticket';
// v0.3.9 (Plan 5 T2 fix round 1, Critical #2): the pre-flight's binding carry — "projection must
// carry driveHome.quote so the sheet can re-render it" — was implemented for the PARENT ticket's
// `linkedJobs` entries (status only) but never for the job's OWN projection, leaving a guest who
// closes the tab between seeing the quote and tapping confirm with no way to resume into anything
// but a dead-end tracking view. Additive and optional on both branches — a job ticket populates
// exactly one of these (matching its own `jobType`); a valet ticket's projection has neither.
const driveHomeDisplaySchema = z.object({
  quote: quoteSchema,
  destination: z.object({ address: z.string(), geo: geoSchema, placeId: z.string().optional() }),
  // Set once the guest has already accepted terms on a prior attempt (e.g. the confirm write landed
  // but the checkout call that follows it didn't) — lets a resumed page skip re-showing the terms
  // checkbox rather than infer acceptance from `status` alone.
  termsAcceptedAt: isoDateSchema.optional(),
});
const rideDisplaySchema = z.object({
  quote: quoteSchema,
  dropoff: z.object({ address: z.string(), geo: geoSchema }),
  passengers: z.number().int().min(1).max(8),
});
export const guestTicketSchema = z.object({
  operatorId: z.string().min(1), ticketId: z.string().min(1), venueName: z.string(), jobType: z.enum(JOB_TYPES), status: ticketStatusSchema,
  branding: z.object({ displayName: z.string(), primaryColor: hexColorSchema, accentColor: hexColorSchema, logoUrl: z.string().url().optional(), supportPhone: z.string().optional() }),
  vehicleSummary: z.string(), times: z.object({ checkedInAt: isoDateSchema, requestedAt: isoDateSchema.optional(), readyAt: isoDateSchema.optional(), deliveredAt: isoDateSchema.optional() }),
  payment: z.object({ status: z.string(), base: moneySchema, tip: moneySchema, tax: moneySchema, fees: moneySchema, total: moneySchema, currency: currencySchema, tipPresets: z.array(z.number().int()) }),
  driver: z.object({ firstName: z.string(), photoUrl: z.string().url().optional(), vehicle: z.string().optional(), etaAt: isoDateSchema.optional(), geo: geoSchema.optional() }).optional(),
  driveHome: driveHomeDisplaySchema.optional(),
  ride: rideDisplaySchema.optional(),
  linkedJobs: z.array(z.object({ ticketId: uuidSchema, jobType: z.enum(JOB_TYPES), status: ticketStatusSchema, token: secretTokenSchema })).default([]),
  features: z.object({ driveHome: z.boolean(), passengerRides: z.boolean() }), expiresAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type GuestTicket = z.infer<typeof guestTicketSchema>;
