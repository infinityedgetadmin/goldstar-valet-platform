import { z } from 'zod';
import { isoDateSchema } from './common';
/** actorUid may be the literal 'system' for platform-initiated actions with no human actor. */
export const auditLogEntrySchema = z.object({
  id: z.string().min(1), operatorId: z.string().min(1).optional(), actorUid: z.string().min(1),
  action: z.string().min(1), target: z.string().min(1),
  before: z.unknown().nullable(), after: z.unknown().nullable(),
  at: isoDateSchema, ip: z.string().optional(), requestId: z.string().min(1),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
