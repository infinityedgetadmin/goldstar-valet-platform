import { z } from 'zod';
import { e164Schema, isoDateSchema, moneySchema, storagePathSchema, uuidSchema } from './common';
import { DAMAGE_KINDS, VEHICLE_PANELS } from './damage';
export const claimSchema = z.object({
  id: uuidSchema, operatorId: z.string(), ticketId: uuidSchema, status: z.enum(['intake', 'under_review', 'accepted', 'denied', 'settled']),
  reportedAt: isoDateSchema, description: z.string().min(1).max(4000),
  allegedDamage: z.array(z.object({ panel: z.enum(VEHICLE_PANELS), kind: z.enum(DAMAGE_KINDS), description: z.string().max(500) })),
  guestContact: z.object({ name: z.string().optional(), phone: e164Schema.optional(), email: z.string().email().optional() }),
  adjudication: z.object({ notes: z.string().max(4000), decidedBy: z.string(), decidedAt: isoDateSchema, amount: moneySchema.optional() }).optional(),
  evidenceBundle: z.object({ pdfPath: storagePathSchema, zipPath: storagePathSchema, generatedAt: isoDateSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  insurer: z.object({ carrier: z.string(), claimNumber: z.string(), submittedAt: isoDateSchema }).optional(),
  createdBy: z.string(), createdAt: isoDateSchema,
});
export type Claim = z.infer<typeof claimSchema>;
