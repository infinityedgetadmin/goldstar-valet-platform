import { z } from 'zod';
import { moneySchema } from './common';
export const platformConfigSchema = z.object({
  tipPresets: z.array(z.number().int()).default([18, 20, 25]),
  laborRateDefault: moneySchema.default(1800),
  targetRequestsPerAttendantHour: z.number().int().default(6),
  rideEndorsements: z.array(z.string()).default([]),
});
export type PlatformConfig = z.infer<typeof platformConfigSchema>;
