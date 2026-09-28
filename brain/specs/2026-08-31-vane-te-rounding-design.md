# Guide-vane trailing-edge rounding — design

**Date:** 2026-08-31
**Status:** approved (user picked tangent rounding over a literal semicircle cap)

## Problem

The guide-vane blade ends in a BLUNT trailing edge: the CAD airfoil's TE is a flat
base ~4.46 mm wide (1.11 % of the 0.4007 m chord) meeting the two blade surfaces at
sharp corners (~69° and ~21° turns). Those corners force the mesher (cfMesh/snappy)
into degenerate cells / heavy local refinement at every one of the 16 blades. The
user wants the TE rounded ("like a half circle") so the fluid meshes cleanly.

The leading edge is already round (osculating radius ≈ 13.6–15.7 mm) and must stay
untouched.

## Where the blade shape actually lives

Everything the mesher and the CAD export see flows from the blade's 2D cross-section
(the blade is prismatic):

1. **Mesh / triSurface / GLB path** — `_vane_prisms()` in
   `apps/api/scripts/buildChamber.py` sections each placed blade at mid-height,
   turns the loop into a shapely Polygon and extrudes it; the prisms are unioned
   with the hub core + shroud casing and boolean-subtracted from the fluid
   (`fluid_F`). All emitted patches (and `chamber.stl`, the mesher's domain) come
   from `fluid_F`, so rounding the section rounds every downstream artifact.
2. **STEP path** — `build_vane_step_solid()` fits the committed clean airfoil
   (`assets/guideVanes_blade_profile.json`) onto each placed blade section, then
   lofts a periodic spline. The same rounding must be applied to the placed loop so
   `chamber.step` matches the meshed fluid (and the STEP volume gate stays exact).

No asset re-bake, no UI change, no new parameter.

## Approach (chosen): tangent rounding via morphological opening

A single 2D helper `_round_blade_te(np, loop)`:

- radius `r = VANE_TE_ROUND_R_FRAC × chord(loop)` with
  `VANE_TE_ROUND_R_FRAC = 0.00585` — half the CAD base-width fraction
  (0.01114 / 2) × 1.05 margin. Chord is measured per loop (PCA extent), so the
  radius scales automatically with the vane ring diameter and pitch rotation.
- `Polygon(loop).buffer(-r, quad_segs=16).buffer(+r, quad_segs=16)` (opening):
  erosion collapses the blunt tail where thickness < 2r; dilation rebuilds it as an
  arc **tangent to both blade surfaces** with radius r. Chord is preserved (the
  reconstructed tip lands on the old base plane); the LE (radius ≈ 6× r) is
  restored to within ~0.05 mm.
- Guards (never fail a build): shapely missing → return the loop unchanged;
  erosion producing a MultiPolygon → keep the largest part; |area drift| > 2 % →
  return the loop unchanged.

Verified numerically on the committed profile: area drift −0.07 %-ish, TE arc fits
a circle of radius ≈ r with sub-0.1 mm residual, points > 3r from the old base are
unchanged to < 0.1 mm.

### Alternative rejected

Semicircle cap bulged from the existing flat base: simpler mental model but grows
the chord ~2.2 mm and leaves ~20° kinks where the arc meets the converging blade
surfaces (the surfaces are not parallel at the base), i.e. worse meshing than the
tangent arc.

## Changes

- `apps/api/scripts/buildChamber.py`
  - new module constants + `_round_blade_te(np, loop)` helper;
  - `_vane_prisms()`: round the section loop before `Polygon(...)`;
  - `build_vane_step_solid()`: round the `placed` airfoil loop before the periodic
    spline (fit stays on the raw blunt loops — exact match — rounding is applied in
    final coordinates).
- `apps/api/scripts/tests/test_build_chamber.py`
  - unit test of `_round_blade_te` on the committed profile: TE corners gone, arc
    radius ≈ r, area preserved, LE untouched, no-op guards;
  - build-level test: a mid-height section of a built vane (from
    `guide_vanes.stl` in `trisurface.zip`) has a circular TE of the expected
    radius.
- Golden volumes in the suite are unaffected (the rounding moves ~1e-4 m³ against
  130–150 m³ goldens, far inside VOL_RTOL).

## Observed outcome (post-implementation)

All golden volumes unchanged. Side benefit: the `hollow-vanes` STEP export used to
fall back to the vane-less solid (its OCC boolean self-overlapped and was rejected
by the round-trip volume gate); the self-overlap originated at the blunt TE
corners, so with the tangent rounding **both** vane variants now ship editable
BREP vanes in `chamber.step` (`stepHasVanes: true`). The policy test was updated
accordingly.

## Error handling

The helper is fully guarded and degrades to the current blunt geometry rather than
failing the build — consistent with the STEP path's "nothing here can fail the
build" policy.
