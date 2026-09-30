// Unit tests of the pure optimisation-study helpers of @dive/shared (WS-H spec
// §4-§5): search space (band ∩ table Min / Max, 50 mm grid snapped inward),
// Exact pinning, relation warnings, weighted objective and Pareto front.
import { describe, expect, it } from 'vitest';
import {
  CHAMBER_GRID_MM,
  chamberInputWithExact,
  computeChamberOutputs,
  computeParamSpace,
  paretoFront,
  studyPickableKeys,
  studyRelationWarnings,
  weightedObjective,
  type ChamberInput,
} from '@dive/shared';

const BASE: ChamberInput = { x1: 1450, x2: 7.85, x3: 8 };
const final = (input: ChamberInput, key: string) =>
  computeChamberOutputs(input).find((o) => o.key === key)!.final;

describe('computeParamSpace', () => {
  it('builds a ±10 % band around the base FINAL, snapped inward to the grid', () => {
    const base = final(BASE, 'width');
    const { ranges, errors } = computeParamSpace(BASE, ['width'], 10);
    expect(errors).toEqual([]);
    expect(ranges).toHaveLength(1);
    const r = ranges[0];
    expect(r).toMatchObject({
      key: 'width',
      label: 'B Kammer',
      base,
      step: CHAMBER_GRID_MM,
      source: 'band',
    });
    expect(r.min).toBe(Math.ceil((base * 0.9) / 50) * 50);
    expect(r.max).toBe(Math.floor((base * 1.1) / 50) * 50);
    expect(r.min % 50).toBe(0);
    expect(r.max % 50).toBe(0);
    expect(r.min).toBeGreaterThanOrEqual(base * 0.9);
    expect(r.max).toBeLessThanOrEqual(base * 1.1);
  });

  it('intersects with a tighter table Min / Max (source table)', () => {
    const input: ChamberInput = { ...BASE, constraints: { width: { max: 4500 } } };
    const { ranges } = computeParamSpace(input, ['width'], 10);
    expect(ranges[0].source).toBe('table');
    expect(ranges[0].max).toBe(4500);
  });

  it('refuses an empty intersection with a readable message', () => {
    // Base width 4450 (±10 % = 4005..4895) but the table forces 4460..4480.
    const input: ChamberInput = { ...BASE, constraints: { width: { min: 4460, max: 4480 } } };
    const { ranges, errors } = computeParamSpace(input, ['width'], 10);
    expect(ranges).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/B Kammer: no value on the 50 mm grid/);
  });

  it('applies a per-parameter band override and keeps the table order', () => {
    const { ranges } = computeParamSpace(BASE, ['hMiddle', 'width'], 10, { width: 20 });
    expect(ranges.map((r) => r.key)).toEqual(['width', 'hMiddle']);
    expect(ranges[0].bandPct).toBe(20);
    expect(ranges[1].bandPct).toBe(10);
  });

  it('refuses the permanent BF1 / BF2 rows', () => {
    expect(studyPickableKeys(BASE)).not.toContain('chamferWidth1');
    const { errors } = computeParamSpace(BASE, ['chamferWidth1'], 10);
    expect(errors[0]).toMatch(/BF1/);
  });
});

describe('chamberInputWithExact', () => {
  it('pins the given keys as Exact and keeps the other constraints', () => {
    const input: ChamberInput = {
      ...BASE,
      constraints: { hLast: { min: 100 }, width: { max: 5000 } },
    };
    const out = chamberInputWithExact(input, { width: 4200 });
    expect(out.constraints).toEqual({ hLast: { min: 100 }, width: { exact: 4200 } });
    expect(final(out, 'width')).toBe(4200);
    // The base is not mutated.
    expect(input.constraints?.width).toEqual({ max: 5000 });
  });
});

describe('studyRelationWarnings', () => {
  it('warns when a driven output and its partner are both picked', () => {
    const warnings = studyRelationWarnings(BASE, ['height', 'hLast']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/H Kammer/);
    expect(warnings[0]).toMatch(/LEOW/);
    expect(studyRelationWarnings(BASE, ['width', 'hMiddle'])).toEqual([]);
    // Relation switched off in the base design: no warning.
    expect(studyRelationWarnings({ ...BASE, relationsMaster: false }, ['height', 'hLast'])).toEqual(
      [],
    );
  });
});

describe('objectives', () => {
  it('normalises the weighted sum by the baseline', () => {
    const baseline = { headLoss: 2, vortex: 0.5 };
    expect(weightedObjective(baseline, baseline, { headLoss: 0.5, vortex: 0.5 })).toBeCloseTo(1);
    expect(
      weightedObjective({ headLoss: 1, vortex: 0.5 }, baseline, { headLoss: 0.5, vortex: 0.5 }),
    ).toBeCloseTo(0.75);
    expect(
      weightedObjective({ headLoss: 1, vortex: 1 }, baseline, { headLoss: 1, vortex: 0 }),
    ).toBeCloseTo(0.5);
  });

  it('keeps the non-dominated points', () => {
    const front = paretoFront([
      { id: 0, headLoss: 2, vortex: 2 },
      { id: 1, headLoss: 1, vortex: 3 },
      { id: 2, headLoss: 3, vortex: 1 },
      { id: 3, headLoss: 2.5, vortex: 2.5 },
    ]);
    expect(front).toEqual([0, 1, 2]);
  });
});
