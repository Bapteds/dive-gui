// Zod schemas for the standalone Meshing endpoints (snappyHexMesh / cfMesh).
import { z } from 'zod';
import { CFMESH_PATCH_TYPES, DOMAIN_TYPES, MESHING_ENGINES } from '@dive/shared';

/** Body for POST /meshing — create a session with its (fixed) engine. */
export const createSessionSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(120, 'Name is too long'),
  engine: z.enum(MESHING_ENGINES).default('snappy'),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Body for POST /meshing/copy — duplicate a session's engine + config + surfaces. */
export const copySessionSchema = z.object({
  sourceId: z.string().trim().min(1, 'A source session id is required'),
  name: z.string().trim().min(1).max(120).optional(),
});
export type CopySessionInput = z.infer<typeof copySessionSchema>;

/**
 * Body for POST /meshing/from-chamber — import a built chamber's patch surfaces
 * into a meshing session. `mode` selects the target:
 *  - 'new':      create a session (name + engine) and import into it.
 *  - 'existing': import into `sessionId` (its engine governs meshing).
 *  - 'copyFrom': copy `sourceId` (engine + config + surfaces) into a new session,
 *                then import — the combined optimization-iteration operation.
 */
export const fromChamberSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('new'),
    chamberHash: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    engine: z.enum(MESHING_ENGINES).default('snappy'),
  }),
  z.object({
    mode: z.literal('existing'),
    chamberHash: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
  }),
  z.object({
    mode: z.literal('copyFrom'),
    chamberHash: z.string().trim().min(1),
    sourceId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120).optional(),
  }),
]);
export type FromChamberInput = z.infer<typeof fromChamberSchema>;

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

/** A per-patch feature-edge override: extraction angle + snappy refinement level. */
const featureRefinementSchema = z.object({
  includedAngle: z.number().min(0).max(180),
  level: z.number().int().min(0).max(10),
});

/** A per-surface (snappy) boundary layer override. */
const surfaceLayerSpecSchema = z.object({
  nLayers: z.number().int().min(1).max(20),
  expansionRatio: z.number().min(1).max(5),
  finalLayerThickness: z.number().positive(),
});

/** A per-patch (cfMesh) boundary layer override. */
const cfMeshPatchLayerSpecSchema = z.object({
  nLayers: z.number().int().min(1).max(20),
  thicknessRatio: z.number().min(1).max(5),
  maxFirstLayerThickness: z.number().positive().nullable().default(null),
});

export const runSnappySchema = z.object({
  engine: z.literal('snappy'),
  domainType: z.enum(DOMAIN_TYPES),
  baseCellSize: z.number().positive().nullable().default(null),
  marginFactor: z.number().min(0).max(10).default(0.1),
  surfaceRefinement: refinementSchema,
  // Per-surface overrides keyed by STL file name; each must also be min <= max.
  surfaceRefinements: z.record(z.string(), refinementSchema).optional(),
  featureLevel: z.number().int().min(0).max(10).default(2),
  featureAngle: z.number().min(0).max(180).default(150),
  // Per-patch feature overrides keyed by STL file name; absent key => the globals above.
  featureRefinements: z.record(z.string(), featureRefinementSchema).optional(),
  // Surfaces (STL file names) whose feature edges are extracted+refined; omitted/empty ⇒ all.
  featureSurfaces: z.array(z.string()).optional(),
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
      // Per-surface layer overrides keyed by STL file name; absent key => the globals.
      perSurface: z.record(z.string(), surfaceLayerSpecSchema).optional(),
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

/**
 * Body shape for a cfMesh (cartesianMesh) run — matches the shared `CfMeshConfig`.
 * Sizes are absolute metres; `maxCellSize` null means "derive from the STL bounds"
 * (rejected server-side for an FMS input, which has no bounds). `cores` maps to
 * OMP threads, clamped to the host budget by the service.
 */
export const runCfMeshSchema = z.object({
  engine: z.literal('cfmesh'),
  maxCellSize: z.number().positive().nullable().default(null),
  minCellSize: z.number().positive().nullable().default(null),
  boundaryCellSize: z.number().positive().nullable().default(null),
  extractFeatures: z.boolean().default(true),
  featureAngle: z.number().min(0).max(180).default(45),
  // Per-patch boundary type (patch name -> OpenFOAM type); a patch absent keeps its
  // FMS/cfMesh default. Written to meshDict as renameBoundary.
  patchTypes: z.record(z.string(), z.enum(CFMESH_PATCH_TYPES)).optional(),
  addLayers: z
    .object({
      enabled: z.boolean(),
      nLayers: z.number().int().min(1).max(20),
      thicknessRatio: z.number().min(1).max(5).default(1.2),
      maxFirstLayerThickness: z.number().positive().nullable().default(null),
      // Per-patch layer overrides keyed by patch name; absent key => the globals.
      perPatch: z.record(z.string(), cfMeshPatchLayerSpecSchema).optional(),
    })
    .default({ enabled: false, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null }),
  cores: z.number().int().min(1).max(1024).default(1),
});
export type RunCfMeshInput = z.infer<typeof runCfMeshSchema>;

/** A run/config body for either engine, discriminated by `engine`. */
export const meshingConfigSchema = z.discriminatedUnion('engine', [runSnappySchema, runCfMeshSchema]);
export type MeshingConfigInput = z.infer<typeof meshingConfigSchema>;
