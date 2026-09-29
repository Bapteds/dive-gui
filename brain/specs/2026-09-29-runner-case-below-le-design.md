# Runner case Ø below LE Ø with guide vanes: 20 mm ledge

> **Status**: approved (2026-09-29) · **Date**: 2026-09-29 · **Workstream**: WS-A v2 (branch `feat/chamber-v2-cfd-loop`)
> **Amends**: `2026-09-29-vane-pocket-runner-case-design.md` (WS-A, implemented): its refusal "Runner case Ø below LE Ø − 5 mm" is replaced; the 5 mm snap, the thin-ring overshoot guard and the junction labels stay.
> **Area**: shared + API (refusal), python, tests

## 1. Goal

With guide vanes, allow a Runner case Ø smaller than LE Ø and build a runner case that looks like it, instead of refusing.

## 2. User decisions (2026-09-29)

1. Geometry (user sketch, axial half-section): the runner case wall stands at `Runner case Ø/2` from the floor up to **20 mm below the shroud brim**; there a horizontal **ledge** runs outward from `Runner case Ø/2` to the brim edge (`LE Ø/2`); above the ledge, the distributor envelope is unchanged (brim and roof at `LE Ø/2`).
2. **Refusal** only when `Runner case Ø < Runner Ø + 20 mm` (Runner Ø = X1, the outlet outer diameter), so the runner case wall stays at least 10 mm (radius) outside the outlet passage.
3. `|Runner case Ø − LE Ø| ≤ 5 mm` stays snapped flush with a warning (WS-A).

## 3. Geometry

Scaled values: `r_le = dLast/2`, `r_case = dFirst/2` (typed override × Part scale, as today), `z_brim` = the shroud brim height, `LEDGE_GAP = 0.020` m (a new constant, × Part scale).

- `r_case ≥ r_le − 2.5 mm`: unchanged from WS-A (ring, snap).
- `X1/2 + 10 mm ≤ r_case < r_le − 2.5 mm` (new regime): the non-fluid solid under the distributor is `r < r_case` from the floor to `z_ledge = z_brim − LEDGE_GAP`, plus `r < r_le` from `z_ledge` up to the brim. The fluid wraps below the ledge. The shroud casing outer wall is not extended beyond `r_le` (no overshoot in this regime).
- `r_case < X1/2 + 10 mm`: refused.
- **Feet** (with vanes): the legs are placed from `max(r_case, r_le)` so they never cut the distributor or the ledge (the gusset plank stays on the LE cylinder, WS-A decision).
- Every fit check that uses the runner-case radius keeps using `r_case`; the chamber-wall checks use `max(r_case, r_le, …)` as today.

## 4. Patches (deterministic labels, after the vote, before the blade skin)
- runner case wall (vertical, `|r − r_case| < 3 mm`, `z < z_ledge`) → `cylinder_walls`;
- ledge underside (horizontal at `z_ledge`, `r_case ≤ r ≤ r_le`) → `cylinder_walls`;
- the 20 mm vertical band at `r_le` between `z_ledge` and the brim → `shroud` (it is the distributor casing);
- chamber floor outside `max(r_case, ro)` → `walls`. No new patch.

## 5. Refusal text
"With guide vanes the runner case must clear the outlet: Runner case Ø (1440 mm) must be at least Runner Ø + 20 mm (1470 mm). Increase Runner case Ø, clear it (auto ≈ 1835 mm), or turn Guide vanes off." API (422 before CadQuery, `runnerCaseBelowLeRefusal` renamed or rewritten for the new rule) and builder (`ValueError`) both.

## 6. Tests (first)
- pytest (from `stepped-vanes` and `hollow-vanes-overrides`): Runner case Ø = LE Ø − 100 mm builds, watertight, exact patch list, a horizontal section just below `z_ledge` shows the runner-case circle at `r_case`, the ledge faces are `cylinder_walls`, the 20 mm band is `shroud`, no `guide_vanes` triangle lost; Runner case Ø = X1 + 10 mm refused; the WS-A snap and thin-ring tests still pass; GOLDEN unchanged.
- API: refusal moves to X1 + 20 mm (LE Ø − 50 mm now accepted when above it).

## 7. Deployment
`buildChamber.py` changes ⇒ purge the chamber cache (`$STORAGE_DIR/chamber/*`).

## 8. Out of scope
Changing the brim, the roof or the outlet; Runner case Ø without guide vanes (unchanged).
