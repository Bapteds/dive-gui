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
  it('evaluates the twelve base X1–X3 fits when the master switch is off', () => {
    const outputs = computeChamberOutputs({ ...BASE, relationsMaster: false });
    expect(outputs).toHaveLength(12);
    const m = byKey(outputs);

    // Linear: width = 3501.480486 - 0.01990289598*X1 - 104.4968392*X2 + 224.0149301*X3.
    expect(m.get('width')!.model).toBeCloseTo(4444.44, 1);
    // Linear: dLast own fit (relation off).
    expect(m.get('dLast')!.model).toBeCloseTo(2439.31, 1);
    // LEB falls back to its own POWER fit; height to its own LINEAR fit.
    expect(m.get('hMiddlePlusFirst')!.form).toBe('power');
    expect(m.get('height')!.form).toBe('linear');

    // With relations and constraints off, FINAL equals the model and every output
    // reads "within range".
    for (const o of outputs) {
      expect(o.final).toBe(o.model);
      expect(o.status).toBe('within range');
    }
  });

  it('applies every structural relation by default (all on)', () => {
    const m = byKey(computeChamberOutputs(BASE));
    // Height = LEB + LEOW, LEB = 2 x HLE.
    expect(m.get('hMiddlePlusFirst')!.final).toBeCloseTo(2 * m.get('hMiddle')!.final, 6);
    expect(m.get('height')!.final).toBeCloseTo(
      m.get('hMiddlePlusFirst')!.final + m.get('hLast')!.final,
      6,
    );
    // Chamfer chain: BF1 = LF1, LF2 = LF1, BF2 = LF2, LT = LF1 + LF2.
    expect(m.get('chamferWidth1')!.final).toBeCloseTo(m.get('chamferLength1')!.final, 6);
    expect(m.get('chamferLength2')!.final).toBeCloseTo(m.get('chamferLength1')!.final, 6);
    expect(m.get('chamferWidth2')!.final).toBeCloseTo(m.get('chamferLength2')!.final, 6);
    expect(m.get('distFromEnd')!.final).toBeCloseTo(
      m.get('chamferLength1')!.final + m.get('chamferLength2')!.final,
      6,
    );
    // LE = 255.16 + 3.4954 x HLE.
    expect(m.get('dLast')!.final).toBeCloseTo(255.16 + 3.4954 * m.get('hMiddle')!.final, 6);
    // A relation-sourced value carries 'from relation' + its label.
    expect(m.get('height')!.status).toBe('from relation');
    expect(m.get('height')!.relationLabel).toBe('= LEB + LEOW');
    expect(m.get('distFromEnd')!.relationLabel).toBe('= LF1 + LF2');
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
      computeChamberOutputs({ ...BASE, constraints: { chamferLength2: { exact: 1234, max: 10 } } }),
    );
    expect(m.get('chamferLength2')!.final).toBe(1234);
    expect(m.get('chamferLength2')!.status).toBe('set exact');
  });

  it('flags an inverted Min/Max range and leaves the model value', () => {
    const m = byKey(
      computeChamberOutputs({ ...BASE, constraints: { width: { min: 5000, max: 4000 } } }),
    );
    expect(m.get('width')!.status).toBe('! min>max');
    expect(m.get('width')!.final).toBe(m.get('width')!.model);
  });

  it('leaves every output unrefined when no partner Exact is set', () => {
    for (const o of computeChamberOutputs(BASE)) {
      expect(o.refined).toBe(false);
    }
  });

  it('refines width from a known Chamfer-1 side distance (its partner)', () => {
    // Known partner value = distFromSideChamfer1 Exact; width uses the sharper fit.
    const m = byKey(
      computeChamberOutputs({ ...BASE, constraints: { distFromSideChamfer1: { exact: 2000 } } }),
    );
    expect(m.get('width')!.refined).toBe(true);
    expect(m.get('width')!.model).toBeCloseTo(4249.44, 1);
    // The partner itself is pinned to its Exact and is not "refined".
    expect(m.get('distFromSideChamfer1')!.final).toBe(2000);
    expect(m.get('distFromSideChamfer1')!.refined).toBe(false);
  });

  it('derives Height as the sum of middle+first and last cylinder height (P2 = P11 + P12)', () => {
    const m = byKey(computeChamberOutputs(BASE));
    const h = m.get('height')!;
    expect(h.status).toBe('from relation');
    expect(h.relationLabel).toBe('= LEB + LEOW');
    expect(h.final).toBeCloseTo(m.get('hMiddlePlusFirst')!.final + m.get('hLast')!.final, 6);
  });

  it('derives middle+first height as 2 x hMiddle (P11 = 2 x P10) and chains into Height', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { hMiddle: { exact: 500 } } }));
    expect(m.get('hMiddle')!.final).toBe(500);
    expect(m.get('hMiddlePlusFirst')!.final).toBeCloseTo(1000, 6); // 2 x 500
    expect(m.get('hMiddlePlusFirst')!.status).toBe('from relation');
    expect(m.get('hMiddlePlusFirst')!.relationLabel).toBe('= 2 × HLE');
    // Height = P11 + P12 picks up the change through the chain.
    expect(m.get('height')!.final).toBeCloseTo(1000 + m.get('hLast')!.final, 6);
  });

  it('recomputes Height when a component (hLast) is constrained', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { hLast: { exact: 1000 } } }));
    expect(m.get('hLast')!.final).toBe(1000);
    expect(m.get('height')!.final).toBeCloseTo(m.get('hMiddlePlusFirst')!.final + 1000, 6);
  });

  it('honors Height’s own Exact override (identity value is only the default)', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { height: { exact: 1234 } } }));
    // The MODEL stays the P11 + P12 sum, but the FINAL takes the exact override.
    expect(m.get('height')!.model).toBeCloseTo(
      m.get('hMiddlePlusFirst')!.final + m.get('hLast')!.final,
      6,
    );
    expect(m.get('height')!.final).toBe(1234);
    expect(m.get('height')!.status).toBe('set exact');
  });

  it('honors an Exact on the LEB identity and propagates it into Height', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { hMiddlePlusFirst: { exact: 1500 } } }));
    expect(m.get('hMiddlePlusFirst')!.final).toBe(1500);
    expect(m.get('hMiddlePlusFirst')!.status).toBe('set exact');
    // Height = LEB + LEOW reads LEB's overridden FINAL.
    expect(m.get('height')!.final).toBeCloseTo(1500 + m.get('hLast')!.final, 6);
  });

  it('clamps an identity output to its Max', () => {
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { height: { max: 100 } } }));
    expect(m.get('height')!.final).toBe(100);
    expect(m.get('height')!.status).toBe('capped at max');
  });

  it('opts out of refinement when the master relations switch is off', () => {
    const m = byKey(
      computeChamberOutputs({
        ...BASE,
        relationsMaster: false,
        constraints: { distFromSideChamfer1: { exact: 2000 } },
      }),
    );
    expect(m.get('width')!.refined).toBe(false);
    // Falls back to the pure X1/X2/X3 fit.
    expect(m.get('width')!.model).toBeCloseTo(4444.44, 1);
  });

  it('turns a single relation off via the per-relation map', () => {
    // Master on, but LT's own relation disabled -> LT uses its own X1–X3 fit while
    // the other relations (e.g. BF2 = LF2) stay on.
    const m = byKey(computeChamberOutputs({ ...BASE, relations: { distFromEnd: false } }));
    expect(m.get('distFromEnd')!.status).toBe('within range');
    expect(m.get('distFromEnd')!.model).toBeCloseTo(2829.85, 1);
    expect(m.get('chamferWidth2')!.status).toBe('from relation');
  });

  it('does not mark a combination output as refined for an unrelated Exact', () => {
    // dLast's relation is a combination (= f(HLE)), not a refine; an unrelated
    // width Exact must not mark it refined.
    const m = byKey(computeChamberOutputs({ ...BASE, constraints: { width: { exact: 4000 } } }));
    expect(m.get('dLast')!.refined).toBe(false);
    // With its own relation off it is the pure X1–X3 fit.
    const off = byKey(computeChamberOutputs({ ...BASE, relations: { dLast: false } }));
    expect(off.get('dLast')!.model).toBeCloseTo(2439.31, 1);
  });
});
