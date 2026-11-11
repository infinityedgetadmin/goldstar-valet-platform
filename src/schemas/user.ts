import { z } from 'zod';
import { ROLES } from '../domain/roles';
import { e164Schema, isoDateSchema, moneySchema, storagePathSchema } from './common';
export const credentialsSchema = z.object({
  licenseNumber: z.string().min(1).optional(), licenseState: z.string().length(2).optional(), licenseClass: z.string().optional(), endorsements: z.array(z.string()).default([]),
  licenseExpiresAt: isoDateSchema.optional(), insuranceCarrier: z.string().optional(), insuranceExpiresAt: isoDateSchema.optional(),
  backgroundCheck: z.object({ status: z.enum(['pending', 'approved', 'rejected']), at: isoDateSchema, provider: z.string().optional() }).optional(),
  documents: z.array(z.object({ kind: z.enum(['license', 'insurance', 'background', 'other']), storagePath: storagePathSchema, uploadedAt: isoDateSchema })).default([]),
  medicalCard: z.object({ expiresAt: isoDateSchema }).optional(),
});
export const eligibilitySchema = z.object({ driveHome: z.boolean(), passengerRide: z.boolean(), reasons: z.array(z.string()) });
export const userSchema = z.object({
  uid: z.string().min(1), operatorId: z.string().min(1), displayName: z.string().min(1), email: z.string().email(), phone: e164Schema.optional(),
  roles: z.array(z.enum(ROLES)).min(1), venueIds: z.array(z.string()).default([]), status: z.enum(['invited', 'active', 'suspended']), avatarPath: storagePathSchema.optional(),
  credentials: credentialsSchema.optional(), eligibility: eligibilitySchema.default({ driveHome: false, passengerRide: false, reasons: [] }),
  stripeConnectAccountId: z.string().optional(), payoutStatus: z.enum(['none', 'onboarding', 'active', 'restricted']).default('none'),
  fcmTokens: z.array(z.string()).default([]), invitedAt: isoDateSchema, activatedAt: isoDateSchema.optional(), lastSeenAt: isoDateSchema.optional(),
  externalIds: z.record(z.string(), z.string()).optional(), hourlyRate: moneySchema.optional(),
  notificationPrefs: z.object({ emailClaims: z.boolean(), emailCredentials: z.boolean(), pushRequests: z.boolean() }).optional(),
});
export type User = z.infer<typeof userSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;
export type Eligibility = z.infer<typeof eligibilitySchema>;
