# Empirical Generator Dimensions (Gen Dim v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blank hollow-variant generator boxes (Generator Ø / Generator height / Dome height) get values from the empirical Gen Dim v3 model (X1–X3 + optional new X4 input) instead of the fixed `0.75·X1 / 1.33·Ø / 0.2·h` ratios; a filled box wins verbatim, and a typed Ø re-bases the blank height/dome autos.

**Architecture:** One pure function `computeChamberGeneratorDims` in `packages/shared` (the chamber model's home) returns `auto` (hint) and `resolved` (build) values; the API's hollow-branch resolution and the web's placeholder hints both call it. The Python builder is untouched — it keeps receiving resolved metres, and the cache key (a hash over resolved params) self-invalidates.

**Tech Stack:** TypeScript monorepo — `packages/shared` (model), Fastify + zod (`apps/api`), React + react-hook-form + zod (`apps/web`), vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-09-02-generator-dimensions-design.md` (approved). Source workbook: `documents/Gen Dim v3 Only Calculator (standalone).xlsx`.

## Global Constraints

- **Toolchain is WSL-only** for npm/node/vitest/tsc. Every build/test command below is a `wsl bash -lc '...'` call run from Windows. WSL prints harmless `Failed to translate 'H:\bin'` lines — ignore them.
- **Rebuild shared before anything consumes it:** after ANY `packages/shared` change, run `npm run build:shared` before API/web tests or typecheck.
- **Model coefficients — copy verbatim, never round:** X4 auto `0.9 * 9.81 * X2 * X3`; frame rules `>1560→115 | ≤175→(X1≤940→26 else 46) | else→(X1≤683→48 else 62)`; length code `132.21 − 0.8294·R − 0.0825·X1 + 13.861·X3`, round to nearest 5 THEN clamp 30..215; height `71.258 + 0.45856·G1 + 6.2368·L`; dome `79.609 + 0.21315·G1`; catalog `{26:572, 36:745, 38:753, 45:976, 46:933, 48:986, 62:1242, 77:1545, 115:2225}`.
- **Commits:** message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; NO double quotes inside commit messages (PowerShell 5.1 mangles them — use the Bash tool / Git Bash for git). Push after every commit (house rule on `feat/chamber-ui-feedback`).
- **UI rules (CLAUDE.md):** no hardcoded colors/spacing — the new X4 field reuses the existing `Field`/`Input` primitives and introduces zero new styles.
- **French changelog:** one note at the bottom of `PLAN.md` when the feature lands (Task 4).
- Do NOT edit `apps/api/scripts/buildChamber.py` — no builder change in this feature.

## File map

| File | Change |
|---|---|
| `packages/shared/src/index.ts` | + `CHAMBER_GENERATOR_FRAME_DIAMETERS_MM`, `CHAMBER_X4_MAX`, `ChamberGeneratorDims`, `computeChamberGeneratorDims`, `ChamberInput.x4`; (Task 4) − three ratio constants |
| `apps/api/tests/chamberModel.test.ts` | + describe block for the new function |
| `apps/api/src/modules/chamber/chamber.schemas.ts` | + `x4` in `chamberBuildSchema` |
| `apps/api/src/modules/chamber/chamber.service.ts` | hollow branch resolves via the shared function |
| `apps/api/tests/chamber.test.ts` | + x4 hash/validation tests, + shared-function parity test |
| `apps/web/src/features/chamber/chamberForm.ts` | + `x4` (type/schema/defaults/snapshot-load), + `ChamberAutoDims` moves here, + `computeChamberAutoDims` helper |
| `apps/web/src/features/chamber/chamberForm.test.ts` | + x4 schema tests, + helper tests (cascade) |
| `apps/web/src/features/chamber/ChamberInputsForm.tsx` | + X4 field in the hollow grid; `ChamberAutoDims` re-exported from chamberForm |
| `apps/web/src/features/chamber/ChamberInputsForm.test.tsx` | + X4 render/submit tests; AUTO_DIMS gains `x4` |
| `apps/web/src/pages/ChamberPage.tsx` | autoDims block → `computeChamberAutoDims`; + `x4` in FIELD_LABELS |
| `PLAN.md` | French changelog note (Task 4) |

---

### Task 1: Shared model — `computeChamberGeneratorDims`

**Files:**
- Modify: `packages/shared/src/index.ts` (constants near line 2404, new function + type after `ChamberInput`, `x4` field inside `ChamberInput` after `x3`)
- Test: `apps/api/tests/chamberModel.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 2–3 rely on these exact names):

```ts
export const CHAMBER_GENERATOR_FRAME_DIAMETERS_MM: Readonly<Record<number, number>>;
export const CHAMBER_X4_MAX = 100_000;
export interface ChamberGeneratorDims {
  x4Auto: number;
  x4Used: number;
  frame: number;
  lengthCode: number;
  auto: { centralDiameter: number; centralHeight: number; domeHeight: number };
  resolved: { centralDiameter: number; centralHeight: number; domeHeight: number };
}
export function computeChamberGeneratorDims(input: {
  x1: number; x2: number; x3: number; x4?: number;
  centralDiameter?: number; centralHeight?: number; domeHeight?: number;
}): ChamberGeneratorDims;
// ChamberInput gains: x4?: number
```

The three old ratio constants are NOT deleted here (the API/web still import them until Tasks 2–3); Task 4 removes them.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/chamberModel.test.ts` (add `CHAMBER_GENERATOR_FRAME_DIAMETERS_MM, computeChamberGeneratorDims` to the existing `@dive/shared` import):

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npx vitest run tests/chamberModel.test.ts'
```

Expected: FAIL — `@dive/shared` has no export `computeChamberGeneratorDims`.

- [ ] **Step 3: Implement in `packages/shared/src/index.ts`**

(a) After the `CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT` constant (near line 2419), add:

```ts
// ---------------------------------------------------------------------------
// Generator dimensions (Gen Dim v3): the hollow variant's central cylinder +
// dome, fitted on historical builds (source: documents/Gen Dim v3 Only
// Calculator (standalone).xlsx). Chain: X1,X2,X3 -> X4 -> frame R (range
// rules) ; R,X1,X3 -> length code L ; R -> Ø (catalog) ; Ø,L -> height ;
// Ø -> dome. All LOO cross-validated: R rules ~70-77% correct, L typically
// within 1-2 catalog steps, height R² 0.93, dome R² 0.71.
// ---------------------------------------------------------------------------

/**
 * Catalog generator diameter (mm) per frame code — exactly one Ø per frame.
 * Only 26/46/48/62/115 are reachable through the range rules; the rare frames
 * (36/38/45/77) are listed for completeness. (R=62 also shipped with 1272 and
 * R=48 with 1026 historically — typing that Ø re-bases height/dome the same.)
 */
export const CHAMBER_GENERATOR_FRAME_DIAMETERS_MM: Readonly<Record<number, number>> = {
  26: 572,
  36: 745,
  38: 753,
  45: 976,
  46: 933,
  48: 986,
  62: 1242,
  77: 1545,
  115: 2225,
};

/** Validation ceiling for a manual X4 (auto X4 tops out ≈ 3 026 on legal X2/X3;
 * anything above 1 560 already maps to the largest frame). */
export const CHAMBER_X4_MAX = 100_000;

/** The Gen Dim v3 evaluation: hint values (`auto`) and build values (`resolved`). */
export interface ChamberGeneratorDims {
  /** 0.9 · 9.81 · X2 · X3 — the blank-X4-field hint. */
  x4Auto: number;
  /** The manual x4 when given, else x4Auto — what the frame rules consumed. */
  x4Used: number;
  /** Suggested frame code (26/46/48/62/115 via the range rules). */
  frame: number;
  /** Catalog length code L (rounded to 5, clamped 30..215). */
  lengthCode: number;
  /**
   * What a BLANK box would get, given the OTHER boxes' current state: the
   * height/dome autos use the RESOLVED Ø (a typed Ø cascades), while the Ø
   * auto is always the catalog value. These are the web form's hints.
   */
  auto: { centralDiameter: number; centralHeight: number; domeHeight: number };
  /** override ?? auto — the values the build consumes (mm). */
  resolved: { centralDiameter: number; centralHeight: number; domeHeight: number };
}

/**
 * Evaluate the Gen Dim v3 empirical generator model (hollow variant). Pure and
 * range-agnostic: callers validate x1/x2/x3 themselves. A typed centralDiameter
 * re-bases the height/dome autos (its cascade); a typed centralHeight does NOT
 * move the dome (the dome follows the Ø only); x4 steers the frame suggestion.
 */
export function computeChamberGeneratorDims(input: {
  x1: number;
  x2: number;
  x3: number;
  x4?: number;
  centralDiameter?: number;
  centralHeight?: number;
  domeHeight?: number;
}): ChamberGeneratorDims {
  const { x1, x3 } = input;
  const x4Auto = 0.9 * 9.81 * input.x2 * input.x3;
  const x4Used = input.x4 ?? x4Auto;
  const frame =
    x4Used > 1560 ? 115 : x4Used <= 175 ? (x1 <= 940 ? 26 : 46) : x1 <= 683 ? 48 : 62;
  // Round to the catalog step of 5 FIRST, then clamp to the catalog span.
  const lengthCode = Math.max(
    30,
    Math.min(215, Math.round((132.21 - 0.8294 * frame - 0.0825 * x1 + 13.861 * x3) / 5) * 5),
  );
  const centralDiameterAuto = CHAMBER_GENERATOR_FRAME_DIAMETERS_MM[frame];
  const centralDiameter = input.centralDiameter ?? centralDiameterAuto;
  const centralHeightAuto = 71.258 + 0.45856 * centralDiameter + 6.2368 * lengthCode;
  const centralHeight = input.centralHeight ?? centralHeightAuto;
  const domeHeightAuto = 79.609 + 0.21315 * centralDiameter;
  const domeHeight = input.domeHeight ?? domeHeightAuto;
  return {
    x4Auto,
    x4Used,
    frame,
    lengthCode,
    auto: {
      centralDiameter: centralDiameterAuto,
      centralHeight: centralHeightAuto,
      domeHeight: domeHeightAuto,
    },
    resolved: { centralDiameter, centralHeight, domeHeight },
  };
}
```

(b) Inside `ChamberInput`, directly after the `x3: number;` line, add:

```ts
  /**
   * Optional X4 (≈ power) steering the Gen Dim generator model. Omitted =>
   * 0.9 · 9.81 · X2 · X3. Feeds the frame suggestion behind the auto generator
   * Ø / height / dome; a typed dimension still wins verbatim. Hollow variant
   * only (accepted but unused otherwise — it never reaches the builder, so it
   * cannot change a cache key by itself). Geometry-only.
   */
  x4?: number;
```

- [ ] **Step 4: Rebuild shared, run the tests**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared'
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npx vitest run tests/chamberModel.test.ts'
```

Expected: PASS (existing describe blocks untouched + the new one green).

- [ ] **Step 5: Commit and push**

```bash
git add packages/shared/src/index.ts apps/api/tests/chamberModel.test.ts
git commit -m "feat(chamber): shared Gen Dim v3 generator-dimensions model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 2: API — `x4` input + hollow resolution via the shared model

**Files:**
- Modify: `apps/api/src/modules/chamber/chamber.schemas.ts` (imports + one field after `partScale`, near line 70)
- Modify: `apps/api/src/modules/chamber/chamber.service.ts` (imports near line 16; hollow branch near lines 201–217)
- Test: `apps/api/tests/chamber.test.ts` (append inside `describe('Chamber Creation')`, after the test at ~line 717)

**Interfaces:**
- Consumes: `computeChamberGeneratorDims`, `CHAMBER_X4_MAX` from `@dive/shared` (Task 1).
- Produces: `POST /chamber/build` accepts optional `x4` (0 < x4 ≤ 100 000; 422 otherwise). Saves need no change (`snapshot` revalidates against this schema).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/chamber.test.ts` (add `computeChamberGeneratorDims` to an import from `'@dive/shared'` — the file has none yet, so add `import { computeChamberGeneratorDims } from '@dive/shared';` under the existing imports):

```ts
  it('keys the hollow build on x4 (a new frame) but ignores x4 on stepped', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    // BUILD's auto X4 ~ 554 -> frame 62; x4 2000 -> frame 115 -> new generator dims.
    const powered = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...hollow, x4: 2000 })
      .expect(200);
    expect(powered.body.hash).not.toBe(auto.body.hash);
    expect(powered.body.outputs).toEqual(auto.body.outputs);

    // Stepped builds have no generator: x4 must not enter the cache key.
    const stepped = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(BUILD)
      .expect(200);
    const steppedX4 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, x4: 2000 })
      .expect(200);
    expect(steppedX4.body.hash).toBe(stepped.body.hash);
  });

  it('resolves blank generator dims from the shared Gen Dim model', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());
    const hollow = { ...BUILD, variant: 'hollow', hollowLength: 2000 };

    const auto = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send(hollow)
      .expect(200);
    // Sending the model's own resolved values EXPLICITLY must land on the same
    // cache key — proof the API resolves blanks through the shared function.
    const gen = computeChamberGeneratorDims({ x1: BUILD.x1, x2: BUILD.x2, x3: BUILD.x3 });
    const explicit = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({
        ...hollow,
        centralDiameter: gen.resolved.centralDiameter,
        centralHeight: gen.resolved.centralHeight,
        domeHeight: gen.resolved.domeHeight,
      })
      .expect(200);
    expect(explicit.body.hash).toBe(auto.body.hash);
  });

  it.each([0, -5, 100_001])('rejects x4 = %s', async (x4) => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, variant: 'hollow', hollowLength: 2000, x4 })
      .expect(422);
  });
```

- [ ] **Step 2: Run to verify failure**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npx vitest run tests/chamber.test.ts'
```

Expected: the three new tests FAIL (`x4` is stripped by the schema today, so hashes match in test 1 and nothing rejects in test 3; test 2 fails because the API still resolves `0.75·X1` ratios).

- [ ] **Step 3: Implement**

(a) `chamber.schemas.ts` — add `CHAMBER_X4_MAX` to the `@dive/shared` import list, then after the `partScale` field (line ~69) add:

```ts
    // Optional X4 (≈ power) steering the hollow generator model (Gen Dim v3).
    // Omitted => 0.9 · 9.81 · X2 · X3. Hollow-only consumer; never forwarded to
    // the builder, so it cannot change a cache key by itself.
    x4: z.number().finite().positive().max(CHAMBER_X4_MAX).optional(),
```

(b) `chamber.service.ts` — in the `@dive/shared` import block, REMOVE `CHAMBER_CENTRAL_DIAMETER_OVER_X1`, `CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER`, `CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT` and ADD `computeChamberGeneratorDims`. Replace the hollow branch (lines 201–217) with:

```ts
  if (variant === 'hollow') {
    const wallMm = input.wallThickness ?? CHAMBER_WALL_THICKNESS_MM;
    // Generator (central cylinder) + dome dims from the empirical Gen Dim v3
    // model (X4 -> frame -> catalog Ø; Ø+L -> height; Ø -> dome). A manual
    // override wins verbatim, and an overridden Ø re-bases the height/dome
    // autos (the model's cascade). Only the RESOLVED mm values go to the
    // builder params (hence into the cache key) — x4 itself never does.
    const gen = computeChamberGeneratorDims({
      x1: input.x1,
      x2: input.x2,
      x3: input.x3,
      x4: input.x4,
      centralDiameter: input.centralDiameter,
      centralHeight: input.centralHeight,
      domeHeight: input.domeHeight,
    });
    params.wallThickness = wallMm * MM_TO_M;
    params.hollowLength = (input.hollowLength ?? 0) * MM_TO_M;
    params.centralDiameter = gen.resolved.centralDiameter * MM_TO_M;
    params.centralHeight = gen.resolved.centralHeight * MM_TO_M;
    params.domeHeight = gen.resolved.domeHeight * MM_TO_M;
  }
```

- [ ] **Step 4: Run the API chamber suites**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts tests/chamberSaves.test.ts'
```

Expected: ALL PASS (including the pre-existing hollow-override key test at ~line 698).

- [ ] **Step 5: Commit and push**

```bash
git add apps/api/src/modules/chamber/chamber.schemas.ts apps/api/src/modules/chamber/chamber.service.ts apps/api/tests/chamber.test.ts
git commit -m "feat(chamber): resolve hollow generator dims via Gen Dim v3 + optional x4 input

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Web — X4 field, model-driven hints, cascade

**Files:**
- Modify: `apps/web/src/features/chamber/chamberForm.ts` (type + schema + defaults + snapshot-load + new `ChamberAutoDims` home + new helper)
- Modify: `apps/web/src/features/chamber/ChamberInputsForm.tsx` (X4 field; `ChamberAutoDims` re-export)
- Modify: `apps/web/src/pages/ChamberPage.tsx` (autoDims block, imports, FIELD_LABELS)
- Test: `apps/web/src/features/chamber/chamberForm.test.ts`, `apps/web/src/features/chamber/ChamberInputsForm.test.tsx`

**Interfaces:**
- Consumes: `computeChamberGeneratorDims`, `CHAMBER_X4_MAX` from `@dive/shared` (Task 1).
- Produces:

```ts
// chamberForm.ts
export interface ChamberFormValues { /* existing */; x4?: number }
export interface ChamberAutoDims {
  dFirst: number | null; dMiddle: number | null; x4: number | null;
  centralDiameter: number | null; centralHeight: number | null; domeHeight: number | null;
}
export function computeChamberAutoDims(
  values: Pick<ChamberFormValues, 'x1' | 'x2' | 'x3' | 'x4' | 'centralDiameter' | 'centralHeight' | 'domeHeight'>,
  dLastFinal: number | null,
): ChamberAutoDims;
// ChamberInputsForm.tsx keeps exporting the type: export type { ChamberAutoDims } from './chamberForm'
```

- [ ] **Step 1: Write the failing tests**

(a) Append to `apps/web/src/features/chamber/chamberForm.test.ts` — extend the existing imports with `computeChamberAutoDims` (from `./chamberForm`):

```ts
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
```

(b) In `apps/web/src/features/chamber/ChamberInputsForm.test.tsx`, add `x4: 618.03,` to the `AUTO_DIMS` literal (line ~18), and append:

```ts
  it('shows the X4 field with its formula hint in the hollow variant only', () => {
    const { rerender } = render(<Harness onValid={() => {}} />);
    expect(screen.queryByLabelText('X4')).not.toBeInTheDocument();

    rerender(<Harness onValid={() => {}} variant="hollow" defaults={{ variant: 'hollow' }} />);
    expect(screen.getByLabelText('X4')).toBeInTheDocument();
    expect(
      screen.getByText('Blank = auto ≈ 618 (0.9 · 9.81 · X2 · X3)'),
    ).toBeInTheDocument();
  });

  it('submits a typed X4 as a number and a blank X4 as undefined (auto)', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} variant="hollow" defaults={{ variant: 'hollow' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(1));
    expect((onValid.mock.calls[0][0] as ChamberFormValues).x4).toBeUndefined();

    fireEvent.change(screen.getByLabelText('X4'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate chamber' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledTimes(2));
    expect((onValid.mock.calls[1][0] as ChamberFormValues).x4).toBe(2000);
  });
```

- [ ] **Step 2: Run to verify failure**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/web && npx vitest run src/features/chamber'
```

Expected: FAIL — `computeChamberAutoDims` does not exist; `AUTO_DIMS` has an unknown `x4` property; the X4 field is missing.

- [ ] **Step 3: Implement**

(a) `chamberForm.ts`:
- Extend the `@dive/shared` value import with `CHAMBER_D_FIRST_OVER_LAST, CHAMBER_D_MIDDLE_OVER_LAST, CHAMBER_X4_MAX, computeChamberGeneratorDims`.
- In `ChamberFormValues`, place the new field with the other optional overrides, directly BEFORE `centralDiameter?`:

```ts
  /** X4 (≈ power) steering the generator model; blank => 0.9 · 9.81 · X2 · X3. Hollow only. */
  x4?: number;
```

- In `chamberFormSchema`, directly before `centralDiameter`:

```ts
    x4: z
      .number({ invalid_type_error: 'Enter a number' })
      .positive('Must be greater than 0')
      .max(CHAMBER_X4_MAX, `Max ${CHAMBER_X4_MAX.toLocaleString('en-US')}`)
      .optional(),
```

- In `CHAMBER_FORM_DEFAULTS`, before `centralDiameter: undefined,`: add `x4: undefined,`.
- In `chamberInputToFormValues`, before `centralDiameter: input.centralDiameter,`: add `x4: input.x4,`.
- Update the three generator-field doc comments in `ChamberFormValues` (they cite the old ratios):

```ts
  /** Generator (central cylinder) Ø (mm); blank => Gen Dim catalog Ø for the suggested frame. Hollow only. */
  centralDiameter?: number;
  /** Generator (central cylinder) height (mm); blank => Gen Dim fit from the resolved Ø + length code. Hollow only. */
  centralHeight?: number;
  /** Dome height (mm); blank => Gen Dim fit from the resolved Ø. Hollow variant only. */
  domeHeight?: number;
```

- At the end of the file, add the moved type + new helper:

```ts
/** The auto (empirical) values shown as placeholders on the blank override fields. */
export interface ChamberAutoDims {
  /** Runner case (first cylinder) Ø, mm. */
  dFirst: number | null;
  /** Guide vanes / middle cylinder Ø, mm. */
  dMiddle: number | null;
  /** X4 (≈ power): 0.9 · 9.81 · X2 · X3 (generator model steering input). */
  x4: number | null;
  /** Generator (central cylinder) Ø, mm (hollow variant). */
  centralDiameter: number | null;
  /** Generator (central cylinder) height, mm (hollow variant). */
  centralHeight: number | null;
  /** Dome height, mm (hollow variant). */
  domeHeight: number | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The "Blank = auto ≈ N" hints: the dLast-driven Ø ratios plus the Gen Dim v3
 * generator dims — computed WITH the current overrides, so a typed Generator Ø
 * re-bases the height/dome hints exactly like the API build will (the shared
 * function is the single source of truth for both).
 */
export function computeChamberAutoDims(
  values: Pick<
    ChamberFormValues,
    'x1' | 'x2' | 'x3' | 'x4' | 'centralDiameter' | 'centralHeight' | 'domeHeight'
  >,
  dLastFinal: number | null,
): ChamberAutoDims {
  const gen =
    finite(values.x1) && finite(values.x2) && finite(values.x3)
      ? computeChamberGeneratorDims({
          x1: values.x1,
          x2: values.x2,
          x3: values.x3,
          x4: values.x4,
          centralDiameter: values.centralDiameter,
          centralHeight: values.centralHeight,
          domeHeight: values.domeHeight,
        })
      : null;
  return {
    dFirst: dLastFinal != null ? CHAMBER_D_FIRST_OVER_LAST * dLastFinal : null,
    dMiddle: dLastFinal != null ? CHAMBER_D_MIDDLE_OVER_LAST * dLastFinal : null,
    x4: gen?.x4Auto ?? null,
    centralDiameter: gen?.auto.centralDiameter ?? null,
    centralHeight: gen?.auto.centralHeight ?? null,
    domeHeight: gen?.auto.domeHeight ?? null,
  };
}
```

(b) `ChamberInputsForm.tsx`:
- DELETE the local `ChamberAutoDims` interface (lines 32–44) and replace with a re-export so `ChamberPage` and the test keep their import path:

```ts
import type { ChamberAutoDims, ChamberFormValues } from './chamberForm';
export type { ChamberAutoDims } from './chamberForm';
```

- In the hollow-variant grid, after the "Wall thickness (mm)" `Field` and BEFORE "Generator Ø (mm)", add:

```tsx
          <Field
            label="X4"
            error={errors.x4?.message}
            helperText={
              autoDims.x4 != null
                ? `Blank = auto ≈ ${Math.round(autoDims.x4)} (0.9 · 9.81 · X2 · X3)`
                : 'Blank = auto (0.9 · 9.81 · X2 · X3)'
            }
          >
            <Input
              type="number"
              step="any"
              placeholder="auto"
              {...register('x4', { setValueAs: numOrUndef })}
            />
          </Field>
```

- Update the component's header doc comment sentence about the hollow section to mention X4 steering the generator autos.

(c) `ChamberPage.tsx`:
- Imports: from `@dive/shared` keep only `computeChamberOutputs` (drop the five ratio constants); add `computeChamberAutoDims` to the `./chamberForm`-sourced import block (`@/features/chamber/chamberForm`).
- Replace the autoDims block (lines 97–112, including the `x1Value`/`centralDiameterAuto`/`centralHeightAuto` locals) with:

```ts
  // Auto (empirical) placeholders for the manual dimension overrides + X4 —
  // the same shared model the API resolves with, computed from the CURRENT
  // form values so typed upstream overrides cascade into the hints exactly
  // like the build (a typed Generator Ø re-bases the height/dome hints).
  const dLastFinal = outputs?.find((o) => o.key === 'dLast')?.final ?? null;
  const autoDims: ChamberAutoDims = computeChamberAutoDims(values, dLastFinal);
```

- In `FIELD_LABELS`, after `x3: 'X3',`: add `x4: 'X4',`.

Note on the spec's "staleness note fires on x4 change": the amber note compares `JSON.stringify({ ...values, constraints })` against the last-built body, and `x4` is a `ChamberFormValues` field, so it participates structurally — the submit test above (x4 lands in the submitted values) is the assertion; there is no page-level test harness and none is added.

- [ ] **Step 4: Run the web chamber suite**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/web && npx vitest run src/features/chamber'
```

Expected: ALL PASS.

- [ ] **Step 5: Commit and push**

```bash
git add apps/web/src/features/chamber/chamberForm.ts apps/web/src/features/chamber/chamberForm.test.ts apps/web/src/features/chamber/ChamberInputsForm.tsx apps/web/src/features/chamber/ChamberInputsForm.test.tsx apps/web/src/pages/ChamberPage.tsx
git commit -m "feat(chamber): X4 field + Gen Dim v3 generator hints with override cascade

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Delete the ratio constants, full verification, changelog

**Files:**
- Modify: `packages/shared/src/index.ts` (delete three constants near lines 2414–2419; fix the `CHAMBER_VARIANTS` doc comment near 2391–2397; fix the three `ChamberInput` override doc comments near 2523–2539)
- Modify: `PLAN.md` (French note at the bottom)

**Interfaces:**
- Consumes: Tasks 2–3 already removed every import of the three constants.
- Produces: `CHAMBER_CENTRAL_DIAMETER_OVER_X1`, `CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER`, `CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT` no longer exist — nothing may reference them afterwards.

- [ ] **Step 1: Verify the constants are unreferenced, then delete**

Run (Grep tool or):

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && grep -rnE "CHAMBER_CENTRAL_DIAMETER_OVER_X1|CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER|CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT" --include="*.ts" --include="*.tsx" apps packages'
```

Expected: matches ONLY in `packages/shared/src/index.ts` (the definitions). Then delete those three constants + their doc comments (keep `CHAMBER_D_FIRST_OVER_LAST` / `CHAMBER_D_MIDDLE_OVER_LAST` — still used). Update the comment block above them (line ~2404) to speak only of the two remaining diameter ratios.

- [ ] **Step 2: Fix the stale doc comments in `packages/shared/src/index.ts`**

(a) `CHAMBER_VARIANTS` comment — replace the parenthetical about `0.75*X1`:

```ts
/**
 * The cylinder-stack design options:
 *  - 'stepped': three solid coaxial cylinders (first/middle/last) - the default.
 *  - 'hollow' : first/middle solid, the LAST cylinder an open-top hollow shell
 *    (walls carved out) of a hand-set length, plus a central generator cylinder
 *    (dims from the Gen Dim v3 model — see computeChamberGeneratorDims) rising
 *    from the middle with an oval dome on top.
 */
```

(b) The three `ChamberInput` override docs:

```ts
  /**
   * Manual override for the GENERATOR (central cylinder) diameter, in mm. Omitted =>
   * the Gen Dim catalog Ø for the suggested frame (computeChamberGeneratorDims).
   * A typed value re-bases the height/dome autos. Hollow variant only. Geometry-only.
   */
  centralDiameter?: number;
  /**
   * Manual override for the GENERATOR (central cylinder) height, in mm. Omitted =>
   * the Gen Dim fit 71.258 + 0.45856·Ø(resolved) + 6.2368·L. Hollow variant only.
   * Geometry-only.
   */
  centralHeight?: number;
  /**
   * Manual override for the DOME height, in mm. Omitted => the Gen Dim fit
   * 79.609 + 0.21315·Ø(resolved). Hollow variant only. Geometry-only.
   */
  domeHeight?: number;
```

- [ ] **Step 3: Full verification battery**

```
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npx tsc -p apps/api/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit'
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts tests/chamberSaves.test.ts'
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/web && npx vitest run src/features/chamber'
```

Expected: typecheck clean; API chamber suites green; web chamber suite green. (Geometry suite not run — `buildChamber.py` untouched. `conversion.test.ts`/`meshes.test.ts` stay excluded: pre-existing WSL environment failures.)

- [ ] **Step 4: French changelog note in `PLAN.md`**

Append at the bottom (house rule):

```markdown
- **Dimensions génératrice empiriques (Gen Dim v3)** : les champs vides Ø / hauteur
  génératrice / hauteur dôme (variante cône) sont désormais calculés par le modèle
  empirique Gen Dim v3 (X1–X3 → X4 → châssis R → Ø catalogue ; Ø+L → hauteur ;
  Ø → dôme) au lieu des ratios fixes 0.75·X1 / 1.33·Ø / 0.2·h. Nouveau champ
  optionnel X4 (vide = 0.9·9.81·X2·X3, borné 0 < X4 ≤ 100 000) ; un Ø saisi
  recalcule les autos hauteur/dôme (cascade) ; fonction partagée
  `computeChamberGeneratorDims` (API + hints web = une seule source de vérité) ;
  les trois constantes de ratio supprimées ; builder Python inchangé ; le cache
  s'auto-invalide via les valeurs résolues. Spec :
  `docs/superpowers/specs/2026-09-02-generator-dimensions-design.md`.
```

- [ ] **Step 5: Commit and push**

```bash
git add packages/shared/src/index.ts PLAN.md
git commit -m "refactor(chamber): drop the fixed generator ratio constants (Gen Dim v3 is the auto path)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

## Verification reference (hand-computed parity values)

| Case | X4used | R | L | Ø | Height | Dome |
|---|---|---|---|---|---|---|
| X1=1450, X2=7, X3=10 | 618.03 | 62 | 100 | 1242 | 1264.47 | 344.34 |
| same + Ø override 1272 | 618.03 | 62 | 100 | 1272 | 1278.23 | 350.74 |
| same + x4 override 2000 | 2000 | 115 | (55) | 2225 | — | — |
| BUILD (1450, 7.85, 8) hollow | 554.46 | 62 | 70 | 1242 | 1077.37 | 344.34 |
