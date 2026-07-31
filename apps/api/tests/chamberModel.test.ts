// Unit tests for the chamber empirical model (the single source of truth in
// @dive/shared). Verifies a few of the twelve fitted formulas (incl. the power
// form) at a known input, that P4/P5 share one formula, and that the Min / Max /
// Exact clamp + Status behave like the calculator.
import { describe, expect, it } from 'vitest';
import { computeChamberOutputs, type ChamberOutput } from '@dive/shared';

const BASE = { x1: 1450, x2: 7.85, x3: 8, length: 14000 };

function byKey(outputs: ChamberOutput[]) {
  return new Map(outputs.map((o) => [o.key, o]));
}

describe('computeChamberOutputs', () => {
  it('evaluates the twelve outputs (linear + power) at a known input', () => {
    const outputs = computeChamberOutputs(BASE);
    expect(outputs).toHaveLength(12);
    const m = byKey(outputs);

    // Linear: width = 3501.480486 - 0.01990289598*X1 - 104.4968392*X2 + 224.0149301*X3.
    expect(m.get('width')!.model).toBeCloseTo(4444.44, 1);
    // Linear: dLast (highest-confidence output).
    expect(m.get('dLast')!.model).toBeCloseTo(2439.31, 1);
    // Power: hMiddlePlusFirst = 2.38913334e-8 * X1^3.632 * X2^0.648 * X3^-1.281.
    expect(m.get('hMiddlePlusFirst')!.model).toBeCloseTo(1919.5, 0);

    // With no constraints, FINAL equals the model value and status is within range.
    for (const o of outputs) {
      expect(o.final).toBe(o.model);
      expect(o.status).toBe('within range');
    }
  });

  it('gives chamfer-1 length and width the same value (shared formula)', () => {
    const m = byKey(computeChamberOutputs(BASE));
    expect(m.get('chamferLength1')!.model).toBe(m.get('chamferWidth1')!.model);
  });

  it('caps a value above its Max', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { width: { max: 4000 } } }));
    expect(m.get('width')!.final).toBe(4000);
    expect(m.get('width')!.status).toBe('capped at max');
  });

  it('raises a value below its Min', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { dLast: { min: 3000 } } }));
    expect(m.get('dLast')!.final).toBe(3000);
    expect(m.get('dLast')!.status).toBe('raised to min');
  });

  it('pins a value to Exact regardless of Min/Max', () => {
    const m = byKey(
      computeChamberOutputs({ ...BASE, constraints: { height: { exact: 1234, max: 10 } } }),
    );
    expect(m.get('height')!.final).toBe(1234);
    expect(m.get('height')!.status).toBe('set exact');
  });

  it('flags an inverted Min/Max range and leaves the model value', () => {
    const m = byKey(
      computeChamberOutputs({ ...BASE, constraints: { width: { min: 5000, max: 4000 } } }),
    );
    expect(m.get('width')!.status).toBe('! min>max');
    expect(m.get('width')!.final).toBe(m.get('width')!.model);
  });
});
