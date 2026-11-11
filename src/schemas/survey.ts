import { z } from 'zod';
import { isoDateSchema, uuidSchema } from './common';
export const surveySchema = z.object({ id: z.string().min(1), operatorId: z.string(), venueId: z.string(), ticketId: uuidSchema, score: z.number().int().min(1).max(5), comment: z.string().max(1000).optional(), at: isoDateSchema });
export type Survey = z.infer<typeof surveySchema>;
