import { z } from 'zod';
import { currencySchema, e164Schema, hexColorSchema, isoDateSchema, storagePathSchema } from './common';
export const operatorBrandingSchema = z.object({
  displayName: z.string().min(1).max(60), primaryColor: hexColorSchema, accentColor: hexColorSchema,
  logoLightPath: storagePathSchema.optional(), logoDarkPath: storagePathSchema.optional(), iconPath: storagePathSchema.optional(),
  supportPhone: e164Schema.optional(), supportEmail: z.string().email().optional(), receiptFooter: z.string().max(200).optional(),
});
export const PAYMENT_PROVIDERS = ['stripe'] as const;
export const MESSAGING_PROVIDERS = ['twilio'] as const;
export const SCHEDULING_PROVIDERS = ['internal', 'ical', 'when_i_work'] as const;
export const VISION_PROVIDERS = ['none', 'plate_recognizer'] as const;
export const ACCOUNTING_PROVIDERS = ['csv', 'quickbooks_online'] as const;
export const operatorModulesSchema = z.object({
  payments: z.object({ provider: z.enum(PAYMENT_PROVIDERS), connectedAccountId: z.string().optional(), chargeModel: z.literal('destination'), platformFeeBps: z.number().int().min(0).max(10_000), tipPresets: z.array(z.number().int().min(0).max(100)).min(1).max(4), tipPolicy: z.enum(['deliverer', 'shift_pool']) }),
  messaging: z.object({ provider: z.enum(MESSAGING_PROVIDERS), messagingServiceSid: z.string().optional(), fromNumber: e164Schema.optional() }),
  scheduling: z.object({ provider: z.enum(SCHEDULING_PROVIDERS), config: z.record(z.string(), z.unknown()).optional() }),
  vision: z.object({ provider: z.enum(VISION_PROVIDERS) }),
  accounting: z.object({ provider: z.enum(ACCOUNTING_PROVIDERS), config: z.record(z.string(), z.unknown()).optional() }),
});
export const operatorFeaturesSchema = z.object({ driveHome: z.boolean(), passengerRides: z.boolean(), venuePortals: z.boolean(), tapToPay: z.boolean(), plateOcr: z.boolean(), payouts: z.boolean() });
export const operatorSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]{2,40}$/), status: z.enum(['onboarding', 'active', 'suspended']),
  timezone: z.string().min(1), currency: currencySchema, isSandbox: z.boolean(), plan: z.string().min(1),
  branding: operatorBrandingSchema, modules: operatorModulesSchema, features: operatorFeaturesSchema,
  security: z.object({ requireMfaForAdmins: z.boolean() }).default({ requireMfaForAdmins: false }),
  createdAt: isoDateSchema, updatedAt: isoDateSchema, createdBy: z.string().min(1),
});
export type Operator = z.infer<typeof operatorSchema>;
export type OperatorBranding = z.infer<typeof operatorBrandingSchema>;
export type OperatorModules = z.infer<typeof operatorModulesSchema>;
