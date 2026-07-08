// Zod schemas for the standalone Meshing endpoints (STL -> snappyHexMesh).
import { z } from 'zod';
import { DOMAIN_TYPES } from '@dive/shared';

/** Body for POST /meshing — create a session. */
export const createSessionSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(120, 'Name is too long'),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Route params carrying a session id. */
export const sessionIdParamSchema = z.object({
  id: z.string().min(1, 'Session id is required'),
});

/** Query carrying an STL file name (for read/delete of one surface). */
export const stlNameQuerySchema = z.object({
  name: z.string().trim().min(1, 'A file name is required'),
});
export type StlNameQuery = z.infer<typeof stlNameQuerySchema>;

/**
 * Body for POST /meshing/:id/run — the snappyHexMesh tunables. Shape matches the
 * shared `SnappyConfig`. `baseCellSize` / `locationInMesh` null means "derive
 * from the STL bounds server-side"; `surfaceRefinement.max` must be >= min.
 */
/** A refinement level range with min <= max. */
const refinementSchema = z
  .object({
    min: z.number().int().min(0).max(10),
    max: z.number().int().min(0).max(10),
  })
  .refine((r) => r.max >= r.min, {
    message: 'The maximum refinement level must be >= the minimum',
    path: ['max'],
  });

export const runSnappySchema = z.object({
  domainType: z.enum(DOMAIN_TYPES),
  baseCellSize: z.number().positive().nullable().default(null),
  marginFactor: z.number().min(0).max(10).default(0.1),
  surfaceRefinement: refinementSchema,
  // Per-surface overrides keyed by STL file name; each must also be min <= max.
  surfaceRefinements: z.record(z.string(), refinementSchema).optional(),
  featureLevel: z.number().int().min(0).max(10).default(2),
  locationInMesh: z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .nullable()
    .default(null),
  addLayers: z
    .object({
      enabled: z.boolean(),
      // Surfaces (STL file names) to grow layers on; omitted/empty ⇒ every surface.
      surfaces: z.array(z.string()).optional(),
      nLayers: z.number().int().min(1).max(20),
      relativeSizes: z.boolean().default(true),
      finalLayerThickness: z.number().positive().default(0.5),
      expansionRatio: z.number().min(1).max(5).default(1.2),
    })
    .default({
      enabled: false,
      nLayers: 3,
      relativeSizes: true,
      finalLayerThickness: 0.5,
      expansionRatio: 1.2,
    }),
  // Cores for the run: 1 = serial, > 1 = MPI-parallel snappyHexMesh. No upper bound
  // here (it is machine-dependent); the service clamps it to the host's core budget.
  cores: z.number().int().min(1).max(1024).default(1),
});
export type RunSnappyInput = z.infer<typeof runSnappySchema>;
