import { z } from 'zod';
import { currencySchema, isoDateSchema, moneySchema, storagePathSchema } from './common';
export const invoiceSchema = z.object({
  id: z.string().min(1), operatorId: z.string(), venueId: z.string(), period: z.string().regex(/^\d{4}-\d{2}$/),
  lines: z.array(z.object({ label: z.string(), quantity: z.number(), unitAmount: moneySchema, amount: moneySchema })),
  subtotal: moneySchema, tax: moneySchema, total: moneySchema, currency: currencySchema, status: z.enum(['draft', 'sent', 'paid', 'void']),
  pdfPath: storagePathSchema.optional(), sentAt: isoDateSchema.optional(), paidAt: isoDateSchema.optional(), createdAt: isoDateSchema,
});
export type Invoice = z.infer<typeof invoiceSchema>;
