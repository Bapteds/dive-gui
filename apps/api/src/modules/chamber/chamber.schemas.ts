// Zod schemas for the Chamber Creation endpoints. The three empirical inputs are
// range-checked against the fit's training span; LENGTH is a direct positive
// geometry dimension (mm); constraints are optional per-output Min/Max/Exact
// overrides keyed by an output parameter name.
import { z } from 'zod';
import { CHAMBER_INPUT_RANGES, CHAMBER_OUTPUT_KEYS, CHAMBER_VARIANTS } from '@dive/shared';

const r = CHAMBER_INPUT_RANGES;

/** One optional per-output override. All fields optional; validated as finite. */
const constraintSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  exact: z.number().finite().optional(),
});

/**
 * Body for POST /chamber/build — the 3 empirical inputs (range-checked), optional
 * per-output constraints, the cylinder variant, and the non-modelled geometry
 * inputs (all mm). `hollowLength` is required when variant === 'hollow'.
 */
export const chamberBuildSchema = z
  .object({
    x1: z.number().finite().min(r.x1.min).max(r.x1.max),
    x2: z.number().finite().min(r.x2.min).max(r.x2.max),
    x3: z.number().finite().min(r.x3.min).max(r.x3.max),
    constraints: z.record(z.enum(CHAMBER_OUTPUT_KEYS), constraintSchema).optional(),
    // Interdependency refinement (paired outputs sharpen from a known partner
    // Exact). On by default; false opts out to a pure X1/X2/X3 fit.
    interdependency: z.boolean().default(true),
    // Torque-foot orientation (0–180): 0/180 = tangential, 90 = radial. The gusset
    // only forms at intermediate angles (~37–143°, not ~90°); default 45.
    footAngleDeg: z.number().finite().min(0).max(180).default(45),
    variant: z.enum(CHAMBER_VARIANTS).default('stepped'),
    lengthOverride: z.number().finite().positive().optional(),
    hollowLength: z.number().finite().positive().optional(),
    wallThickness: z.number().finite().positive().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.variant === 'hollow' && v.hollowLength == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hollowLength'],
        message: 'A hollow length is required for the hollow variant.',
      });
    }
  });
export type ChamberBuildInput = z.infer<typeof chamberBuildSchema>;

/** Route params carrying a build hash. */
export const chamberHashParamSchema = z.object({
  hash: z.string().trim().min(1, 'A build id is required'),
});
export type ChamberHashParam = z.infer<typeof chamberHashParamSchema>;

/** Route params for an export download: a build hash + the artifact kind. */
export const chamberExportParamSchema = z.object({
  hash: z.string().trim().min(1, 'A build id is required'),
  kind: z.enum(['stl', 'step', 'trisurface']),
});
export type ChamberExportParam = z.infer<typeof chamberExportParamSchema>;
