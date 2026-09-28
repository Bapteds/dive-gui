# Guide-Vane STEP Export — Design

**Date:** 2026-08-13
**Status:** Draft for review
**Feature branch context:** `feat/chamber-creation`

## Goal

Make `chamber.step` contain the true guide-vane fluid geometry (blades + hub +
shroud carved out) as **editable BREP**, so a guide-vane build's STEP opens in
desktop CAD (SolidWorks / Inventor / FreeCAD) as real, dimensionable surfaces —
not the current vane-less solid, and not a faceted mesh shell.

## Problem

For guide-vane builds the OCC solid `result` (`box − part − feet`) never contains
the distributor: the middle cylinder is omitted and the hub/shroud/blades exist
only as **trimesh** geometry. The true fluid body `fluid_F` is computed with a
mesh boolean (`manifold`). STEP can only be written from an OCC BREP, so today it
falls back to `result` — a chamber with an empty throat
([buildChamber.py:1590-1598](../../../apps/api/scripts/buildChamber.py)).

STL, GLB, `edges.bin`, `manifest.json`, the triSurface zip, and patch
classification already carry the correct vane geometry (mesh); **only STEP is
wrong**.

## Non-goals

- No change to the mesh pipeline (`fluid_F`, GLB, STL, edges, manifest,
  triSurface, classification) — it stays the source of truth for meshing and the
  viewer, and must remain byte-identical for existing builds.
- No change to non-guide-vane builds (their STEP is already correct).
- No re-meshing / re-tuning of the vane distributor math.
- Not attempting to support the dead legacy non-analytic vane path (see
  "Legacy builds").

## Key decisions (settled with the user)

1. **Fidelity:** the STEP feeds *editable* desktop CAD → genuine analytic/NURBS
   BREP required. A faceted mesh-in-STEP shell is explicitly rejected.
2. **Failure policy:** if the OCC reconstruction/boolean fails or the safety gate
   rejects it → **fall back to today's clean vane-less STEP + `WARN`**; the build
   still succeeds. A STEP problem must never fail the chamber build.
3. **Safety gate:** the OCC fluid solid is trusted only if its volume matches the
   already-trusted mesh `fluid_F` volume within tolerance (plus a validity
   check). Otherwise → fallback.
4. **UI surfacing:** when a guide-vane STEP falls back to vane-less, surface it in
   the app (a `stepHasVanes: false` signal), not just a server log.

## Architecture

A single **additive, isolated** change in `buildChamber.py`, inside the
`if guide_vanes:` branch only, plus a one-time offline asset-bake and a small
build-metadata flag surfaced to the web UI.

The existing mesh distributor (`_core`, `_casing`, `_prisms`, `_solid`,
`fluid_F`) is **unchanged**. We add a *parallel* OCC solid built solely to write
`chamber.step`. If any part of it fails, we fall back to the current behaviour.

```
                         (unchanged mesh pipeline) ──────────────► fluid_F ─► GLB/STL/edges/manifest/triSurface
resolved params ─► buildChamber.py main() ─┤
                                           └─(new, guide-vane only)─► OCC distributor ─► result.cut ─► occ_fluid ─► volume gate ─► chamber.step
                                                                                                                         │ fail
                                                                                                                         └────► vane-less STEP from `result` + WARN + stepHasVanes:false
```

## Component 1 — One-time asset bake (offline script, committed output)

The clean blade comes from the user-provided SolidWorks STEP
(`GuideVanes50Deg.STEP`). Findings from inspection:

- It contains **shell 1 (4 NURBS faces) = the blade**, geometrically identical to
  the baked `assets/guideVanes_blade.stl`: radial range `0.700–1.034 m`, height
  `0.557 m`, azimuth span `15.9°` all match exactly. (Shell 0 = hub+shroud, which
  we ignore — the build regenerates hub/shroud parametrically.)
- The only frame difference vs. the asset is a **rotation about the vertical axis
  + a +0.425 m vertical shift**; radius is identical (same axis, no XY offset, no
  scale).

A committed offline script (e.g. `apps/api/scripts/bakeVaneBladeProfile.py`) will:

1. Load the STEP, isolate the blade shell (the shell whose r-range/height/azimuth
   match the blade — **not** by shell index, which is export-order-fragile).
2. Compute the 2-parameter rigid alignment (`Δθ` about Z, `Δz`) that maps the STEP
   blade onto the asset-frame blade (validated against `guideVanes_blade.stl` by
   point-cloud overlay; assert max deviation below a small tolerance).
3. Because the blade is **prismatic** (the build already relies on this), extract
   the airfoil as a single clean 2D section in asset frame, plus its z-range.
4. Commit the result as a new asset, e.g. `assets/guideVanes_blade_profile.json`
   (an ordered list of section points forming the airfoil loop, in asset metres),
   alongside a provenance note.

This quarantines all STEP handling and alignment risk to a one-time, verifiable
step; the per-build code never touches the STEP.

## Component 2 — OCC distributor in the build (guide-vane branch)

After the existing mesh distributor is built, construct an OCC (CadQuery) sibling
from the **same analytic data already in scope**:

- **Hub core → `revolve`** the analytic hub profile
  (`_core_prof`, [buildChamber.py:1374](../../../apps/api/scripts/buildChamber.py))
  about the part axis `(target_x, target_y)`. Clean BREP surface of revolution.
- **Shroud casing → `revolve`** the annular shroud profile
  (`_cas_prof`, [buildChamber.py:1390](../../../apps/api/scripts/buildChamber.py)).
- **Blades → `extrude`** the committed clean airfoil profile (Component 1): apply
  the same per-blade placement the mesh path uses (radial scale `s`, pitch about
  the spindle by `vane_angle_deg`, ring-replicate by `bladeAngleStepDeg`), then
  extrude vertically across the passage span. Because the profile is a clean 2D
  curve and every transform is affine-in-XY (scale/rotate) + a vertical extrude,
  the blades come out smooth and editable.
- `occ_distributor = hub_core ∪ shroud_casing ∪ blades` (union), then
  `occ_fluid = result.cut(occ_distributor)`.

Overlaps/overcuts mirroring the mesh path (`FLOOR_OVERCUT`, the blade→shroud
penetration) are reproduced so no faces are exactly coincident (OCC booleans fail
on coincident geometry).

### Boolean strategy

Default: build the union then one cut. If that proves fragile in the spike, fall
back to sequential cuts (`result.cut(core).cut(casing).cut(blade_i)…`) — a tuning
detail decided during implementation, not a design fork.

## Component 3 — Safety gate & fallback

Wrap the entire OCC reconstruction in a guard. `occ_fluid` is accepted only if:

- it is a **single, valid, closed solid**; and
- `abs(occ_fluid.Volume − fluid_F.volume) / fluid_F.volume ≤ VOL_TOL`
  (`VOL_TOL` pinned in the spike; ~1–2 % to absorb tessellation differences
  between the OCC solid and the mesh boolean result).

On acceptance → write `chamber.step` from `occ_fluid`, set `stepHasVanes = true`.
On any exception, invalid solid, gate failure, or missing clean profile →
write today's vane-less STEP from `result`, emit `WARN`, set
`stepHasVanes = false`. The build always succeeds.

## Component 4 — Surfacing the fallback in the UI

- Persist a small per-build flag in the build directory, e.g.
  `build-meta.json = { "stepHasVanes": true | false }`, written **only** for
  guide-vane builds (absent/`null` ⇒ not applicable, i.e. non-vane build always
  has a correct STEP).
- Expose it to the frontend via the least-invasive path — decided during the
  plan; candidates: a field in the chamber build result that is also persisted
  and returned on cache hits, or a tiny meta endpoint / manifest sidecar. The
  chosen path must return the flag on **cache hits** too (re-opening a cached
  chamber), not only at first build.
- In `ChamberExportButtons`, when `stepHasVanes === false`, show a note on the
  STEP download ("STEP omits guide vanes for this build") so an operator doing
  editable-CAD work is not misled.

## Legacy builds

The analytic vane path always runs for current builds (`outletOuterD = X1` and
`outletRatio` are always supplied by the service), so `_core_prof`/`_cas_prof`
always exist. A build without them (only possible for stale cached builds
predating the analytic path) simply takes the fallback — no special handling,
`stepHasVanes = false`.

## Testing & verification

1. **Spike first (throwaway):** for 2–3 representative cached guide-vane builds
   (stepped+vanes, hollow+vanes), build `occ_fluid`, confirm (a) the volume
   matches `fluid_F` within tolerance and (b) it opens in FreeCAD as real BREP
   with the vanes present and analytic/NURBS faces. This de-risks the OCC boolean
   before committing to the full build-out. If the boolean proves too fragile,
   re-evaluate before proceeding.
2. **Asset-bake test:** the baked airfoil overlays `guideVanes_blade.stl` within
   tolerance (alignment correctness).
3. **Builder tests:** volume-match assertion across variants and a few vane
   angles / `dMiddle` overrides; gate rejects a deliberately corrupted case.
4. **Fallback test:** force a reconstruction failure → assert vane-less STEP,
   `WARN`, and `stepHasVanes = false`.
5. **Regression:** non-vane and legacy STEP unchanged; GLB / STL / edges /
   manifest / triSurface byte-identical for existing builds; existing chamber and
   meshing tests stay green.
6. **UI:** the STEP note appears iff `stepHasVanes === false`, including on a
   cache-hit re-open.

## Risks

- **OCC boolean robustness/perf** is the primary risk (why the vane path is
  mesh-only today). Mitigated by: the spike, the volume gate, the always-safe
  fallback, and reproducing the mesh path's overlaps. Build time may rise for
  guide-vane builds (one-time per unique param hash, cached thereafter).
- **Alignment drift** between the STEP blade and the baked STL — mitigated by the
  overlay assertion in the bake step and the volume gate at build time.

## Open questions for the plan

- Exact `VOL_TOL` and the OCC boolean strategy (union-cut vs sequential) — settled
  empirically in the spike.
- The precise frontend transport for `stepHasVanes` (build result vs sidecar vs
  manifest field) — chosen in the plan against the existing chamber API shape.
