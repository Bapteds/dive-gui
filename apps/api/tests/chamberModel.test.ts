// Unit tests for the chamber empirical model (the single source of truth in
// @dive/shared). Verifies a few of the twelve fitted formulas (incl. the power
// form) at a known input, that P4/P5 share one formula, and that the Min / Max /
// Exact clamp + Status behave like the calculator.
import { describe, expect, it } from 'vitest';
import {
  CHAMBER_GRID_MM,
  computeChamberOutputs,
  nonPositiveChamberFinals,
  snapToChamberGrid,
  type ChamberOutput,
} from '@dive/shared';

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

    // With relations and constraints off, FINAL is the model snapped to the
    // 50 mm grid and every output reads "within range".
    for (const o of outputs) {
      expect(o.final).toBe(snapToChamberGrid(o.model));
      expect(o.final % CHAMBER_GRID_MM).toBe(0);
      expect(o.status).toBe('within range');
      expect(o.userDriven).toBe(false);
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
    // LE = 255.16 + 3.4954 x HLE is a fitted formula: its result re-snaps to the grid.
    expect(m.get('dLast')!.final).toBe(snapToChamberGrid(255.16 + 3.4954 * m.get('hMiddle')!.final));
    // A relation-sourced value carries 'from relation' + its label.
    expect(m.get('height')!.status).toBe('from relation');
    expect(m.get('height')!.relationLabel).toBe('= LEB + LEOW');
    expect(m.get('distFromEnd')!.relationLabel).toBe('= LF1 + LF2');
  });

  it('gives chamfer-1 length and width the same value (shared formula)', () => {
    // Relations off so BOTH models are the raw shared fit (with BF1's = LF1
    // relation on, its model reads LF1's grid-snapped FINAL instead).
    const m = byKey(computeChamberOutputs({ ...BASE, relationsMaster: false }));
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
    expect(m.get('width')!.final).toBe(snapToChamberGrid(m.get('width')!.model));
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

  // Empirical dimensions snap to the 50 mm manufacturing grid; user-entered
  // values — and true identities fed by one — pass through verbatim. LE's
  // = f(HLE) is a fitted formula, not an identity, so it ALWAYS re-snaps.
  describe('50 mm grid snapping', () => {
    it('puts every final on the grid for purely empirical inputs', () => {
      for (const relationsMaster of [true, false]) {
        for (const o of computeChamberOutputs({ ...BASE, relationsMaster })) {
          expect(o.final % CHAMBER_GRID_MM).toBe(0);
          expect(o.userDriven).toBe(false);
        }
      }
    });

    it('propagates an off-grid Exact LF1 verbatim through the chamfer identities', () => {
      const m = byKey(
        computeChamberOutputs({ ...BASE, constraints: { chamferLength1: { exact: 1012 } } }),
      );
      expect(m.get('chamferLength1')!.final).toBe(1012);
      expect(m.get('chamferLength1')!.userDriven).toBe(true);
      // BF1 = LF1, LF2 = LF1, BF2 = LF2, LT = LF1 + LF2 — all verbatim, off-grid.
      expect(m.get('chamferWidth1')!.final).toBe(1012);
      expect(m.get('chamferLength2')!.final).toBe(1012);
      expect(m.get('chamferWidth2')!.final).toBe(1012);
      expect(m.get('distFromEnd')!.final).toBe(2024);
      expect(m.get('distFromEnd')!.userDriven).toBe(true);
      expect(m.get('distFromEnd')!.status).toBe('from relation');
    });

    it('keeps LEB = 2 × HLE exact for a user HLE, but re-snaps LE = f(HLE)', () => {
      const m = byKey(computeChamberOutputs({ ...BASE, constraints: { hMiddle: { exact: 253 } } }));
      // Identity: verbatim (and H Kammer stays the exact sum).
      expect(m.get('hMiddlePlusFirst')!.final).toBe(506);
      expect(m.get('hMiddlePlusFirst')!.userDriven).toBe(true);
      expect(m.get('height')!.final).toBe(506 + m.get('hLast')!.final);
      // Fitted formula: snapped despite the user-defined HLE.
      expect(m.get('dLast')!.final).toBe(snapToChamberGrid(255.16 + 3.4954 * 253));
      expect(m.get('dLast')!.final % CHAMBER_GRID_MM).toBe(0);
      expect(m.get('dLast')!.userDriven).toBe(false);
    });

    it('treats a bitten Min as user-driven and propagates it unrounded', () => {
      const m = byKey(
        computeChamberOutputs({ ...BASE, constraints: { chamferLength1: { min: 2013 } } }),
      );
      expect(m.get('chamferLength1')!.final).toBe(2013);
      expect(m.get('chamferLength1')!.status).toBe('raised to min');
      expect(m.get('chamferLength1')!.userDriven).toBe(true);
      expect(m.get('chamferWidth1')!.final).toBe(2013);
      expect(m.get('distFromEnd')!.final).toBe(4026);
    });

    it('clamps against the snapped value, and an unbitten Max leaves the snap', () => {
      // Width base fit ≈ 4444.44 → snaps to 4450.
      const capped = byKey(computeChamberOutputs({ ...BASE, constraints: { width: { max: 4430 } } }));
      expect(capped.get('width')!.final).toBe(4430);
      expect(capped.get('width')!.status).toBe('capped at max');
      const free = byKey(computeChamberOutputs({ ...BASE, constraints: { width: { max: 4460 } } }));
      expect(free.get('width')!.final).toBe(4450);
      expect(free.get('width')!.status).toBe('within range');
      expect(free.get('width')!.userDriven).toBe(false);
    });

    it('still snaps a width refined from a measured B1 (a fit, not an identity)', () => {
      const m = byKey(
        computeChamberOutputs({ ...BASE, constraints: { distFromSideChamfer1: { exact: 2000 } } }),
      );
      expect(m.get('width')!.refined).toBe(true);
      expect(m.get('width')!.final).toBe(snapToChamberGrid(m.get('width')!.model));
      expect(m.get('width')!.userDriven).toBe(false);
    });
  });

  // The fits CAN go non-positive on legal inputs — the API refuses such builds
  // and the table flags them; noEffect outputs (a disconnected LEOW) never block.
  describe('nonPositiveChamberFinals', () => {
    it('flags the negative H Kammer the fits produce at a legal input corner', () => {
      const outputs = computeChamberOutputs({ x1: 700, x2: 1.8, x3: 23, relationsMaster: false });
      expect(outputs.find((o) => o.key === 'height')!.final).toBeLessThan(0);
      expect(nonPositiveChamberFinals(outputs).map((o) => o.key)).toContain('height');
    });

    it('excludes a non-positive LEOW the build never reads (noEffect)', () => {
      const outputs = computeChamberOutputs({
        ...BASE,
        relationsMaster: false,
        constraints: { hLast: { exact: -5 } },
      });
      expect(outputs.find((o) => o.key === 'hLast')!.noEffect).toBe(true);
      expect(nonPositiveChamberFinals(outputs)).toEqual([]);
    });

    it('flags nothing for the mid-range default inputs', () => {
      expect(nonPositiveChamberFinals(computeChamberOutputs(BASE))).toEqual([]);
    });
  });

  // LEOW (hLast) is never consumed by the builder directly (the stepped last
  // cylinder is pinned through the box top; hollow ignores it) — its ONLY lever
  // on the build is the H Kammer = LEB + LEOW relation. The model flags it
  // `noEffect` whenever that lever is disconnected so the UI can say so.
  describe('LEOW (hLast) noEffect flag', () => {
    it('is unflagged while the H Kammer relation is on and unpinned (LEOW drives H)', () => {
      const m = byKey(computeChamberOutputs(BASE));
      expect(m.get('hLast')!.noEffect).toBeFalsy();
    });

    it('flags LEOW when H Kammer is set Exact (H no longer reads LEOW)', () => {
      const m = byKey(computeChamberOutputs({ ...BASE, constraints: { height: { exact: 4200 } } }));
      expect(m.get('hLast')!.noEffect).toBe(true);
      expect(m.get('height')!.status).toBe('set exact');
    });

    it('flags LEOW when the H = LEB + LEOW relation is toggled off', () => {
      const m = byKey(computeChamberOutputs({ ...BASE, relations: { height: false } }));
      expect(m.get('hLast')!.noEffect).toBe(true);
    });

    it('flags LEOW when the relations master switch is off', () => {
      const m = byKey(computeChamberOutputs({ ...BASE, relationsMaster: false }));
      expect(m.get('hLast')!.noEffect).toBe(true);
    });

    it('keeps LEOW effective under a mere Min/Max on H Kammer (not a hard pin)', () => {
      const m = byKey(computeChamberOutputs({ ...BASE, constraints: { height: { max: 9000 } } }));
      expect(m.get('hLast')!.noEffect).toBeFalsy();
    });

    it('never flags any other output', () => {
      const m = byKey(
        computeChamberOutputs({ ...BASE, constraints: { height: { exact: 4200 } } }),
      );
      for (const [key, output] of m) {
        if (key !== 'hLast') expect(output.noEffect).toBeFalsy();
      }
    });
  });
});
