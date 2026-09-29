// Unit tests for the chamber empirical model (the single source of truth in
// @dive/shared). Verifies a few of the twelve fitted formulas (incl. the power
// form) at a known input, that P4/P5 share one formula, and that the Min / Max /
// Exact clamp + Status behave like the calculator.
import { describe, expect, it } from 'vitest';
import {
  CHAMBER_GENERATOR_FRAME_DIAMETERS_MM,
  CHAMBER_SPIRAL_CLEARANCE_M,
  CHAMBER_SPIRAL_DERIVED_KEYS,
  CHAMBER_SPIRAL_FLOW_RANGE,
  CHAMBER_SPIRAL_PHI_START_DEG,
  applyChamberSpiralToOutputs,
  chamberSpiralBoxDims,
  chamberSpiralInputs,
  chamberSpiralModelInput,
  CHAMBER_GRID_MM,
  computeChamberGeneratorDims,
  blankGeneratorHeightRefusal,
  runnerCaseBelowLeRefusal,
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

describe('computeChamberGeneratorDims', () => {
  const GEN = { x1: 1450, x2: 7, x3: 10 };

  it('matches the workbook at X1=1450, X2=7, X3=10', () => {
    const g = computeChamberGeneratorDims(GEN);
    expect(g.x4Auto).toBeCloseTo(618.03, 2); // 0.9 * 9.81 * 7 * 10
    expect(g.x4Used).toBeCloseTo(618.03, 2);
    expect(g.frame).toBe(62);
    expect(g.lengthCode).toBe(100); // round5(99.7722)
    expect(g.auto.centralDiameter).toBe(1242);
    expect(g.auto.centralHeight).toBeCloseTo(1264.47, 2); // 71.258 + 0.45856*1242 + 6.2368*100
    expect(g.auto.domeHeight).toBeCloseTo(344.34, 2); // 79.609 + 0.21315*1242
    expect(g.resolved).toEqual(g.auto); // nothing overridden
  });

  it.each([
    ['X4 > 1560 -> 115', { x1: 1450, x2: 14.9, x3: 23 }, 115], // x4Auto ~ 3025.7
    ['X4 <= 175 and X1 <= 940 -> 26', { x1: 800, x2: 1.8, x3: 1 }, 26], // x4Auto ~ 15.9
    ['X4 <= 175 and X1 > 940 -> 46', { x1: 1450, x2: 1.8, x3: 1 }, 46],
    // The fn is pure (no range check): x1=650 exercises the 48 branch even
    // though the app's x1 floor (700) never reaches it.
    ['mid X4 and X1 <= 683 -> 48', { x1: 650, x2: 7, x3: 10 }, 48],
    ['mid X4 and X1 > 683 -> 62', { x1: 700, x2: 7, x3: 10 }, 62],
  ] as const)('picks the frame: %s', (_label, input, frame) => {
    const g = computeChamberGeneratorDims(input);
    expect(g.frame).toBe(frame);
    expect(g.auto.centralDiameter).toBe(CHAMBER_GENERATOR_FRAME_DIAMETERS_MM[frame]);
  });

  it('a manual x4 overrides the computed one and re-picks the frame', () => {
    const g = computeChamberGeneratorDims({ ...GEN, x4: 2000 });
    expect(g.x4Used).toBe(2000);
    expect(g.x4Auto).toBeCloseTo(618.03, 2); // still reported (the blank-field hint)
    expect(g.frame).toBe(115);
    expect(g.auto.centralDiameter).toBe(2225);
  });

  it('rounds the length code to the nearest 5 BEFORE clamping to 30..215', () => {
    // Raw L = 132.21 - 0.8294*62 - 0.0825*700 + 13.861*23 = 341.84 -> 340 -> 215.
    expect(computeChamberGeneratorDims({ x1: 700, x2: 1.8, x3: 23 }).lengthCode).toBe(215);
    // x4 2000 -> frame 115; raw L = 132.21 - 95.381 - 199.65 + 13.861 = -148.96 -> -150 -> 30.
    expect(computeChamberGeneratorDims({ x1: 2420, x2: 7, x3: 1, x4: 2000 }).lengthCode).toBe(30);
  });

  it('cascades an overridden diameter into the height/dome autos', () => {
    const g = computeChamberGeneratorDims({ ...GEN, centralDiameter: 1272 });
    expect(g.resolved.centralDiameter).toBe(1272);
    expect(g.auto.centralDiameter).toBe(1242); // hint = what a BLANK box would get
    expect(g.auto.centralHeight).toBeCloseTo(1278.23, 2); // 71.258 + 0.45856*1272 + 6.2368*100
    expect(g.auto.domeHeight).toBeCloseTo(350.74, 2); // 79.609 + 0.21315*1272
    expect(g.resolved.centralHeight).toBe(g.auto.centralHeight);
    expect(g.resolved.domeHeight).toBe(g.auto.domeHeight);
  });

  it('a height override wins verbatim and does NOT move the dome', () => {
    const g = computeChamberGeneratorDims({ ...GEN, centralHeight: 1500 });
    expect(g.resolved.centralHeight).toBe(1500);
    expect(g.auto.centralHeight).toBeCloseTo(1264.47, 2);
    expect(g.auto.domeHeight).toBeCloseTo(344.34, 2); // dome follows the Ø only
    expect(g.resolved.domeHeight).toBe(g.auto.domeHeight);
  });
});

describe('blankGeneratorHeightRefusal (blank generator height)', () => {
  // BASE finals: LEB 1200; Gen Dim v3 height ≈ 1077 + dome ≈ 344 at X1 1450 / X2 7.85 / X3 8.
  const H = (exact: number) => ({ constraints: { height: { exact } } });
  const refusal = (input: Parameters<typeof blankGeneratorHeightRefusal>[0]) =>
    blankGeneratorHeightRefusal(input, computeChamberOutputs(input));
  const SIMPLIFY = { variant: 'hollow' as const, simplifyGenerator: true };

  it('accepts an H Kammer that holds LEB + the Gen Dim generator + dome heights', () => {
    expect(refusal({ ...BASE })).toBeNull();
    expect(refusal({ ...BASE, ...H(2650) })).toBeNull(); // 1200 + 1077 + 344 = 2622
    expect(refusal({ ...BASE, ...H(2650), ...SIMPLIFY, hollowLength: 200 })).toBeNull();
  });

  it('refuses a lower H Kammer in Closed generator and names the fix', () => {
    // 2300 held the generator alone: the dome now counts too.
    const msg = refusal({ ...BASE, ...H(2300) });
    expect(msg).toContain('H Kammer (2300 mm) is too low for the generator');
    expect(msg).toContain(
      'LEB 1200 mm + generator 1077 mm + dome 344 mm (Gen Dim model minimum) = 2622 mm',
    );
    expect(msg).toContain('Increase H Kammer to at least 2650 mm');
    expect(msg).toContain('set Part scale to 0.87 or less');
  });

  it('refuses With cone + Simplify generator when the generator rises above the cone', () => {
    const msg = refusal({ ...BASE, ...H(1800), ...SIMPLIFY, hollowLength: 200 });
    expect(msg).toContain(
      'generator 1077 mm + dome 344 mm (Gen Dim model minimum, which rises above the 200 mm cone)',
    );
    expect(msg).toContain('= 2622 mm');
  });

  it('scales with Part scale', () => {
    expect(refusal({ ...BASE, ...H(2650), partScale: 1.1 })).toContain('at Part scale 1.1');
  });

  it('leaves a typed height, a taller cone and the domed design to the builder', () => {
    expect(refusal({ ...BASE, ...H(1800), centralHeight: 500 })).toBeNull();
    expect(refusal({ ...BASE, ...H(1800), ...SIMPLIFY, hollowLength: 200, centralHeight: 500 })).toBeNull();
    expect(refusal({ ...BASE, ...H(1800), ...SIMPLIFY, hollowLength: 1500 })).toBeNull();
    expect(refusal({ ...BASE, ...H(1800), variant: 'hollow', hollowLength: 200 })).toBeNull();
  });
});

describe('runnerCaseBelowLeRefusal (Runner case Ø below LE Ø with guide vanes)', () => {
  const LE = { constraints: { dLast: { exact: 1600 } } };
  const VANES = { guideVanes: true };
  const refusal = (input: Parameters<typeof runnerCaseBelowLeRefusal>[0]) =>
    runnerCaseBelowLeRefusal(input, computeChamberOutputs(input));

  it('refuses a typed Runner case Ø below LE Ø and names the three levers', () => {
    const msg = refusal({ ...BASE, ...LE, ...VANES, dFirst: 1450 });
    expect(msg).toBe(
      'With guide vanes the distributor sits inside the runner case: Runner case Ø (1450 mm) ' +
        'must be at least LE Ø (1600 mm). Increase Runner case Ø, clear it ' +
        '(auto ≈ 1835 mm), or turn Guide vanes off.',
    );
  });

  it('accepts a Runner case Ø within 5 mm below LE Ø (the builder snaps it flush)', () => {
    expect(refusal({ ...BASE, ...LE, ...VANES, dFirst: 1595 })).toBeNull();
    expect(refusal({ ...BASE, ...LE, ...VANES, dFirst: 1600 })).toBeNull();
    expect(refusal({ ...BASE, ...LE, ...VANES, dFirst: 1594 })).not.toBeNull();
  });

  it('compares on the scaled diameters (the builder tolerance is in real mm)', () => {
    // 4 mm below at scale 1 is snapped; at Part scale 2 it is 8 mm below.
    expect(refusal({ ...BASE, ...LE, ...VANES, dFirst: 1596 })).toBeNull();
    expect(refusal({ ...BASE, ...LE, ...VANES, dFirst: 1596, partScale: 2 })).not.toBeNull();
  });

  it('leaves the auto Runner case Ø and vane-less builds alone', () => {
    expect(refusal({ ...BASE, ...LE, ...VANES })).toBeNull();
    expect(refusal({ ...BASE, ...LE, dFirst: 1450 })).toBeNull();
    expect(refusal({ ...BASE, ...LE, guideVanes: false, dFirst: 1450 })).toBeNull();
  });
});

describe('semi-spiral casing helpers (spec 2026-09-29-semi-spiral-casing)', () => {
  // The stepped-spiral fixture vertices (metres, axis frame).
  const VERTICES = [
    { id: 'V0', x: -2.7, y: -2.13664 },
    { id: 'V1', x: -2.7, y: 0.75 },
    { id: 'V2', x: -1.3, y: 2.2 },
    { id: 'V3', x: 0.55, y: 2.2 },
    { id: 'V4', x: 1.7, y: 1.0 },
    { id: 'V5', x: 1.7, y: 0.15 },
    { id: 'V6', x: 1.492759, y: -0.54332 },
    { id: 'V7', x: 1.492759, y: -0.99332 },
    { id: 'V8', x: 1.7, y: -1.68664 },
    { id: 'V9', x: 1.7, y: -2.13664 },
  ];

  it('ships the fixed rules and the flow velocity range', () => {
    expect(CHAMBER_SPIRAL_FLOW_RANGE).toEqual({ min: 0.3, max: 3, default: 0.922 });
    expect(CHAMBER_SPIRAL_CLEARANCE_M).toBe(0.2);
    expect(CHAMBER_SPIRAL_PHI_START_DEG).toBe(160);
    expect([...CHAMBER_SPIRAL_DERIVED_KEYS]).toEqual([
      'distFromSideChamfer1',
      'chamferLength1',
      'chamferWidth1',
      'chamferLength2',
      'chamferWidth2',
      'distFromEnd',
    ]);
  });

  it('derives the doubly chamfered box from the spiral vertices (spec section 3)', () => {
    const box = chamberSpiralBoxDims(VERTICES);
    expect(box.width).toBeCloseTo(4.4, 9); // x4 - x_in
    expect(box.length).toBeCloseTo(2.2 + 2.13664, 9); // y_top - foot_y
    expect(box.distFromSideChamfer1).toBeCloseTo(1.7, 9); // x4
    expect(box.distFromEnd).toBeCloseTo(2.2, 9); // y_top
    expect(box.chamferLength1).toBeCloseTo(1.2, 9); // y_top - y4
    expect(box.chamferWidth1).toBeCloseTo(1.15, 9); // x4 - x3
    expect(box.chamferLength2).toBeCloseTo(1.45, 9); // y_top - y1
    expect(box.chamferWidth2).toBeCloseTo(1.4, 9); // x2 - x_in
  });

  it('maps the chamber to the tool inputs in metres (spec section 4)', () => {
    const input = { ...BASE, semiSpiral: true, spiralFlowVelocity: 0.8, partScale: 1.1 };
    const outputs = computeChamberOutputs(input);
    const f = (k: string) => outputs.find((o) => o.key === k)!.final;
    const inputs = chamberSpiralInputs(input, outputs);
    // widest part = the auto runner case (1.14703 x LE), scaled; 200 mm unscaled gap
    expect(inputs.D_LE).toBeCloseTo((1.14703 * f('dLast') * 1.1) / 1000, 12);
    expect(inputs).toMatchObject({
      Q: 8,
      c_flow: 0.8,
      clearance: 0.2,
      phi_start: 160,
    });
    expect(inputs.H_ch).toBeCloseTo(f('height') / 1000, 12);
    expect(inputs.max_width).toBeCloseTo(f('width') / 1000, 12);
    // a typed Guide vanes Ø wider than the runner case becomes the widest part
    const wide = chamberSpiralInputs({ ...input, dMiddle: 5000 }, outputs);
    expect(wide.D_LE).toBeCloseTo(5.5, 12);
    // the default velocity
    expect(chamberSpiralInputs({ ...BASE, semiSpiral: true }, outputs).c_flow).toBe(0.922);
  });

  it('ignores constraints left on the derived rows while the spiral is on', () => {
    // A B1 Exact refines B Kammer (the spiral's width limit): not while B1 is derived.
    const input = {
      ...BASE,
      constraints: { distFromSideChamfer1: { exact: 1234 }, width: { max: 9000 } },
    };
    const on = chamberSpiralModelInput({ ...input, semiSpiral: true });
    expect(on.constraints).toEqual({ width: { max: 9000 } });
    const off = { ...input, semiSpiral: false };
    expect(chamberSpiralModelInput(off)).toBe(off);
    const f = (i: typeof input) => byKey(computeChamberOutputs(i)).get('width')!.final;
    expect(f(on)).toBe(f({ ...BASE, constraints: { width: { max: 9000 } } }));
    expect(f(input)).not.toBe(f(on));
  });

  it('marks the derived rows "from spiral" with the derived value, or none before Generate', () => {
    const outputs = computeChamberOutputs({
      ...BASE,
      constraints: { chamferLength1: { min: 900, max: 100 } },
    });
    const box = chamberSpiralBoxDims(VERTICES);
    const boxMm = Object.fromEntries(
      Object.entries(box).map(([k, v]) => [k, v * 1000]),
    ) as typeof box;
    const filled = byKey(applyChamberSpiralToOutputs(outputs, boxMm));
    for (const key of CHAMBER_SPIRAL_DERIVED_KEYS) {
      expect(filled.get(key)!.status).toBe('from spiral');
      expect(filled.get(key)!.final).toBeCloseTo(boxMm[key], 9);
    }
    // an inverted range on a derived row no longer counts
    expect(filled.get('chamferLength1')!.status).toBe('from spiral');
    // other rows untouched (B Kammer stays the width limit)
    expect(filled.get('width')).toEqual(byKey(outputs).get('width'));
    const blank = byKey(applyChamberSpiralToOutputs(outputs, null));
    expect(Number.isNaN(blank.get('distFromEnd')!.final)).toBe(true);
    expect(nonPositiveChamberFinals([...blank.values()])).toEqual([]);
  });
});
