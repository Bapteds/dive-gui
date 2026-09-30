# Semi-spiral casing: editable Length (Min / Max / Exact)

> **Status**: approved (user decisions 2026-09-30) · **Feature**: `brain/features/chamber-creation.md` · **Builds on**: `2026-09-29-semi-spiral-casing-design.md`

## 1. Goal

User request (2026-09-30): with **Semi-spiral casing** ticked, the Length row of the Parameters table is read-only ("from spiral"); the user needs to change it. Asked "limit, extension, or both?", the user answered **"Both, Min/Max/Exact"**.

## 2. Approved semantics (user decisions 2026-09-30)

Length of the spiral casing = `V2.y − V0.y` (top of the chamfered end to the flat inlet end, `chamberSpiralBoxDims.length`).

| Value | Effect |
|---|---|
| **Max M** | A hard length limit passed to the spiral optimiser (like B Kammer = `max_width` for the width): the spiral is reshaped so that its length ≤ M. Binding ⇒ the build is delivered with a warning (like the width warning). Infeasible ⇒ the spiral step refuses, naming the smallest feasible length. |
| **Min m** | If the spiral's length is below m, the **straight inlet channel is extended**: the flat inlet end V0–V9 (both at foot level) moves further out so the length equals m; the straight walls L1 (V1→V0) and L9 (V8→V9) get longer; the spiral itself (V1..V8) is unchanged. |
| **Exact E** | Max = E and Min = E: the spiral fits within E, then the channel is extended to exactly E. |
| Min > Max | The existing inverted-range refusal applies to Length (it is no longer exempt). The other derived rows (B1, LF1, BF1, LF2, BF2, LT) stay read-only "from spiral" and exempt. |
| No Length value | Behaviour, spiral inputs, spiral hash and chamber hash exactly as today (no re-key of existing builds or saves). |

Exact wins over Min / Max when both are typed (same rule as every other row, `resolveChamberFinal`).

## 3. Contract

- `ChamberInput.spiralLength?: ChamberConstraint` (mm; `min`, `max`, `exact`, each a positive dimension ≤ 100,000 like the table constraints). Read **only** when `semiSpiral` is true; ignored otherwise. Length is not a `ChamberOutputKey`, so it cannot live in `constraints`; `lengthOverride` stays the plain-box Length (hidden and ignored with the spiral). Saves carry it in the snapshot (the snapshot is the build body); old saves have none.
- Shared helper `chamberSpiralLengthLimits(input)` → `{ minMm, maxMm, inverted, min, max }` (nulls when the spiral is off or nothing is typed; Exact sets both).
- `ChamberSpiralInputs.max_length?: number` (m): present only when a Max (or Exact) applies, so the spiral hash of every existing input set is unchanged.
- `ChamberSpiralSummary` gains optional `lengthMm` (final box length), `lengthBinding` (the Max holds the spiral back) and `inletExtensionMm` (how far the inlet was moved out, 0 when not extended).
- Zod: `spiralLength: constraintSchema.optional()` on `chamberBuildSchema` (and so on the saves' snapshot).

## 4. Optimiser (designSemiSpiral.py)

- New optional input `max_length` (m, > 0). The CLI reads it only when present; absent ⇒ exactly today's code path (same constraints list, same floating point, golden vertices unchanged).
- Length of a candidate: `foot_y = V9.y = 2·V6.y − y5 − 2·STUB` (nose: L7 and L9 stubs, L8 mirror of L6), so `length = yt − foot_y = yt − 2·V6.y + y5 + 0.9`. Constraint `max_length − length ≥ 0` appended to `_shape_ok` (penalty in the global search, rejection in the grid refinement).
- Grid rounding can push a candidate just over the limit: when the rounded corners violate it, a repair lowers `yt` by grid steps (dragging `y4`, `y5` down to keep `yt ≥ y4 ≥ y5`) until it fits.
- **Pre-check**: the smallest length the search box allows is `L_min = max(top − 0.6, 1.0) − 2·V6.y + (V6.y + 0.05) + 0.9` (lower bounds of `yt`, `y4`, `y5`; `top` = highest point of the ideal wall). `max_length < L_min` ⇒ `SpiralLengthInfeasibleError` before any optimisation. If the optimisation still fails with a length limit, it is re-run without it: a failure there is the width refusal (natural width), otherwise the length refusal names the length of that width-only design (a feasible length).
- Output: `inputs.max_length`, `dimensions.length` and `quality.length_binding` only when `max_length` is set. Binding = `length > max_length − GRID − 1e-6` (implementation note: `yt` and `y5` sit on the 0.05 m grid, so the reachable lengths are 0.05 m apart and a held wall lands up to one step under the limit). A set limit changes the global search even when it does not bind (the differential evolution penalises the longer candidates it visits), so only "no limit" guarantees today's vertices.
- Texts (chamber wording, shown alone after "Cannot build the chamber."):
  - refusal: "The semi-spiral casing does not fit in the Length Max (N mm): the shortest valid spiral for these inputs is M mm long. Raise the Length Max to at least M mm." (M rounded up to the mm);
  - warning: "The semi-spiral casing is limited by the Length Max (N mm): worst cross-section error X m² at Y°. Raise the Length Max to reduce it." (after the width warning when both bind).
- `ALGORITHM` tag unchanged (no max_length ⇒ identical results; with it, `max_length` is in the hashed inputs).

## 5. Extension (API, after the spiral step)

`foot_y' = V2.y − m` (m in metres, rounded to 1e-6 like the tool) when `V2.y − V0.y < m`; V0.y and V9.y take `foot_y'`, every other vertex is unchanged. The builder already derives the box from `V0.y` (`spiral_box`) and cuts the nose from V5..V8 only, so a lower foot simply lengthens the box: L1 and L9 are the box's side walls, the inlet patch stays the flat end. **No builder change, no chamber cache purge.**

## 6. Hash and caching

- Spiral hash: `max_length` enters only when set. Min alone never re-keys the spiral.
- Chamber hash: the extended vertices are in `params.spiral.vertices`; `quality.length_binding` only when `max_length` is set. No Length value, or a Min at or below the spiral's own length ⇒ same params ⇒ same hash as today.

## 7. Refusals and warnings

- 422 `VALIDATION_ERROR` (before the spiral step): Length Min > Max joins the existing inverted-range message ("Length: Min X > Max Y").
- Spiral step `KO:` (422 `CHAMBER_REFUSED`): the Length Max refusal of section 4.
- Warning (persisted in `warnings.json`, listed with the spiral notes first): the Length Max warning of section 4.

## 8. UI

- Parameters table, Length row with the spiral on: the existing Min / Max / Exact number cells (same `NumCell` as the other rows, aria labels "Length minimum / maximum / exact"); Final = the build's length; Status: `! min>max` (red) when inverted, `set exact` with an Exact, `capped at max` when the Max binds, `raised to min` when the inlet was extended, else `from spiral`. The other derived rows keep their read-only cells.
- The spiral note under the table header mentions an extension ("inlet channel extended by N mm") or a binding Length Max.
- `ChamberPage` keeps the Length constraint in its own state (`spiralLength`), sends it only when the spiral is on and a value is typed, checks the inverted range client-side like the other rows, and restores it from saves and study hand-offs.

## 9. Tests (written first)

- Python: `_shape_ok` with `max_length`; pre-check refusal + message; slow: case A with `max_length` 4.5 m (length ≤ 4.5, binding, warning); golden and case A without `max_length` unchanged.
- API `chamber.test.ts`: Max passed as `max_length` and in the spiral hash only when set; Min extends V0/V9 (frozen vertices, box length, hash) and a Min below the spiral length changes nothing; Exact; inverted refusal; no constraint ⇒ hash unchanged; Length refusal shown alone.
- Shared (`chamberModel.test.ts`): `chamberSpiralLengthLimits`.
- Web: `ChamberOutputsTable` Length row editable with the spiral on, the other derived rows read-only, statuses; `chamberForm` load helper.

## 10. Out of scope

A live length preview, Length constraints without the spiral (the plain box keeps `lengthOverride`), extending the spiral anywhere but the inlet channel, making the other derived rows editable.
