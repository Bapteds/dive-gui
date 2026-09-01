# Part-fit refusals: width overflow error + hollow height refusal — design

**Date:** 2026-08-31
**Status:** approved (user-prescribed: "introduce a new error which tells that the
part has width larger than the box" + "the part not to be scaled down in the
hollow variant, but rather reject the build")

## 1. Width (radial) overflow — new error, both variants

The part axis sits `distFromSideChamfer1` (B1) from the chamfer-side wall and
`distFromEnd` (LT) from the chamfered end. Nothing checked the radial fit, so an
oversized part (big Part scale, or dFirst/dMiddle overrides) silently cut through
the box side wall and the build "succeeded" with broken geometry.

New check in `buildChamber.py`, right after the per-variant part build (where
`rmax = max(d_first, d_middle, d_last) / 2` is computed): the largest internal
radius must clear all four walls —

- chamfer-side wall: `B1`
- far side wall: `B Kammer − B1`
- chamfered end: `LT`
- inlet end: `Length − LT`

If `rmax` exceeds the smallest clearance the build is REFUSED (KO) with a message
naming the violated wall, the part diameter/radius, the available clearance, and
the levers (increase B Kammer / Length or move the axis via B1 / LT, reduce Part
scale / diameter overrides). The KO text reaches the UI through the existing
error plumbing (red notices panel + toast).

## 2. Hollow H-Kammer overflow — refuse instead of scale-to-fit

Until now a hollow stack taller than H Kammer was silently (then warned-ly)
scaled down to fit — load-bearing behavior, since typical hollow configurations
overflow at Part scale 1. Per user decision this becomes a REFUSAL, mirroring the
stepped variant: KO with the stack height, the allowed height, and the exact
`Part scale ≤ X` that would fit (X = the factor the old clamp would have applied),
plus the other levers (lower cone/generator/dome heights or HLE, raise H Kammer).

Consequence (accepted): hollow builds at Part scale 1 that used to auto-shrink now
fail until the user sets the suggested Part scale (or resizes the heights).

## Test changes (apps/api/scripts/tests)

- `params/hollow-vanes.json`: `partScale` 1 → 0.7944 (the value the old clamp
  picked for these params) so the golden fixture keeps building the same
  geometry; golden volume refreshed if drifted.
- `test_hollow_overflow_clamps_to_fit_with_a_warning` → replaced by
  `test_hollow_overflow_is_refused`: `hollow-vanes` with `partScale: 1` must KO
  mentioning H Kammer and the suggested Part scale.
- New `test_part_wider_than_box_is_refused`: an absurd `dFirst` override must KO
  naming the violated wall; runs on the stepped fixture (the check itself is
  variant-independent).

No web/API code changes: the KO text already surfaces in the red notices panel
and the toast (feature 2026-08-31 "errors in both places").
