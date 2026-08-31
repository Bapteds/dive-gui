import { describe, expect, it } from 'vitest';
import type { ChamberInput } from '@dive/shared';
import {
  CHAMBER_FORM_DEFAULTS,
  chamberFormSchema,
  chamberInputToFormValues,
  type ChamberFormValues,
} from './chamberForm';

/**
 * chamberFormSchema tests: the defaults are self-consistent, the hollow variant
 * requires a cone length, every range guard rejects out-of-range values, and the
 * optional overrides stay optional (undefined) but refuse non-positive numbers.
 * A schema bug here silently sends wrong parameters to the geometry builder.
 */

function parse(values: ChamberFormValues) {
  return chamberFormSchema.safeParse(values);
}

describe('chamberFormSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(parse(CHAMBER_FORM_DEFAULTS).success).toBe(true);
  });

  it('requires a cone length for the hollow variant only', () => {
    const hollow = parse({ ...CHAMBER_FORM_DEFAULTS, variant: 'hollow', hollowLength: undefined });
    expect(hollow.success).toBe(false);
    if (!hollow.success) {
      const issue = hollow.error.issues.find((i) => i.path.join('.') === 'hollowLength');
      expect(issue?.message).toBe('A cone length is required for this variant.');
    }
    // The same blank is fine on stepped (the field is unused there).
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, variant: 'stepped', hollowLength: undefined }).success).toBe(
      true,
    );
  });

  it.each([
    ['x1 below range', { x1: -1 }],
    ['footAngleDeg above 180', { footAngleDeg: 181 }],
    ['footAngleDeg below 0', { footAngleDeg: -5 }],
    ['partScale of 0', { partScale: 0 }],
    ['partScale above 5x', { partScale: 5.5 }],
    ['vaneAngleDeg below 45', { vaneAngleDeg: 44 }],
    ['vaneAngleDeg above 55', { vaneAngleDeg: 56 }],
    ['outletRatio below 0.35', { outletRatio: 0.34 }],
    ['outletRatio above 0.50', { outletRatio: 0.51 }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, ...patch }).success).toBe(false);
  });

  it('keeps the five dimension overrides optional but positive', () => {
    expect(
      parse({ ...CHAMBER_FORM_DEFAULTS, dFirst: undefined, dMiddle: undefined }).success,
    ).toBe(true);
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, dFirst: 2800 }).success).toBe(true);
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, dFirst: 0 }).success).toBe(false);
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, dMiddle: -10 }).success).toBe(false);
    expect(
      parse({ ...CHAMBER_FORM_DEFAULTS, variant: 'hollow', centralDiameter: -1 }).success,
    ).toBe(false);
  });

  it('ships defaults that leave every override on auto (undefined)', () => {
    expect(CHAMBER_FORM_DEFAULTS.lengthOverride).toBeUndefined();
    expect(CHAMBER_FORM_DEFAULTS.dFirst).toBeUndefined();
    expect(CHAMBER_FORM_DEFAULTS.dMiddle).toBeUndefined();
    expect(CHAMBER_FORM_DEFAULTS.centralDiameter).toBeUndefined();
    expect(CHAMBER_FORM_DEFAULTS.centralHeight).toBeUndefined();
    expect(CHAMBER_FORM_DEFAULTS.domeHeight).toBeUndefined();
  });
});

describe('chamberInputToFormValues', () => {
  it('round-trips a full form: values -> snapshot -> values', () => {
    const values: ChamberFormValues = {
      ...CHAMBER_FORM_DEFAULTS,
      x1: 1500,
      variant: 'hollow',
      guideVanes: true,
      vaneAngleDeg: 52,
      outletRatio: 0.4,
      relations: { ...CHAMBER_FORM_DEFAULTS.relations, height: false },
      lengthOverride: 4200,
      hollowLength: 250,
      dMiddle: 1900,
    };
    // The snapshot is exactly what Generate posts (constraints ride separately).
    const snapshot: ChamberInput = { ...values, constraints: { width: { max: 3000 } } };
    const loaded = chamberInputToFormValues(snapshot);
    expect(loaded).toEqual(values);
  });

  it('fills a sparse snapshot with the same defaults as a fresh form', () => {
    const loaded = chamberInputToFormValues({ x1: 1450, x2: 7.85, x3: 8 });
    expect(loaded).toEqual({ ...CHAMBER_FORM_DEFAULTS, wallThickness: undefined, hollowLength: undefined });
  });

  it('keeps saved per-relation toggles and defaults the missing ones', () => {
    const loaded = chamberInputToFormValues({
      x1: 1450,
      x2: 7.85,
      x3: 8,
      relations: { height: false },
    });
    expect(loaded.relations.height).toBe(false);
    // Every other relation keeps its shipped default.
    for (const [key, on] of Object.entries(CHAMBER_FORM_DEFAULTS.relations)) {
      if (key !== 'height') expect(loaded.relations[key]).toBe(on);
    }
  });
});
