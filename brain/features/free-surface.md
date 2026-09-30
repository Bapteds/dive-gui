# Feature · Free surface (lid iteration)

> **Status**: in progress (branch `feat/free-surface-tool`, not merged; OpenFOAM side to validate on the Debian server) · **Updated**: 2026-09-30
> **Specs**: `brain/specs/2026-09-30-free-surface-tool-design.md` (WS-I) · **Codemaps**: `brain/codemap/api-projects.md` (`freeSurface.*`, `mesh.service.ts`, `runs.service.ts`), `brain/codemap/api-lib.md` (`pipelineStages`, `lidkit`, `freeSurfaceStorage`, `meshOriginStorage`, `polyMeshLevels`, `stlMerge`), `brain/codemap/api-scripts.md` (`lidkit/*`), `brain/codemap/web-features-projects.md` (`features/freesurface`), `brain/codemap/web-core.md` (`ProjectDetailPage.tsx`)
> **Source tool**: `documents/Tools/lidIterationKit/` (README = method, validation, limitations).

## 1. Purpose

From a project whose case has a converged **rigid-lid** steady run (a flat horizontal top patch, typically `atmosphere`, slip), compute the free-surface elevation `z_s = Z_lid + (p_lid − p0_inlet)/g` and iterate the lid shape by **remeshing** (never mesh morphing): fit the flat base STL to `z_s`, mesh it with the source meshing session's settings, send the mesh to the case, re-solve, and repeat until the lid residual RMS `|z_s(new) − z_lid(mesh)|` is below the tolerance or the requested iterations (1 by default, 2 or 3) are done. Any member who can see the project can use it; an invisible project is 404.

## 2. User journey

Project page, tab **Free surface** (`?view=freesurface`), enabled once the case has `constant/polyMesh/` (tooltip otherwise).

1. **Loading**: skeleton; error: `ErrorState` "We could not load the free-surface tool." + retry.
2. **Setup panel**: the six readiness checks (icon + text, never color alone): lid patch (flat top patch or the blocking message "This mesh has no flat top patch…"), lid BC (warning only when `0/U` is not `slip` / `symmetry` / `symmetryPlane`), inlet patch, parent run ("Run the solver to convergence first."), source meshing session ("Pick the meshing session that produced this mesh." when there is no recorded mesh origin), solver (steady incompressible). Selects: lid patch (flat patches only, with their z), inlet patch (`patch` type), source session (meshed sessions; prefilled from the mesh origin). "Measured lid height Z_lid" (from the session's lid surface, never typed). Settings: Iterations segmented `1 · 2 · 3` (hint "Each iteration remeshes and re-solves: about one mesh + one solve."), tolerance (mm), **Advanced** (`<details>`: smoothing radius, minimum water over tops, lid edge length, interior spacing, clearance, level datum, machine axis x / y, rings, cut toggle). One orange **Start**, disabled while a check blocks. Changing a select re-queries the checks with the selection.
3. **Progress panel** (while a job runs): "Iteration k of n" (or "Residual check after iteration k"), stepper Export → Surface → Fit → Mesh → Case → Solve (`aria-current="step"`), link to the live meshing session, "Open the Solver tab" during the solve, **Stop** (then "Stopping…"). Start is replaced by "A free-surface job is running on this project."
4. **Results panel** (running or last / picked job): status badge, reason (e.g. "Iterations done: the lid residual RMS is 5.0 mm (tolerance 3.0 mm)."), notes (figures skipped…), table "Results per iteration" (Parent + one row per iteration: z_s mean / min, residual RMS / max, clamped lid points, upstands, mesh cells, Δp₀, fitted STL download), residual-RMS-per-iteration SVG chart with the tolerance line and a "Show residual values" table, "Show figures" (fit check + post figures, fetched on demand), delete (confirmation).
5. **Previous runs** list when there is more than one job.

## 3. Business rules and invariants

- **One job per project**; while it runs the project is locked: `POST /runs`, `DELETE /files` (reset), `POST /files/import`, `POST /cgns/convert`, `POST /meshes/merge`, `POST /mesh/from-meshing` (case target), `POST /boundary-conditions/apply`, `POST /mesh/backup/restore` answer 409 `FREE_SURFACE_IN_PROGRESS` (`freeSurfaceLock` route middleware). The job's own calls go to the services, not through these routes. A second start is 409 `FREE_SURFACE_IN_PROGRESS`; an active solver run is 409 `RUN_IN_PROGRESS`; a blocking check is 422 `FREE_SURFACE_NOT_READY` whose message is the check's text. A running optimisation study (WS-H) locks the same routes with 409 `STUDY_IN_PROGRESS` and blocks the free-surface start; a running free-surface job blocks a study start (409 `FREE_SURFACE_IN_PROGRESS`).
- **Flat lid**: the case mesh's face centres within ±1 mm of one z AND every face normal vertical (`polyMeshLevels`, ASCII polyMesh only; a binary / compressed mesh blocks with its own message). Default lid: `atmosphere` when flat, else the only flat patch, else the user picks.
- **Base STL is always the flat source geometry** (the kit rule "never fit a fitted STL"): `base.stl` is built once per job from the source session's surfaces. After a job the case lid is no longer flat, so the tool blocks until the original mesh is back (backup restore).
- Session surfaces → solids: a file with 2+ named solids keeps their names, any other file is one solid named after its stem (the cfMesh merge rule). The fitted STL is split back per file by solid name; a new upstand solid would join the lid's file (the upstand patch is the lid).
- Iteration k: new session `<source name>-lid<k>` = copy of the source setup (engine + config + surfaces) with the fitted surfaces, meshed with the source's last run config; a failed session fails the job at stage `meshing` ("The meshing session "…" failed. Open it to read the log."). The mesh goes to the case through WS-F (`importMeshFromMeshing`, BCs kept by name, original case backed up once), then time directories > 0, `processor*` and `postProcessing/` are removed (the kit's Allrun cleanup) and the solver runs with the parent run's cores.
- Convergence: residual RMS of surface j < tolerance ⇒ `converged` (checked from the parent on, like the kit loop); iterations done ⇒ `completed`. Other ends: `failed` (stage + reason), `stopped`, `interrupted` (server restart, reconciled at boot).
- Stop stops the current stage (`stopMeshingRun` or `stopRun`; a Python step finishes first) and the job ends `stopped`. Idempotent.
- The fit check (open edges above the base count without cut solids) fails the job, as in the kit driver.
- Figures need matplotlib in the kit interpreter: probed once per job; without it they are skipped with a note (the job still runs).
- Δp₀ is shown only when the `inlet_p0_flux` / `outlet_p0_flux` monitors (WS-G) wrote data, else "-".
- Downloads are allow-listed: `domain_lidIter<k>.stl|png` and `lid_iter<k>.png` only (`isFreeSurfaceFileName`), anything else 404.

## 4. Technical flow

### Readiness
`FreeSurfaceTab` → `useFreeSurfaceQuery` (`['projects', id, 'free-surface', 'overview', selection]`, `keepPreviousData`, polls 2 s while a job runs) → `GET /projects/:id/free-surface?lidPatch&inletPatch&sessionId` → `freeSurface.service.getFreeSurfaceOverview` → `computeReadiness`: `polyMeshLevels.readPatchLevels` (cached in `freesurface/patch-levels.json` on the mesh files' size + mtime), `0/U` via `getFieldPatchType`, latest `Run` row + time directories, `readMeshOrigin`, `meshingStorage` (`readMeta`, `hasCompleteResultMesh`, `isSessionRunning`), `pipelineStages.sessionMeshingConfig`, `lidkit.readSessionSolids` + `solidZStats` (Z_lid), `controlDict` application.

### Job
`useStartFreeSurface` → `POST /projects/:id/free-surface` (202 `{ job }`) → `startFreeSurfaceJob` (claims the lock first, re-runs the checks, writes `base.stl` and `job.json`) → background `runJob`:
1. matplotlib probe (`python -c "import matplotlib"`);
2. `exporting` j: `system/lidSurfaces` (kit template, patch names substituted), `postProcess -case <case> -func lidSurfaces -latestTime` (`planOpenfoamCommand`, `LIDKIT_TIMEOUT_MS`), latest `postProcessing/lidSurfaces/<t>/{lid,inlet}.vtk` copied to `export_iter<j>/`;
3. `surface` j: `lidkit_surface.py <export> zs_iter<j>.npy --z-lid Z [--axis= --rings= --datum-y=]` → `zs_iter<j>.json` → `surfaces[j]` (+ Δp₀), post figure `lid_iter<j>.png` for j ≥ 1;
4. for k = 1..n while RMS ≥ tol: `fitting` (`lidkit_fitlid.py base.stl geometry/domain_lidIter<k>.stl --zs zs_iter<k-1>.npy …`), `meshing` (`pipelineStages.meshSessionWithSurfaces` + `awaitMeshingTerminal`, cell count from the session log), `transferring` (`sendSessionToCase` + cleanup), `solving` (`solveCase` → `startRun` + `awaitRunTerminal`), then 2-3 for j = k.
Every stage is persisted before it starts. `useFreeSurfaceJobQuery` (`['projects', id, 'free-surface', 'job', jobId]`) polls the job; when it ends the tab invalidates `['projects', id, 'files' | 'runs' | 'runnable']`.

### Stop, delete, files, boot
`POST …/:jobId/stop` → `stopFreeSurfaceJob`; `DELETE …/:jobId` (409 while active) → `deleteJobDir`; `GET …/:jobId/files/:name` → `readFreeSurfaceFile` (attachment); `server.ts` → `reconcileOrphanFreeSurfaceJobs` (`running` ⇒ `interrupted`, "Interrupted by a server restart").

### Mesh origin (shared with WS-H)
`importChamberIntoMeshing` stamps the session `meta.json` with `origin.chamberHash`; `importMeshFromMeshing` (case target) writes `projects/<id>/mesh-origin.json` after `replaceCasePolyMesh`; `replaceCasePolyMesh`, `clearCase` (reset, restore), a case import touching `constant/polyMesh/` and a CGNS conversion delete it. `GET /projects/:id/mesh-origin` → `{ origin }`. `buildChamber` also writes `input.json` (the `ChamberInput`) next to `params.json` (not hashed).

## 5. Data and storage

- `STORAGE_DIR/projects/<id>/freesurface/<jobId>/`: `job.json` (atomic), `base.stl`, `export_iter<j>/`, `zs_iter<j>.{npy,json}`, `geometry/domain_lidIter<k>.{stl,json,png}`, `lid_iter<j>.{png,json}`, `logs/`; `freesurface/patch-levels.json` (flatness cache). New meshing sessions `<source>-lid<k>` under `STORAGE_DIR/meshing/`. `projects/<id>/mesh-origin.json`. `chamber/<hash>/input.json`.
- No Prisma change. In-memory registry of active jobs (single API instance).

## 6. Configuration and external dependencies

- `LIDKIT_PYTHON_BIN` (default: the `CHAMBER_PYTHON_BIN` value; numpy + scipy + shapely, matplotlib optional), `LIDKIT_TIMEOUT_MS` (15 min per kit step). `OPENFOAM_BASHRC` for `postProcess`; the mesher and the solver use their own settings.
- Vendored scripts `apps/api/scripts/lidkit/` (`lidkit_surface.py`, `lidkit_fitlid.py`, `vtk_reader.py` unchanged; `lidkit_post.py` adapted to take paths on the command line; `templates/lidSurfaces`). The kit driver `lidkit.py` is not vendored (shell strings, `setsid`): its orchestration is `runJob`.
- **To validate on the Debian server**: `postProcess -func lidSurfaces` on ESI v2406 (output path and legacy VTK names), the kit scripts under the server interpreter, one real iteration end to end (timings).

## 7. Tests

- `apps/api/tests/freeSurface.test.ts` (14): readiness (ready, no flat patch, not-slip warning, no parent run, no origin, stranger 404, 422), one full iteration, 2 iterations with early convergence, figures skipped without matplotlib, meshing failure, lock + stop during solving + delete, file allow-list, boot reconciliation. Fakes: command runner (postProcess, kit scripts), stream runner (cartesianMesh, checkMesh, simpleFoam), one-cell ASCII cube mesh.
- `apps/api/tests/meshOrigin.test.ts` (6), `apps/api/tests/pipelineStages.test.ts` (4).
- `apps/api/scripts/tests/test_lidkit.py` (3, skipped without numpy/scipy/shapely): `--flat` box regression, analytic surface, post figure.
- `apps/web/src/features/freesurface/FreeSurfaceTab.test.tsx` (5).

## 8. History

- 2026-09-30: created (WS-I), `brain/changelog/2026-09.md`.

## 9. Known limits and bugs

- Kit limitations kept (README): no shoreline modelling of exposed tops (`tmin` clamp + count), flat single-height lids only, vertical protrusions only for the cut.
- The lid flatness reader handles ASCII polyMesh only.
- After a job the case holds the last iteration's mesh and solution; the parent solution lives only in the mesh backup (original case).
- `postProcess` is hard-coded (no `*_BIN`), like `decomposePar` (K5).

## 10. Changing this feature

- Keep the vendored kit maths unchanged; re-vendor from `documents/Tools/lidIterationKit/` and re-run `test_lidkit.py`.
- `pipelineStages.ts` is shared with WS-H: keep it generic.
- New stages or statuses: `FREE_SURFACE_STAGES` / `FREE_SURFACE_JOB_STATUSES` in `@dive/shared`, the tab's `STEPS` / `STATUS_META`, this sheet.
- A new case-mutating route must get `freeSurfaceLock()` and, if it replaces the mesh, clear the mesh origin.
