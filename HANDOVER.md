# Handover — Guide-vane STEP export (editable BREP) + chamber/meshing branch state

> Branch: `feat/chamber-creation`. Latest work is **committed AND pushed** (`1b542bf`).
> **PR not yet opened** — open it here (no `gh` CLI / HTTP token on this machine, so it needs a browser):
> https://github.com/Bapteds/dive-gui/compare/main...feat/chamber-creation?expand=1
> Supersedes the previous handover (2026-08-10, "hub & shroud X1 reshaping") — that work is done
> and folded into the branch; its detail now lives in the `PLAN.md` changelog.
> The full, per-feature French changelog for everything on this branch is at the bottom of `PLAN.md`.

---

## 0. Access & toolchain (READ FIRST if new to this repo — unchanged)

The toolchain lives in **WSL**, outside this folder:

- `npm`/`node` are **WSL-only** — Git Bash / PowerShell on Windows fail with "npx: command not found".
- CadQuery Python is a **WSL venv**: `/home/hristo/cadquery-env/bin/python`
  (the API reads it via `CHAMBER_PYTHON_BIN`; the mesh viewer uses `MESH_PYTHON_BIN` →
  `/home/hristo/mesh-viz-env`, a separate venv with pyvista/trimesh — see PLAN.md).
- Invoke via `wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/... && ..."`.
  WSL prints harmless `Failed to translate 'H:\bin'` lines on every call — ignore them
  (silence with `wsl -e bash 2>/dev/null -lc '...'`).

```bash
# Build ONE chamber (params JSON -> outDir: chamber.glb, manifest.json, exports/, build-meta.json)
wsl -e bash 2>/dev/null -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <params.json> <outDir>'

# Chamber test gate (FAKE builder — never runs real CadQuery; TS logic only)
wsl -e bash 2>/dev/null -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && \
  npx --workspace @dive/api vitest run chamber'

# Typecheck (shared must build first)
wsl -e bash 2>/dev/null -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && \
  npm run -w @dive/shared build && \
  npx tsc -p apps/api/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit'
```

- After **any** `buildChamber.py` change, **purge the build cache**:
  `rm -rf apps/api/storage/chamber/*` (builds are hashed on params, not code).
- `CHAMBER_DEBUG_DUMP=1` dumps `core.stl`, `casing.stl`, `result.stl`, `F.stl`, `meta.json`, etc.
  into `<outDir>/_debug/` — the main diagnostic tool for the geometry.
- **The full API vitest suite is slow on WSL disk I/O (times out ~7 min).** Run targeted suites
  (`chamber`, `meshing`, `snappyPipeline`, `mesh`, `meshes`) rather than the whole thing.
- **Scratch discipline**: one-off diagnostic scripts/builds go under underscore-prefixed names
  (`apps/api/scripts/_diag_*`, or the session scratchpad). Never `git add -A`; stage explicit
  file lists so scratch never enters a commit.

---

## 1. Latest work: guide-vane STEP export as editable BREP (main change in `1b542bf`)

**Ask (user):** *"make the step file also export properly in the case of present guide vanes."*
**Confirmed scope:** consumer = editable desktop CAD → needs **genuine analytic/NURBS BREP**, not
faceted; failure policy = **fall back to a vane-less STEP + warn**; safety = **volume-match gate**.

**Why it's hard (the core fact):** a STEP file can only hold **BREP** (analytic/NURBS solids). The
guide vanes in the pipeline are **mesh** (STL triangles) — you cannot put a mesh into a STEP. So
the vane-less STEP always exported fine (it's an OCC `result` solid), but to get vanes into the
STEP they must be **reconstructed as BREP** and boolean-cut from the fluid solid.

**Architecture — a parallel, additive path.** The mesh/viewer/solver source of truth is unchanged:
`fluid_F` (the trimesh manifold difference) still feeds GLB / STL / edges / triSurface / patch
classification. The STEP work is a **separate OCC computation** that only produces `chamber.step`;
it never feeds the mesher. Changing it cannot affect the mesh.

**Files:**
- `apps/api/scripts/buildChamber.py`
  - `VANE_STEP_VOL_TOL = 0.005` (0.5%).
  - `build_vane_step_solid(cq, np, trimesh, result, core_prof, cas_prof, airfoil, blades_mesh,
    cx, cy, z0, z1, fluid_volume, vol_tol=…)` — revolves analytic hub/shroud
    (**revolve axis `(0,1,0)` = global Z; `(0,0,1)` gives ZERO volume — an OCC gotcha**), fits a
    clean airfoil onto each placed blade section via 2D Procrustes (`_similarity_2d` / `_fit_airfoil`
    / `_resample_loop`), spline-extrudes each blade, unions into a distributor, `result.cut(dist)`,
    `.clean()`, then **gates on a STEP round-trip**: exports a temp STEP, re-imports it, and checks
    `abs(vol − fluid_volume)/fluid_volume ≤ vol_tol`. Returns the solid or `None`.
  - Helper `_load_vane_blade_profile` reads the baked airfoil asset.
  - Export block (~L1748): guide-vane builds try `build_vane_step_solid`; on `None`/any exception
    they **fall back** to exporting the vane-less `result` and warn. `build-meta.json`
    `{"stepHasVanes": bool}` is written for guide-vane builds only (non-vane builds write no meta).
  - `CHAMBER_STEP_DEBUG` env var enables gate/blade logging (off by default, harmless).
- `apps/api/scripts/bakeVaneBladeProfile.py` — **offline** one-shot bake: loads the supplied blade
  STEP, identifies the blade shell by r-range/height/azimuth (not by index), sections it at
  mid-height, aligns to the STL blade by 2D Procrustes (cyclic shift + reflection), asserts
  maxDev ≤ 2 mm, writes the canonical 160-point airfoil.
- `apps/api/scripts/assets/guideVanes_blade_profile.json` — the generated asset (scale 1.00106,
  maxDev 1.55 mm, sectionZAsset 0.7925, centroid radius 0.8687). Committed; regenerate only if the
  blade geometry changes.
- Spec: `docs/superpowers/specs/2026-08-13-guide-vane-step-export-design.md`
- Plan: `docs/superpowers/plans/2026-08-13-guide-vane-step-export.md`

**Outcome:**
- ✅ **Stepped** guide-vane builds ship a STEP with **editable analytic vanes** — round-trip
  135.42 m³ vs `fluid_F` 135.42 (0.005%), 123 smooth faces. `stepHasVanes=true`.
- ⚠️ **Hollow** guide-vane builds hit a **malformed OCC boolean**: the solid tessellates fine
  (153 m³, watertight) but STEP round-trips to **+30% / 199 m³** — a topological doubling from
  coincident faces at the `z_mid_top` interface **plus** the hollow cup's enclosed internal void.
  `.clean()` (UnifySameDomain) does not repair it. The gate catches it → **safe fallback** to the
  vane-less STEP, `stepHasVanes=false`. No wrong STEP can ship.

**Descoped by user decision (2026-08-13):** *"leave the build as it is, I don't need a good STEP
file anymore."* Plan Tasks 4–6 (wire `stepHasVanes` through the API + surface the fallback in the
web UI + dedicated tests) were **not done**. The flag is written to `build-meta.json` but **not
consumed** — there is deliberately **no `stepHasVanes` reference anywhere in TS**, so there is no
half-wiring and the build is clean. To resume: read the plan's Tasks 4–6 (API
`readChamberBuildMeta` in `chamberStorage.ts`, `ChamberBuildResult.stepHasVanes` in
`chamber.service.ts`, shared type, web `types.ts` + `ChamberPage` + `ChamberExportButtons`, tests
incl. cache-hit).

---

## 2. Verifying the STEP path (real CadQuery — TS tests can't)

The TS `chamber.test.ts` uses a **fake builder** and never runs CadQuery, so STEP/geometry
correctness must be checked in the WSL cadquery-env. Cached guide-vane params live under
`apps/api/storage/chamber/<hash>/params.json`; convenient reference hashes:
- `052bccd7ac0ea7ec` — **stepped + vanes** (should ship vanes)
- `0ee2a0131b351f62` — **hollow + vanes** (should fall back)

Recipe: purge the cache, build each params into a scratch dir with the cadquery-env python, then
re-import `exports/chamber.step` with `cadquery.importers.importStep`, sum solid volumes, and
compare against `exports/chamber.stl`'s volume (trimesh) and against `build-meta.json`'s
`stepHasVanes`. Expected: stepped rel-err ~0.005% with `stepHasVanes=true`; hollow `stepHasVanes=false`
with the STEP being the vane-less solid.

---

## 3. Also on this branch (previously uncommitted — folded into `1b542bf`)

Full detail per feature is in the `PLAN.md` changelog. Summary:
- **Meshing live run log + Stop** — file-backed background job (`mesh.log` + `status.json`
  sidecars), non-blocking `POST /:id/run` (202), `GET /:id/run/log`, `POST /:id/run/stop`, boot
  reconciliation, Run button locked while active.
- **Rename** for meshing sessions (`PATCH /meshing/:id`) and projects (`PATCH /projects/:id`,
  manager-only) + reusable `RenameDialog`.
- **Chamber feet on/off** toggle (`feetEnabled`, legs+planks together).
- **Adjustable derived chamber dimensions** — `dFirst / dMiddle / centralDiameter / centralHeight
  / domeHeight` overridable in the UI, empirical-relation fallback when blank; shared ratio
  constants are the single source of truth.
- **Stepped fit-to-box refusal** — stepped now *rejects* (KO → toast) when the stack exceeds
  H Kammer instead of silently shrinking; hollow keeps the fit-to-box clamp (it's load-bearing —
  21/26 cached hollow builds legitimately exceed the box).

---

## 4. Known limitations & possible next steps (not requested — flagged)

- **Hollow guide-vane STEP has no vanes** (falls back). If wanted, ranked by effort/odds:
  1. **Fuzzy boolean** — do the `result.cut(dist)` via OCP `BRepAlgoAPI_Cut` with a small
     `SetFuzzyValue` (~1e-6–1e-5 m) to merge the coincident faces. Cheapest, textbook fix for this
     failure mode. Keep the fuzzy value as small as works (a too-large value could round tiny
     features if the STEP is later re-meshed; the volume gate backstops gross error).
  2. **Overcuts** — extend the hub core / blade prisms slightly past the `z_mid_top` interface into
     already-void space so no boolean shares an exact coplanar face. Volume-neutral by construction
     (the code already has a `FLOOR_OVERCUT` constant used for z1).
  3. **Reconstruct the hollow cup/dome as analytic BREP** (like hub/shroud) so the whole `result`
     is clean analytic BREP and the boolean is well-conditioned. Highest odds, most work; removes
     the mesh-derived enclosed-void fragility for good.
  Note: fuzzy/overcuts live **only** in the OCC/STEP branch and are consumed by the boolean — they
  cannot affect the solver mesh (which uses `fluid_F`), and the 0.5% gate rejects any that change
  the volume.
- **Normal orientation** (from an older handover): STL patch normals point outward
  (OpenFOAM-standard), not into the fluid; a flip was raised, then deprioritized. **Still not
  done.** One-line winding flip across all patches (they share `fluid_F`), but needs `F.volume`
  sign re-check + a manual normal check, and a decision on whether `chamber.stl` should flip too.
- **Pre-existing flaky/failing test unrelated to this work**: `apps/api/tests/meshes.test.ts`
  undo-all was fixed on this branch (see PLAN.md), but the full suite is slow on WSL — prefer
  targeted runs.

---

## 5. Repo conventions (unchanged)

- `CLAUDE.md`'s frontend skill sequence (ui-ux-pro-max → frontend-design → design-taste-frontend →
  web-design-guidelines) applies to **UI (JSX/CSS) only**, not the Python builder.
- Log every code change as a **French** note at the bottom of `PLAN.md`, matching the existing
  entries' style and detail.
- Branch `feat/chamber-creation`; main is `main`. Don't push without being asked (this push was
  requested).
- **Commit discipline**: batch — implement + verify fully, then commit once with the user's
  explicit go-ahead. Stage explicit file paths, never `git add -A`.
- No secrets in commits: `apps/api/.env` (holds `CHAMBER_PYTHON_BIN` / `MESH_PYTHON_BIN` /
  `OPENFOAM_BASHRC`) is gitignored — environment config is not committed.
