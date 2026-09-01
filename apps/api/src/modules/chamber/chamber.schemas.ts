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
    // Master switch for ALL structural relations (hard override). false forces
    // every relation off (pure X1/X2/X3 fits). On by default.
    relationsMaster: z.boolean().default(true),
    // Per-relation on/off, keyed by the driven output. Consulted only when
    // relationsMaster is not false; a missing entry uses the relation's default.
    relations: z.record(z.enum(CHAMBER_OUTPUT_KEYS), z.boolean()).optional(),
    // Torque-foot orientation (0–180): 0/180 = tangential, 90 = radial. The gusset
    // only forms at intermediate angles (~37–143°, not ~90°); default 40.
    footAngleDeg: z.number().finite().min(0).max(180).default(40),
    variant: z.enum(CHAMBER_VARIANTS).default('stepped'),
    // Replace the middle cylinder with a guide-vane ring (geometry-only; both
    // variants). A different flag => a different cached build.
    guideVanes: z.boolean().default(false),
    // Cut the two corners at the box's inlet end (geometry-only; the chamfer's
    // own model values keep being computed regardless). A different flag =>
    // a different cached build.
    chamferEnabled: z.boolean().default(true),
    // Cut the four torque-foot voids (geometry-only; footAngleDeg keeps being
    // validated regardless). A different flag => a different cached build.
    feetEnabled: z.boolean().default(true),
    // Absolute guide-vane open angle (deg); the asset is baked at 50° and each blade
    // swings about its own spindle by (vaneAngleDeg - 50). Range 45..55. Guide-vane
    // builds only. A different angle => a different cached build.
    vaneAngleDeg: z.number().finite().min(45).max(55).default(50),
    // Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). The outlet's
    // outer diameter is X1; the inner diameter is outletRatio * outer. Guide-vane
    // builds only. A different ratio => a different cached build.
    outletRatio: z.number().finite().min(0.35).max(0.5).default(0.45),
    // Uniform scale for the whole internal assembly (cylinders + feet + vanes +
    // hollow/dome) about its floor-anchored axis; the box + axis stay fixed.
    // Geometry-only. Stepped: a scale that overgrows the box height is refused;
    // hollow: the internal part is scaled down to fit (with a warning).
    partScale: z.number().finite().positive().max(5).default(1),
    lengthOverride: z.number().finite().positive().optional(),
    hollowLength: z.number().finite().positive().optional(),
    wallThickness: z.number().finite().positive().optional(),
    // Manual overrides for otherwise-derived dimensions (mm). Omitted => the fixed
    // empirical relation is used. dFirst/dMiddle apply to both variants; the three
    // central/dome ones only affect the hollow variant. A different value => a
    // different cached build (they flow into resolveGeometryParams's hash).
    dFirst: z.number().finite().positive().optional(),
    dMiddle: z.number().finite().positive().optional(),
    centralDiameter: z.number().finite().positive().optional(),
    centralHeight: z.number().finite().positive().optional(),
    domeHeight: z.number().finite().positive().optional(),
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

/** Route params for an export download: a build hash + the artifact kind.
 * stepMirrored is the z-y-mirrored STEP, generated on demand at first download. */
export const chamberExportParamSchema = z.object({
  hash: z.string().trim().min(1, 'A build id is required'),
  kind: z.enum(['stl', 'step', 'stepMirrored', 'trisurface']),
});
export type ChamberExportParam = z.infer<typeof chamberExportParamSchema>;
