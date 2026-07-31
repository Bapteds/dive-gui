import { z } from 'zod';
import { CHAMBER_INPUT_RANGES, CHAMBER_VARIANTS, CHAMBER_WALL_THICKNESS_MM } from '@dive/shared';
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
  /** Interdependency refinement on (default) or opted out (inputs-only). */
  interdependency: boolean;
  /** Torque-foot orientation (deg): 0 = tangential, 90 = radial. */
  footAngleDeg: number;
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
    interdependency: z.boolean(),
    footAngleDeg: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(0, 'Min 0° (tangential)')
      .max(180, 'Max 180° (tangential, opposite)'),
    lengthOverride: optionalPositive,
    hollowLength: optionalPositive,
    wallThickness: optionalPositive,
  })
  .superRefine((v, ctx) => {
    if (v.variant === 'hollow' && v.hollowLength == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hollowLength'],
        message: 'A hollow length is required for this variant.',
      });
    }
  });

/** Sensible mid-range starting point (length auto = 2 x width; hollow prefilled). */
export const CHAMBER_FORM_DEFAULTS: ChamberFormValues = {
  x1: 1450,
  x2: 7.85,
  x3: 8,
  variant: 'stepped',
  interdependency: true,
  footAngleDeg: 0,
  lengthOverride: undefined,
  hollowLength: 2000,
  wallThickness: CHAMBER_WALL_THICKNESS_MM,
};
