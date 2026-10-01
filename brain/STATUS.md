# Current project state

> Snapshot to read at the start of a session. **Rewrite it** (do not stack) as soon as the state changes: branch, work in progress, verification, open threads.
> Detailed history: `brain/changelog/`. Bugs and debt: `brain/known-issues.md`.
> Last updated: 2026-10-01.

## 1. Where we are

- **Chamber Creation v2 + CFD loop merged into `main`** (2026-09-29, merge `9e92400` of `feat/chamber-v2-cfd-loop`, at the user's request). Work order WS-A to WS-I:
  - **Done (on `main`)** (each with its approved spec in `brain/specs/2026-09-29-*`, tests and brain update):
    - WS-A guide-vane pocket vs Runner case Ø (5 mm snap with warning, junction labels) + WS-A v2: Runner case Ø below LE Ø builds a 20 mm ledge under the shroud brim, refused only below Runner Ø + 20 mm;
    - WS-B Guide vane count, now any whole number 8 to 32 (branch `feat/guide-vane-count-any`, not merged); chord min(1, 16/n) since 2026-09-30 (below 16 the 16-vane blade: every count builds, vaned STEP at 8 / 13 in about 30 s; worktree branch `worktree-agent-abda8d52e36f8b19d`, not merged);
    - Corner chamfers: the "always at 45°" lock (BF1 = LF1, BF2 = LF2 permanent) was **reverted on 2026-09-30** (`fix/bf-relations-toggleable`, merged). BF1 = LF1 and BF2 = LF2 are normal relations again: on by default, can be turned off, "Configure relations (n/9 on)"; the BF rows take Min / Max / Exact and show their confidence; saves load their BF values and toggles as saved. Spec `2026-09-29-corner-chamfer-45-design.md` is superseded;
    - WS-C v2 Cone chamfer: 45° foot chamfer on the LE part in both designs, part widened by the chamfer size above it (the first top-rim version was removed at the user's request);
    - WS-E Semi-spiral casing (cached `designSemiSpiral.py` step, nose + plank = new `tongue` patch, Feet off; unticking it restores Chamfer);
    - WS-F Meshing session → project (`POST /projects/:id/mesh/from-meshing`, "Send to project" dialog, chamber patch types forced).
  - **Hub shoulder fold fixed (2026-09-30, branch `fix/chamber-hub-knee-ellipse`)**: knee P2 = 45° point of the P1–P3 quarter ellipse (spec `2026-09-30-hub-shoulder-knee-ellipse-design.md`), supersedes the WS-D "keep the rule" decision; the `hub shoulder non-monotonic` warning is gone. **Deploy: purge `$STORAGE_DIR/chamber/*`.**
  - **Done 2026-09-30 (on `main`)**: WS-G convergence criteria + vortex metrics in the Solver tab (SimplePDrop default, robust, residuals; Δp₀ and vortex charts; spec `2026-09-30-solver-convergence-vorticity-design.md`); WS-I Free surface project tab (lid iteration by remeshing, 1 to 3 iterations; spec `2026-09-30-free-surface-tool-design.md`); Casing flow velocity read-only, derived from B Kammer. Everything touching OpenFOAM (coded function objects, `postProcess`, the kit scripts, a real iteration) is **to validate on the Debian server**.
  - **Done 2026-09-30 (on `main`)**: WS-H optimisation loop in the project **Optimisation** tab (Prisma migration `20260930085427_optimisation_studies`, Optuna ask/tell via `optimiseSuggest.py`, the project is the work project and keeps its own solver setup / BCs; spec §0). **Deploy**: back up the database (migration applies at the service restart), install `optuna` for `OPTIM_PYTHON_BIN` (defaults to `MESH_PYTHON_BIN`), then validate one real 3-evaluation study on the server.
  - **Still to do (after the merge)**: browser pass (A, B, C, E, F), CI run (geometry job), and at deploy **purge `$STORAGE_DIR/chamber/*`** (`buildChamber.py` changed; the live `.env` has `STORAGE_DIR="./storage"`, relative to the service working directory, so probably `/home/app/apps/api/storage/chamber/*`: to confirm) plus a real snappy chamber session sent to a project on the server.
- **Before it on `main`**: `5638b42` (brain chamber-sheet refresh) and the 2026-09-28/29 chamber fixes (generator minimum with dome, readable errors).
- **Version**: 1.0.x (v1.0.1 audit fixes included: every CRITICAL and HIGH finding).
- **Brain**: reorganized on 2026-09-28 (`brain/`, English, generated `INDEX.md`, playbooks, zone rules, `Stop` hook).

## 2. Last known verification

Hub knee ellipse (branch `fix/chamber-hub-knee-ellipse`, 2026-09-30, `C:/cqv`): geometry suite 140/140 with CadQuery 2.8.0 (`C:/cqv`, 20 min 34 s; every GOLDEN within `VOL_RTOL`, none updated); `_test_hub_shroud_math.py` ALL PASS; API chamber + chamberModel 136/136, web chamber 135/135, typecheck clean. Browser not checked.

Chord cap min(1, 16/n) + corner chamfers at 45°, the latter since reverted (worktree branch `worktree-agent-abda8d52e36f8b19d`, 2026-09-30): geometry 123/123 with CadQuery 2.8.0 (`C:/cqv`, 97 builder + 26 spiral-module, 18 min 26 s; every GOLDEN unchanged), API chamber suites 136/136, web chamber 127/127, typecheck clean, lint 0 errors; vaned STEP 28 s at 8 vanes, 36 s at 13.

Free guide vane count (branch `worktree-agent-a841f1e42daa5f408`, 2026-09-29, same workstation): geometry 118/118 (GOLDEN unchanged), API chamber suites 129/129, web chamber 123/123, typecheck clean, lint 0 errors; vaned STEP falls back at 8 vanes and is very slow at 13 (`known-issues.md` §6).

Branch `feat/chamber-v2-cfd-loop`, 2026-09-29, Baptiste's Windows workstation (CadQuery venv `C:/cqv`), last results reported per workstream:

- real geometry suite (`pytest`, CadQuery 2.8.0): 106/106 after WS-C v2 + WS-A v2 (80 builder + 26 spiral-module tests); existing GOLDEN volumes unchanged;
- API: `chamber` + `chamberModel` + `chamberSaves` + `chamberPatchTypes` 123/123; `meshFromMeshing` green; `meshing.test.ts` has 2 Stop tests flaky on native Windows, also on `main` (`known-issues.md` §6);
- web chamber 113/113; WS-F dialog and project page tests green; typecheck clean; lint 0 errors (7 pre-existing warnings);
- no local chamber cache existed, nothing purged; CI and browser not run.

## 3. Development environments

| Workstation | Specifics |
|---|---|
| Baptiste's Windows workstation (this checkout: `C:\Users\Baptiste.Erades\Desktop\dive-gui`) | `node` v24 and `npm` **native on Windows** (available in Git Bash); Windows Python 3.13 **without CadQuery**; `node_modules` **not installed** as of 2026-09-28 (run `npm install` before any test or typecheck); `apps/mcp/.env` missing, so the `dive` MCP server does not start. |
| Co-developer's workstation (Hristo, WSL) | `node`/`npm` only inside WSL; CadQuery in the venv `/home/hristo/cadquery-env` (`CHAMBER_PYTHON_BIN`); mesh viewer via `/home/hristo/mesh-viz-env` (`MESH_PYTHON_BIN`); calls `wsl bash -lc "cd /mnt/c/... && ..."` (the "Failed to translate 'H:\bin'" lines are harmless). |
| Production server (`192.168.5.51`, checked 2026-09-29, runtime re-checked 2026-10-01) | **Ubuntu 24.04** on a Proxmox VM (not Debian 12 as older docs say), 24 cores, 107 GB RAM. ESI OpenFOAM **v2406 and v2606** in `/usr/lib/openfoam/` (the API uses v2406 via `OPENFOAM_BASHRC`); both have `gcc`/`g++`/`wmake` (so `coded` function objects compile), cfMesh (`cartesianMesh`, `improveMeshQuality`), `topoSet`, `postProcess`, field/utility function-object libraries. Mesh venv `MESH_PYTHON_BIN=/home/dive-venv/bin/python` (numpy 2.5, pyvista 0.48). CadQuery 2.8.0 lives in the miniforge `base` env (`~/miniforge`); `CHAMBER_PYTHON_BIN` is **not set** in `.env`, so the API calls plain `python3`, which has CadQuery only because the app is started from a miniforge-activated shell (the system `python3` has none). `STORAGE_DIR="./storage"` (relative, not `/var/lib/dive/storage`). App in `/home/app` as root; nginx serves `apps/web/dist` and proxies `/api` to `127.0.0.1:4000`. **No systemd service** (checked 2026-10-01): the app runs by hand, `source $HOME/miniforge/bin/activate && npm run dev` in `/home/app` (update: `git pull`, the same `source`, `npm run build`, `npm run dev`). No tmux/screen; detached start: `setsid nohup bash -c "source \$HOME/miniforge/bin/activate && npm run dev" > /tmp/dive-dev.log 2>&1 &`. Health: `curl http://127.0.0.1:4000/health`. SSH from Baptiste's workstation: alias `dive` (key `C:\Users\Baptiste.Erades\.ssh\dive_claude`); Git Bash `$HOME` there is `H:\`, so pass `-F C:/Users/Baptiste.Erades/.ssh/config`. See `brain/operations/installation.md` (target procedure; the live server departs from it) and `brain/playbooks/deploy-and-update.md`. |

On a workstation without OpenFOAM, ParaView or CadQuery, CFD actions answer "not found" step by step (by design). The real geometry suite only runs with CadQuery (GitHub CI is the authority).

## 4. Open threads (nothing is requested)

See `brain/known-issues.md` §6 and §7: hub P3 / P1-height rules vs a real 2420 mm design, visual pass of Simplify Generator, STL normals, saves cascade, multi-instance build lock. Audit side: 22 MEDIUM and 21 LOW open, and product decision C2 (shared projects of a deleted account).

**Questions waiting for a user decision** (raised on 2026-09-28):
- Name of the `outlet` patch placed on the middle cylinder in Closed generator without guide vanes (`known-issues.md` §6).
- Omega formula of the turbulence calculator: the reference note uses `0.09^0.75`, the usual formula `Cmu^0.25` (`known-issues.md` K22).
- Product decision C2: fate of the shared projects (and chamber saves) of a deleted account.

## 5. Pitfalls to know before touching the code

- Changing `buildChamber.py` ⇒ purge `apps/api/storage/chamber/*`.
- Changing `packages/shared` ⇒ `npm run build:shared` before typecheck or tests.
- `conversion.test.ts` and `meshes.test.ts` fail locally when `OPENFOAM_BASHRC` is set in `apps/api/.env` (see `known-issues.md` §8): run targeted suites.
- `npm test -w @dive/api` alone does not rebuild `@dive/shared`: use root `npm test` or `npm run build:shared` first.
- `CHAMBER_DEBUG_DUMP=1` writes `core.stl`, `casing.stl`, `meta.json`… into `<outDir>/_debug/`.
- "outlet" = flow outlet, never the middle cylinder.
