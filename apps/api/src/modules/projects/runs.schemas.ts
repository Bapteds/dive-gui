// Zod schemas for the solver-run endpoints.
import { z } from 'zod';
import { SOLVER_IDS } from '@dive/shared';

/**
 * Body for starting a run. `solver` is optional: by default the run uses the
 * solver named in the case's controlDict `application`; an explicit value lets a
 * caller override it (bounded to the supported set).
 */
export const startRunSchema = z.object({
  solver: z.enum(SOLVER_IDS).optional(),
  /**
   * Number of cores (parallel subdomains) to run on. 1 (default) = serial. When > 1
   * the run decomposes the mesh, runs `mpirun -np N <solver> -parallel`, then
   * reconstructs. The effective cap is the server's core budget (checked at start).
   */
  cores: z.coerce.number().int().min(1).max(1024).optional(),
});

export type StartRunInput = z.infer<typeof startRunSchema>;

/** Route params carrying a project id and a run id. */
export const runIdParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  runId: z.string().min(1, 'Run id is required'),
});
