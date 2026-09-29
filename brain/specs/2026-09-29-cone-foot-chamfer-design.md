# Cone foot chamfer (replaces the top-rim cone chamfer)

> **Status**: implemented (2026-09-29) · **Date**: 2026-09-29 · **Workstream**: WS-C v2 (Chamber Creation v2, branch `feat/chamber-v2-cfd-loop`)
> **Supersedes**: `2026-09-29-cone-chamfer-design.md` (top-rim chamfer, implemented in `dbc944a` then rejected by the user: the chamfer belongs on the lower edge)
> **Area**: shared, API, python, web, tests

## 1. Goal

A 45° chamfer on the **lower outer edge** of the LE part, where it stands on the distributor roof at LEB, right above the guide vanes. The part is widened by the chamfer size above it, so the chamfer foot lands exactly on LE Ø/2 at the roof: the joint with the distributor does not move.

## 2. User decisions (2026-09-29)

1. The top-rim chamfer is removed completely (code, form, tests, brain). The branch was never deployed, so no compatibility is kept for it.
2. Geometry: outer radius `LE Ø/2 + c` above the chamfer, 45° chamfer from `(r = LE Ø/2, z = LEB)` to `(r = LE Ø/2 + c, z = LEB + c)`. Inner Ø unchanged (the With cone wall is `c` thicker).
3. **Both designs**: With cone (the cone) and Closed generator (the LE cylinder, which runs through the ceiling).
4. Form: "Cone chamfer" checkbox + "Cone chamfer size (mm)" field, default 50 mm (× Part scale in the builder, like every part dimension). The keys `coneChamferEnabled` / `coneChamferSize` are reused (their meaning changes; nothing on `main` uses them).

## 3. Changes

- **Builder** (`buildChamber.py`): read `P.get("coneChamferEnabled", False)` / `P.get("coneChamferSize", 0.05)`; when on, the LE part (stepped last cylinder, hollow cone outer wall) is built with outer radius `r_le + c` above `LEB + c` and a 45° conical frustum from `r_le` at `LEB` to `r_le + c` at `LEB + c`. The widened radius `r_le + c` feeds every fit check that uses the LE radius (`rmax`, chamber walls, chamfer faces, feet clearance), the semi-spiral plank tangent circle, and the hub-roof label rule stays at `r ≤ r_le` (the roof itself does not move).
- **Refusals** (form names, whole mm, levers): size ≤ 0; size larger than the LE part height above LEB (Closed generator: up to the ceiling; With cone: Cone length − Wall thickness); widened part no longer fits in the chamber (existing wall / chamfer-face messages, now counting the widened radius); With cone generator: nothing new (the inner bore does not change).
- **Patches**: the chamfer face belongs to `cylinder_walls`. No new patch.
- **Hash**: keys only when on (both designs now), so every existing build keeps its hash.
- **Web**: checkbox visible in both designs (after Guide vanes options), size field shown only when ticked; hint "Blank = 50 mm".

## 4. Tests (first)
- pytest: Closed generator + vanes and With cone + vanes with chamfer 50 mm: builds, watertight, exact patch list, volume delta matches the analytic frustum + widening, a section at `LEB + c/2` shows the conical wall between `r_le` and `r_le + c`; size too large refused; widened part too wide for the chamber refused; option off = GOLDEN unchanged.
- API: hash only when on, both designs; 422 on size ≤ 0.
- Web: checkbox in both designs, size field conditional, old saves load off / 50.

## 5. Deployment
`buildChamber.py` changes ⇒ purge the chamber cache (`$STORAGE_DIR/chamber/*`).

## 6. Out of scope
Top-rim chamfer; chamfer on the runner case; changing the roof or the shroud.
