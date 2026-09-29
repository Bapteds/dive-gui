# Guide-vane pocket robust to Runner case Ø close to or below LE Ø

> **Status**: implemented (2026-09-29) · **Date**: 2026-09-29 · **Workstream**: WS-A (Chamber Creation v2)
> **Area**: python (`apps/api/scripts/buildChamber.py`), shared + API (early refusal), tests
> **Related**: `brain/features/chamber-creation.md` §3.6, §3.8, §3.9, §4.3, §4.4; `brain/playbooks/change-chamber-geometry.md`

## 1. Goal

With guide vanes, the builder carves the whole disk `r < dLast/2` out of the runner case (first cylinder) and places the distributor inside it. The runner case only keeps its outer ring `[dLast/2, dFirst/2]`. This spec makes the three regimes of Runner case Ø (`dFirst`) against LE Ø (`dLast`) produce clean patches or a clear refusal. It must not change the geometry of the default regime.

## 2. Findings (reproduction of 2026-09-29, 45 builds, CadQuery 2.8.0 on Windows)

Ring width `w = dFirst/2 − dLast/2` (scaled, metres). Default ratio 1.14703 gives `w = 0.0735 · dLast`.

| Regime | Observed |
|---|---|
| `w > 10 mm` | Clean. GOLDEN volumes reproduced. |
| `0 < w ≤ 10 mm` | The shroud casing overshoot (outer wall at `dLast/2 + FLOOR_OVERCUT`, lines ~682 and ~1149) pokes out of the thin ring. Its full-height outer wall becomes wetted (3 to 7 m²) and the nearest-source vote splits it between `cylinder_walls`, `shroud` and `walls`. |
| `w ≤ 0` | The runner case is **silently erased**: the typed Runner case Ø is ignored (identical STL for equal, −2 mm, 0.9×, 0.75×). The casing wall comes out as `shroud` + `walls`, and up to 21 % of the chamber floor is labelled `shroud`. With feet, the legs are still placed from `dFirst` and **cut the blades** with no refusal (vane area −10 %). |

No crash was reproduced; the user did not supply a failing case (the refusal below covers the whole `dFirst < dLast` range anyway). The suspected "invalid OCC solid" is refuted: cutting the disk just deletes the first cylinder.

Places hard-wired to `dLast/2` in the vane path (audit): blade ring scale without `dMiddle` (~512), analytic and fallback hub roof (~656, ~672), shroud brim and casing outer wall (~682, ~1149), `make_feet` gusset base (~1776, while the leg tips use `dFirst`, ~1734), first-cylinder cavity (~1802), `cylinder_walls` source bottom disk (~1975), roof override to `hub` (~2001); plus `rmax` (~1596, ~1614) and `pocket_radius` (~1813) which use `dFirst`.

## 3. User decisions

1. `dFirst < dLast` with guide vanes: **refuse** with a clear lever message (option c).
2. Snap tolerance **5 mm on the diameter**: `|dFirst − dLast| ≤ 5 mm` is treated as equal (runner case built flush with LE Ø, no ring).
3. The snap emits a **warning**.
4. No failing case to reproduce: proceed.

## 4. Changes

### 4.1 Resolved radii (builder)
- `R_env = d_last / 2`: the single distributor-envelope radius, used by every place listed in §2 that means "the distributor edge" (hub roof, brim, casing wall, cavity, roof override, `cylinder_walls` source disk).
- `r_case = d_first / 2`, `w = r_case − R_env`.
- **Snap**: if guide vanes and `|d_first − d_last| ≤ SNAP_D_TOL` (`SNAP_D_TOL = 0.005` m, a new constant, compared on the scaled diameters): `r_case_eff = R_env`, no ring is kept, no casing overshoot beyond `R_env`. Otherwise `r_case_eff = r_case`.
- **Overshoot guard**: the casing outer wall is `R_env + min(FLOOR_OVERCUT, w / 2)` when `0 < w`, so it never pokes out of a thin ring. For `w ≥ 2 · FLOOR_OVERCUT` (20 mm and more) this equals today's `R_env + FLOOR_OVERCUT`: byte-identical for the default regime.
- Feet, `rmax` and `pocket_radius` use `r_case_eff`. `make_feet` receives `r_case_eff` for both its gusset base and its leg tips when vanes are on (removes the `dLast`/`dFirst` inconsistency).

### 4.2 Refusal
Guide vanes on and `d_first < d_last − SNAP_D_TOL` (scaled):
- **API** (422 `VALIDATION_ERROR`, before CadQuery, only when `dFirst` is typed; the auto ratio is always larger): a pure helper `runnerCaseBelowLeRefusal(input, outputs)` in `@dive/shared`, called in `chamber.service.buildChamber` next to `blankGeneratorHeightRefusal`.
- **Builder** (same rule, `ValueError`, for direct calls and old params).
- Text: "With guide vanes the distributor sits inside the runner case: Runner case Ø (1450 mm) must be at least LE Ø (1600 mm). Increase Runner case Ø, clear it (auto ≈ 1835 mm), or turn Guide vanes off."

### 4.3 Warning (snap)
`WARNING: Runner case Ø 1602 mm is within 5 mm of LE Ø 1600 mm: built flush with it.` (stdout, collected as usual).

### 4.4 Deterministic labels at the junction
Applied after the nearest-source vote and before the blade-skin mask:
- vertical faces with `|r − r_case_eff| < 3 mm` and `z < z_mid_base` → `cylinder_walls`;
- horizontal faces with `z_brim ≤ z ≤ z_mid_base`: `r > R_env + 1 mm` → `cylinder_walls`; `ro + 3 mm < r < R_env − 1 mm` → `shroud`;
- the small vertical step at `R_env` (casing edge) → `shroud`;
- horizontal floor faces at `z_box_floor` with `r > max(ro, r_case_eff) + 1 mm` → `walls`.
Simulated on the default fixtures: 0 labels changed except 182 triangles (0.004 m²) moving from `cylinder_walls` to `shroud` on the `hollow-vanes-overrides` fixture (bytes of the STL unchanged).

### 4.5 Not changed
Patch names and list, default geometry (GOLDEN volumes), vane-less builds, the hub shoulder rule (user decision 2026-09-29: keep the current rule).

## 5. Tests (written first)
- **pytest** (`test_build_chamber.py`), from `hollow-vanes-overrides` and `stepped-vanes`:
  - `dFirst` = LE Ø − 50 mm → exit 1, `KO:` names Runner case Ø and LE Ø;
  - `dFirst` = LE Ø + 2 mm → builds, `WARNING` "built flush", exact `VANE_PATCHES`, no `shroud` face with `r > R_env + 1 mm`, no `walls` face on the casing wall, watertight STL;
  - `dFirst` = LE Ø + 12 mm (thin ring) → builds, no `shroud`/`walls` triangle on the runner-case wall (vertical, `r ≈ r_case`), watertight;
  - existing GOLDEN tests unchanged.
- **API** `chamberModel.test.ts`: `runnerCaseBelowLeRefusal` (typed below, within 5 mm, auto, vanes off); `chamber.test.ts`: 422 with the message, no builder call.
- **Web**: none (message shown through the existing "Build errors" block).

## 6. Deployment
`buildChamber.py` changes ⇒ purge `apps/api/storage/chamber/*` locally and `/var/lib/dive/storage/chamber/*` on the server.

## 7. Out of scope
Option (a) shrinking the distributor, option (b) widening the runner case, the hub shoulder rule, feet at small Runner Ø.
