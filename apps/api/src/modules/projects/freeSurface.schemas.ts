// Validation schemas of the Free surface tool routes (WS-I spec §6).
import { z } from 'zod';
import { FREE_SURFACE_ITERATION_COUNTS } from '@dive/shared';

/** An OpenFOAM patch name (word). */
const patchName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Invalid patch name');
/** A meshing session id (slug). */
const sessionId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid session id');
const length = z.coerce.number().finite().positive().max(10);

/** Body of POST /projects/:id/free-surface (kit settings; defaults from the kit template). */
export const freeSurfaceStartSchema = z.object({
  lidPatch: patchName,
  inletPatch: patchName,
  sourceSessionId: sessionId,
  iterations: z.coerce
    .number()
    .int()
    .refine(
      (n) => (FREE_SURFACE_ITERATION_COUNTS as readonly number[]).includes(n),
      'Iterations must be 1, 2 or 3',
    )
    .transform((n) => n as 1 | 2 | 3)
    .optional(),
  tolRmsMm: z.coerce.number().finite().positive().max(1000).optional(),
  smooth: z.coerce.number().finite().min(0).max(10).optional(),
  tmin: z.coerce.number().finite().min(0).max(10).optional(),
  sub: length.optional(),
  steiner: length.optional(),
  clear: z.coerce.number().finite().min(0).max(10).optional(),
  cut: z.boolean().optional(),
  axis: z.tuple([z.number().finite(), z.number().finite()]).nullable().optional(),
  rings: z
    .array(
      z
        .tuple([z.number().finite().min(0), z.number().finite().min(0)])
        .refine(([a, b]) => b > a, 'r1 must exceed r0'),
    )
    .max(10)
    .optional(),
  datumY: z.number().finite().nullable().optional(),
});
export type FreeSurfaceStartInput = z.infer<typeof freeSurfaceStartSchema>;

/** Query of GET /projects/:id/free-surface: the selection the checks are computed for. */
export const freeSurfaceSelectionSchema = z.object({
  lidPatch: patchName.optional(),
  inletPatch: patchName.optional(),
  sessionId: sessionId.optional(),
});
export type FreeSurfaceSelectionQuery = z.infer<typeof freeSurfaceSelectionSchema>;

/** Route params with a job id. */
export const freeSurfaceJobParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  jobId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid job id'),
});

/** Route params with a job id and a file name (allow-listed in the service). */
export const freeSurfaceFileParamSchema = freeSurfaceJobParamSchema.extend({
  name: z.string().min(1).max(64),
});
