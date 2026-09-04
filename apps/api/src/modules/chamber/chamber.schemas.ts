// Zod schemas for the Chamber Creation endpoints. The three empirical inputs are
// range-checked against the fit's training span; LENGTH is a direct positive
// geometry dimension (mm); constraints are optional per-output Min/Max/Exact
// overrides keyed by an output parameter name.
import { z } from 'zod';
import {
  CHAMBER_DIMENSION_MAX_MM,
  CHAMBER_INPUT_RANGES,
  CHAMBER_OUTPUT_KEYS,
  CHAMBER_VARIANTS,
  CHAMBER_X4_MAX,
} from '@dive/shared';

const r = CHAMBER_INPUT_RANGES;

/** A user-entered dimension (mm): strictly positive, bounded so an absurd
 * value cannot burn a CPU core for the whole build timeout. */
const dimensionMm = z.number().positive().max(CHAMBER_DIMENSION_MAX_MM);

/** One optional per-output override. All fields optional; each a dimension. */
const constraintSchema = z.object({
  min: dimensionMm.optional(),
  max: dimensionMm.optional(),
  exact: dimensionMm.optional(),
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
    // Optional X4 (≈ power) steering the hollow generator model (Gen Dim v3).
    // Omitted => 0.9 · 9.81 · X2 · X3. Hollow-only consumer; never forwarded to
    // the builder, so it cannot change a cache key by itself.
    x4: z.number().finite().positive().max(CHAMBER_X4_MAX).optional(),
    // Simplify Generator (hollow only): pin the central cylinder through the
    // box top (stepped-style) with no dome; centralHeight/domeHeight are
    // ignored while on. A different flag => a different cached build.
    simplifyGenerator: z.boolean().default(false),
    lengthOverride: dimensionMm.optional(),
    hollowLength: dimensionMm.optional(),
    wallThickness: dimensionMm.optional(),
    // Manual overrides for otherwise-derived dimensions (mm). Omitted => the fixed
    // empirical relation is used. dFirst/dMiddle apply to both variants; the three
    // central/dome ones only affect the hollow variant. A different value => a
    // different cached build (they flow into resolveGeometryParams's hash).
    dFirst: dimensionMm.optional(),
    dMiddle: dimensionMm.optional(),
    centralDiameter: dimensionMm.optional(),
    centralHeight: dimensionMm.optional(),
    domeHeight: dimensionMm.optional(),
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
