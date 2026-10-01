import { z } from 'zod';
import {
  CHAMBER_CONE_CHAMFER_SIZE_MM,
  CHAMBER_D_FIRST_OVER_LAST,
  CHAMBER_D_MIDDLE_OVER_LAST,
  CHAMBER_DIMENSION_MAX_MM,
  CHAMBER_INPUT_RANGES,
  CHAMBER_RELATIONS,
  CHAMBER_VANE_COUNT_DEFAULT,
  CHAMBER_VANE_COUNT_MAX,
  CHAMBER_VANE_COUNT_MIN,
  CHAMBER_VARIANTS,
  CHAMBER_WALL_THICKNESS_MM,
  CHAMBER_X4_MAX,
  chamberSpiralVelocityOf,
  chamberSpiralVelocityRefusal,
  computeChamberGeneratorDims,
  normaliseChamberLength,
} from '@dive/shared';
import type {
  ChamberConstraint,
  ChamberInput,
  ChamberOutput,
  ChamberOutputKey,
  ChamberVariant,
} from '@dive/shared';
import { ApiError } from '@/lib/api/client';

/**
 * Form contract for the chamber inputs, kept apart from the component file so
 * fast-refresh stays happy (a component module should export only components).
 */

const r = CHAMBER_INPUT_RANGES;

/** The chamber form fields. Lengths are in mm (the box Length is a Parameters-table row). */
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
  /** Number of guide vanes (whole number 8..32, default 16; chord x min(1, 16/n)). Guide-vane builds only. */
  vaneCount: number;
  /** Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). Guide-vane builds only. */
  outletRatio: number;
  /** Hollow last-cylinder height (mm); required when variant === 'hollow'. */
  hollowLength?: number;
  /** Hollow wall thickness (mm); defaults to CHAMBER_WALL_THICKNESS_MM. */
  wallThickness?: number;
  /** Cone chamfer: a 45° foot chamfer on the lower outer edge of the LE part, widened by the size above it. Both designs. */
  coneChamferEnabled: boolean;
  /** Cone chamfer size (mm, both legs = the widening; With cone: at most Cone length minus Wall thickness); blank => 50 on the server. */
  coneChamferSize?: number;
  /** Runner case (first cylinder) Ø (mm); blank => auto from D_last. Both variants. */
  dFirst?: number;
  /** Guide vanes / middle cylinder Ø (mm); blank => auto from D_last. Both variants. */
  dMiddle?: number;
  /** Simplify Generator: strict cylinder pinned through the chamber top, no dome. Hollow only. */
  simplifyGenerator: boolean;
  /** X4 (≈ power) steering the generator model; blank => 0.9 · 9.81 · X2 · X3. Hollow only. */
  x4?: number;
  /** Generator (central cylinder) Ø (mm); blank => Gen Dim catalog Ø for the suggested frame. Hollow only. */
  centralDiameter?: number;
  /** Generator height above LEB (mm). With cone: blank => Gen Dim fit. Closed generator / Simplify: blank => through the chamber top. */
  centralHeight?: number;
  /** Dome height (mm); blank => Gen Dim fit from the resolved Ø. Hollow variant only. */
  domeHeight?: number;
  /** Semi-spiral casing: the footprint follows the optimised spiral + tongue. Both designs; needs Feet off. */
  semiSpiral: boolean;
}

// A user-entered dimension (mm): strictly positive and bounded, mirroring the
// API schema (CHAMBER_DIMENSION_MAX_MM) so the server never sees an absurdity.
const optionalPositive = z
  .number({ invalid_type_error: 'Enter a number' })
  .positive('Must be greater than 0')
  .max(CHAMBER_DIMENSION_MAX_MM, `Max ${CHAMBER_DIMENSION_MAX_MM.toLocaleString('en-US')} mm`)
  .optional();

/** A model input (Runner Ø / Head / Q_max): the empirical fits only hold inside their range. */
const modelRange = ({ min, max }: { min: number; max: number }, unit: string) => {
  const msg = `Must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')} ${unit} (the range the model was fitted on)`;
  return z.number({ invalid_type_error: 'Enter a number' }).min(min, msg).max(max, msg);
};

/** One message for every bad Guide vane count (blank, fractional, out of range). */
const VANE_COUNT_MESSAGE = `Enter a whole number from ${CHAMBER_VANE_COUNT_MIN} to ${CHAMBER_VANE_COUNT_MAX}`;

/** Range-validated schema; hollowLength is required for the hollow variant. */
export const chamberFormSchema = z
  .object({
    x1: modelRange(r.x1, 'mm'),
    x2: modelRange(r.x2, 'm'),
    x3: modelRange(r.x3, 'm³/s'),
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
    vaneCount: z
      .number({ invalid_type_error: VANE_COUNT_MESSAGE })
      .int(VANE_COUNT_MESSAGE)
      .min(CHAMBER_VANE_COUNT_MIN, VANE_COUNT_MESSAGE)
      .max(CHAMBER_VANE_COUNT_MAX, VANE_COUNT_MESSAGE),
    outletRatio: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(0.35, 'Min 0.35')
      .max(0.5, 'Max 0.50'),
    hollowLength: optionalPositive,
    wallThickness: optionalPositive,
    coneChamferEnabled: z.boolean(),
    coneChamferSize: optionalPositive,
    dFirst: optionalPositive,
    dMiddle: optionalPositive,
    simplifyGenerator: z.boolean(),
    x4: z
      .number({ invalid_type_error: 'Enter a number' })
      .positive('Must be greater than 0')
      .max(CHAMBER_X4_MAX, `Max ${CHAMBER_X4_MAX.toLocaleString('en-US')}`)
      .optional(),
    centralDiameter: optionalPositive,
    centralHeight: optionalPositive,
    domeHeight: optionalPositive,
    semiSpiral: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // Mirrors the API refusal (spec 2026-09-29-semi-spiral-casing): the form
    // unticks Feet when the spiral is ticked, so this only guards a stale state.
    if (v.semiSpiral && v.feetEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feetEnabled'],
        message: 'The semi-spiral casing needs Feet off for now.',
      });
    }
    if (v.variant === 'hollow' && v.hollowLength == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hollowLength'],
        message: 'Enter a cone length: the With cone design needs one.',
      });
    }
    // Cone chamfer (spec 2026-09-29-cone-foot-chamfer): the With cone bound
    // (Cone length minus Wall thickness), for instant feedback. The Closed
    // generator bound depends on H Kammer and LEB, so the builder alone checks it.
    if (
      v.variant === 'hollow' &&
      v.coneChamferEnabled &&
      v.coneChamferSize != null &&
      v.hollowLength != null
    ) {
      const room = v.hollowLength - (v.wallThickness ?? CHAMBER_WALL_THICKNESS_MM);
      // room <= 0 is the builder's own Cone length refusal.
      if (room > 0 && v.coneChamferSize > room) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coneChamferSize'],
          message: `Must be at most Cone length minus Wall thickness (${Math.round(room)} mm)`,
        });
      }
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
  vaneCount: CHAMBER_VANE_COUNT_DEFAULT,
  outletRatio: 0.45,
  hollowLength: 200,
  wallThickness: CHAMBER_WALL_THICKNESS_MM,
  coneChamferEnabled: false,
  coneChamferSize: CHAMBER_CONE_CHAMFER_SIZE_MM,
  dFirst: undefined,
  dMiddle: undefined,
  simplifyGenerator: false,
  x4: undefined,
  centralDiameter: undefined,
  centralHeight: undefined,
  domeHeight: undefined,
  semiSpiral: false,
};

/** Recursively sort object keys so serialization ignores property order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Canonical comparison key for a build body ({ ...form values, constraints }).
 * Key-order-insensitive: the live form (watch(), keys in registration order)
 * and the last built body (handleSubmit's zod parse output, keys in schema
 * order) hold the same data in different property orders, so a plain
 * JSON.stringify comparison would flag every build as stale immediately.
 * Blank overrides (undefined) and omitted keys serialize identically.
 */
export function chamberBodyKey(body: object): string {
  return JSON.stringify(sortKeysDeep(body));
}

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
    // Saves made before the vane count existed load as the asset's 16 vanes.
    vaneCount: input.vaneCount ?? CHAMBER_FORM_DEFAULTS.vaneCount,
    outletRatio: input.outletRatio ?? CHAMBER_FORM_DEFAULTS.outletRatio,
    hollowLength: input.hollowLength,
    wallThickness: input.wallThickness,
    // Saves made before the cone chamfer existed load with it off, at 50 mm.
    coneChamferEnabled: input.coneChamferEnabled ?? CHAMBER_FORM_DEFAULTS.coneChamferEnabled,
    coneChamferSize: input.coneChamferSize ?? CHAMBER_FORM_DEFAULTS.coneChamferSize,
    dFirst: input.dFirst,
    dMiddle: input.dMiddle,
    simplifyGenerator: input.simplifyGenerator ?? CHAMBER_FORM_DEFAULTS.simplifyGenerator,
    x4: input.x4,
    centralDiameter: input.centralDiameter,
    centralHeight: input.centralHeight,
    domeHeight: input.domeHeight,
    // Saves made before the semi-spiral casing existed load with it off.
    semiSpiral: input.semiSpiral ?? CHAMBER_FORM_DEFAULTS.semiSpiral,
  };
}

/**
 * The Parameters-table constraints of a saved build snapshot or a hand-off, with
 * an old save's Length folded in (spec 2026-10-01-chamber-length-row §5): a
 * plain-box `lengthOverride` becomes a Length Exact, a spiral `spiralLength`
 * the Length Min / Max / Exact.
 */
export function chamberInputToConstraints(
  input: ChamberInput,
): Partial<Record<ChamberOutputKey, ChamberConstraint>> {
  return { ...(normaliseChamberLength(input).constraints ?? {}) };
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
  /**
   * Generator height that reaches the chamber top, mm at partScale 1: the
   * blank-field hint of the Closed generator and Simplify generator designs.
   */
  generatorToTop: number | null;
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
  top?: { heightFinal: number | null; lebFinal: number | null; partScale: number },
): ChamberAutoDims {
  const scale = top && finite(top.partScale) && top.partScale > 0 ? top.partScale : null;
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
    // The pinned generator's top is the chamber top: (H - scale x LEB) / scale.
    generatorToTop:
      top && scale != null && top.heightFinal != null && top.lebFinal != null
        ? (top.heightFinal - scale * top.lebFinal) / scale
        : null,
  };
}

/**
 * Side effects of ticking / unticking "Semi-spiral casing" on the other options.
 * Ticked: Feet and Chamfer go off (the spiral needs Feet off and its cut sides
 * are the corner chamfers, spec 2026-09-29-semi-spiral-casing sections 6 / 10),
 * and the Chamfer state is remembered. Unticked: Chamfer gets that state back.
 * Without a remembered state (a save loaded with the spiral on) Chamfer is left alone.
 */
export function semiSpiralToggle(
  on: boolean,
  current: Pick<ChamberFormValues, 'chamferEnabled'>,
  savedChamfer: boolean | null,
): {
  set: Partial<Pick<ChamberFormValues, 'feetEnabled' | 'chamferEnabled'>>;
  savedChamfer: boolean | null;
} {
  if (on) {
    return {
      set: { feetEnabled: false, chamferEnabled: false },
      savedChamfer: current.chamferEnabled,
    };
  }
  return {
    set: savedChamfer === null ? {} : { chamferEnabled: savedChamfer },
    savedChamfer: null,
  };
}

/** The read-only Casing flow velocity the form shows (semi-spiral casing). */
export interface CasingVelocity {
  /** m/s, null when it cannot be computed or is out of range. */
  value: number | null;
  /** B Kammer Final (mm) it comes from, null before the outputs exist. */
  widthMm: number | null;
  /** The API's refusal text when the velocity leaves 0.3 to 3 m/s. */
  error: string | null;
}

/**
 * Casing flow velocity derived live from B Kammer (user rule 2026-09-30), with
 * the same shared helpers the API uses, so it follows every B Kammer / H Kammer /
 * Q_max / machine-diameter change without a build.
 */
export function casingVelocity(
  values: ChamberFormValues,
  constraints: Record<string, ChamberConstraint>,
  outputs: ChamberOutput[] | null,
): CasingVelocity {
  if (!outputs) return { value: null, widthMm: null, error: null };
  const input = { ...values, constraints } as unknown as ChamberInput;
  const widthMm = Math.round(outputs.find((o) => o.key === 'width')!.final);
  const error = chamberSpiralVelocityRefusal(input, outputs);
  return { value: error ? null : chamberSpiralVelocityOf(input, outputs), widthMm, error };
}

/**
 * The message shown when a build fails. Every API refusal carries a
 * client-safe message: a builder refusal (422 CHAMBER_REFUSED, a `KO:` line,
 * since WS-H), a pre-builder refusal (422 VALIDATION_ERROR) and a crash
 * (502 CHAMBER_BUILD_FAILED) all show it as is; anything else gets a generic line.
 */
export function chamberBuildErrorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Could not generate the chamber.';
}
