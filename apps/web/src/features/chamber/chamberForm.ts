import { z } from 'zod';
import {
  CHAMBER_D_FIRST_OVER_LAST,
  CHAMBER_D_MIDDLE_OVER_LAST,
  CHAMBER_DIMENSION_MAX_MM,
  CHAMBER_INPUT_RANGES,
  CHAMBER_RELATIONS,
  CHAMBER_VARIANTS,
  CHAMBER_WALL_THICKNESS_MM,
  CHAMBER_X4_MAX,
  computeChamberGeneratorDims,
} from '@dive/shared';
import type { ChamberInput, ChamberVariant } from '@dive/shared';

/**
 * Form contract for the chamber inputs, kept apart from the component file so
 * fast-refresh stays happy (a component module should export only components).
 */

const r = CHAMBER_INPUT_RANGES;

/** The chamber form fields. Lengths are in mm; lengthOverride blank => 2 x width. */
export interface ChamberFormValues {
  x1: number;
  x2: number;
  x3: number;
  variant: ChamberVariant;
  /** Master switch for all structural relations (hard override; off = X1–X3 only). */
  relationsMaster: boolean;
  /** Per-relation on/off, keyed by the driven output. Only read when the master is on. */
  relations: Record<string, boolean>;
  /** Torque-foot orientation (deg): 0 = tangential, 90 = radial. */
  footAngleDeg: number;
  /** Uniform scale of the whole internal assembly (cylinders + feet + vanes); box + axis stay fixed. */
  partScale: number;
  /** Replace the middle cylinder with a guide-vane ring (both variants). */
  guideVanes: boolean;
  /** Cut the two corners at the box's inlet end. Geometry-only. */
  chamferEnabled: boolean;
  /** Cut the four torque-foot voids (legs + planks). Geometry-only. */
  feetEnabled: boolean;
  /** Absolute guide-vane open angle (deg, 45..55; asset baked at 50°); each blade swings about its spindle. Guide-vane builds only. */
  vaneAngleDeg: number;
  /** Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). Guide-vane builds only. */
  outletRatio: number;
  /** Box length along Y (mm); blank => auto 2 x width. */
  lengthOverride?: number;
  /** Hollow last-cylinder height (mm); required when variant === 'hollow'. */
  hollowLength?: number;
  /** Hollow wall thickness (mm); defaults to CHAMBER_WALL_THICKNESS_MM. */
  wallThickness?: number;
  /** Runner case (first cylinder) Ø (mm); blank => auto from D_last. Both variants. */
  dFirst?: number;
  /** Guide vanes / middle cylinder Ø (mm); blank => auto from D_last. Both variants. */
  dMiddle?: number;
  /** X4 (≈ power) steering the generator model; blank => 0.9 · 9.81 · X2 · X3. Hollow only. */
  x4?: number;
  /** Generator (central cylinder) Ø (mm); blank => Gen Dim catalog Ø for the suggested frame. Hollow only. */
  centralDiameter?: number;
  /** Generator (central cylinder) height (mm); blank => Gen Dim fit from the resolved Ø + length code. Hollow only. */
  centralHeight?: number;
  /** Dome height (mm); blank => Gen Dim fit from the resolved Ø. Hollow variant only. */
  domeHeight?: number;
}

// A user-entered dimension (mm): strictly positive and bounded, mirroring the
// API schema (CHAMBER_DIMENSION_MAX_MM) so the server never sees an absurdity.
const optionalPositive = z
  .number({ invalid_type_error: 'Enter a number' })
  .positive('Must be greater than 0')
  .max(CHAMBER_DIMENSION_MAX_MM, `Max ${CHAMBER_DIMENSION_MAX_MM.toLocaleString('en-US')} mm`)
  .optional();

/** Range-validated schema; hollowLength is required for the hollow variant. */
export const chamberFormSchema = z
  .object({
    x1: z.number({ invalid_type_error: 'Enter a number' }).min(r.x1.min).max(r.x1.max),
    x2: z.number({ invalid_type_error: 'Enter a number' }).min(r.x2.min).max(r.x2.max),
    x3: z.number({ invalid_type_error: 'Enter a number' }).min(r.x3.min).max(r.x3.max),
    variant: z.enum(CHAMBER_VARIANTS),
    relationsMaster: z.boolean(),
    relations: z.record(z.boolean()),
    guideVanes: z.boolean(),
    chamferEnabled: z.boolean(),
    feetEnabled: z.boolean(),
    footAngleDeg: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(0, 'Min 0° (tangential)')
      .max(180, 'Max 180° (tangential, opposite)'),
    partScale: z
      .number({ invalid_type_error: 'Enter a number' })
      .positive('Must be greater than 0')
      .max(5, 'Max 5×'),
    vaneAngleDeg: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(45, 'Min 45°')
      .max(55, 'Max 55°'),
    outletRatio: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(0.35, 'Min 0.35')
      .max(0.5, 'Max 0.50'),
    lengthOverride: optionalPositive,
    hollowLength: optionalPositive,
    wallThickness: optionalPositive,
    dFirst: optionalPositive,
    dMiddle: optionalPositive,
    x4: z
      .number({ invalid_type_error: 'Enter a number' })
      .positive('Must be greater than 0')
      .max(CHAMBER_X4_MAX, `Max ${CHAMBER_X4_MAX.toLocaleString('en-US')}`)
      .optional(),
    centralDiameter: optionalPositive,
    centralHeight: optionalPositive,
    domeHeight: optionalPositive,
  })
  .superRefine((v, ctx) => {
    if (v.variant === 'hollow' && v.hollowLength == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hollowLength'],
        message: 'A cone length is required for this variant.',
      });
    }
  });

/** Sensible mid-range starting point (length auto = 2 x width; hollow prefilled). */
export const CHAMBER_FORM_DEFAULTS: ChamberFormValues = {
  x1: 1450,
  x2: 7.85,
  x3: 8,
  variant: 'stepped',
  relationsMaster: true,
  relations: Object.fromEntries(CHAMBER_RELATIONS.map((rel) => [rel.key, rel.defaultOn])),
  footAngleDeg: 40,
  partScale: 1,
  // On by default: the guide-vane distributor is the configuration the team
  // builds most. (Saved builds always carry their own explicit value.)
  guideVanes: true,
  chamferEnabled: true,
  feetEnabled: true,
  vaneAngleDeg: 50,
  outletRatio: 0.45,
  lengthOverride: undefined,
  hollowLength: 200,
  wallThickness: CHAMBER_WALL_THICKNESS_MM,
  dFirst: undefined,
  dMiddle: undefined,
  x4: undefined,
  centralDiameter: undefined,
  centralHeight: undefined,
  domeHeight: undefined,
};

/**
 * Map a saved build snapshot (the `POST /chamber/build` body) back onto the
 * form. Snapshot fields with server-side defaults fall back to the same values
 * the form starts with, so loading an old, sparser snapshot behaves exactly
 * like typing it in fresh; blank optional overrides stay blank (auto).
 */
export function chamberInputToFormValues(input: ChamberInput): ChamberFormValues {
  return {
    x1: input.x1,
    x2: input.x2,
    x3: input.x3,
    variant: input.variant ?? CHAMBER_FORM_DEFAULTS.variant,
    relationsMaster: input.relationsMaster ?? CHAMBER_FORM_DEFAULTS.relationsMaster,
    relations: Object.fromEntries(
      CHAMBER_RELATIONS.map((rel) => [rel.key, input.relations?.[rel.key] ?? rel.defaultOn]),
    ),
    footAngleDeg: input.footAngleDeg ?? CHAMBER_FORM_DEFAULTS.footAngleDeg,
    partScale: input.partScale ?? CHAMBER_FORM_DEFAULTS.partScale,
    guideVanes: input.guideVanes ?? CHAMBER_FORM_DEFAULTS.guideVanes,
    chamferEnabled: input.chamferEnabled ?? CHAMBER_FORM_DEFAULTS.chamferEnabled,
    feetEnabled: input.feetEnabled ?? CHAMBER_FORM_DEFAULTS.feetEnabled,
    vaneAngleDeg: input.vaneAngleDeg ?? CHAMBER_FORM_DEFAULTS.vaneAngleDeg,
    outletRatio: input.outletRatio ?? CHAMBER_FORM_DEFAULTS.outletRatio,
    lengthOverride: input.lengthOverride,
    hollowLength: input.hollowLength,
    wallThickness: input.wallThickness,
    dFirst: input.dFirst,
    dMiddle: input.dMiddle,
    x4: input.x4,
    centralDiameter: input.centralDiameter,
    centralHeight: input.centralHeight,
    domeHeight: input.domeHeight,
  };
}

/** The auto (empirical) values shown as placeholders on the blank override fields. */
export interface ChamberAutoDims {
  /** Runner case (first cylinder) Ø, mm. */
  dFirst: number | null;
  /** Guide vanes / middle cylinder Ø, mm. */
  dMiddle: number | null;
  /** X4 (≈ power): 0.9 · 9.81 · X2 · X3 (generator model steering input). */
  x4: number | null;
  /** Generator (central cylinder) Ø, mm (hollow variant). */
  centralDiameter: number | null;
  /** Generator (central cylinder) height, mm (hollow variant). */
  centralHeight: number | null;
  /** Dome height, mm (hollow variant). */
  domeHeight: number | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The "Blank = auto ≈ N" hints: the dLast-driven Ø ratios plus the Gen Dim v3
 * generator dims — computed WITH the current overrides, so a typed Generator Ø
 * re-bases the height/dome hints exactly like the API build will (the shared
 * function is the single source of truth for both).
 */
export function computeChamberAutoDims(
  values: Pick<
    ChamberFormValues,
    'x1' | 'x2' | 'x3' | 'x4' | 'centralDiameter' | 'centralHeight' | 'domeHeight'
  >,
  dLastFinal: number | null,
): ChamberAutoDims {
  const gen =
    finite(values.x1) && finite(values.x2) && finite(values.x3)
      ? computeChamberGeneratorDims({
          x1: values.x1,
          x2: values.x2,
          x3: values.x3,
          x4: values.x4,
          centralDiameter: values.centralDiameter,
          centralHeight: values.centralHeight,
          domeHeight: values.domeHeight,
        })
      : null;
  return {
    dFirst: dLastFinal != null ? CHAMBER_D_FIRST_OVER_LAST * dLastFinal : null,
    dMiddle: dLastFinal != null ? CHAMBER_D_MIDDLE_OVER_LAST * dLastFinal : null,
    x4: gen?.x4Auto ?? null,
    centralDiameter: gen?.auto.centralDiameter ?? null,
    centralHeight: gen?.auto.centralHeight ?? null,
    domeHeight: gen?.auto.domeHeight ?? null,
  };
}
