import { describe, expect, it } from 'vitest';
import { chamberSpiralVelocityOf, computeChamberOutputs, type ChamberInput } from '@dive/shared';
import {
  CHAMBER_FORM_DEFAULTS,
  casingVelocity,
  chamberBodyKey,
  chamberBuildErrorMessage,
  chamberFormSchema,
  chamberInputToFormValues,
  chamberInputToSpiralLength,
  chamberSpiralLengthBody,
  computeChamberAutoDims,
  semiSpiralToggle,
  type ChamberFormValues,
} from './chamberForm';
import { ApiError } from '@/lib/api/client';

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
      expect(issue?.message).toBe('Enter a cone length: the With cone design needs one.');
    }
    // The same blank is fine on stepped (the field is unused there).
    expect(
      parse({ ...CHAMBER_FORM_DEFAULTS, variant: 'stepped', hollowLength: undefined }).success,
    ).toBe(true);
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
    ['a vane count of 7', { vaneCount: 7 }],
    ['a vane count of 33', { vaneCount: 33 }],
    ['a fractional vane count', { vaneCount: 12.5 }],
    ['a blank vane count', { vaneCount: Number.NaN }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, ...patch }).success).toBe(false);
  });

  it('defaults the guide vane count to 16 and accepts any whole number from 8 to 32', () => {
    expect(CHAMBER_FORM_DEFAULTS.vaneCount).toBe(16);
    for (const vaneCount of [8, 12, 16, 17, 18, 32]) {
      expect(parse({ ...CHAMBER_FORM_DEFAULTS, vaneCount }).success).toBe(true);
    }
    for (const vaneCount of [7, 33, 12.5, Number.NaN]) {
      const bad = parse({ ...CHAMBER_FORM_DEFAULTS, vaneCount });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const issue = bad.error.issues.find((i) => i.path.join('.') === 'vaneCount');
        expect(issue?.message).toBe('Enter a whole number from 8 to 32');
      }
    }
  });

  it('keeps the five dimension overrides optional but positive', () => {
    expect(parse({ ...CHAMBER_FORM_DEFAULTS, dFirst: undefined, dMiddle: undefined }).success).toBe(
      true,
    );
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
      vaneCount: 18,
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
    expect(loaded).toEqual({
      ...CHAMBER_FORM_DEFAULTS,
      wallThickness: undefined,
      hollowLength: undefined,
    });
  });

  it('loads an old save without a vane count as 16 vanes', () => {
    const loaded = chamberInputToFormValues({ x1: 1450, x2: 7.85, x3: 8, guideVanes: true });
    expect(loaded.vaneCount).toBe(16);
  });

  it.each([16, 18, 24])('loads a save with %i vanes as is', (vaneCount) => {
    const loaded = chamberInputToFormValues({ x1: 1450, x2: 7.85, x3: 8, guideVanes: true, vaneCount });
    expect(loaded.vaneCount).toBe(vaneCount);
    expect(parse(loaded).success).toBe(true);
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

describe('cone chamfer (45° foot chamfer on the lower outer edge of the LE part, both designs)', () => {
  const hollow: ChamberFormValues = { ...CHAMBER_FORM_DEFAULTS, variant: 'hollow' };
  const stepped: ChamberFormValues = { ...CHAMBER_FORM_DEFAULTS, variant: 'stepped' };

  function issueOn(values: ChamberFormValues, key: string) {
    const res = parse(values);
    if (res.success) return undefined;
    return res.error.issues.find((i) => i.path.join('.') === key)?.message;
  }

  it('ships off, with a 50 mm size', () => {
    expect(CHAMBER_FORM_DEFAULTS.coneChamferEnabled).toBe(false);
    expect(CHAMBER_FORM_DEFAULTS.coneChamferSize).toBe(50);
    expect(parse({ ...hollow, coneChamferEnabled: true }).success).toBe(true);
    expect(parse({ ...stepped, coneChamferEnabled: true }).success).toBe(true);
  });

  it('loads an old save as off / 50 and round-trips a saved chamfer', () => {
    const base = { x1: 1450, x2: 7, x3: 10, variant: 'stepped' } as ChamberInput;
    const old = chamberInputToFormValues(base);
    expect(old.coneChamferEnabled).toBe(false);
    expect(old.coneChamferSize).toBe(50);
    const saved = chamberInputToFormValues({
      ...base,
      coneChamferEnabled: true,
      coneChamferSize: 30,
    });
    expect(saved.coneChamferEnabled).toBe(true);
    expect(saved.coneChamferSize).toBe(30);
  });

  /** Cone chamfer ticked, plus a patch (With cone unless the patch says otherwise). */
  const on = (patch: Partial<ChamberFormValues>): ChamberFormValues => ({
    ...hollow,
    coneChamferEnabled: true,
    ...patch,
  });

  it('refuses a size taller than Cone length minus Wall thickness (With cone)', () => {
    const values = on({ coneChamferSize: 40, wallThickness: 50, hollowLength: 80 });
    expect(issueOn(values, 'coneChamferSize')).toBe(
      'Must be at most Cone length minus Wall thickness (30 mm)',
    );
    // Blank wall thickness = the 50 mm default.
    expect(
      issueOn(on({ coneChamferSize: 40, wallThickness: undefined, hollowLength: 80 }), 'coneChamferSize'),
    ).toBe('Must be at most Cone length minus Wall thickness (30 mm)');
    // Equal to the bound is allowed.
    expect(parse(on({ coneChamferSize: 30, wallThickness: 50, hollowLength: 80 })).success).toBe(
      true,
    );
  });

  it('allows a size above the Wall thickness (the part widens outward)', () => {
    expect(parse(on({ coneChamferSize: 60, wallThickness: 50, hollowLength: 200 })).success).toBe(
      true,
    );
  });

  it('leaves the Closed generator bound to the builder (it depends on H Kammer)', () => {
    expect(parse(on({ variant: 'stepped', coneChamferSize: 400, hollowLength: 80 })).success).toBe(
      true,
    );
  });

  it('ignores the size when the option is off', () => {
    expect(
      parse(on({ coneChamferEnabled: false, coneChamferSize: 400, hollowLength: 80 })).success,
    ).toBe(true);
  });

  it('refuses a non-positive size in both designs', () => {
    expect(parse(on({ coneChamferSize: 0 })).success).toBe(false);
    expect(parse(on({ variant: 'stepped', coneChamferSize: 0 })).success).toBe(false);
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

  it('gives the generator height that reaches the chamber top, per unit of Part scale', () => {
    const top = { heightFinal: 3900, lebFinal: 1200, partScale: 1 };
    expect(computeChamberAutoDims(V, 2400, top).generatorToTop).toBe(2700);
    // Scaled part: the typed height is scaled too, so the hint is (H - s.LEB) / s.
    expect(computeChamberAutoDims(V, 2400, { ...top, partScale: 0.5 }).generatorToTop).toBe(6600);
    expect(computeChamberAutoDims(V, 2400).generatorToTop).toBeNull();
    expect(
      computeChamberAutoDims(V, 2400, { ...top, partScale: Number.NaN }).generatorToTop,
    ).toBeNull();
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

describe('semi-spiral casing (spec 2026-09-29-semi-spiral-casing)', () => {
  it('ships off, without a casing flow velocity (derived from B Kammer)', () => {
    expect(CHAMBER_FORM_DEFAULTS.semiSpiral).toBe(false);
    expect(CHAMBER_FORM_DEFAULTS).not.toHaveProperty('spiralFlowVelocity');
  });

  it('derives the casing flow velocity live from B Kammer, as the API does', () => {
    const values = { ...CHAMBER_FORM_DEFAULTS, semiSpiral: true, feetEnabled: false };
    const outputs = computeChamberOutputs({ x1: values.x1, x2: values.x2, x3: values.x3 });
    const shown = casingVelocity(values, {}, outputs);
    expect(shown.value).toBe(chamberSpiralVelocityOf({ ...values }, outputs));
    expect(shown.widthMm).toBe(Math.round(outputs.find((o) => o.key === 'width')!.final));
    // a wider B Kammer lowers it
    const wider = computeChamberOutputs({
      x1: values.x1,
      x2: values.x2,
      x3: values.x3,
      constraints: { width: { exact: shown.widthMm! + 1000 } },
    });
    expect(casingVelocity(values, {}, wider).value!).toBeLessThan(shown.value!);
    // too narrow: no value, the API's message
    const narrow = computeChamberOutputs({
      x1: values.x1,
      x2: values.x2,
      x3: values.x3,
      constraints: { width: { exact: 1000 } },
    });
    const bad = casingVelocity(values, {}, narrow);
    expect(bad.value).toBeNull();
    expect(bad.error).toMatch(/^B Kammer \(1000 mm\) is too narrow/);
    // no outputs yet
    expect(casingVelocity(values, {}, null)).toEqual({ value: null, widthMm: null, error: null });
  });

  it('refuses Feet on with the spiral, on the Feet field', () => {
    const res = parse({ ...CHAMBER_FORM_DEFAULTS, semiSpiral: true, feetEnabled: true });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.path.join('.'))).toContain('feetEnabled');
  });

  it('loads old saves with the spiral off and drops a saved velocity (now derived)', () => {
    const base = { x1: 1450, x2: 7, x3: 10 } as ChamberInput;
    const old = chamberInputToFormValues(base);
    expect(old.semiSpiral).toBe(false);
    const saved = chamberInputToFormValues({
      ...base,
      semiSpiral: true,
      spiralFlowVelocity: 0.7,
      feetEnabled: false,
    });
    expect(saved.semiSpiral).toBe(true);
    expect(saved).not.toHaveProperty('spiralFlowVelocity');
  });
});

describe('semiSpiralToggle (Chamfer off with the spiral, restored when it goes)', () => {
  it('turns Feet and Chamfer off when the spiral is ticked and remembers Chamfer', () => {
    expect(semiSpiralToggle(true, { chamferEnabled: true }, null)).toEqual({
      set: { feetEnabled: false, chamferEnabled: false },
      savedChamfer: true,
    });
  });

  it('restores the Chamfer state saved when the spiral was ticked', () => {
    expect(semiSpiralToggle(false, { chamferEnabled: false }, true)).toEqual({
      set: { chamferEnabled: true },
      savedChamfer: null,
    });
    expect(semiSpiralToggle(false, { chamferEnabled: false }, false)).toEqual({
      set: { chamferEnabled: false },
      savedChamfer: null,
    });
  });

  it('leaves Chamfer alone when nothing was saved (e.g. a save loaded with the spiral on)', () => {
    expect(semiSpiralToggle(false, { chamferEnabled: false }, null)).toEqual({
      set: {},
      savedChamfer: null,
    });
  });
});

describe('old saves: BF relations and constraints load as saved (2026-09-30)', () => {
  const base: ChamberInput = { x1: 1450, x2: 7.85, x3: 8 };

  it('keeps disabled BF relations', () => {
    const loaded = chamberInputToFormValues({
      ...base,
      relations: { chamferWidth1: false, chamferWidth2: false, chamferLength2: false },
    });
    expect(loaded.relations.chamferWidth1).toBe(false);
    expect(loaded.relations.chamferWidth2).toBe(false);
    expect(loaded.relations.chamferLength2).toBe(false);
  });

  it('restores the semi-spiral Length Min / Max / Exact (empty for old saves)', () => {
    expect(chamberInputToSpiralLength({ ...base, spiralLength: { min: 5000, max: 6000 } })).toEqual({
      min: 5000,
      max: 6000,
    });
    expect(chamberInputToSpiralLength(base)).toEqual({});
  });
});

describe('chamberSpiralLengthBody (spec 2026-09-30-spiral-length)', () => {
  it('sends the Length constraint only with the spiral on and a value typed', () => {
    expect(chamberSpiralLengthBody(true, { min: 5000 })).toEqual({ min: 5000 });
    expect(chamberSpiralLengthBody(true, {})).toBeUndefined();
    expect(chamberSpiralLengthBody(false, { max: 6000 })).toBeUndefined();
  });

  it('keeps an old body and one with an empty Length on the same comparison key', () => {
    const body = { x1: 1450, x2: 7.85, x3: 8, semiSpiral: true };
    expect(chamberBodyKey({ ...body, spiralLength: chamberSpiralLengthBody(true, {}) })).toBe(
      chamberBodyKey(body),
    );
  });
});

describe('chamberBuildErrorMessage', () => {
  it('shows a builder refusal (CHAMBER_REFUSED, 422) with the same message as before', () => {
    const refused = new ApiError(
      'CHAMBER_REFUSED',
      'Cannot build the chamber. The guide vanes do not fit.',
      422,
    );
    expect(chamberBuildErrorMessage(refused)).toBe(
      'Cannot build the chamber. The guide vanes do not fit.',
    );
    const crash = new ApiError('CHAMBER_BUILD_FAILED', 'The chamber builder stopped.', 502);
    expect(chamberBuildErrorMessage(crash)).toBe('The chamber builder stopped.');
    expect(chamberBuildErrorMessage(new Error('boom'))).toBe('Could not generate the chamber.');
  });
});
