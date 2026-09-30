# Free-surface (lid iteration) tool (WS-I) — design

**Date:** 2026-09-30
**Status:** approved (user decisions 2026-09-30, see §9)
**Feature:** new project tab **Free surface** (`brain/features/free-surface.md`, to create).
**Source (user tool, stored in `documents/Tools/lidIterationKit/`):** `lidkit.py` (driver), `lidkit_surface.py`, `lidkit_fitlid.py`, `lidkit_post.py`, `vtk_reader.py`, `templates/{lidSurfaces,Allrun.sh,config_template.json}`, README (method, validation, limitations).
**Scope:** API (new `freesurface` sub-module of `projects`, an in-process job runner, shared pipeline helpers reused by WS-H), Python (the kit's surface / fit / figure scripts vendored under `apps/api/scripts/lidkit/`), web (tab) + tests. No change to `buildChamber.py` (no cache purge), to the meshers or to the BC presets.

---

## 1. Goal

From a project whose case has a converged **rigid-lid** simpleFoam run, compute the free-surface elevation and iterate the lid shape by **remeshing** (no mesh morphing), automatically:

1. **surface**: z_s(x, y) = Z_lid + (p_lid − p0_inlet)/g from the latest time (kit step 1, `lidkit_surface.py`);
2. **fit**: the flat base STL rebuilt with the lid as the smoothed height field z_s (kit step 2, `lidkit_fitlid.py`, walls follow, roof upstands, `tmin` over submerged tops, protruding solids cut): this is the "lid from VTK to STL" step, fully automated;
3. **mesh**: a new meshing session = copy of the source session's setup with the fitted surfaces, meshed with the same engine and settings;
4. **case**: the new mesh replaces the project's case mesh (WS-F route, BCs kept by name), same solver setup;
5. **run**: the solver runs to its criterion (WS-G);
6. back to 1; stop when the lid residual RMS |z_s(new) − z_lid(mesh)| < `tolRmsMm` or after the requested number of iterations.

**One iteration by default; 2 and 3 are optional** (user). Each iteration costs one mesh + one solve.

## 2. Prerequisites and checks (shown in the tab before the Start button)

| Check | Rule | Message when it fails |
|---|---|---|
| Lid patch | A boundary patch of the case mesh, **flat and horizontal** (all its face centres within ±1 mm of one z). Default: `atmosphere` when present; otherwise the user picks among the flat horizontal patches. | "This mesh has no flat top patch. The free surface needs a rigid-lid run whose top is its own patch (e.g. `atmosphere`); meshes whose top is part of `walls` cannot use this tool." (tool disabled) |
| Lid BC | `0/U` type on the lid is `slip` (or `symmetry` / `symmetryPlane`) | Warning, not blocking: "The lid is not slip (U: noSlip). The kit assumes a slip rigid lid." |
| Inlet patch | A `patch`-type patch (default `inlet`) | "Pick the inlet patch." |
| Parent run | The project's latest run is `converged` or `completed`, no run active, a time directory > 0 exists | "Run the solver to convergence first." |
| Source meshing session | Recorded **mesh origin** of the case (§4) or picked by the user; must be meshed, its surfaces must contain a solid named like the lid patch and one like the inlet patch; its engine is reused | "Pick the meshing session that produced this mesh." / "The session has no surface named `atmosphere`." |
| Solver | Steady incompressible (the kit's p is kinematic) | "The free-surface tool needs a steady incompressible solver (simpleFoam)." |

Z_lid is **measured** (the lid solid of the base STL), never typed.

## 3. Settings (the kit's config keys, defaults from `templates/config_template.json`)

`iterations` 1 (1, 2 or 3), `tolRmsMm` 3.0, `smooth` 0.10 m, `tmin` 0.02 m, `sub` 0.08 m, `steiner` 0.07 m, `clear` 0.08 m, `cut` true, `upstandPatch` = the lid patch, optional `axis` [x, y] + `rings` [[r0, r1], …] for sector statistics, `datumY` (null). Advanced fields collapsed by default. `improve_mesh_on_fail` is not carried over: the meshing session's own pipeline and quality report decide (a failed session run fails the iteration). `openfoam_bashrc` comes from the API env (`OPENFOAM_BASHRC`).

## 4. Mesh origin (new, small, shared with WS-H)

- `importChamberIntoMeshing` records `origin: { chamberHash }` in the session's `meta.json` (additive; old sessions have none).
- `importMeshFromMeshing(target 'case')` writes `STORAGE_DIR/projects/<id>/mesh-origin.json` `{ sessionId, sessionName, engine, chamberHash?, at }`; any other case-mesh replacement (import, conversion, merge, assembly, reset) deletes it (the recorded origin would be stale).
- `GET /projects/:id/mesh-origin` → `{ origin | null }`.
- `buildChamber` also writes `input.json` (the `ChamberInput` that produced the hash) next to `params.json` (metadata, not in the hash: no re-key, no purge). Used by WS-H.

## 5. Job runner (in-process, persisted as JSON)

- One job at a time **per project**; the project is locked meanwhile for manual runs and mesh/case mutations (409 `FREE_SURFACE_IN_PROGRESS` on start-run, mesh import, BC apply, reset, merge; the job's own calls pass an internal bypass).
- Storage `STORAGE_DIR/projects/<id>/freesurface/<jobId>/`: `job.json` (settings, status, stage, per-iteration results, reason), `base.stl` (the multi-solid flat STL merged from the source session's surfaces, solid = file stem), `zs_iter<k>.{npy,json}`, `geometry/domain_lidIter<k>.{stl,json,png}`, `lid_iter<k>.png` (post figure, optional), `logs/`.
- Stages per iteration k (1..n), each persisted before it starts: `exporting` (write `system/lidSurfaces` with the patch names, `postProcess -case <dir> -func lidSurfaces -latestTime`), `surface` (`lidkit_surface.py`), `fitting` (`lidkit_fitlid.py` from **base.stl** always), `meshing` (new session `<source name>-lid<k>` via `copySessionSetup`; the fitted STL split per solid and written over the session surfaces by name; `startMeshingRun`; await terminal), `transferring` (WS-F `importMeshFromMeshing` case), `solving` (`startRun` with the parent run's cores; await terminal), then the next iteration's `exporting` + `surface` gives iteration k's residual. Final state: `converged` (RMS < tol), `completed` (iterations done, residual reported), `failed` (stage + reason), `stopped`, `interrupted` (server restart).
- Awaiting a run / a meshing run uses new completion hooks `awaitRunTerminal(runId)` (`runs.service.ts`, resolved by `finalizeRun`, falls back to polling the row) and `awaitMeshingTerminal(sessionId)` (`meshing.service.ts`). These helpers live in `apps/api/src/lib/pipelineStages.ts` together with `meshSessionWithSurfaces`, `sendSessionToCase`, `solveCase`; WS-H reuses them.
- Stop: `POST …/stop` stops the current stage (`stopMeshingRun`, `stopRun`; a Python step finishes) then `stopped`. Boot reconciliation: a job left active ⇒ `interrupted` ("Interrupted by a server restart").
- Python: new env `LIDKIT_PYTHON_BIN` (default `CHAMBER_PYTHON_BIN`, which has numpy + scipy + shapely), `LIDKIT_TIMEOUT_MS` (default 15 min). Figures need matplotlib: skipped with a note when it is missing. `requirements.txt`: matplotlib added (optional). All commands argv (`runCommand`, `planOpenfoamCommand`).

## 6. API (all `requireAuth`, project Visible, 404 otherwise)

```
GET    /api/v1/projects/:id/free-surface               200 { checks, defaults, origin, jobs }   (checks = §2 table, patches with flatness)
POST   /api/v1/projects/:id/free-surface               body freeSurfaceStartSchema  202 { job }
       409 FREE_SURFACE_IN_PROGRESS | RUN_IN_PROGRESS | STUDY_IN_PROGRESS, 422 FREE_SURFACE_NOT_READY (a failed check, message = its text)
GET    /api/v1/projects/:id/free-surface/:jobId        200 { job }
POST   /api/v1/projects/:id/free-surface/:jobId/stop   200 { job }   idempotent
GET    /api/v1/projects/:id/free-surface/:jobId/files/:name   the fitted STL / figures (allow-listed names), download
DELETE /api/v1/projects/:id/free-surface/:jobId        204 (not while active: 409)
GET    /api/v1/projects/:id/mesh-origin                200 { origin }
```
New error codes: `FREE_SURFACE_IN_PROGRESS`, `FREE_SURFACE_NOT_READY`.

## 7. Web (tab **Free surface**, enabled when the case has a mesh)

- **Readiness card**: the §2 checks as a list (ok / warning / blocking), lid patch select (flat horizontal patches only, with their z), inlet select, source session (prefilled from the mesh origin, else a select of meshed sessions), measured Z_lid.
- **Settings**: Iterations segmented control `1 · 2 · 3` (default 1, hint "Each iteration remeshes and re-solves: about one mesh + one solve."), tolerance, Advanced (smooth, tmin, sub, steiner, clear, cut, axis/rings). One CTA `Start` (orange, single in the zone).
- **Progress**: stepper per iteration (export → surface → fit → mesh → case → solve) with links to the live meshing session and to the Solver tab; `Stop`.
- **Results** per iteration: z_s vs Z_lid (mean / min, mm), residual RMS / max (mm), clamped lid points, upstands, mesh cells, Δp₀ (from WS-G monitors when present), the fit check figure and the post figure, `Download fitted STL`; a small residual-RMS-per-iteration chart with a table alternative.
- UI skill sequence + design system before any JSX.

## 8. Out of scope

- Mesh morphing (discouraged by the user).
- Exposed-top shoreline modelling (kit limitation, kept: `tmin` clamp + count).
- Sloped / stepped lids as input (kit limitation).
- Builder change to split the chamber top into an `atmosphere` patch (user: not every mesh has one; some are walls only).
- Transient / VoF runs.

## 9. Decisions (user, 2026-09-30)

| # | Topic | Decision |
|---|---|---|
| I1 | Iterations | 1 by default, 2 and 3 optional. |
| I2 | Lid → STL | Automated (kit fit step) in the job. |
| I3 | Morphing | Not used: every iteration remeshes. |
| I4 | Lid patch | Not every mesh has an `atmosphere` patch; some have walls only. The tool uses a flat top patch when one exists (default `atmosphere`, user-pickable) and is disabled otherwise. No builder change. |
| I5 | Where | In the project (tab), iterations replace the project's case mesh (original backed up once, as WS-F). |

## 10. Tests

- API `freeSurface.test.ts` (supertest + fakes: `setCommandRunner` for `postProcess` / Python writing the kit's outputs, `setStreamRunner` for the mesher and the solver writing `constant/polyMesh/*` and `solver.log`): readiness checks (no flat patch, not slip warning, no parent run, no origin), start 202, one full iteration happy path, 2 iterations with early convergence, meshing failure ⇒ `failed` (stage meshing), stop during solving ⇒ `stopped`, lock (start-run 409 while the job runs), boot reconciliation ⇒ `interrupted`, file download allow-list.
- API `meshOrigin.test.ts`: written by from-meshing case, cleared by another mesh import; chamber `input.json` written.
- API `pipelineStages.test.ts`: `awaitRunTerminal` resolves on finalize and on an already-terminal row; `awaitMeshingTerminal`.
- Python `apps/api/scripts/tests/test_lidkit.py` (skipped without scipy/shapely): `--flat` regression on a small box STL reproduces the flat lid; surface from a synthetic VTK pair gives the analytic z_s.
- Web: `FreeSurfaceTab.test.tsx` (checks rendering, disabled without a flat patch, iterations control, progress, results table).
- ⚠️ To validate on the Debian server: `postProcess -func lidSurfaces` on v2406, the kit scripts under the server interpreter, one real iteration end to end (timings).
