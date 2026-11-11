import { z } from 'zod';
import { geoSchema, isoDateSchema, storagePathSchema, uuidSchema } from './common';
export const VEHICLE_PANELS = ['front_bumper', 'hood', 'windshield', 'roof', 'rear_window', 'trunk', 'rear_bumper', 'front_left_fender', 'front_left_door', 'rear_left_door', 'rear_left_quarter', 'front_right_fender', 'front_right_door', 'rear_right_door', 'rear_right_quarter', 'wheels', 'interior', 'other'] as const;
export const DAMAGE_KINDS = ['scratch', 'dent', 'chip', 'crack', 'scuff', 'missing', 'stain', 'other'] as const;
export const damageReportSchema = z.object({
  id: uuidSchema, operatorId: z.string().min(1), ticketId: uuidSchema, vehicleSnapshot: z.object({ plate: z.string().optional(), make: z.string().optional(), model: z.string().optional(), color: z.string().optional() }),
  phase: z.enum(['check_in', 'check_out', 'pre_drive', 'post_drive', 'incident']),
  // Plan 2b (contracts v0.3.5, finding 4): `x`/`y` are PANEL-LOCAL — normalized (0-1, 0-1)
  // coordinates within the tapped panel's OWN bounding box (its top-left origin, its own width/
  // height), not a position within the whole-diagram container. This is the only definition
  // that captures an actual tap location; every writer (including a check-in flow with no tap
  // coordinate, which writes the panel's own center at `(0.5, 0.5)`) and every reader (dashboard,
  // claims evidence bundles, check-out comparison) must agree on this single semantic.
  diagramMarks: z.array(z.object({ panel: z.enum(VEHICLE_PANELS), x: z.number().min(0).max(1), y: z.number().min(0).max(1), kind: z.enum(DAMAGE_KINDS), preExisting: z.boolean(), note: z.string().max(200).optional() })),
  notes: z.string().max(2000), createdBy: z.string().min(1), createdAt: isoDateSchema, photoCount: z.number().int().nonnegative().optional(),
});
export const photoSchema = z.object({ id: uuidSchema, storagePath: storagePathSchema, stage: z.enum(['wide', 'medium', 'close', 'diagram']), panel: z.enum(VEHICLE_PANELS).optional(), at: isoDateSchema, geo: geoSchema.optional(), actorUid: z.string().min(1), deviceId: z.string().min(1), bytes: z.number().int().positive().max(10_485_760), width: z.number().int().positive(), height: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type DamageReport = z.infer<typeof damageReportSchema>;
export type Photo = z.infer<typeof photoSchema>;
