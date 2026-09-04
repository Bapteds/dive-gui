import { describe, expect, it } from 'vitest';
import type { ChamberInput } from '@dive/shared';
import {
  CHAMBER_FORM_DEFAULTS,
  chamberBodyKey,
  chamberFormSchema,
  chamberInputToFormValues,
  computeChamberAutoDims,
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

describe('x4 (generator model steering input)', () => {
  it('accepts a blank and a positive x4', () => {
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, x4: undefined }).success).toBe(true);
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, x4: 618 }).success).toBe(true);
  });

  it.each([
    ['x4 of 0', { x4: 0 }],
    ['a negative x4', { x4: -5 }],
    ['x4 above the cap', { x4: 100_001 }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, ...patch }).success).toBe(false);
  });

  it('round-trips through a saved snapshot and defaults to blank on old saves', () => {
    const base = { x1: 1450, x2: 7, x3: 10 } as ChamberInput;
    expect(chamberInputToFormValues({ ...base, x4: 618 }).x4).toBe(618);
    expect(chamberInputToFormValues(base).x4).toBeUndefined();
  });
});

describe('simplifyGenerator (generator pinned to the chamber top)', () => {
  it('ships off by default and accepts both states', () => {
    expect(CHAMBER_FORM_DEFAULTS.simplifyGenerator).toBe(false);
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, simplifyGenerator: true }).success).toBe(true);
  });

  it('round-trips through a saved snapshot and defaults to false on old saves', () => {
    const base = { x1: 1450, x2: 7, x3: 10 } as ChamberInput;
    expect(chamberInputToFormValues({ ...base, simplifyGenerator: true }).simplifyGenerator).toBe(
      true,
    );
    expect(chamberInputToFormValues(base).simplifyGenerator).toBe(false);
  });
});

describe('chamberBodyKey (stale-build comparison)', () => {
  // ChamberPage flags "Inputs changed since this build" by comparing the live
  // form (watch(): key order = defaults/registration order) against the last
  // built body (handleSubmit: zod parse output, key order = schema order).
  // The comparison must therefore ignore key order, or the banner sticks on
  // forever right after a successful Generate (the bug this guards against).
  const constraints = { width: { max: 3000 } };

  it('matches raw watch() values against their zod parse output', () => {
    const parsed = chamberFormSchema.parse(CHAMBER_FORM_DEFAULTS);
    expect(chamberBodyKey({ ...parsed, constraints })).toBe(
      chamberBodyKey({ ...CHAMBER_FORM_DEFAULTS, constraints }),
    );
  });

  it('treats a blank override (undefined) the same as an omitted key', () => {
    const { x4: _x4, ...withoutX4 } = CHAMBER_FORM_DEFAULTS;
    expect(chamberBodyKey({ ...CHAMBER_FORM_DEFAULTS, x4: undefined, constraints })).toBe(
      chamberBodyKey({ ...withoutX4, constraints }),
    );
  });

  it('still detects real drift in a value, a nested relation, or a constraint', () => {
    const base = chamberBodyKey({ ...CHAMBER_FORM_DEFAULTS, constraints });
    expect(chamberBodyKey({ ...CHAMBER_FORM_DEFAULTS, x1: 1500, constraints })).not.toBe(base);
    expect(
      chamberBodyKey({
        ...CHAMBER_FORM_DEFAULTS,
        relations: { ...CHAMBER_FORM_DEFAULTS.relations, height: false },
        constraints,
      }),
    ).not.toBe(base);
    expect(
      chamberBodyKey({ ...CHAMBER_FORM_DEFAULTS, constraints: { width: { max: 2999 } } }),
    ).not.toBe(base);
  });
});

describe('computeChamberAutoDims', () => {
  const V = { ...CHAMBER_FORM_DEFAULTS, x1: 1450, x2: 7, x3: 10 };

  it('derives the generator hints from the Gen Dim model', () => {
    const dims = computeChamberAutoDims(V, 2400);
    expect(dims.dFirst).toBeCloseTo(1.14703 * 2400, 5);
    expect(dims.dMiddle).toBeCloseTo(0.8 * 2400, 5);
    expect(dims.x4).toBeCloseTo(618.03, 2);
    expect(dims.centralDiameter).toBe(1242);
    expect(dims.centralHeight).toBeCloseTo(1264.47, 2);
    expect(dims.domeHeight).toBeCloseTo(344.34, 2);
  });

  it('cascades a typed Generator Ø into the height/dome hints', () => {
    const dims = computeChamberAutoDims({ ...V, centralDiameter: 1272 }, null);
    expect(dims.centralDiameter).toBe(1242); // hint = what a blank Ø would get
    expect(dims.centralHeight).toBeCloseTo(1278.23, 2);
    expect(dims.domeHeight).toBeCloseTo(350.74, 2);
    expect(dims.dFirst).toBeNull(); // no dLast -> no ratio hints
  });

  it('a typed x4 re-picks the frame for the hints', () => {
    expect(computeChamberAutoDims({ ...V, x4: 2000 }, null).centralDiameter).toBe(2225);
  });

  it('returns null generator hints while X1–X3 are not finite', () => {
    const dims = computeChamberAutoDims({ ...V, x1: Number.NaN }, 2400);
    expect(dims.x4).toBeNull();
    expect(dims.centralDiameter).toBeNull();
    expect(dims.centralHeight).toBeNull();
    expect(dims.domeHeight).toBeNull();
    expect(dims.dFirst).toBeCloseTo(1.14703 * 2400, 5); // dLast ratios don't need X1–X3
  });
});
