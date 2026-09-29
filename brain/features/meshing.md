# Feature · Meshing (snappyHexMesh / cfMesh)

> **Status**: in production · **Updated**: 2026-09-29
> **Specs**: `brain/specs/2026-08-11-per-patch-feature-edges-design.md`, `brain/specs/2026-08-11-per-patch-layers-design.md`, `brain/specs/2026-08-11-per-patch-toggles-design.md`, `brain/specs/2026-08-17-cfmesh-per-patch-refinement-and-layers-design.md`, `brain/specs/2026-08-11-chamber-to-meshing-transfer-design.md`, `brain/specs/2026-09-29-meshing-to-project-design.md` · **Codemaps**: `brain/codemap/web-features-meshing-solver.md` (section `features/meshing`), `brain/codemap/web-core.md` (`MeshingPage.tsx`, `MeshingSessionPage.tsx`), `brain/codemap/api-core.md` (`meshing` module), `brain/codemap/api-lib.md` (`meshingStorage`, `meshingVizStorage`, `snappyDicts`, `snappyPipeline`, `cfMeshDicts`, `cfMeshPipeline`, `meshPipelineRun`, `stlBounds`, `stlMerge`, `cores`), `brain/codemap/root-shared-mcp.md` (meshing sessions)

## 1. Purpose

Turn STL surfaces (or a `.fms` for cfMesh) into an OpenFOAM `constant/polyMesh` mesh, outside of any project. Each "session" is a disposable OpenFOAM case, with an engine chosen at creation (`snappy` = snappyHexMesh, `cfmesh` = cfMesh `cartesianMesh`) and fixed afterwards. The user tunes refinement, boundary layers and sharp edges, often patch by patch, launches the mesher in the background, follows the log live, then inspects the result in 3D and downloads the case. Access: any authenticated user; sessions are tied neither to a project nor to a user, they are shared by the whole team.

## 2. User journey

### List (`/meshing`, `Meshing` navigation entry)
- `MeshingPage`: creation form (name of 1 to 120 characters, engine `snappyHexMesh` / `cfMesh` via `SegmentedRadioGroup`, server `VALIDATION_ERROR` surfaced on the field), sessions table (link, engine badge, number of surfaces, meshed yes/no, date, `Rename` and `Duplicate` actions), skeleton while loading.
- **Transfer from Chamber**: `Send to Meshing` button in `ChamberPage` (existing build), `SendToMeshingDialog` dialog with three modes: new session (name + engine), existing session, copy of a session's setup with the geometry injected. On success, navigation to `/meshing/:id`. Displayed note: a patch with the same name replaces the existing surface, the other surfaces stay.

### Detail (`/meshing/:id`)
- Header: name, engine, number of surfaces, "mesh ready" / "not meshed yet"; `Download case` and `Send to project` (both if meshed, secondary) and `Delete` (`AlertDialog` confirmation). `Send to project` is `aria-disabled` with the tooltip "Wait for the mesh run to finish." while a run is active.
- **Send to project** (`SendToProjectDialog`, WS-F): pick a visible project, then `Case mesh` (default: replaces the project's case mesh, the original case is backed up once, BCs of same-name patches kept) or `Mesh library part` (name prefilled with the session name, required). Errors inline (`MESHING_NOT_MESHED`, `MESH_IN_PROGRESS`, `RUN_IN_PROGRESS`, `NOT_FOUND`). Success: toast "Mesh sent to <project>." then `/projects/:id?view=visualize`.
- **Surfaces** (`StlManager`): add via a file picker (`.stl`, and `.fms` in cfMesh), delete per row, toasts "Surface added." / "N surfaces added.".
- **Preview**: `StlViewer` (client-side three.js, no OpenFOAM) before meshing, `MeshResultViewer` (server rendering of the patches, `PatchTable` + scene shared with Visualize) after.
- **Configuration**: `SnappyConfigForm` or `CfMeshConfigForm`, seeded only once at mount from the autosaved config, otherwise from the last run's config, then debounced 800 ms autosave (silent failure). Single orange CTA `Generate mesh`.
- **Run** (`MeshRunPanel`): status badge, timer, `Stop`, `RunLog` (dedicated `ariaLabel`). End of run: toast "Mesh generated.", "Mesh run stopped." or "Meshing did not complete. See the log below.", step report `ImportReport`.
- States handled: loading (skeleton modeled on the layout), session not found (404), no WebGL, manifest being built, render error with `Try again`, no patches.

## 3. Business rules and invariants

- **Fixed engine**: a config whose `engine` differs from the session's is refused (400 `ENGINE_MISMATCH`), both at run time and at autosave.
- **Surfaces**: snappy only accepts readable `.stl` files (non-empty bbox); cfMesh accepts `.stl` files **or** a single `.fms`, never both (422 `INVALID_STL`). No file: 400 `NO_STL`. Names are sanitized (`sanitizeStlName`: basename, NFKD without diacritics, `[A-Za-z0-9._-]`, `.stl` extension forced except `.fms`); a file with the same name is overwritten.
- **One run per session** (in-memory registry `activeMeshRuns`, 409 `MESH_IN_PROGRESS`). At least one surface (400 `NO_STL`); snappy requires a readable bbox (400).
- **Cores** bounded to `[1, coreBudget()]` on the server (at run time and at autosave), even if the client sends more. This budget is not shared with solver runs (L21).
- **Allclean** before each run (`cleanPriorMeshArtifacts`): deletion of `constant/polyMesh`, `processor*` and numeric time folders; `system/` and `constant/triSurface/` kept. Avoids the `decomposePar` error "Size N is not equal to the expected length M".
- **snappyHexMesh**:
  - `internal` domain (keep-point at the center of the bbox) or `external` (corner of the enlarged box slightly pulled in), optional manual keep-point (`locationInMesh`);
  - base size = `baseCellSize` or diagonal/40, box enlarged by `marginFactor × diagonal`, 1 to 500 cells per axis;
  - min/max refinement **per surface** (`surfaceRefinements`, integer levels 0 to 10, `max >= min` otherwise the CTA is blocked);
  - sharp edges **per surface**: on/off checkbox (`featureSurfaces`, OFF = neither feature extraction nor feature refinement), angle `includedAngle` (default 150°) and level (default 2) per surface (`featureRefinements`);
  - layers **per surface**: on/off (`addLayers.surfaces`, empty = all) and overrides n / expansion / final thickness (`perSurface`); `relativeSizes` stays global (OpenFOAM limit); warning if layers are enabled with no surface checked;
  - MPI parallel if `cores > 1`.
- **cfMesh**:
  - absolute sizes in meters (auto `maxCellSize` = diagonal/40; mandatory for FMS input without a bbox, otherwise CTA disabled); `minCellSize`, `boundaryCellSize` optional;
  - several STLs merged into one multi-solid ASCII STL, one solid (hence one patch) per file;
  - global sharp edges (`extractFeatures`, `featureAngle` default 45°, hidden if `.fms`);
  - **boundary types per patch** (`patchTypes` limited to `patch`, `wall`, `symmetry`, `symmetryPlane`, `empty`; seed: saved choice, otherwise FMS type, otherwise `wall`; `empty` is never a default);
  - **local refinement per patch** (`localRefinement`, `cellSize` > 0, only for checked patches);
  - **tri-state layers per patch**: unchecked = no layer (`noLayerPatches`, rendered as `nLayers 0`); checked = read-only mirror of the global block, which follows its edits; checked + `Customize` = own values (`perPatch`), `Reset to global` to go back to the mirror;
  - `cores` = OpenMP threads (`OMP_NUM_THREADS`), no MPI.
- **Persistent status**: `status.json` (`running`, `succeeded`, `failed`, `stopped`) written atomically (`status.json.tmp` then `rename`); the read retries up to 5 times, 5 ms apart. Session never launched: `idle`.
- **Stop**: idempotent; SIGTERM of the current step's process then SIGKILL after `RUN_STOP_GRACE_MS`; stop between two steps via `aborted()`; with no live process, an orphan `running` goes to `stopped`.
- **Session deletion**: an active run is first killed with SIGKILL, then `rm -rf`.
- **Duplication** (`copySessionSetup`): same engine, copy of `constant/triSurface/` and `config.json`; never the mesh, `system/`, `run.json`, the log, the status or the render.
- **Transfer from Chamber**: reads the build's `exports/trisurface.zip` (409 `CHAMBER_NOT_BUILT` if missing), extracts one STL per patch **excluding `domain.stl`** (422 `INVALID_STL` if none), then goes through `addStlFiles` (same rules as the upload, overwrite by name, surfaces with other names kept).
- **Bridge to a project** (WS-F, 2026-09-29): `POST /api/v1/projects/:id/mesh/from-meshing` `{ sessionId, target: 'case' | 'library', name? }` copies ONLY the session's `constant/polyMesh/**` (never `system/`, `0/`, `.viz/`, logs). Gate: project Visible (404 first, so sessions are not probed through a foreign project), session exists (404), no run in progress (registry or `status.json` `running`, 409 `MESH_IN_PROGRESS`), complete polyMesh incl. `neighbour` (`hasCompleteResultMesh`, 409 `MESHING_NOT_MESHED`), and for `case` no queued/running solver run (409 `RUN_IN_PROGRESS`). Both targets drop a zero-face `domainBoundary` (and only that name); `case` forces the chamber patch types (`CHAMBER_PATCH_TYPES`: `inlet`/`outlet` `patch`, the walls `wall`, constraint types never overwritten). Project side: `brain/features/mesh-library-and-conversion.md`; full contract in the spec. `Download case` stays available.

## 4. Technical flow

### Sessions
Hooks `useMeshing.ts` (keys `['meshing']`, `['meshing', id]`) → `/api/v1/meshing` (`requireAuth` only): `GET /`, `POST /` (`useCreateMeshingSession`), `POST /copy` (`useCopyMeshingSession`), `POST /from-chamber` (`useTransferChamberToMeshing`, zod union `new` / `existing` / `copyFrom`), `GET|PATCH|DELETE /:id`. Mutations write the detail into the cache (`setQueryData`) and invalidate the list. `meshing.service.ts` → `meshingStorage` (`createSession`, `renameSession`, `copySessionSetup`, `deleteSession`) and `chamberStorage.readChamberExport` for the transfer.

### Surfaces and STL preview
`useUploadStl` → `POST /meshing/:id/stl` (multipart `files`, shared parser `parseCaseUpload`) → `addStlFiles` → `writeStl`. `useDeleteStl` → `DELETE /:id/stl?name=`. `StlViewer`: inline query `['meshing', id, 'stlBuffers', <names>]` → `GET /:id/stl?name=` for each file, parsed by `STLLoader`. The session view (`assembleSession`) provides `bounds` (union of the STL bboxes), `patches` (cfMesh: names from the `.fms`, from the solids of a single STL, or `mergedSolidNames` for several STLs), `savedConfig`, `lastRun`, `maxCores`, `runStatus`.

### Configuration
Autosave: `useSaveMeshingConfig` → `PUT /:id/config` (`meshingConfigSchema`, discriminated union on `engine`) → `saveMeshingConfig` (engine check, core bounding) → `config.json`. Payload built in `useMemo` by the form; effect keyed on `JSON.stringify(config)`, first render ignored.

### Background run
`useStartMeshing` → `POST /:id/run` → `startMeshingRun`: validations (§3), registration in `activeMeshRuns` before any `await`, `truncateMeshLog`, header `=== Meshing (<engine>) ===`, `status.json` `running`, `config.json`, 202 response `{ session, status }`, then `finishMeshingRun` as a background task:
- **snappy** (`runSnappyPipeline`): writes `system/{controlDict,fvSchemes,fvSolution,blockMeshDict,surfaceFeatureExtractDict,snappyHexMeshDict}` (+ `decomposeParDict` in parallel). Serial: `blockMesh`, `surfaceFeatureExtract`, `snappyHexMesh -overwrite`, `checkMesh`. Parallel: `blockMesh`, `surfaceFeatureExtract`, `decomposePar -force`, `mpirun <MPI_RUN_FLAGS> -np N snappyHexMesh -overwrite -parallel`, `reconstructParMesh -constant`, `checkMesh`; `processor*` deleted only if the reconstruction succeeds.
- **cfMesh** (`runCfMeshPipeline`): resolution of `maxCellSize` (immediate failure if impossible), `.work/`, surface preparation (FMS as is, single STL as is, several STLs merged into `.work/combined.stl`: "Combine surfaces" step), `surfaceFeatureEdges -angle <a>` to `.work/combined.fms` if requested, writing of `system/{controlDict,fvSchemes,fvSolution,meshDict}` (`renderMeshDict`: `localRefinement`, `boundaryLayers` + `patchBoundaryLayers`, `renameBoundary`), `cartesianMesh` with `OMP_NUM_THREADS`, `checkMesh`.
- `runStepsStreaming` appends `=== label ===` and `$ command` to `mesh.log` for each step, runs `runStream`, exposes the handle to the registry (for the stop), and short-circuits to `skipped` after a failure.
- End: `run.json` (config + report), `config.json`, terminal `status.json` (`stopped` if a stop was requested, otherwise `succeeded`/`failed`), deletion of `.viz/`, `=== Done ===` / `Stopped` / `Failed` line, removal from the registry. Any exception becomes a `failed` run.

### Live log and end of run
`useMeshingRunLog` → `GET /:id/run/log` every 1,200 ms as long as the status is unknown or `running` → `getMeshingLog`: `status.json`, tail of `mesh.log` bounded to `SOLVER_LOG_MAX_BYTES` then 20,000 characters, `run.json` report attached only once terminal. The page detects the active-to-terminal transition (ref) and calls `useOnMeshingRunSettled` only once: invalidation of detail + list and `removeQueries` of the manifest / glb / edges keys.

### Stop
`useStopMeshing` → `POST /:id/run/stop` → `stopMeshingRun` (§3).

### Result viewer
`MeshResultViewer` → `useMeshingManifestQuery` (`GET /:id/mesh/manifest`, builds the render on demand: `MESH_PYTHON_BIN extractPatches.py <caseDir> <glb> <manifest>` if `meshingVizIsStale`) then, if the manifest is OK and WebGL is present, `useMeshingGeometryQuery` (`GET /:id/mesh/geometry`, GLB) and `useMeshingEdgesQuery` (`GET /:id/mesh/edges`, 204 if absent). Errors: 409 `NO_MESH`, 500 `SCRIPT_MISSING`, 502 `MESH_BUILD_FAILED`, 409 `MESH_NOT_BUILT`. Caches `staleTime`/`gcTime` 5 min, `retry: false`.

### Send to project
`SendToProjectDialog` → `useImportMeshFromMeshing` (`features/projects/useMeshes.ts`) → `importMeshFromMeshing` (`lib/api/projects.ts`) → `POST /projects/:id/mesh/from-meshing` → `mesh.service.importMeshFromMeshing` (session gate `meshing.service.requireMeshedSession`; staging under `meshes/.work/from-meshing-*`; case: `ensureOriginalBackup`, `caseStorage.replaceCasePolyMesh`, `clearAppliedAssembly`, `scaffoldCase` if no `system/controlDict`, `syncBoundaryFields` merge; library: `meshes.service.addMeshingPartToLibrary`). Web cache: H6 purge (`manifest`/`glb`/`edges` removed; `files` set; `meshes`, `assembly`, `mergePlan`, `runnable`, `mesh/backup` invalidated) or library list set.

### Download
`getSessionZip` → `GET /:id/download` → `downloadSessionZip` (`zipTreeAt` over the whole session folder) → file `meshing-<name>.zip` (`blob:` anchor).

### Reconciliation at boot
`server.ts` launches `reconcileOrphanMeshingRuns()`: each session left `running` goes to `failed`, with "[runner] Interrupted by a server restart." in the log. Unlike the solver (H1), a possibly surviving process is not killed.

## 5. Data and storage

No Prisma model: everything lives under `STORAGE_DIR/meshing/<sessionId>/` (see `brain/architecture/storage-layout.md`):
- `meta.json` (`id`, `name`, `engine`, `createdAt`; unknown engine mapped back to `snappy`), `config.json` (autosave), `run.json` (last `MeshingRun`), `status.json` (atomic), `mesh.log`;
- `constant/triSurface/<name>.stl|.fms` (inputs), `system/*` (generated dicts), `constant/polyMesh/*` (result, presence tested by `hasResultMesh`: `points`, `faces`, `owner`, `boundary`), `.work/` (cfMesh scratch), `processor<N>/` (parallel snappy, temporary), `.viz/{patches.glb, manifest.json, edges.bin}` (render, stale if `boundary`/`points` are newer than the GLB, deleted at every end of run).
- Session id = slug of the name (`-2`, `-3`… on collision), never renamed; `Rename` only changes `meta.json`.
- Web caches: everything is under the `['meshing']` prefix; invalidating the list refreshes all active meshing queries (details, log, STL buffers, render).

## 6. Configuration and external dependencies

- Snappy: `BLOCK_MESH_BIN`, `SURFACE_FEATURE_BIN`, `SNAPPY_HEX_MESH_BIN`, `DECOMPOSE_PAR_BIN`, `RECONSTRUCT_PAR_MESH_BIN`, `CHECK_MESH_BIN`, `MPI_BIN`, `MPI_RUN_FLAGS`, `DECOMPOSE_METHOD`, `SNAPPY_STEP_TIMEOUT_MS` (30 min per step).
- cfMesh: `CARTESIAN_MESH_BIN`, `SURFACE_FEATURE_EDGES_BIN`, `CHECK_MESH_BIN`, `CFMESH_STEP_TIMEOUT_MS` (30 min per step). The multi-STL merge is done in TypeScript (`stlMerge`), not by `surfaceAdd` (deemed unreliable on the server).
- Rendering: `MESH_PYTHON_BIN` (pyvista, trimesh, numpy), `EXTRACT_PATCHES_SCRIPT`, `MESH_BUILD_TIMEOUT_MS`.
- Budget: `SOLVER_TOTAL_CORES` (via `coreBudget`), `SOLVER_LOG_MAX_BYTES`, `RUN_STOP_GRACE_MS`. All OpenFOAM tools go through `OPENFOAM_BASHRC` if it is defined.
- Missing tool: the step concerned is `failed` (ENOENT in the report), the following ones `skipped`, status `failed`. Without OpenFOAM (Windows workstation), upload and STL preview still work.

## 7. Tests

- `apps/api/tests/meshing.test.ts`: sessions (creation, upload, list, rename, deletion), background run (202 then poll until `succeeded`, zip), cfMesh (`surfaceFeatureEdges`, `cartesianMesh`), multi-STL merge, `ENGINE_MISMATCH`, missing tool, `idle`, `MESH_IN_PROGRESS`, stop, transfers (copy, chamber into new / existing / copy, `domain.stl` excluded, `CHAMBER_NOT_BUILT`), snappy and cfMesh zod schemas.
- `apps/api/tests/meshingStorage.test.ts`: slugs, `sanitizeStlName`, atomic write of `status.json` (200 rewrites without a torn state), `copySessionSetup`.
- `apps/api/tests/snappyDicts.test.ts`, `snappyPipeline.test.ts`: domain, per-surface dicts (angle, level, layers, `minMedialAxisAngle`), serial order and MPI chain, Allclean, short-circuit.
- `apps/api/tests/cfMeshDicts.test.ts`, `stlMerge.test.ts`, `stlBounds.test.ts`: `meshDict` (`renameBoundary`, `localRefinement`, `patchBoundaryLayers`, `noLayerPatches` as `nLayers 0`), STL merge, bbox.
- `apps/web/src/features/meshing/CfMeshConfigForm.perPatch.test.tsx`: tri-state layers, live mirror, `Customize` / `Reset to global`, local refinement per patch.
- `apps/web/src/features/chamber/SendToMeshingDialog.test.tsx`: transfer dialog.
- `apps/api/tests/meshFromMeshing.test.ts` (14): the session -> project hand-off (access, guards, case and library targets, patch retyping, `domainBoundary`). `apps/api/tests/chamberPatchTypes.test.ts`: `CHAMBER_PATCH_TYPES` parity with `buildChamber.py`. `meshingStorage.test.ts`: `hasCompleteResultMesh`.
- `apps/web/src/features/meshing/SendToProjectDialog.test.tsx` (9), `apps/web/src/features/projects/useMeshes.fromMeshing.test.tsx` (2).
- Not covered: `SnappyConfigForm`, `MeshingSessionPage` (the header button included), `MeshResultViewer`.

## 8. History

- 2026-07-07: Meshing page, STL to snappyHexMesh; per-surface refinement, layer options, config persistence, `minMedialAxisAngle` keyword (`brain/changelog/2026-07.md`).
- 2026-07-08: MPI parallel snappy + autosave, Allclean, per-surface layers, snappy/cfMesh engine choice, in-process multi-STL merge (`surfaceAdd` abandoned, "single file" reverted), cfMesh boundary type editor, no more `empty` patch by default.
- 2026-08-11: Chamber to Meshing transfer and session duplication; per-surface sharp edges (snappy); per-patch layers (snappy and cfMesh); per-patch override toggles (`brain/changelog/2026-08.md`).
- 2026-08-11: renaming of sessions (and projects); environment fix for the render's pyvista interpreter.
- 2026-08-12: live log and Stop button (background job persisted to file).
- 2026-08-17: cfMesh, local refinement per patch and tri-state layers.
- 2026-08-31: atomic write and read of `status.json` (CI "idle" flake).
- 2026-09-29: `Send to project` (WS-F): session polyMesh into a project's case or mesh library (`brain/changelog/2026-09.md`).

## 9. Known limits and bugs

- **M5**: meshers killed at 16 MB of output by `commandRunner` (buffered path; the page's run goes through the streamed path).
- **M6**: SIGKILL on `streamRunner` timeout, MPI ranks possibly orphaned.
- **M12**: `Number(x) || DEFAULT` in `SnappyConfigForm` and `CfMeshConfigForm` replaces a legitimate `0` with the default.
- **M17**: binary STLs with padding rejected.
- **L9**: a `.fms` upload into a snappy session is now refused with 422 by `addStlFiles`; the registry entry seems obsolete (to confirm before closing it).
- **L19**: `StlViewer` silently ignores an unreadable STL; WebGL context loss not handled.
- **L21**: meshing `mpirun` jobs outside the global core budget.
- **K16**: invalidating `['meshing']` refreshes all active meshing queries. **K20**: `SendToMeshingDialog` sends `name: ''` without validation. **K31**: in-memory locks and run registry, single API instance.
- At boot, a surviving mesher is not killed (no H1 equivalent); `reconcileOrphanMeshingRuns` returns the number of sessions listed, not the number changed.
- New patches that appear after the cfMesh form is mounted get the defaults of `DEFAULT_CFMESH_CONFIG`, not the edited global values.
- Chamber transfer into a copied session: surfaces of the old geometry with other names stay (documented choice of the spec).

## 10. Changing this feature

- **Full chain to keep aligned**: `packages/shared` types (`SnappyConfig`, `CfMeshConfig`, defaults) → zod `meshing.schemas.ts` → renderers `snappyDicts.ts` / `cfMeshDicts.ts` → web forms → schema and dict tests. A key missing from a per-patch map must always fall back to the global value, so that a saved config stays identical.
- Rebuild `@dive/shared` before the API tests (`cfMeshDicts.test.ts` depends on it).
- snappy region names are sanitized (`regionNameFor`) but the `.eMesh` file keeps the exact stem (dashes included): do not "simplify".
- `clampCores`, `defaultCores`, `fmt`, `diagonalOf` are duplicated in both forms; `MeshingSessionPage` has its own `runStatusMeta` table.
- Tests go through `setStreamRunner` and `logicalCommand` (see the `OPENFOAM_BASHRC` wrapper): renaming a step or a binary breaks the fake runners.
- Any change to session storage must preserve the atomic write of `status.json` (read while the finalizer writes it).
- Update this sheet, the codemaps and `brain/changelog/` in the same change.
