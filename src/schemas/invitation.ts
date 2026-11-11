import { z } from 'zod';
import { ROLES } from '../domain/roles';
import { isoDateSchema } from './common';
export const invitationSchema = z.object({
  id: z.string().min(1), email: z.string().email(), operatorId: z.string().min(1),
  roles: z.array(z.enum(ROLES)), venueIds: z.array(z.string()),
  displayName: z.string().nullable(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: isoDateSchema, acceptedAt: isoDateSchema.nullable(),
  acceptedUid: z.string().optional(), invitedBy: z.string().min(1), createdAt: isoDateSchema,
});
export type Invitation = z.infer<typeof invitationSchema>;
