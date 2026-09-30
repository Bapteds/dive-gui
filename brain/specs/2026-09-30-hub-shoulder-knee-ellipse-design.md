# Guide-vane hub shoulder — knee P2 from the P1–P3 quarter ellipse — design

**Date:** 2026-09-30
**Status:** approved (decisions taken by the user, Hristo Dimitrov, in a session with Claude Code); implemented 2026-09-30 on `fix/chamber-hub-knee-ellipse`.
**Feature:** Chamber Creation — guide-vane distributor, hub shoulder.
**Scope:** `apps/api/scripts/buildChamber.py` geometry only (analytic hub path of `make_vane_patches`), its tests and the brain. No shared-type, API-schema, web-form or MCP change; no new parameter, so the build hash is unchanged (cache purge needed).

**Supersedes** the P2 rule of `2026-08-10-hub-shroud-x1-adaptation-design.md` §4 (P2 at half `Δr_hub`) and its §6 decision 4 (fold accepted, `WARNING` only). The rest of that spec stays in force.

---

## 1. Goal

The hub shoulder is the meridional polyline **rim → P1 → P2 → P3 → flat roof**, revolved into the hub core. Under the 2026-08-10 rule P2's radius moved at half the rate of P1, so at large Runner Ø P1 overtook P2 and the shoulder folded back (warning `hub shoulder non-monotonic …`, from ≈ 2179 mm at ratio 0.45, ≈ 1961 mm at 0.50; and P2 passed P3 at the small end, ≈ 641 to 711 mm). The fold must disappear by construction.

## 2. The rule

Build-frame coordinates, `r` = radius from the distributor axis, `z` = up. P1 and P3 are computed exactly as before.

```
Δr = r_P3 − r_P1   (> 0)
Δz = z_P3 − z_P1   (> 0)

Construction ellipse: centre (r_P3, z_P1), radial semi-axis Δr, vertical semi-axis Δz
  → vertical tangent at P1 (continues the duct), horizontal tangent at P3 (continues the roof).

P2 = the ellipse point at 45°:
  r_P2 = r_P1 + (1 − √2/2)·Δr = r_P1 + 0.292893·Δr
  z_P2 = z_P1 + (√2/2)·Δz     = z_P1 + 0.707107·Δz
```

The ellipse is a construction only: the built profile stays **straight segments** `[rim, P1, P2, P3]` then the flat roof to `d_last/2`, densified and revolved as before. `z_P2` is computed in build z from the mapped `z_P1`, `z_P3` (the HLE map is affine, so it equals mapping the asset-z knee).

Code: `HUB_KNEE_R_FRACTION = 1 − √2/2`, `HUB_KNEE_Z_FRACTION = √2/2`; the pure helper `_hub_knee_from_ellipse(r_p1, z_p1, r_p3, z_p3) → (r_p2, z_p2)` holds the rule and raises `ValueError("hub shoulder degenerate: roof break not outside/above the duct top (P1=… P3=…)")` when `r_P3 ≤ r_P1` or `z_P3 ≤ z_P1` (cannot happen with today's P1/P3 rules; protects future changes). `_hub_point_radii` keeps its 4-tuple `(r_rim, r_p1, r_p2, r_p3)`, its `r_p2` taken from the helper (the knee radius does not depend on the heights).

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Knee | P2 = 45° point of the P1–P3 quarter ellipse (vertical tangent at P1, horizontal at P3). |
| 2 | Built profile | Straight segments P1 → P2 → P3 kept (no curve emitted). |
| 3 | P1 | Rule unchanged, including its 0.25 mm inward lean relative to the rim (user decision 2026-09-30). |
| 4 | P3 | Rule unchanged (`0.9384 × R_shroud`, roof height); its fit to real designs is a separate open question (`known-issues.md` §6). |
| 5 | Fold warning | Removed; replaced by a defensive refusal for a degenerate shoulder. The rim is never compared with P1. |
| 6 | Baseline shift | At the drawn baseline the knee moves by −3.8 mm radially and +7.0 mm vertically (asset scale): accepted. |

## 4. Reference numbers

Asset baseline (Runner Ø 1310, ratio 0.4515, `sz ≈ 1`), metres:

| Point | r | z | note |
|---|---|---|---|
| rim | 0.29573 | 0.05288 | unchanged |
| P1 | 0.29548 | 0.22608 | unchanged |
| P2 old (`P2_0`, history) | 0.39274 | 0.51575 | removed constant `VANE_HUB_P2` |
| P2 new | 0.38896 | 0.52276 | P1 + (0.2929·0.31917, 0.7071·0.41957) |
| P3 | 0.61465 | 0.64565 | unchanged |

Runner Ø 2420 (unclamped outlet), ratio 0.50: P1 r 604.7 mm, P3 1135.5 mm, old P2 547.4 mm (fold), new P2 760 mm. Runner Ø 700 / ratio 0.50: P1 175, P3 328, new P2 220 mm. The depth of P2 below the roof is always `(1 − 0.7071) ×` the depth of P1.

## 5. Verification

- `_test_hub_shroud_math.py`: baseline P2 0.38896; X1 1800 / 0.45: `p2 = p1 + 0.292893·(p3 − p1)`; sweep Runner Ø 700 → 2420 (step 20) × ratio {0.35, 0.45, 0.50}: `p1 < p2 < p3`; knee helper at baseline (0.38896, 0.52276), on the ellipse, degenerate cases refused.
- `test_build_chamber.py::test_hub_shoulder_is_monotonic_at_large_runner_diameter`: `stepped-vanes` scaled to LE Ø 3.95 m (so the outlet is not clamped), Runner Ø 2420, ratio 0.50: builds, watertight, no `hub shoulder` warning, min-r-per-2 mm-z-bin silhouette of the `hub` patch never steps inward by more than 1 mm. Red before the change (57.5 mm inward step).
- GOLDEN: `stepped` / `stepped-feet-off` unchanged (no vanes); vane goldens within `VOL_RTOL` or refreshed with justification in the changelog.
- API and web chamber suites unchanged (no TS reference to the warning text).
- Browser: shoulder at ≈ 1450 and 2420 mm without fold (to validate).

## 6. Out of scope

- The P3 radius rule and the P1 height rule (a real 2420 mm design has its roof break at 0.82 × outer rim and P1 at 0.90 × HLE below the roof): open questions in `known-issues.md` §6.
- The P1 rule and its lean; the outlet clamp; the shroud fillet; the vertical map; the empirical model; the non-vane path; the fallback path.
