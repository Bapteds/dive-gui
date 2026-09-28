# Guide-vane throat — design

**Date:** 2026-08-03
**Feature:** Chamber Creation — replace the middle cylinder with a ring of guide vanes
**Scope:** geometry builder + API plumbing + web toggle + a committed vane asset. No change to the empirical model (X1/X2/X3 → 12 parameters).

---

## 1. Goal

When the user turns on a new **Guide vanes** option, the plain cylindrical *middle* section of the flow cavity is replaced by a **contoured annular passage that carries a ring of 16 guide vanes**. Water flows down from the box cavity, passes *between* the blades, and exits the passage bottom toward the turbine. The option works with **both** existing variants (`stepped` and `hollow`); everything else (first/last cylinder, chamfers, torque feet, hollow central cylinder + dome) is unchanged.

The source geometry is `GuideVanes50DegOpen.stl` (provided by the user). "Open" means the top **inlet** cap has been removed — the surfaces present are exactly the ones needed for CFD: the passage side walls (hub + shroud), the outlet (bottom), and the 16 blades.

## 2. Source geometry (measured)

`GuideVanes50DegOpen.stl` — 168 180 vertices / 321 148 triangles, in **metres**, centred at XY ≈ (1.0882, 1.0882), z ∈ [0.4251, 1.0708].

Connected components = **17**:
- **16 identical blade shells** (~7 586 faces each), outer annulus r ≈ [0.70, 1.03], z ≈ [0.514, 1.071].
- **1 passage shell** (199 744 faces), r ≈ [0.296, 1.085], z ≈ [0.425, 1.071] = hub + outer shroud + bottom outlet, **open at the top**.

Natural dimensions about the axis:
- Outer Ø (shroud) ≈ **2.1696 m** (r_out ≈ 1.0848).
- Hub inner r ≈ **0.296 m**.
- Full z-band height ≈ **0.6457 m**.

The passage is **contoured** (the hub flares outward with height; the shroud/draft-cone profile is not a plain cylinder), so it must be scaled *uniformly* to stay physically valid.

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Blade representation | **Separate wall patch** — no OCC mesh-boolean. Blades ride along as their own scaled triSurface + a preview node. |
| 2 | Variant scope | **Toggle usable on both** `stepped` and `hollow`. |
| 3 | Asset storage | **Commit a decimated asset** under `apps/api/scripts/assets/`. |
| 4 | Source file | Use **`GuideVanes50DegOpen.stl`** (inlet already removed). |
| 5 | In-plane scaling | **Uniform** scale from the diameter → preserves the 50° blade angle and the passage contour. |
| 6 | Height / HLE | **Add a straight collar** at the outlet so total passage height = `HLE` (`hMiddle`), leaving the contoured + bladed region undistorted. |

## 4. Architecture

Four layers, following the existing chamber feature's boundaries.

### 4.1 Asset (offline, one-time) — `apps/api/scripts/assets/`

A small preprocessing script (kept in `apps/api/scripts/`, run once by a developer, **not** on every build) produces committed, axis-centred, decimated binary STLs:

- `guideVanes_walls.stl` — the passage shell (hub + shroud + outlet), recentred so the axis is at (0, 0) and the **bottom of the passage is at z = 0**.
- `guideVanes_blades.stl` — the 16 blades, same transform.
- `guideVanes.json` — natural metadata the builder needs without re-measuring:
  ```json
  { "outerDiameter": 2.1696, "hubRadius": 0.296, "height": 0.6457,
    "outletZ": 0.0, "outletOuterR": 0.688, "outletInnerR": 0.296 }
  ```

Decimation target ≈ **30–60 k triangles total** (a few MB), enough fidelity for a snappyHexMesh triSurface. The preprocessing script cleans the mesh (merge vertices, drop degenerate faces), recentres, and quadric-decimates.

*Rationale:* keeping preprocessing offline means the 86 MB source never touches the build path or git, and the build stays fast and deterministic.

### 4.2 Geometry builder — `apps/api/scripts/buildChamber.py`

New branch active when `guideVanes` is true. Everything below is expressed relative to the existing part axis `(target_x, target_y)` and floor `z_floor`.

**Scale.** `s = (RATIO_D_MIDDLE_OVER_LAST · d_last) / outerDiameter_natural`. This is the single uniform factor (matches the old middle-cylinder Ø = 0.80·d_last). Apply `s` to X, Y **and** Z of both STLs → blade angle and contour preserved.

**Placement.** The passage replaces the middle-cylinder band. Its top (inlet, open) meets the top of the first cylinder; its bottom (outlet) sits `HLE` below that. Concretely the passage bottom is at `z_mid_base = z_floor + h_first`, and the passage occupies `z_mid_base … z_mid_base + HLE` (the same band the middle cylinder used, since the middle cylinder was `h_first … h_first + h_middle`). *(Orientation note to verify at implementation: the STL's open top must face the box cavity and its outlet must face the turbine side; flip in Z if the source is oriented the other way.)*

**Collar (height = HLE).** After uniform scaling, the contoured + bladed region has height `s · height_natural`. Let `Δ = HLE − s · height_natural`.
- `Δ > 0` → extend a **straight annular collar** (outer r = `outletOuterR·s`, inner r = `outletInnerR·s`) downward from the scaled outlet by `Δ`; the collar's new bottom face becomes the outlet.
- `Δ < 0` → clip the passage from the outlet upward by `|Δ|` (a planar Z cut); warn if the clip would reach into the bladed band.
- `|Δ|` small → collar negligible.

**Box opening.** The box is cut with a **plain bounding cylinder** (radius = scaled shroud outer = `d_middle/2`, over the passage z-band, including the collar) so the background region is hollow and the fluid connects first-cavity → vanes → outlet. Per decision #1 the true contoured walls + blades are **not** booleaned into the solid; they are supplied as triSurface patches that drive the CFD mesh. The first and last cylinders are still cut exactly as today; only the middle cylinder cut is swapped for this opening.

**Hollow variant.** Identical treatment of the middle band; the hollow central cylinder + dome (which rise from the middle top) and the hollow last "cup" are unchanged. The central cylinder still starts at `z_floor + h_first + HLE` (top of the vane passage), preserving today's stacking.

### 4.3 Patches / manifest

New patch set when `guideVanes` is on:

| Patch | Type | Source |
|-------|------|--------|
| `guide_vane_walls` | `wall` | passage shell hub + shroud (+ collar walls) |
| `outlet` | `patch` | passage bottom face (after collar) |
| `guide_vanes` | `wall` | the 16 blade shells |
| `inlet` | `patch` | unchanged (box −Y end face) |
| `walls` | `wall` | unchanged (box faces) |

There is **no** vane-passage inlet patch (open interface to the box cavity). The blade + wall triSurfaces are added to the GLB scene (so the 3D preview shows the vanes), to `manifest.json`, and to `exports/trisurface.zip`. Because these come from meshes (not BREP faces), edge extraction for them is best-effort (feature edges), consistent with how the viewer already falls back.

*Note:* the `classify()` step currently keys the `outlet` off the middle cylinder's CAD face. With guide vanes on, that cylinder is gone; the outlet comes from the vane passage instead. `classify()` gains a `guideVanes` code path.

### 4.4 API + shared + web plumbing

- **shared** (`packages/shared/src/index.ts`): `ChamberInput.guideVanes?: boolean` (pure-geometry flag, like `footAngleDeg` — outside the empirical model, does not affect the 12 outputs).
- **API schema** (`chamber.schemas.ts`): `guideVanes: z.boolean().default(false)`.
- **API service** (`chamber.service.ts`): `resolveGeometryParams` passes `params.guideVanes = input.guideVanes ?? false`. It is part of the build hash (a different flag ⇒ a different cached build), consistent with `footAngleDeg`/`variant`. When true, the resolved vane dimensions (scale target, collar height) are derived from `d_middle` and `HLE` — no new empirical inputs.
- **web** (`chamberForm.ts`, `ChamberInputsForm.tsx`): a `guideVanes` boolean field (default false) + a checkbox "Guide vanes (replace the middle cylinder with a vane ring)". No new outputs-table columns; geometry-only, so the outputs table is unaffected.

## 5. Data flow

```
X1/X2/X3 + guideVanes flag
  → computeChamberOutputs (unchanged 12 params)
  → resolveGeometryParams  (adds guideVanes; derives scale target = 0.80·d_last, collar from HLE)
  → buildChamber.py
       if guideVanes:
         load committed guideVanes_{walls,blades}.stl + guideVanes.json
         uniform-scale s, recentre on axis, place in middle band, add/clip collar
         box.cut(first).cut(bounding-cyl passage).cut(last)   [+ hollow extras]
         patches = walls, outlet(passage bottom), guide_vane_walls, guide_vanes, inlet
  → GLB + manifest + edges + exports (STL/STEP/triSurface.zip)
```

## 6. Error handling

- Missing asset files → clear `KO:` message naming the expected path (mirrors `SCRIPT_MISSING`).
- Scaled shroud Ø exceeds the box half-width (pocket breaks a side wall) → reuse the existing `WARN:` check on the bounding cylinder.
- `Δ < 0` clip reaching into the bladed band → `WARN:` (blades would be truncated); build still completes.
- Guide vanes + degenerate params (e.g. `HLE` ≤ 0) → existing positive-value validation covers it.
- Guide vanes are independent of the torque-foot gusset angle rule; both can be active.

## 7. Testing / verification

- **shared/API unit tests:** `guideVanes` accepted; default false; a `true` vs `false` build yields a **different hash**; flag does not change the 12 outputs.
- **CadQuery verification** (Windows `cadquery-env`, both variants, guideVanes on/off): build exits 0; passage sits in the old middle band; outlet at the collar bottom; blades present as a distinct patch; `guide_vane_walls` / `outlet` / `guide_vanes` appear in the manifest; shroud within the box. Render top + side views to confirm the ring seats correctly and the collar makes the passage `HLE` tall.
- **Cache:** purge `apps/api/storage/chamber` after builder changes (the hash does not capture Python constants or the asset).
- **web test:** the checkbox renders and round-trips into the request; outputs table unchanged.

## 8. Out of scope (YAGNI)

- No selectable vane angle (only the 50° "Open" asset for now; a 26° asset exists and could be added later behind the same mechanism).
- No independent control of vane count, hub ratio, or blade count — all inherited from the asset.
- No fused-solid (single watertight STL with blades) path — decision #1 chose the separate-patch route.

## 9. Open items to confirm at implementation

1. **Z orientation** of the source STL (which end is the open inlet) — verify and flip if needed so the open face meets the box cavity.
2. **Decimation ratio** — pick the coarsest level that still resolves the blade trailing edges acceptably for the mesher.
3. Whether the `outlet` should be split from `guide_vane_walls` by face-normal at preprocessing time (tag bottom-facing triangles) or by a planar test in the builder.
