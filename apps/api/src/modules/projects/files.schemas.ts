// Zod schemas for the case-file content endpoints.
import { z } from 'zod';
import { CONFIGURABLE_SOLVER_IDS, TURBULENCE_MODEL_IDS } from '@dive/shared';

/**
 * Body for "Make runnable" (POST /runnable/scaffold). Both fields are optional and
 * bounded: `solver` to the scaffoldable solvers (defaults to simpleFoam server-side),
 * `turbulence` to the offered turbulence models (applied over the scaffold default
 * when present). The preprocess tolerates a bodiless POST (Express leaves req.body
 * undefined) by treating it as `{}`, while still rejecting out-of-set values.
 */
export const scaffoldSolverSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    solver: z.enum(CONFIGURABLE_SOLVER_IDS).optional(),
    turbulence: z.enum(TURBULENCE_MODEL_IDS).optional(),
  }),
);

export type ScaffoldSolverInput = z.infer<typeof scaffoldSolverSchema>;

/** Query carrying a case-relative file path (e.g. ?path=system/controlDict). */
export const filePathQuerySchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

export type FilePathQuery = z.infer<typeof filePathQuerySchema>;

/** Body for creating a new (empty) case file from the editor. */
export const createFileSchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

export type CreateFileInput = z.infer<typeof createFileSchema>;

/** Body for moving/renaming a file or directory: source and destination paths. */
export const movePathSchema = z.object({
  from: z.string().trim().min(1, 'A source path is required'),
  to: z.string().trim().min(1, 'A destination path is required'),
});

export type MovePathInput = z.infer<typeof movePathSchema>;
