import { z } from 'zod';
import { ROLES } from '../domain/roles';
import { SCHEDULING_PROVIDERS } from './operator';
import { dayStringSchema, geoSchema, isoDateSchema, moneySchema, uuidSchema } from './common';
export const shiftAssignmentSchema = z.object({ uid: z.string().min(1), role: z.enum(ROLES), startsAt: isoDateSchema, endsAt: isoDateSchema, confirmed: z.boolean() });
export const shiftSchema = z.object({
  id: z.string().min(1), operatorId: z.string().min(1), venueId: z.string().min(1), date: dayStringSchema, startsAt: isoDateSchema, endsAt: isoDateSchema,
  leadUid: z.string().optional(), status: z.enum(['planned', 'open', 'closed']), assignments: z.array(shiftAssignmentSchema), notes: z.string().max(1000).default(''),
  /** denormalized from assignments[].uid in the same write */
  assignedUids: z.array(z.string()).default([]),
  source: z.object({ provider: z.enum(SCHEDULING_PROVIDERS), externalId: z.string().optional(), syncedAt: isoDateSchema.optional(), hash: z.string().optional() }),
  tipPool: z.object({ total: moneySchema, hoursByUid: z.record(z.string(), z.number()), allocations: z.array(z.object({ uid: z.string(), amount: moneySchema })) }).optional(),
});
export const clockEventSchema = z.object({ id: uuidSchema, uid: z.string().min(1), type: z.enum(['in', 'out', 'break_start', 'break_end']), at: isoDateSchema, geo: geoSchema.optional(), deviceId: z.string().min(1), pushedToProviderAt: isoDateSchema.optional() });
export type Shift = z.infer<typeof shiftSchema>;
export type ClockEvent = z.infer<typeof clockEventSchema>;
