# Handover — Guide-vane hub & shroud, X1-driven parametric reshaping

> Branch: `feat/chamber-creation`. Latest work is **committed** (`7e2fd7d`), not pushed.
> Supersedes the previous handover in this file (2026-08-06, "outlet sizing / next task").
> That "next task" is what this handover's §2 describes as **done**.

## 0. Access & toolchain (unchanged — READ FIRST if new to this repo)

The toolchain lives in **WSL**, outside this folder:

- `npm`/`node` are **WSL-only** — Bash/PowerShell on Windows fail with "npx: command not found".
- CadQuery Python is a **WSL venv**: `/home/hristo/cadquery-env/bin/python`.
- Invoke via `wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/... && ..."`.
  WSL prints harmless `Failed to translate 'H:\bin'` lines on every call — ignore.

```bash
# Build ONE chamber (params JSON -> output dir: chamber.glb, manifest.json, exports/)
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <params.json> <outDir>'

# Chamber test gate
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run chamber'

# Pure hub/shroud math unit tests (no build needed)
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  /home/hristo/cadquery-env/bin/python _test_hub_shroud_math.py'

# Full geometry regression (after CHAMBER_DEBUG_DUMP=1 build): watertight, rims, ellipse/hub invariants
wsl -e bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py <outDir> <X1_metres> <outletRatio>'
```

- **Pre-existing failing test, unrelated to this work**: `apps/api/tests/meshes.test.ts >
  GET /projects/:id/meshes/assembly + POST /meshes/merge (Disassemble) > clears the assembly
  record when the mesh backup is restored (undo-all)` — an `EISDIR` on `.work/m1`. Predates and
  is outside chamber-creation work; don't chase it unless asked.
- After **any** `buildChamber.py` change, **purge the build cache**:
  `rm -rf apps/api/storage/chamber/*` (builds are hashed on params, not code).
- `CHAMBER_DEBUG_DUMP=1` dumps `core.stl`, `casing.stl`, `result.stl`, `hub_throat.stl`,
  `hub_source.stl`, `shroud_source.stl`, `vanes_source.stl`, `F.stl`, `meta.json` into
  `<outDir>/_debug/` — the main diagnostic tool for this geometry.
- **Scratch discipline**: any one-off diagnostic script/build output goes under
  `apps/api/scripts/_diag_*` / `_dm_*` / similar underscore-prefixed names — `git clean -ndx --
  apps/api/scripts` previews them, `-fdx` removes them. Never let scratch leak into a commit
  (stage explicit file lists, not `git add -A`).

## 1. What this is (current architecture)

Guide-vane builds (`guideVanes: true`) replace the middle cylinder with a **radial distributor**
(16 blades + hub + shroud + outlet). The hub and shroud are built one of two ways, chosen per
build by whether the outlet-sizing params are present:

- **Analytic path** (when `outletOuterD` + `outletRatio` are both present in params — the normal
  case today): hub and shroud are **parametric meridional profiles** (a 3-point polyline for the
  hub, an ellipse fillet for the shroud), revolved directly into solids. §2 below.
- **Mesh fallback path** (either param absent — old cached builds only): hub/shroud are built by
  remapping the `guideVanes_walls.stl` asset mesh (`place_throat`) + PCHIP-smoothing a silhouette
  off it. Preserved byte-identical to before this feature for backward compatibility.

Either way: the vane blades are extruded into watertight prisms, the hub-core/shroud-casing
solids + prisms are **unioned**, and that union is **subtracted from the OCC fluid box**
(`trimesh.boolean.difference`, manifold engine). The resulting true wetted boundary `F` is then
re-split into named patches (`hub`, `shroud`, `outlet`, `guide_vanes`, plus OCC-derived
`inlet`/`cylinder_walls`/`walls`) by nearest-source classification.

Key functions in `apps/api/scripts/buildChamber.py`:
- `_hub_point_radii(R_hub_new, R_shroud_new, meta)` — pure function, the hub 3-point radial rule.
- `_shroud_fillet_profile(np, R_shroud_new, z_brim, r_wall)` — pure function, the shroud ellipse.
- `_revolve_open` / `_densify` — surface-of-revolution + tessellation-density helpers for the
  analytic profiles (density matters — see §2's "pitfalls" below).
- `make_vane_patches(...)` — branches into analytic vs. mesh fallback; returns hub/shroud/outlet/
  blade meshes plus `hub_profile`/`shroud_profile`/`hub_pts` (analytic-path extras, empty on
  fallback).
- `main()`'s `guide_vanes` branch — revolves `hub_profile`/`shroud_profile` into `_core`/`_casing`
  when present (analytic), else calls `_hub_core_solid`/`_shroud_casing_solid` (mesh fallback);
  orchestrates the union/subtract/classify and emits patches.

## 2. Current state: hub & shroud parametric reshaping (DONE, committed)

Spec: `docs/superpowers/specs/2026-08-10-hub-shroud-x1-adaptation-design.md`.
Plan: `docs/superpowers/plans/2026-08-10-hub-shroud-x1-adaptation.md` (all 5 tasks executed
inline, TDD where testable).
Commit: `7e2fd7d` — also carries the earlier X1/`outletRatio` plumbing (shared type, zod schema,
web form field, service) from the same working tree, called out explicitly in the commit body.

**What changed:** the hub and shroud now **adapt to the outlet size** (X1, and for the hub also
`outletRatio`), replacing the pinned-rim mesh remap with **analytic meridional profiles**.

**Hub — 3-point rule.** Baseline points measured from `guideVanes_walls.stl` by objective RDP
(Ramer–Douglas–Peucker) polyline reduction — confirmed exactly 3 interior corners, no more (an
earlier 4th "point" was a plotting artifact, not real geometry):

| point | baseline (r, z), asset/absolute metres | move rule |
|---|---|---|
| inner rim | r = 0.29573 | → `R_hub_new = outletRatio · X1/2` |
| P1 | (0.29548, 0.22608) | `P1₀ + Δr_hub` (full — tracks the rim, duct stays vertical) |
| P2 | (0.39274, 0.51575) | `P2₀ + Δr_hub/2` (half — user's explicit choice) |
| P3 | (0.61465, 0.64565) | `0.93840 · R_shroud_new` (proportional to the OUTER rim, X1 only — ratio-independent) |

`Δr_hub = R_hub_new − 0.29573`. **z is unchanged** by X1/ratio — it stays on the existing HLE
vertical map (`z_sb + z_asset·sz`). **Known accepted limitation**: because P1 moves at rate 1 and
P2 at rate 0.5, P1 can overtake P2 at very high X1 (a "fold") — the user explicitly chose to keep
the simple half-rate rule and accept this, rather than a proportional (fold-proof) rule. The
builder prints a `WARNING` when it detects `P1 > P2` but does **not** clamp. In practice this is
rarely reachable because the pre-existing `VANE_OUTLET_SAFE_MARGIN` clamp (0.97·R_anchor) already
bounds `R_shroud` — see the verification note below.

**Shroud — ellipse fillet.** The floor curve was characterized (circle vs. ellipse fit against
the real STL curve) and found to be a wide axis-aligned ellipse, not a circle (RMS 0.00038 vs.
0.00064). Rebuilt as `a = 0.160·R_shroud_new` (radial), `b = 0.119·R_shroud_new` (vertical),
seated at the outer rim, tangent-horizontal into the flat brim. Both semi-axes scale with
`R_shroud`, so `R_curve/(X1/2)` is held **exactly** constant — the user's original ask.

**Pitfalls hit and fixed during implementation** (read before touching this code again):
1. **Non-watertight casing.** An annular revolve profile must be explicitly closed
   (first point == last point) for `trimesh.creation.revolve` — the hub core "accidentally" works
   without this because it touches the axis (auto-capped), the shroud casing (an annulus) does
   not.
2. **Coarse tessellation → misclassification.** `_revolve_open` naively puts one ring per profile
   point (4-5 points on the raw hub/shroud polylines) — far too coarse for the boolean +
   nearest-source classification, which caused a real bug (hub duct wall not owned by the hub
   patch near the floor) and a false monotonicity failure in the shroud contour check (some
   verification r-bins caught zero top-surface samples). Fixed with `_densify`, which inserts
   points so no meridional segment exceeds a step **smaller than the verification script's r-bin
   width** — if you change either the verify script's `nb` (bin count) or `_densify`'s `step`,
   re-check they stay consistent.
3. **Spurious fold warning at the default case.** The naive check `rim ≤ P1` fires even at
   baseline because `P1₀` (0.29548) sits ~0.25mm inside the baseline rim (0.29573) by
   construction, not because of a real fold. The real invariant to check is `P1 ≤ P2 ≤ P3`.

**Verified**: pure-function unit tests (`_test_hub_shroud_math.py`, standalone, no build) all
pass. Full sweep {cone, tall, short} × ratio {0.35, 0.45, 0.50} × X1 {low, default, high} = 27
builds, **27/27 ALL PASS** (F watertight/1-component, rims exact, `a/R_shroud`/`b/R_shroud`
constant, `P3 = 0.9384·R_shroud`, hub owns its duct wall, shroud casing monotone, no stray/
misclassified faces). Additionally: an oversized-X1 case correctly hits the pre-existing
`R_anchor` clamp (not the hub-fold path); a non-hollow "stepped" variant builds clean (path
generalizes beyond the hollow/dome case); the no-params fallback takes the mesh path (empty
`hub_pts`/`shroud_ell` in the debug meta) and still builds watertight. 31/31 `chamber` vitest
tests pass.

**Not yet done — the one gate I could not run**: a **live look at the rendered GLB in the app**
(chamber page is behind a login wall). Purge the cache first:
```bash
rm -rf apps/api/storage/chamber/*
```
then generate a guide-vane chamber at default settings and at a couple of X1/ratio extremes, and
confirm the hub shoulder (3-point shape) and shroud fillet (ellipse) read correctly in the
rendered mesh — not just pass the numeric checks above.

## 3. Possible next steps (not requested yet, just flagged)

- If the user ever wants the **hub fold to be fold-proof** instead of warn-only: the
  spec/handover discussion (see git history around 2026-08-10) worked out a "pin-both-ends"
  proportional alternative (`P2` at a baseline-derived fraction between the rim and P3) that
  cannot fold by construction — the user explicitly declined it in favor of the simpler half-rate
  rule with an accepted limitation, but the alternative is documented in the conversation if
  revisited.
- The **normal orientation** question from the previous handover (STLs should point INTO the
  fluid, not the current outward-from-fluid/OpenFOAM-standard convention) was raised, the user
  asked for the flip, then redirected to other work before it was done. **Still not done.** It's a
  one-line change (negate/flip winding on the emitted triangles, consistently across every
  patch — they share the same `fluid_F` boundary) but needs re-verification of `F.volume` sign
  and a manual normal check after. Confirm with the user whether this should also flip
  `chamber.stl` (whole-domain export) and whether `extractPatches.py`'s consumers care (viewer is
  double-sided/orientation-agnostic per earlier investigation, so likely no viewer impact).

## 4. Repo conventions (unchanged)

- `CLAUDE.md`'s frontend skill sequence (ui-ux-pro-max → frontend-design → design-taste-frontend
  → web-design-guidelines) applies to **UI (JSX/CSS) only**, not the Python builder.
- Log every code change as a **French** note at the bottom of `PLAN.md`, matching the existing
  entries' style and level of detail.
- Branch `feat/chamber-creation`; main branch is `main`. Don't push without being asked.
- **Commit discipline**: this repo batches — implement + verify fully, then commit once with the
  user's explicit go-ahead, not per-task. Stage explicit file paths, never `git add -A` (scratch
  diagnostic output must never enter a commit).
- The mesh-seal fallback approach (`_backup_meshseal_buildChamber.py`) was deleted per the user's
  explicit request once the boolean approach was fully verified — don't recreate it speculatively.

## 5. Stray files noticed but NOT touched

At the root and under `apps/api/`, a few untracked items predate this session's work and are of
unclear origin — left alone rather than guessed at: `apps/api/-case`, `dive-turbinen@1.0.0`,
`npm`, `prisma`, `test2.txt` (all empty or near-empty; look like accidental artifacts from some
past command, not scratch from this feature). Worth asking the user whether they're safe to
delete, rather than assuming.
