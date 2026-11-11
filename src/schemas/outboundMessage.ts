import { z } from 'zod';
import { isoDateSchema, uuidSchema } from './common';
export const outboundMessageSchema = z.object({
  id: z.string().min(1), channel: z.enum(['sms', 'email']), operatorId: z.string().min(1),
  venueId: z.string().optional(), ticketId: uuidSchema.optional(),
  to: z.string().min(1), template: z.string().min(1), vars: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'sending', 'retry', 'sent', 'failed', 'queued_email']),
  attempts: z.number().int().nonnegative(),
  providerRef: z.string().optional(), lastError: z.string().optional(),
  leaseUntil: isoDateSchema.optional(), retryAt: isoDateSchema.optional(), deliveryStatus: z.string().optional(),
  createdAt: isoDateSchema, sentAt: isoDateSchema.optional(),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
