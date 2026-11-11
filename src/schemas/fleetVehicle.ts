import { z } from 'zod';
export const fleetVehicleSchema = z.object({
  id: z.string().min(1), operatorId: z.string().min(1), plate: z.string().min(1), state: z.string().length(2).optional(),
  make: z.string(), model: z.string(), color: z.string(), capacity: z.number().int().min(1).max(8), accessible: z.boolean(),
  status: z.enum(['available', 'in_use', 'maintenance', 'retired']), currentDriverUid: z.string().optional(), notes: z.string().max(500).optional(),
});
export type FleetVehicle = z.infer<typeof fleetVehicleSchema>;
