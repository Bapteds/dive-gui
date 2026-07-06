// Request schema for the "boundary conditions" overlay. Only the shape is
// validated here; semantic checks that need the real mesh (patch existence,
// mode-vs-type, value-required-per-mode) live in boundary.service, which throws
// INVALID_BC_PLAN / BC_CSV_REQUIRED with an actionable message.
import { z } from 'zod';
import { DRIVING_MODES, OBJECT_TYPES } from '@dive/shared';

/** Operating-point values collected by the overlay (all strictly positive). */
export const boundaryConditionValuesSchema = z.object({
  head: z.number().positive().optional(),
  flowRate: z.number().positive().optional(),
  intensity: z.number().positive().max(1).optional(),
  mixingLength: z.number().positive().optional(),
});

/**
 * The JSON payload of POST /:id/boundary-conditions/apply, sent as the multipart
 * `payload` field alongside an optional CSV (the draft-tube runner-exit profile).
 */
export const applyBoundaryConditionsSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  mode: z.enum(DRIVING_MODES),
  inlet: z.string().trim().min(1, 'An inlet patch is required'),
  outlet: z.string().trim().min(1, 'An outlet patch is required'),
  walls: z.array(z.string().trim().min(1)).default([]),
  values: boundaryConditionValuesSchema.default({}),
});

export type ApplyBoundaryConditionsInput = z.infer<typeof applyBoundaryConditionsSchema>;
