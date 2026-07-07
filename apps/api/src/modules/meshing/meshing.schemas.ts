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
export const runSnappySchema = z.object({
  domainType: z.enum(DOMAIN_TYPES),
  baseCellSize: z.number().positive().nullable().default(null),
  marginFactor: z.number().min(0).max(10).default(0.1),
  surfaceRefinement: z
    .object({
      min: z.number().int().min(0).max(10),
      max: z.number().int().min(0).max(10),
    })
    .refine((r) => r.max >= r.min, {
      message: 'The maximum refinement level must be >= the minimum',
      path: ['max'],
    }),
  featureLevel: z.number().int().min(0).max(10).default(2),
  locationInMesh: z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .nullable()
    .default(null),
  addLayers: z
    .object({ enabled: z.boolean(), nLayers: z.number().int().min(1).max(20) })
    .default({ enabled: false, nLayers: 3 }),
});
export type RunSnappyInput = z.infer<typeof runSnappySchema>;
