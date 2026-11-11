import { z } from 'zod';
import { geoSchema, isoDateSchema, uuidSchema } from './common';
export const liveLocationSchema = z.object({ ticketId: uuidSchema, geo: geoSchema, heading: z.number().min(0).max(360), speed: z.number().min(0), at: isoDateSchema, expiresAt: isoDateSchema });
export type LiveLocation = z.infer<typeof liveLocationSchema>;
