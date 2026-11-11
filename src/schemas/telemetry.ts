import { z } from 'zod';
import { dayStringSchema, isoDateSchema } from './common';
export const telemetrySchema = z.object({ operatorId: z.string(), day: dayStringSchema, photosUploaded: z.number().int(), photosNeedsAttention: z.number().int(), writesPending: z.number().int(), appVersion: z.string(), platform: z.enum(['ios', 'android']), updatedAt: isoDateSchema });
export type Telemetry = z.infer<typeof telemetrySchema>;
