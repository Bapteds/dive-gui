# Chamber input floors + distributor fit bound — design

**Date:** 2026-09-01
**Status:** approved (batch 2 of the chamber review: findings 5–7)

## Problems fixed

5. Legal X1/X2/X3 can yield NEGATIVE or zero finals from the fits (e.g.
   relations master off, x1=700 / x2=1.8 / x3=23 → H Kammer ≈ −3442 mm),
   labeled "within range" and sent to CadQuery as −3.45 m.
6. Constraint cells and geometry overrides accept 0, negatives, and
   `1e999`-style extremes; several builder parameters (`distFromEnd`, the
   chamfer setbacks) have no range validation, and an axis sitting INSIDE a
   removed chamfer corner evades all fit checks.
7. The radial fit check bounds the part by `max(dFirst,dMiddle,dLast)/2`, but
   the guide-vane distributor (blades ≈ 1.251 × ring radius, shroud wider
   still) reaches further — a `dMiddle` override can carve blade holes through
   the box wall on a "successful" build.

## Fix 1 — non-positive finals refuse the build (shared + API + web)

- Shared: `nonPositiveChamberFinals(outputs)` — outputs with `final <= 0`,
  excluding `noEffect` ones (LEOW that the build never reads must not block).
- API `buildChamber()`: before hashing, refuse with 422 `VALIDATION_ERROR`
  listing each offending `label = value mm` and the levers (inputs, relations,
  constraints). When `chamferEnabled === false` the four chamfer dims
  (LF1/BF1/LF2/BF2) are exempt — the build does not consume them (LT/B1 always
  count: they position the axis). The web already pipes server messages to the
  red panel + toast verbatim.
- Web Parameters table: a row with `final <= 0` (and not noEffect) renders its
  Final in the danger color and its Status as a red `! ≤ 0 mm` — visible live,
  before Generate. No new `ChamberStatus` value (statuses drive the userDriven
  logic; this is a display-layer flag).

## Fix 2 — bounds on user-entered dimensions

- Shared: `CHAMBER_DIMENSION_MAX_MM = 100_000` (100 m — far above any chamber,
  low enough to stop absurd values burning a CPU core for the 10-min timeout).
- API schema: `constraints.{min,max,exact}` become
  `.positive().max(CHAMBER_DIMENSION_MAX_MM)`; the free geometry overrides
  (`lengthOverride`, `hollowLength`, `wallThickness`, `dFirst`, `dMiddle`,
  `centralDiameter`, `centralHeight`, `domeHeight`) gain the same `.max()`.
- Web form schema mirrors the `.max()` bounds with field messages.
- `NumCell` (constraint cells) propagates only finite values in
  `(0, CHAMBER_DIMENSION_MAX_MM]`; anything else clears the constraint (same
  behaviour as today's empty-string path), so `1e999` / `-5` can no longer
  reach the API from the table.

## Fix 3 — builder guards (`buildChamber.py`)

- `distFromEnd`: `0 < LT < length`, like B1's existing check.
- Chamfer setbacks (when `chamferEnabled`): each length/width must be > 0 and
  smaller than the box side it eats into.
- Axis-inside-corner refusal: if (target_x, target_y) lies inside a removed
  chamfer triangle, refuse naming B1/LT and the chamfer as the levers (the
  existing edge-distance check assumes the axis is outside the triangle).

## Fix 4 — distributor radial fit (guide-vane builds)

The wall + chamfer-face refusals are refactored into one `_refuse_radial(r,
what, levers)` closure. It runs as today for the cylinder radius, and — for
guide-vane builds — a second time right after `make_vane_patches` with the
EXACT max radial reach of the distributor meshes (blades + hub + shroud vertex
distances from the axis). No hardcoded asset ratio: the bound automatically
covers the vane-angle swing, `dMiddle` overrides, and any future asset change.
The refusal names the distributor and adds "reduce Guide vanes Ø (dMiddle)" to
the levers.

## Tests

- Model: `nonPositiveChamberFinals` — the x1=700/x2=1.8/x3=23 relations-off
  case flags H Kammer; a noEffect LEOW ≤ 0 is excluded.
- API: that same build body → 422 naming H Kammer; a negative constraint and
  an over-max `dFirst` → 422 from zod; chamfer-disabled builds with negative
  chamfer finals still build.
- Geometry: axis-inside-chamfer override → KO "lies inside"; zero chamfer
  width → KO from validation; a vane build whose cylinders fit (radius 3.25 m
  vs 3.5 m gaps) but whose distributor reaches ~4.07 m → KO naming the
  distributor; same overrides without guide vanes build fine (existing
  fixtures stay green).
- Web: table renders the `! ≤ 0 mm` flag; NumCell drops out-of-range input.

## Out of scope

- The review's remaining medium/minor batches (lost fallback warning, stale
  page state, snap explanation, a11y).
- Physical plausibility floors beyond > 0 (a 50 mm B Kammer still builds — the
  builder's own geometric checks own that space).
