import { z } from 'zod';
import { e164Schema, geoSchema, isoDateSchema } from './common';
export const guestSchema = z.object({
  phoneE164: e164Schema, name: z.string().max(80).optional(),
  savedVehicles: z.array(z.object({ plate: z.string().max(12), state: z.string().length(2).optional(), make: z.string().optional(), model: z.string().optional(), color: z.string().optional(), label: z.string().optional() })).default([]),
  savedAddresses: z.array(z.object({ label: z.string(), address: z.string(), geo: geoSchema })).default([]),
  needs: z.object({ wheelchair: z.boolean(), extraTime: z.boolean(), other: z.string().max(200).optional() }).optional(),
  stripeCustomerId: z.string().optional(), fcmTokens: z.array(z.string()).default([]),
  consent: z.object({ sms: z.boolean(), push: z.boolean() }), lastOperatorId: z.string().optional(), updatedAt: isoDateSchema.optional(),
});
export type Guest = z.infer<typeof guestSchema>;
