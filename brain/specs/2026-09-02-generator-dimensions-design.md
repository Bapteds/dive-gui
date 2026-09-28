# Empirical generator dimensions (Gen Dim v3) — design

**Date:** 2026-09-02
**Status:** approved
**Source:** `documents/Gen Dim v3 Only Calculator (standalone).xlsx` (Calculator sheet,
updated 2026-09-02 so that G2/G3 depend on G1, not on R — an overridden diameter
cascades without re-deriving the frame).

## Goal

Replace the fixed-ratio auto values of the three hollow-variant generator boxes
(Generator Ø `0.75·X1`, Generator height `1.33·Ø`, Dome height `0.2·height`)
with the empirical Gen Dim v3 model fitted on historical builds. Blank boxes get
the model value; a filled box wins verbatim (exactly today's contract). One new
optional input, **X4**, steers the model; there is NO frame (R) override field
and NO derivation read-out in the UI — a wrong frame is corrected by typing the
right Generator Ø, which cascades into the height/dome autos.

## The model (all constants exactly as in the workbook)

```
X4auto = 0.9 · 9.81 · X2 · X3            (≈ power; manual X4 wins when given)
X4used = x4 ?? X4auto

R (frame) = X4used > 1560 → 115
          | X4used ≤ 175  → (X1 ≤ 940 → 26, else 46)
          | else          → (X1 ≤ 683 → 48, else 62)      (~70–77% correct)

L (length code) = clamp(30, 215, round5(132.21 − 0.8294·R − 0.0825·X1 + 13.861·X3))
                  round5 = Math.round(v/5)·5, rounding BEFORE the clamp (Excel order)

G1 Generator Ø  = centralDiameter ?? CATALOG[R]
G2 Gen. height  = centralHeight   ?? 71.258 + 0.45856·G1resolved + 6.2368·L   (R² 0.93)
G3 Dome height  = domeHeight      ?? 79.609 + 0.21315·G1resolved              (R² 0.71)
```

`CATALOG` (one diameter per frame, mm):
`{26: 572, 36: 745, 38: 753, 45: 976, 46: 933, 48: 986, 62: 1242, 77: 1545, 115: 2225}`.
Only frames 26/46/48/62/115 are reachable (no R override), so the workbook's
linear fallback (`72.477 + 19.012·R`) is dropped; the full 9-frame catalog is
kept as documentation and for the (unreachable today) rare frames.

**Cascade contract:** `G1resolved` = the user's Ø when typed, else `CATALOG[R]` —
so overriding only the Ø re-bases the height and dome autos (user requirement:
"if R is wrong, overriding G1 is sufficient"). A height override no longer
affects the dome auto (the old `0.2·height` link is gone; dome follows Ø only).

**No 50 mm snapping** of generator dims — same as today (the catalog values are
not on the grid; regression outputs pass verbatim). `CHAMBER_GRID_MM` is not
involved.

## Where the logic lives

One pure function in `packages/shared/src/index.ts` (the chamber model's home,
same reasoning as `computeChamberOutputs`): the API build resolution and the
web hints both call it, so they agree for free. The Python builder is untouched
(it keeps receiving resolved metres).

```ts
computeChamberGeneratorDims({ x1, x2, x3, x4?, centralDiameter?, centralHeight?, domeHeight? }) => {
  x4Auto, x4Used, frame, lengthCode,
  auto:     { centralDiameter, centralHeight, domeHeight },  // own override ignored, upstream kept
  resolved: { centralDiameter, centralHeight, domeHeight },  // override ?? auto — what gets built
}
```

`auto` is what a BLANK box would get given the other boxes' current state
(hint text); `resolved` is what the build uses. For an overridden field the two
differ; `auto.centralHeight`/`auto.domeHeight` use the RESOLVED Ø (cascade).

New shared constants: `CHAMBER_GENERATOR_FRAME_DIAMETERS_MM` (the catalog),
`CHAMBER_X4_MAX = 100_000` (validation ceiling; auto X4 tops out ≈ 3 026 on
legal X2/X3, and any X4 > 1 560 already maps to frame 115).
Deleted: `CHAMBER_CENTRAL_DIAMETER_OVER_X1`, `CHAMBER_CENTRAL_HEIGHT_OVER_DIAMETER`,
`CHAMBER_DOME_HEIGHT_OVER_CENTRAL_HEIGHT` (no other consumers than the two
call sites being replaced).

## API changes

- `ChamberInput` gains optional `x4` (number). `chamberBuildSchema`: finite,
  `> 0`, `≤ CHAMBER_X4_MAX` — same bounded-input policy as the dimensions
  (typing 0 is a validation error; blank means auto).
- `buildParams`'s hollow branch replaces the ratio chain with
  `computeChamberGeneratorDims(...).resolved` (mm → m as today). `x4` itself is
  NOT forwarded to the builder — only resolved dimensions are, so the cache key
  keeps working unchanged and **existing cache entries self-invalidate**
  (same inputs now resolve to different central dims → different hash).
- Saves: `snapshot` is a JSON-encoded `ChamberInput` revalidated on write —
  `x4` flows through with no Prisma migration. Old saves (no `x4`) load as
  auto. Solid-variant inputs may carry `x4`; it is simply unused (mirrors
  `wallThickness` handling).

## Web changes

- New field **"X4"** in the cylinder-design (hollow) section, placed FIRST among
  the generator fields (it feeds them): `type="number"`, `placeholder="auto"`,
  registered like the other optional overrides (`setValueAs: numOrUndef`),
  validated `> 0`, `≤ CHAMBER_X4_MAX`. Helper text:
  `Blank = auto ≈ N (0.9 · 9.81 · X2 · X3)` — no unit (the workbook names none).
- The three generator boxes' hints switch from the ratio chain to
  `computeChamberGeneratorDims(...).auto` — passing the CURRENT override values,
  which FIXES the existing inconsistency where the web hint ignored a typed Ø
  while the API build did not. `ChamberAutoDims` gains `x4: number | null`.
- `x4` participates in form state, save/load round-trip, and the amber
  "inputs changed since this build" staleness note automatically (it is a form
  value like any other); tests assert it.

## Not changing

`buildChamber.py`, exports/STEP flow, the twelve-parameter model and its 50 mm
grid, `dFirst`/`dMiddle` ratios, the saves API surface, the cache layout.

## Tests

- **Shared** (new describe block): Excel parity — X1=1450, X2=7, X3=10 →
  X4used 618.03, R 62, L 100, Ø 1242, height 1264.47, dome 344.34; every R
  branch (X4>1560; X4≤175 with X1≤940/ >940; else with X1≤683/ >683); L
  round-then-clamp edges (≤30 → 30, ≥215 → 215, round5 to nearest);
  X4 override changes the frame; Ø override cascades into height+dome autos
  and `resolved` echoes overrides; height override does NOT move the dome.
- **API** (`chamber.test.ts` / `chamberModel.test.ts`): hollow build params use
  the new resolved values; `x4` accepted, bounded, absent-means-auto; invalid
  x4 → 422; solid variant ignores it.
- **Web** (`ChamberInputsForm` / `chamberForm` / page tests): X4 field renders in
  hollow mode with the auto hint; hints cascade from a typed Ø; save round-trip
  includes x4; staleness note fires on x4 change.
- Suites: web chamber vitest, API chamber vitest trio, typecheck (rebuild
  shared first). Geometry suite untouched (builder unchanged).
