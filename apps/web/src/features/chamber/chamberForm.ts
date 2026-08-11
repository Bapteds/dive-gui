import { z } from 'zod';
import {
  CHAMBER_INPUT_RANGES,
  CHAMBER_RELATIONS,
  CHAMBER_VARIANTS,
  CHAMBER_WALL_THICKNESS_MM,
} from '@dive/shared';
import type { ChamberVariant } from '@dive/shared';

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
}

const optionalPositive = z.number({ invalid_type_error: 'Enter a number' }).positive().optional();

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
  guideVanes: false,
  vaneAngleDeg: 50,
  outletRatio: 0.45,
  lengthOverride: undefined,
  hollowLength: 200,
  wallThickness: CHAMBER_WALL_THICKNESS_MM,
};
