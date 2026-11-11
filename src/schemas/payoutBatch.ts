import { z } from 'zod';
import { currencySchema, isoDateSchema, moneySchema, uuidSchema } from './common';
export const payoutBatchSchema = z.object({
  id: z.string().min(1), operatorId: z.string(), period: z.string(), totalTips: moneySchema, currency: currencySchema,
  allocations: z.array(z.object({ uid: z.string(), amount: moneySchema, transferRef: z.string().optional(), status: z.enum(['pending', 'paid', 'failed']), lastError: z.string().optional() })),
  createdAt: isoDateSchema, status: z.enum(['pending', 'completed', 'partial', 'failed']),
});
export const payoutAllocationSchema = z.object({
  id: z.string().min(1), ticketId: uuidSchema.optional(), shiftId: z.string().optional(), amount: moneySchema, currency: currencySchema,
  status: z.enum(['pending', 'paid', 'failed']), batchId: z.string().optional(), transferRef: z.string().optional(), createdAt: isoDateSchema, paidAt: isoDateSchema.optional(),
});
export type PayoutBatch = z.infer<typeof payoutBatchSchema>;
export type PayoutAllocation = z.infer<typeof payoutAllocationSchema>;
