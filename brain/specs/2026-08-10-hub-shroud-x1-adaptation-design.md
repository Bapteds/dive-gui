# Guide-vane hub & shroud — X1-driven parametric reshaping — design

**Date:** 2026-08-10
**Feature:** Chamber Creation — guide-vane distributor, hub/shroud adaptation to outlet size
**Scope:** `apps/api/scripts/buildChamber.py` geometry only (`make_vane_patches` + the hub-core / shroud-casing builders in `main()`). No shared-type / API-schema / web-form change — this reuses the existing `outletOuterD` (= X1·MM_TO_M) and `outletRatio` params already plumbed by the 2026-08-06 feature. No change to the empirical model or the non-guide-vane path.

**Supersedes** the hub/shroud reshaping half of `2026-08-06-outlet-x1-ratio-design.md` §5.2–5.3 (the "monotonic piecewise-linear radial remap pinned at both rims, identity beyond `R_anchor`"). The **rims** (`ro_target = X1/2`, `ri_target = outletRatio·ro_target`) and all the parameter plumbing from that feature are kept unchanged; only how the hub shoulder and shroud floor are *built between and beyond the rims* changes.

---

## 1. Goal

Today, changing X1 / `outletRatio` reshapes **only** the region between the two outlet rims and the vane inner working radius `R_anchor` — everything beyond `R_anchor` (hub shoulder, roof, shroud brim) is held at identity by the pinned-rim remap. The user wants the **hub shoulder and the shroud fillet to adapt to the outlet size**, driven parametrically:

1. The hub meridional profile is defined by **3 interior points** (P1, P2, P3) plus the inner rim and the roof edge. As the outlet rims move, these points move by explicit rules (§4).
2. The shroud floor fillet is an **axis-aligned ellipse** whose semi-axes scale with the outer rim, so `R_curve / (X1/2)` is held constant (§5).

This replaces the mesh-silhouette + PCHIP-smoothing hub/shroud construction (and the pinned-rim `place_throat` remap) with **analytic meridional profiles** revolved directly.

## 2. Current mechanism (as verified in code)

- `make_vane_patches` loads `guideVanes_walls.stl`, splits it into hub/shroud by face normal (`_split_hub_shroud`), and applies `place_throat` — a piecewise-linear **radial** remap pinned at the two rims, identity beyond `R_anchor` (the vane's own inner working radius, measured from the placed+pitched reference blade). `z` follows the HLE vertical map `z = z_sb + z_asset·sz`, where `sz = band / (height − blade_z0)` and `band = z_mid_top − z_mid_base = hMiddle`.
- The hub patch = `place_throat(hub_walls)` throat + a synthesised flat roof out to `d_last/2`. `_hub_core_solid` revolves a **PCHIP-smoothed** silhouette of that throat.
- The shroud patch = `place_throat(shroud_walls)`; `_shroud_casing_solid` revolves a **PCHIP-smoothed** monotone floor contour read off that mesh. The blade drape reads `shroud_floor_z(r)` off the placed shroud mesh.
- The outlet = `place_throat(outlet_asset)` — the passage's bottom annular face.
- Rims: `ro_target = outletOuterD/2 = X1/2` (absolute metres); `ri_target = outletRatio · ro_target`. Both clamped by `VANE_OUTLET_SAFE_MARGIN (0.97) · R_anchor`.

## 3. Baseline constants (measured from the committed `guideVanes_walls.stl`)

All in **asset space = absolute metres** (the "as-drawn" reference; see §6 for the basis decision). Recovered by RDP reduction of the meridional silhouette (`_diag_rdp.py`, `_diag_baseline.py`, `_diag_shroudcurve.py`):

| symbol | value | meaning |
|---|---|---|
| `R_hub0` | 0.29573 | baseline inner rim (`outletInnerR`) |
| `R_shroud0` | 0.65500 | baseline outer rim (`outletOuterR`) |
| `P1_0` (r, z) | (0.29548, 0.22608) | hub duct-top → shoulder |
| `P2_0` (r, z) | (0.39274, 0.51575) | hub shoulder knee |
| `P3_0` (r, z) | (0.61465, 0.64565) | hub roof break |
| `P3_ratio` | `P3_0 / R_shroud0` = **0.93840** | P3's fixed ratio to the outer rim |
| `ELL_A` | `a / R_shroud` = **0.160** | shroud fillet radial semi-axis ratio |
| `ELL_B` | `b / R_shroud` = **0.119** | shroud fillet vertical semi-axis ratio |

The hub interior points are exactly three (verified objectively by RDP: 5 total meridional vertices → 3 interior). The shroud fillet is a short quarter-arc better described by an axis-aligned ellipse than a circle (RMS 0.00038 vs 0.00064 in the fit).

## 4. Hub — 3-point radial rule

Rims (unchanged from the 2026-08-06 feature): `R_shroud_new = X1/2`, `R_hub_new = outletRatio · R_shroud_new`, both clamped as today. Deltas:

```
Δr_hub    = R_hub_new    − R_hub0            # depends on BOTH X1 and ratio (via R_hub)
R_shroud_new                                  # depends on X1 only
```

Radial positions (metres); **z of every point is unchanged** — it keeps the existing HLE vertical map `z = z_sb + z_asset·sz`:

| point | new radius | driver |
|---|---|---|
| inner rim | `R_hub_new` | X1 + ratio |
| **P1** | `P1_0 + Δr_hub` | X1 + ratio — tracks the rim ⇒ duct stays vertical |
| **P2** | `P2_0 + Δr_hub / 2` | X1 + ratio — half-rate |
| **P3** | `P3_ratio · R_shroud_new` (= 0.93840·X1/2) | **X1 only** — proportional to the outer rim, ratio-independent |
| roof edge | `d_last / 2` | chamber (unchanged) |

**Hub meridional polyline** (revolved for the core, emitted as the hub patch):
`(R_hub_new, z_rim) → P1 → P2 → P3 → (d_last/2, z_roof)`, then flat roof out to the wall — no PCHIP, no mesh silhouette.

**Rationale for the P1/P2/P3 split** (locked with the user):
- P1 at full `Δr_hub` keeps the vertical duct wall aligned with the moving rim.
- P2 at half `Δr_hub` — the user's chosen middle-point behaviour. Accepted trade-off: because P1's rate (1·Δr) exceeds P2's (½·Δr), **P1 overtakes P2 at high X1** (≈ X1 2179 mm at ratio 0.45), folding the profile. This is knowingly accepted; the builder prints a `WARNING` when the polyline goes non-monotonic but does **not** clamp.
- P3 proportional to `R_shroud` (fixed ratio, not fixed offset) so the outlet region stays **geometrically similar** across sizes (consistent with `R_hub` and the shroud ellipse, which also scale proportionally with `R_shroud`), and to avoid a *second* fold at the low-X1 end that a fixed offset introduces (offset would drop P3 below P2 near X1 700; ratio keeps it above).

## 5. Shroud — scaled ellipse fillet

The shroud floor fillet is rebuilt as an **axis-aligned quarter-ellipse** whose semi-axes scale with the outer rim (so `R_curve / (X1/2)` is constant — exactly, for every radius of the curve):

```
a = ELL_A · R_shroud_new      # radial semi-axis  (0.160 · X1/2)
b = ELL_B · R_shroud_new      # vertical semi-axis (0.119 · X1/2)
```

Geometry: seated at the inner rim `r = R_shroud_new` (vertical tangent), rising with a horizontal tangent into the flat brim; brim runs out to `d_last/2 + FLOOR_OVERCUT` (unchanged). `_shroud_casing_solid` revolves this analytic floor; the blade drape reads `shroud_floor_z(r)` from the analytic curve instead of the placed mesh.

**Consequence noted with the user:** because *both* semi-axes scale with `R_shroud`, the fillet's *vertical* extent `b` is now X1-driven, not HLE-driven — a tall fillet under a short HLE band is a possible edge case to watch in verification.

**Ellipse method chosen over "scale the true curve":** the user confirmed the curve is intended to be an ellipse; the two approaches are identical when the true curve is an ellipse, and the explicit-ellipse form is cleaner to parametrise. It carries the fit's ~0.4 mm deviation from the raw STL points at baseline.

### 5.1 Outlet cap and ducts

The outlet cap is the flat annular face at the passage bottom between the hub inner duct (`r = R_hub_new`) and the shroud rim (`r = R_shroud_new`) — a `_flat_annulus(cx, cy, z_floor, R_hub_new, R_shroud_new)`, replacing the `place_throat(outlet_asset)` mesh (the placed asset's "slight conical" outlet becomes a clean flat annulus between the two analytic rims; confirm in review that losing the small cone is acceptable). The hub and shroud straight ducts down to the box floor (`_open_cylinder` at `R_hub_new` / `R_shroud_new`) are retained as today.

## 6. Basis decisions (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Radial basis | **Absolute metres, independent of the vane radial scale `s`.** Baseline point radii = the asset values (§3) used directly as metres. Only the roof edge (`d_last/2`) and the vane blades stay on `s`. |
| 2 | Z basis | Radii are X1-driven, but **z keeps the existing HLE vertical map** (`z_sb + z_asset·sz`). X1/ratio changes move radius only ("Zp does not change"); the HLE band still sets the hub's height so the roof meets the upper cylinder and the duct reaches the floor. |
| 3 | P1 rate | Full `Δr_hub` (duct vertical). |
| 4 | P2 rate | Half `Δr_hub` (fixed), fold at high X1 accepted, `WARNING` only. |
| 5 | P3 | Fixed **ratio** to `R_shroud` (0.93840), ratio-independent. |
| 6 | Shroud curve | Explicit axis-aligned ellipse, semi-axes ∝ `R_shroud`. |

## 7. Backward compatibility

- Params JSON without `outletOuterD` / `outletRatio` (old cached builds) → the **existing** fallback in `make_vane_patches` still applies: rims fall back to the historical asset-derived values **and** the hub/shroud fall back to today's mesh-based construction (the new analytic path is entered only when both params are present). Old builds reproduce byte-identical geometry.
- Non-guide-vane path: untouched.
- At the defaults the new analytic hub/shroud will differ slightly from today's mesh-derived geometry (the deliberate correction of this feature), not a regression to guard against — but the default case must still read as a clean distributor.

## 8. Verification plan

Extend `_verify_outlet_ratio.py` (the existing regression net) across the short/tall/cone matrix × `outletRatio ∈ {0.35, 0.45, 0.50}` × a low, default, and high X1 (to exercise both fold regions and the clamp):

- `F` watertight, single connected component.
- Rims exact: outlet outer radius == `R_shroud_new` (or clamped, WARNING present); inner == `outletRatio · R_shroud_new`.
- Hub points land at `P1_0+Δr`, `P2_0+Δr/2`, `P3_ratio·R_shroud` (± tessellation tolerance); polyline monotonic except where the accepted high-X1 fold is expected (assert the WARNING fires there).
- Shroud fillet: `a/R_shroud` and `b/R_shroud` constant across the sweep (the core invariant); floor monotone non-decreasing in r.
- No stray/misclassified faces at the outlet corner or under the vanes.
- Fallback (no new params) reproduces the pre-feature volume to the same tolerance the 2026-08-06 feature verified (tall ≈ 88.79).
- 31 existing `chamber` vitest tests pass unmodified.
- Manual build + app review of the rendered GLB at default and at a couple of X1/ratio extremes.

## 9. Out of scope

- The rims, the clamp, and all parameter plumbing (shared type / schema / form / service) — reused unchanged from the 2026-08-06 feature.
- The empirical model, `CHAMBER_INPUT_RANGES`, and the non-guide-vane path.
- The normal-orientation flip flagged in `HANDOVER.md` §4 (separate task).
- A clamp for the accepted high-X1 hub fold (warning only, by decision).
