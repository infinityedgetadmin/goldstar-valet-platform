import { z } from 'zod';
import { isoDateSchema, storagePathSchema, uuidSchema } from './common';
export const INCIDENT_TYPES = ['damage', 'injury', 'theft', 'altercation', 'near_miss', 'property', 'other'] as const;
export const incidentSchema = z.object({ id: uuidSchema, operatorId: z.string().min(1), venueId: z.string().min(1), ticketId: uuidSchema.optional(), type: z.enum(INCIDENT_TYPES), description: z.string().min(1).max(4000), photos: z.array(storagePathSchema).default([]), reportedBy: z.string().min(1), at: isoDateSchema, status: z.enum(['open', 'reviewing', 'resolved']).default('open'), assignedTo: z.string().optional(), witnesses: z.array(z.object({ name: z.string(), contact: z.string().optional() })).default([]) });
export type Incident = z.infer<typeof incidentSchema>;
