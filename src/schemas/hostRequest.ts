import { z } from 'zod';
import { isoDateSchema, uuidSchema } from './common';
export const hostRequestSchema = z.object({
  id: z.string().min(1), operatorId: z.string(), venueId: z.string(), kind: z.enum(['car', 'pre_arrival', 'ride']),
  table: z.string().optional(), phoneLast4: z.string().length(4).optional(), name: z.string().optional(), eta: isoDateSchema.optional(),
  partySize: z.number().int().optional(), vip: z.boolean().default(false), note: z.string().max(200).optional(),
  at: isoDateSchema, by: z.string(), ticketId: uuidSchema.optional(), status: z.enum(['open', 'matched', 'unmatched', 'dismissed']),
});
export type HostRequest = z.infer<typeof hostRequestSchema>;
