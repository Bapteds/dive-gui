# Guide vane count (16 or 18) — design

> **Status**: approved (2026-09-29; every OPEN question resolved with its recommended option, see the decision note at the end) · **Date**: 2026-09-29 · **Workstream**: WS-B (Chamber Creation v2, branch `feat/chamber-v2-cfd-loop`)
> **Area**: shared, backend, python (`apps/api/scripts/buildChamber.py`), frontend, tests
> **Related**: `brain/features/chamber-creation.md` §3.7, §3.8, §3.9, §4.3, §4.4, §4.5, §5.1; `brain/playbooks/add-chamber-input-or-parameter.md`; `brain/playbooks/change-chamber-geometry.md`; `brain/specs/2026-08-03-guide-vane-throat-design.md`, `2026-08-13-guide-vane-step-export-design.md`, `2026-08-31-vane-te-rounding-design.md`; WS-A `2026-09-29-vane-pocket-runner-case-design.md` (same builder region, lands first).

## 1. Goal

Let the user choose how many guide vanes the distributor has: **16** (today's asset, default) or **18**. With 18 vanes each blade gets a chord shortened by **16/18**, so the cascade solidity (total chord over pivot-circle circumference) stays the same. The pivot radius does not move. Both designs (Closed generator and With cone) are covered, as are the mesh fluid, the patches and the deferred vaned STEP.

A new refusal blocks a distributor whose neighbouring blades would touch or overlap at the requested Vane angle. It is checked on the real blade outlines.

## 2. User decisions (final, 2026-09-29)

| # | Decision |
|---|---|
| D1 | New input `vaneCount` ∈ {16, 18}, default **16**, label **"Guide vane count"**, a select. |
| D2 | 18 vanes: chord × 16/18 (solidity kept); **pivot radius unchanged**; angular step = 360/n in the mesh path and in the STEP. |
| D3 | Shared type + zod default 16 + `resolveGeometryParams` + builder `P.get("vaneCount", 16)` + form + old-save fallback + hash. |
| D4 | New refusal if adjacent blades overlap at the requested vane angle, checked on the real outlines. |
| D5 | Tests: pytest fixture with 18 vanes (18 blades on `guide_vanes`, vaned STEP passes the volume gate), API hash tests, web form tests. |

## 3. Current mechanism (verified in code)

| Concern | Where (`buildChamber.py` unless stated) | Notes |
|---|---|---|
| Asset metadata | `assets/guideVanes.json`: `pivotRadius` 0.86732, `bladeCount` 16, `bladeAngleStepDeg` 22.5 | Read by `_load_vane_meta()`. |
| Ring scale | `vane_scale_and_height`: `s = d_ring / (2·pivotRadius)` | `d_ring` = `dMiddle` (override × Part scale, or 0.80 × LE). |
| Pivot | `make_vane_patches`: `theta0 = atan2(mean(blade.vertices))`, pivot = `pivotRadius·s` at `theta0` | Measured: this point sits **14.7 mm × s outside** the airfoil outline (asset frame), close to its concave side. It is the spindle the Vane angle pitch rotates about. |
| Pitch | `base = place(blade)`, then translate(−pivot) · rotate(`vaneAngleDeg − 50`) · translate(+pivot) | Only when the pitch is non-zero. |
| `R_anchor` | min radius of the placed, pitched blade | Drives the outlet clamp `ro ≤ 0.97·R_anchor` (WARNING) and the fallback remap knot. |
| Drape | bottom 15 % of the band re-seated on the shroud floor (z only) | A function of radius, so it survives the ring rotation. |
| Ring copies | `for k in range(int(meta["bladeCount"]))`, `ang = k·bladeAngleStepDeg` | The only place the count and step are used. |
| Prisms + outlines | `_vane_prisms`: mid-height section of each connected blade (`blades_mesh.split()`), TE rounded by `_round_blade_te` (radius `0.00585 × chord`), extruded | Count-agnostic. The outlines feed `_blade_skin_mask`. |
| Vaned STEP | `build_vane_step_solid`: loops over `blades_mesh.split()`, fits the committed airfoil onto each section with a **2D similarity (scale `c` free)**, rounds the TE, extrudes a spline | Count-agnostic and scale-agnostic: nothing hard-codes 16 or 22.5°. |
| Distributor fit | `_refuse_radial(_dist_r, ...)` on the max radial reach of blades + hub + shroud | The shroud reaches `dLast/2 + FLOOR_OVERCUT`, beyond any blade, so a shorter blade never changes this check. |

## 4. Geometry definition

### 4.1 Chord scaling (decision proposed by this spec)

- **Uniform 2D scale of the blade in XY by `k = n_ref / n`**, where `n_ref = meta["bladeCount"]` (16) and `n = vaneCount`. For 18 vanes, `k = 16/18 = 0.8889`.
- **Centre of scaling: the pivot** (the same point the Vane angle pitch rotates about). Scale and rotation about the same point commute, so it slots into the existing pitch block: translate(−pivot), scale `(k, k, 1)`, rotate(pitch), translate(+pivot).
- **Z is not scaled**: the blade span still fills the HLE band, and the drape still seats its bottom on the shroud floor.
- **Why uniform (not chord-only)**: the airfoil stays geometrically similar, so thickness/chord, the leading-edge radius, the camber line and the TE shape (the rounding radius is a fraction of the chord) are all kept. The vaned STEP fits the committed airfoil with a similarity transform, so it follows a uniform scale exactly, with no new asset. A chord-only stretch would need a new airfoil definition and would make the STEP fit leave its tolerance.
- **Why about the pivot**: the pivot circle radius is unchanged by construction (D2), and the blade stays on its spindle at any Vane angle. The other option, scaling about the section centroid, would keep the mid-chord radius but move the blade off its spindle.
- **Solidity**: `σ = n·c / (2π·R_p)`. `18 × (16/18)·c = 16·c`, so σ is identical: 1.179 for the asset at 50°.
- **Side effect, stated**: the shorter blade has a larger inner radius (at 50°, asset frame: `R_anchor` 0.7003·s for 16, 0.7172·s for 18) and a smaller outer radius (1.0339·s to 1.0153·s). `R_anchor` is measured on the real (scaled) blade, so an 18-vane build clamps the outlet a little later (only when Runner Ø is large, see the WARNING in §3.8 of the feature sheet). Hub, shroud, the outlet at normal X1 and the distributor reach are unchanged.

### 4.2 Angular step

`ang_k = k · 360° / n` for `k = 0..n−1` about the ring axis. For n = 16 this is 22.5° exactly (the metadata value), so the 16-vane path is bit-identical. `bladeAngleStepDeg` stays in `guideVanes.json` but is no longer read (codemap note).

### 4.3 Measured clearance (prototype, 2026-09-29, CadQuery venv `C:/cqv`)

Minimum distance between any two neighbouring blade outlines (mid-height section, TE rounded, the exact rings `_blade_skin_mask` uses). Asset frame (`s = 1`, chord 401.7 mm) and scale-free ratio:

| n | chord factor | 45° | 47.5° | 50° | 52.5° | 55° |
|---|---|---|---|---|---|---|
| 16 | 1 | 207.3 mm (0.516 c) | 214.1 (0.533 c) | 220.3 (0.548 c) | 225.9 (0.562 c) | 230.9 (0.575 c) |
| **18** | **16/18** | **187.7 mm (0.526 c')** | 193.9 (0.543 c') | **199.6 (0.559 c')** | 204.8 (0.574 c') | **209.5 (0.587 c')** |
| 18 (for reference, chord not scaled) | 1 | 178.3 (0.444 c) | 184.6 | 190.3 | 195.6 | 200.3 (0.499 c) |

At real size (the gap scales with the ring):

| Fixture (ring Ø) | 16 vanes at 45 / 50 / 55° | 18 vanes at 45 / 50 / 55° |
|---|---|---|
| `stepped-vanes` (1937 mm, chord 449 → 399 mm) | 231 / 246 / 258 mm | **210 / 223 / 234 mm** |
| `hollow-vanes` (1703 mm, chord 394 → 350 mm) | 204 / 216 / 227 mm | **184 / 196 / 206 mm** |
| `hollow-vanes-overrides` (2231 mm, chord 517 → 459 mm) | 267 / 283 / 297 mm | 241 / 257 / 270 mm |

**No overlap anywhere in the 45 to 55° range, for either count.** The smallest gap (18 vanes, 45°) is still 0.53 chord. Because every vane dimension scales with the ring, the gap/chord ratio does not depend on Runner Ø, LE, Guide vanes Ø or Part scale. So the D4 refusal is a **safety net**: it cannot fire with today's asset and today's 45 to 55° range. It will matter if the angle range or the asset changes. It is tested by a unit test (§9).

### 4.4 Prototype end-to-end builds (scratch copy of the builder, not committed)

| Build | Result |
|---|---|
| `stepped-vanes`, 16 (prototype code path) | OK, volume 135.469768 (GOLDEN 135.469749: unchanged), 16 blade components. |
| `stepped-vanes`, 18, 50°, `--step` | OK 49 s, watertight, **135.495642 m³** (+0.019 %: the blades' total section area drops by 16/18), patches = `VANE_PATCHES`, **18** `guide_vanes` components, mean chord 398.4 mm (449 × 16/18 = 398.4), **`stepHasVanes: true`** (volume gate passed). |
| `stepped-vanes`, 18 at 45° / 55° | OK, 135.495648 / 135.495628. |
| `hollow-vanes`, 18, `--step` | OK 49 s, watertight, 153.130045 m³ (16: 153.091653), 18 components, chord 350.3 mm, **`stepHasVanes: true`**. |

The mesh build time is unchanged (≈ 26 s stepped, 22 s hollow at 16; the 18-vane builds take the same time).

## 5. Changes per layer

### 5.1 Shared (`packages/shared/src/index.ts`)
- `export const CHAMBER_VANE_COUNTS = [16, 18] as const;` and `export type ChamberVaneCount = (typeof CHAMBER_VANE_COUNTS)[number];`.
- `export const CHAMBER_VANE_COUNT_DEFAULT: ChamberVaneCount = 16;`.
- `ChamberInput.vaneCount?: ChamberVaneCount`, with a JSDoc covering: number of guide vanes, 16 (asset) or 18; with 18 each chord is scaled by 16/18 about its pivot (same solidity, same pivot radius); only affects guide-vane builds; geometry-only; default 16.
- `npm run build:shared`.

### 5.2 API
- `apps/api/src/modules/chamber/chamber.schemas.ts`: `vaneCount: z.union([z.literal(16), z.literal(18)]).default(16)` (built from `CHAMBER_VANE_COUNTS`), with a comment in the house style. Saves reuse the schema, so old snapshots parse to 16 and new saves materialise the value.
- `apps/api/src/modules/chamber/chamber.service.ts` `resolveGeometryParams`: `if (params.guideVanes && (input.vaneCount ?? 16) !== 16) params.vaneCount = input.vaneCount;`. The key is **omitted when 16** (every existing vane build keeps its hash; no re-key, no rebuild) and **omitted without guide vanes** (no effect, so no re-key; unlike `vaneAngleDeg`, which re-keys needlessly, known-issues §6).
- No new error code: 17 is a zod 422 `VALIDATION_ERROR`.

### 5.3 Builder (`apps/api/scripts/buildChamber.py`)
- Constants block: `VANE_COUNTS = (16, 18)`, `VANE_MIN_GAP = 2e-3` (m, see OPEN Q1).
- `main()`: `vane_count = int(P.get("vaneCount", 16))` (old `params.json` files and every 16-vane build omit it). Common validation: if `vane_count not in VANE_COUNTS`, then `ValueError` (text R1).
- `make_vane_patches(..., vane_count=16)`:
  - `n_ref = int(meta["bladeCount"])`, `k_chord = n_ref / float(vane_count)`;
  - pitch block runs when `vane_angle_deg or k_chord != 1.0`: translate(−pivot), `apply_scale((k_chord, k_chord, 1.0))` when `k_chord != 1`, rotate, translate(+pivot). `R_anchor`, the outlet clamp and the drape then follow unchanged;
  - ring loop `for k in range(vane_count)`, `ang = radians(k * 360.0 / vane_count)`.
- `main()` passes `vane_count=vane_count` to `make_vane_patches`.
- New helper `_min_blade_gap(outlines)` (shapely, lazy import like `_vane_prisms`): the minimum `Polygon.distance` over **all pairs** of outlines (0 when two intersect). All pairs, not "i and i+1": `blades_mesh.split()` does not return the blades in azimuth order; 153 pairs at 18 is negligible.
- In `main()`, right after `_vane_prisms` and **before** the manifold union (the expensive step):
  - if `len(_blade_outlines) != vane_count`, raise `RuntimeError("expected %d blade sections, found %d")` (internal);
  - if `_min_blade_gap(_blade_outlines) < VANE_MIN_GAP`, raise `ValueError` (text R2).
- `build_vane_step_solid`: **no change**. It iterates `blades_mesh.split()` and fits the airfoil with a free similarity scale, so it picks up the 18 blades and `c ≈ 16/18` by itself (the prototype STEPs pass the gate). The committed profile `guideVanes_blade_profile.json` is not touched.
- Docstrings: `make_vane_patches` (count and chord scale), header parameter list (`vaneCount`), and the stale "16 vanes" mentions.

### 5.4 Web
- `apps/web/src/features/chamber/chamberForm.ts`:
  - `ChamberFormValues.vaneCount: ChamberVaneCount` (non-optional, like `vaneAngleDeg`);
  - `chamberFormSchema`: `vaneCount: z.union([z.literal(16), z.literal(18)], { errorMap: () => ({ message: 'Choose 16 or 18 vanes' }) })`;
  - `CHAMBER_FORM_DEFAULTS.vaneCount = 16`;
  - `chamberInputToFormValues`: `vaneCount: input.vaneCount ?? CHAMBER_FORM_DEFAULTS.vaneCount` (old saves load as 16).
- `apps/web/src/features/chamber/ChamberInputsForm.tsx`: in the field grid, just before "Vane angle (°)":
  `<Field label="Guide vane count" error={errors.vaneCount?.message} helperText="Guide-vane builds only: 18 vanes get a chord 16/18 as long (same solidity)"><NativeSelect {...register('vaneCount', { valueAsNumber: true })}><option value="16">16</option><option value="18">18</option></NativeSelect></Field>`.
  RHF applies `valueAsNumber` to a single `<select>` (its `getFieldValueAs` path); the form test locks that the submitted value is the number 18. It reuses existing primitives, so step 4 of the skill sequence (`web-design-guidelines`) is enough.
- `apps/web/src/pages/ChamberPage.tsx`: `FIELD_LABELS.vaneCount = 'Guide vane count'`.
- Staleness note, Save snapshot and "Build errors" pick the field up with no other code.

## 6. Hash impact

| Body | `params.vaneCount` | Hash vs today |
|---|---|---|
| Any body without vanes (any `vaneCount`) | omitted | unchanged |
| Vanes, `vaneCount` omitted or 16 | omitted | **unchanged** (no rebuild of existing vane builds) |
| Vanes, `vaneCount: 18` | `18` | new key |

Old cached `params.json` files never contain the key, so a `--step` re-feed builds 16 vanes, as the build did.

## 7. Refusals and messages (exact texts)

| Id | Layer | Condition | Message |
|---|---|---|---|
| R0 | API zod (422) / web form | `vaneCount` not 16 or 18 | zod default message (API); form: "Choose 16 or 18 vanes" |
| R1 | Builder `ValueError` | `vaneCount` not in (16, 18) (hand-fed params) | `Guide vane count must be 16 or 18 (got 17).` |
| R2 | Builder `ValueError` | min gap between two blade outlines < `VANE_MIN_GAP` | `Neighbouring guide vanes touch or overlap: with 18 vanes at a Vane angle of 45°, the closest gap between two blades is 0 mm (at least 2 mm is needed). Increase the Vane angle or set Guide vane count to 16.` |

R2 format: `"Neighbouring guide vanes touch or overlap: with %d vanes at a Vane angle of %g\u00b0, the closest gap between two blades is %s (at least %s is needed). Increase the Vane angle or set Guide vane count to 16."` with `_mm(gap)` and `_mm(VANE_MIN_GAP)`. The lever "set Guide vane count to 16" is dropped when n is already 16: then `"... Increase the Vane angle."`. Neither Guide vanes Ø nor Part scale is offered: they scale the gap and the chord together (§4.3), so they cannot fix it. As the API shows it: "Cannot build the chamber. Neighbouring guide vanes touch or overlap: …".

## 8. Patches

Unchanged list for vane builds: `inlet, cylinder_walls, walls, hub, shroud, outlet, guide_vanes`. `guide_vanes` holds the skin of 18 blades instead of 16 (assigned by `_blade_skin_mask` on the 18 outlines). No rename, no new patch, so meshing sessions are not affected.

## 9. Tests (test-first)

**Python** (`apps/api/scripts/tests/`, CadQuery):
1. New fixture `params/stepped-vanes-18.json` = `stepped-vanes.json` + `"vaneCount": 18`, added to `GOLDEN` as `("stepped-vanes-18": (135.495642, VANE_PATCHES))`. The prototype value is to be confirmed by the first run of the real implementation. It then runs the parametrized watertight / patches / exports tests automatically.
2. `test_eighteen_vanes_put_eighteen_blades_on_the_guide_vanes_patch`: `guide_vanes.stl` from `trisurface.zip` splits into exactly 18 connected components (each > 20 faces). The mean mid-height chord is 16/18 of the `stepped-vanes` one (± 2 %). The per-blade azimuth step is 20° ± 0.5°, from the component centroids about the outlet centre.
3. Add `"stepped-vanes-18"` to `test_vane_skin_stays_on_the_guide_vanes_patch` and to `test_step_export_vane_policy` (`--step` gives `{"stepHasVanes": true}`, no fallback message).
4. `test_min_blade_gap_detects_touching_outlines` (unit, via `_builder_module()`): two unit squares 1 mm apart give 0.001, overlapping squares give 0, and a 3-ring list in shuffled order returns the true minimum.
5. `test_vane_count_outside_16_or_18_is_refused`: override `{"vaneCount": 17}` on `stepped-vanes` gives exit 1, `KO:` and `Guide vane count must be 16 or 18`.
6. Guard: existing GOLDEN values **unchanged** (`stepped-vanes` 135.469749, `hollow-vanes` 153.090155, `hollow-vanes-overrides` 167.700993).

R2 cannot be triggered end to end with valid inputs (§4.3); the unit test (4) plus a code review of the call site cover it. **OPEN Q2** offers an end-to-end alternative.

**API** (`apps/api/tests/chamber.test.ts`, fake runner):
7. `keys a guide-vane build on the vane count, 16 = omitted`: vanes + 18 gives a new hash; vanes + 16 gives the same hash as vanes without the field; the builder `params.json` has `vaneCount: 18` only in the 18 case (spy runner as in `passes a typed Closed generator height ...`); the 12 outputs are unchanged.
8. `ignores the vane count without guide vanes`: `guideVanes: false` + 18 gives the same hash as without the field.
9. `rejects a vane count other than 16 or 18`: 17 gives 422.
10. `chamberSaves.test.ts`: a snapshot without `vaneCount` is stored normalised with 16 (only if the existing snapshot normalisation test pattern covers defaults).

**Web** (`apps/web/src/features/chamber/`):
11. `chamberForm.test.ts`: default 16; schema accepts 16 and 18 and rejects 17; `chamberInputToFormValues` round-trips 18 and defaults to 16 on old saves.
12. `ChamberInputsForm.test.tsx`: the "Guide vane count" select renders in both designs with options 16 and 18; choosing 18 then submitting carries `vaneCount: 18` (a number).

## 10. GOLDEN impact

**None may move.** The 16-vane path is bit-identical: `k_chord == 1` skips the scale, and 360/16 = 22.5 exactly. One new GOLDEN entry (`stepped-vanes-18`). The prototype reproduced `stepped-vanes` at 135.469768 (GOLDEN 135.469749).

## 11. Cache purge

`buildChamber.py` changes, so purge `apps/api/storage/chamber/*` (dev) and `<STORAGE_DIR>/chamber/*` on the server at deployment, and record it in the changelog. The hash does not change for existing builds (§6), so without the purge they would keep serving from the old code. That is harmless here (same geometry for 16), but it is still the house rule.

## 12. Out of scope

- Counts other than 16 and 18; a free count.
- Changing the Vane angle range (45 to 55°), the asset, the airfoil or the pivot definition. The pivot sits outside the outline; this is noted, not fixed.
- Re-keying fix for `vaneAngleDeg` / `outletRatio` without vanes (known-issues §6).
- Viewer or outputs-table changes; semi-spiral integration (its own spec, after WS-A/B/C).

## 13. OPEN questions

- **OPEN Q1 (minimum gap)**: what gap counts as "overlap"?
  - (a) strictly overlapping or touching (gap = 0);
  - (b) gap < 2 mm (`2 × VANE_SKIN_TOL`: below that the skin mask cannot tell the two blades apart, and a mesher cannot put cells in the slot);
  - (c) a fraction of the chord (e.g. 5 %).
  **Recommendation: (b)**, as written in §5.3 and §7. It never fires today (smallest gap 184 mm).
- **OPEN Q2 (testing R2)**: R2 is unreachable with valid inputs. Options:
  - (a) unit test of `_min_blade_gap` only (recommended, as in §9);
  - (b) also a test-only env var that lowers the angle bound to force an overlap (adds a test hook to production code, not recommended).
- **OPEN Q3 (field visibility)**: the select sits with "Vane angle" and "Outlet ratio".
  - (a) always visible with a "Guide-vane builds only" hint, like those two fields (recommended, consistent);
  - (b) shown only when Guide vanes is ticked (would call for the same change on its two siblings to stay consistent).
- **Decision proposed by this spec, to confirm on approval**: uniform XY scale about the pivot (§4.1) rather than about the section centroid.

## 14. Implementation plan (ordered)

1. `docs:` commit of this spec (status approved).
2. Shared: constants, type, JSDoc, then `npm run build:shared`.
3. API tests 7 to 10 (red), then zod field and `resolveGeometryParams` (green).
4. Python tests 1 to 6 (red; GOLDEN for `stepped-vanes-18` initially from the prototype), then builder changes (§5.3) (green). Run the whole geometry suite (`C:/cqv/Scripts/python.exe -m pytest apps/api/scripts/tests -q`) and confirm the new GOLDEN value.
5. Web tests 11 and 12 (red), then `chamberForm.ts`, `ChamberInputsForm.tsx`, `FIELD_LABELS` (green).
6. Purge `apps/api/storage/chamber/*`; `npm run typecheck`, `npm run lint`, targeted suites.
7. Manual browser pass: 16 and 18 in both designs, STEP download (18), old save loads as 16.
8. Brain: changelog, `features/chamber-creation.md` (§3.7 row, §3.8 R1/R2, §3.9 note, §4.3 step 11, §5.1 hash, §4.7 old saves, §11 glossary), codemaps (`api-scripts.md` `buildChamber.py` + `guideVanes.json` note + tests + new fixture, `root-shared-mcp.md`, `api-core.md`, `web-features-assemble-chamber.md`), `python brain/codemap/build-index.py`, `STATUS.md`.

## Decisions (2026-09-29)
The user accepted the recommended option for every OPEN question above (Q1 to Q3).
