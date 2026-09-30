# Codemap: API module projects

> Scope: `apps/api/src/modules/projects/**` · Updated: 2026-09-28

## Overview
Central API module: it carries project CRUD (visibility for owner + collaborators + super-admin) and everything related to a project's OpenFOAM case. Each subdomain follows the triplet `*.schemas.ts` (zod) → `*.controller.ts` (thin Express adapter, `requireViewer` duplicated in each controller) → `*.service.ts` (business logic, independent of Express). The HTTP entry point is `createProjectsRouter()` (mounted on `/api/v1/projects` by `app.ts`); `server.ts` additionally imports `reconcileOrphanRuns` (at boot) and `attachTerminalGateway` (WebSocket).
Every operation starts with `assertProjectVisible(viewer, projectId)` (404 `NOT_FOUND` if the project is unknown or invisible, never 403, so as not to reveal its existence). Only rename/delete/collaborators additionally require `canManage` (403 `FORBIDDEN`).
Main flows: case file import (`files`), CGNS→polyMesh conversion (`conversion`), mesh library + assembly/merge (`meshes`), 3D visualization and patch editing of the case mesh (`mesh`), boundary condition presets (`boundary`), serial/MPI solver launch (`runs`), CGNS export for CFD-Post (`export`), per-project shell terminal (`terminal.gateway`).
Cross-cutting convention of the external pipelines (conversion, merge, autoPatch, export): binaries configurable via `config/env`, execution via the injectable runner `runCommand` (or `runStream` for the solver), `planOpenfoamCommand` which sources `OPENFOAM_BASHRC` if set (`bash -c 'source "$OPENFOAM_BASHRC" && exec "$@"'`), and a tool failure is never thrown: it is reported as a structured step (`status: 'failed'`, stdout/stderr truncated to the tail). Only validation/access errors throw an `AppError`.

## `apps/api/src/modules/projects/boundary.controller.ts`
**Role**: controller of the "Boundary conditions" overlay. Parses a multipart request containing a text field `payload` (JSON) and an optional CSV file, validates the JSON with zod, then delegates to `applyBoundaryConditions`.
**Exports**:
- `parseBoundaryUpload: RequestHandler`. In-memory multer (`fileSize` = `MAX_UPLOAD_MB`, `files: 1`). `LIMIT_FILE_SIZE` → 413 `PAYLOAD_TOO_LARGE`; other `MulterError` → 400 `VALIDATION_ERROR`.
- `applyBoundaryConditionsController(req, res)`. `JSON.parse(req.body.payload)` (failure → 422 `VALIDATION_ERROR`), `applyBoundaryConditionsSchema.safeParse` (failure → 422 `VALIDATION_ERROR` with the first zod message), retrieves the file from the `csv` field, responds 200 `{ result }`.
**Depends on**: `boundary.service`, `boundary.schemas`, `multer`, `config/env`. **Used by**: `projects.routes` (`POST /:id/boundary-conditions/apply`).
**Notes**: zod validation is done by hand in the controller (not via the `validate` middleware) because the JSON arrives as a multipart field. No global `Content-Length` guard here, unlike `parseCaseUpload`.

## `apps/api/src/modules/projects/boundary.schemas.ts`
**Role**: zod shape schema for the BC overlay payload. The semantic checks that need the real mesh (patch existence, mode compatible with the object type, value required by mode) live in the service.
**Exports**:
- `boundaryConditionValuesSchema`. `head`, `flowRate`, `mixingLength` positive and optional; `intensity` in ]0, 1].
- `sixDofRotorSchema`. Parameters of a free 6-DoF rotor: `patches` (≥ 1), non-zero `axis`, `centreOfMass`, `mass` > 0, `momentOfInertia` > 0 on each axis, `rhoInf`, `innerDistance`, `outerDistance` > 0, `damperCoeff` ≥ 0.
- `rotorConfigSchema`. `mode` (`ROTOR_MODES`), `cellZone`, `origin`, `axis` (non-zero), `omega` (rad/s), `nonRotatingPatches` (default `[]`), `movingKind` (`MOVING_ROTOR_KINDS`), `sixDof`; refine: `movingRotor` + `free` requires `sixDof`.
- `applyBoundaryConditionsSchema`. `objectType` (`OBJECT_TYPES`), `mode` (`DRIVING_MODES`), `inlet`, `outlet`, `walls` (default `[]`), `values` (default `{}`), optional `rotor`.
- `ApplyBoundaryConditionsInput` (inferred type).
**Depends on**: `@dive/shared` (enumerations). **Used by**: `boundary.controller`.

## `apps/api/src/modules/projects/boundary.service.ts`
**Role**: applies a per-component boundary condition preset (Turbine / Pipe / DraftTube / Chamber + driving mode) to all `0/` fields of the case, optionally with the rotor dictionary (MRF or dynamic mesh) for a turbine. The case is scaffolded and then backed up before writing.
**Exports**:
- `applyBoundaryConditions(viewer, projectId, request: ApplyBoundaryConditionsRequest, csv?: Buffer): Promise<ApplyBoundaryConditionsResult>`. Sequence:
  1. `assertProjectVisible`; reads `constant/polyMesh/boundary` (missing → 409 `NO_MESH`).
  2. Validation before any write: `inlet`/`outlet`/`walls` exist (otherwise 422 `INVALID_BC_PLAN`), `inlet !== outlet`, `mode` allowed by `OBJECT_TYPE_MODES[objectType]`, `values.head` required in `pressure` mode, `values.flowRate` in `flowRate` mode, CSV required in `csvProfile` mode (422 `BC_CSV_REQUIRED`).
  3. `ensureOriginalBackup` (one-time backup of the original).
  4. `scaffoldSolver(viewer, projectId, caseSolver())` to guarantee the `0/` fields (non-destructive), then reads the turbulence model.
  5. `csvProfile` mode: writes the CSV to a tmpdir (`dive-bc-*`), `convertCsvToBoundaryData(caseDir, csvAbs, inlet)` produces `boundaryData` and the list of mapped fields; notes if the conversion fails or if `k`/`omega` are missing (intensity fallback). The tmpdir is always removed.
  6. Unconstrained `walls` patches switch to geometric type `wall` in `boundary`; constraint-type patches (`CONSTRAINT_PATCH_TYPES`) keep their type.
  7. For each non-`polyMesh` file, ≤ 2 MB, containing `boundaryField`: `setFieldPatchBc` with `componentInletBc`, `componentOutletBc` and `fieldBcBody(field, wallGeoType, model)` for walls (a constraint is mirrored as is).
  8. Turbine with `rotor`: checks `nonRotatingPatches` (422 `INVALID_BC_PLAN`), notes if `constant/polyMesh/cellZones` is missing (zone to be created by topoSet). `frozenRotor` → `constant/MRFProperties` (`renderMrfProperties`); otherwise `constant/dynamicMeshDict` via `renderDynamicMeshDictFree` (free 6-DoF, patches checked) or `renderDynamicMeshDict` (forced), plus a note reminding that a moving rotor requires pimpleFoam and a cyclicAMI pair.
  9. Returns `{ success: true, applied: { objectType, mode, inlet, outlet, walls, fields, p0?, rotor? }, csvSteps, notes }` where `p0 = GRAVITY * head` (rounded to 6 decimals) in `pressure` mode.
**Depends on**: `lib/openfoamCase` (dictionary rendering and editing), `lib/boundaryData`, `lib/caseStorage`, `lib/meshBackupStorage`, `files.service.scaffoldSolver`, `projects.service`. **Used by**: `boundary.controller`.
**Notes**: internal helpers `caseTurbulenceModel` (default `kOmegaSST`) and `caseSolver` (configurable solver from controlDict, otherwise `simpleFoam`, so as never to downgrade). Pitfall: validation of the rotor patches (`nonRotatingPatches`, `sixDof.patches`) happens AFTER the `0/` fields and `boundary` have been written, so a 422 at that stage leaves the case partially modified (the backup allows restoring). `FIELD_SCAN_MAX_BYTES` (2 MB) duplicated from `mesh.service`.

## `apps/api/src/modules/projects/conversion.controller.ts`
**Role**: HTTP adapters for the CGNS upload and the CGNS→OpenFOAM conversion.
**Exports**:
- `listCgnsController`. 200 `{ files }`.
- `uploadCgnsController`. Takes the `file` part or, failing that, the first part; none → 400 `NO_FILES_UPLOADED`; 201 `{ file, files }`.
- `deleteCgnsController`. `?name=`; 200 `{ files }`.
- `convertCgnsController`. Body `ConvertCgnsInput`; 200 `{ result }`.
**Depends on**: `conversion.service`. **Used by**: `projects.routes` (`/:id/cgns`, `/:id/cgns/convert`).

## `apps/api/src/modules/projects/conversion.schemas.ts`
Zod schemas: `convertCgnsSchema` (`cgnsFile`, `templateId`, non-empty strings) and `cgnsNameQuerySchema` (non-empty `name`), with the types `ConvertCgnsInput` and `CgnsNameQuery`. Used by `projects.routes`.

## `apps/api/src/modules/projects/conversion.service.ts`
**Role**: management of a project's CGNS sources (stored outside the case via `cgnsStorage`) and the "Convert to Foam" pipeline that produces `constant/polyMesh` from a chosen CGNS, applying a template for the rest of the configuration.
**Exports**:
- `CgnsFileInfo`, `ConversionStep`, `ConversionResult` (interfaces). A step carries `id`, `label`, `command` (displayed logical line), `status` (`success` | `failed` | `skipped`), `exitCode`, `stdout`/`stderr` (tail of 20,000 characters), `durationMs`.
- `listCgns(viewer, projectId): Promise<CgnsFileInfo[]>`.
- `uploadCgns(viewer, projectId, file: { name, data }): Promise<{ file, files }>`. `.cgns` extension mandatory and non-empty content, otherwise 400 `INVALID_CGNS`; `writeCgnsUpload` returns the stored name.
- `removeCgns(viewer, projectId, name): Promise<{ files }>`. `cgnsBaseName` (sanitization), 404 `NOT_FOUND` if missing; also removes the intermediate `.vtk` with the same name (best-effort).
- `convertCgnsToFoam(viewer, projectId, input: ConvertCgnsInput): Promise<ConversionResult>`. Sequence:
  1. Access; CGNS missing → 404 `NOT_FOUND`.
  2. `getTemplate(templateId)` then `applyTemplate(viewer, projectId, templateId)` (adds the files, keeps the existing ones); note "Applied template …".
  3. If `system/controlDict` is missing: `scaffoldCase` (minimal base files), note.
  4. `cgnsToVtk` step: pre-check that the script exists (`CGNS_TO_VTK_SCRIPT` or `apps/api/scripts/CgnsToVtk.py` resolved from `__dirname`), then `CGNS_PYTHON_BIN <script> <cgns> <vtk>` (cwd = CGNS folder). An exit 0 without a VTK file is requalified as `failed`.
  5. `vtkToFoam` step: `VTK_TO_FOAM_BIN -case <caseDir> <vtk>` via `planOpenfoamCommand`.
  6. `checkMesh` step: `CHECK_MESH_BIN -case <caseDir>`.
  7. Short-circuit on the first failure (following steps `skipped`), then `finalize`: `verifyCase` + `listCaseTree`, `success` = all steps `success`.
  Per-step timeout: `CONVERSION_STEP_TIMEOUT_MS`.
- `CONVERSION_STEP_ORDER`. Re-export of `CONVERSION_STEPS` (`@dive/shared`) for the tests.
**Depends on**: `lib/commandRunner`, `lib/openfoamCommand`, `lib/caseStorage`, `lib/cgnsStorage`, `files.service` (`scaffoldCase`, `verifyCase`), `templates.service` (`applyTemplate`, `getTemplate`). **Used by**: `conversion.controller`.
**Notes**: internal helpers `toStep`, `skippedStep`, `pathExists`, `planVtkToFoamDisplay`, `planCheckMeshDisplay`, `cgnsToVtkScript`. The resulting mesh stays as the tools left it (no rollback). The step label mentions a "ParaView script" in a comment but the command uses python3 + standalone VTK.
**WS-I (2026-09-30)**: clears the mesh origin after the `vtkUnstructuredToFoam` step.

## `apps/api/src/modules/projects/export.controller.ts`
**Role**: HTTP adapters for the OpenFOAM→CGNS export ("Export" tab).
**Exports**:
- `runExportController`. 200 `{ result }`.
- `getExportStatusController`. 200 `{ status }` (null if no export).
- `downloadExportArtifactController`. For `cgns`: tries `out.cgns` (`application/octet-stream`), and on 404 falls back to the per-time-step zip (`application/zip`). For `session` / `memo` / `report`: `ARTIFACT_HEADERS` table (MIME type + name `EXPORT_FILES.*`). Headers `Content-Disposition: attachment` and `Cache-Control: private, max-age=0, must-revalidate`.
**Depends on**: `export.service`, `lib/exportStorage` (`EXPORT_FILES`). **Used by**: `projects.routes` (`/:id/export`, `/:id/export/download/:artifact`).

## `apps/api/src/modules/projects/export.schemas.ts`
Schema `exportArtifactParamSchema`: params `id` + `artifact` ∈ `cgns | session | memo | report`; type `ExportArtifactParam`.

## `apps/api/src/modules/projects/export.service.ts`
**Role**: 4-step pipeline that turns a solved OpenFOAM case into a CGNS loadable by Ansys CFD-Post, plus a `.cse` session, a memo and a report. Artifacts live in the project's `export/` store (never in the case).
**Exports**:
- `runExport(viewer, projectId): Promise<ExportResult>`. `clearExport` + `ensureExportDir`, then:
  1. `inspectCase`: `latestSolvedTime` looks for the largest numeric time folder > 0 (regex `TIME_DIR_RE`, accepts exponential notation); missing → `failed` step "No solved results to export". Builds the `CaseProfile` from the files: solver (`application`), `steady` (list `STEADY_SOLVERS`), compressible (presence of `thermophysicalProperties` or prefix `rho`/`sonic`/`compressible`), turbulence model (`momentumTransport` then `turbulenceProperties`), patches and empty patches (nFaces 0), `inletGuess`/`outletGuess` guesses. Runs `checkMesh -case <dir> -latestTime` only to detect polyhedra; its failure makes the step a `warning` (non-blocking). Writes `profile` as JSON.
  2. `convertToCgns`: creates `case.foam`, checks the script (`FOAM_TO_CGNS_SCRIPT` or `scripts/FoamToCgns.py`) and copies a version into `export/`. Runs `xvfb-run -a PVBATCH_BIN FoamToCgns.py <case.foam> <out.cgns> <time|all> <fieldsCsv>` if `PVBATCH_XVFB=true`, otherwise `PVBATCH_BIN --force-offscreen-rendering …`; `PVBATCH_PYTHONPATH` is prepended to `PYTHONPATH`. `EXPORT_ALL_TIMES=true` mode: series `out_<i>.cgns` sorted numerically (`seriesIndex`), times read from the `out.cgns.times` sidecar (`readSeriesTimes`) otherwise by scanning folders (`listSolvedTimeValues`), then merged into one transient CGNS by `MESH_PYTHON_BIN CgnsMergeTime.py <out.cgns> <times> <series…>`. Merge success: the series and the sidecar are deleted; failure: `zipCgnsFiles` and the last piece of the series serves as `cgnsPath`. Fails if no CGNS is produced; diagnostics added (xvfb missing, VTK crash caused by a pip `vtk` wheel shadowing ParaView's).
  3. `validateCgns`: `MESH_PYTHON_BIN CgnsInspect.py <cgns>` (script `CGNS_INSPECT_SCRIPT` or bundled), parses the last JSON line (`CgnsReport`) and produces the checks "Fields present", "Cell-centred data", "Mesh non-empty", "No empty zones" (pass/fail) and "Velocity max" (info). Writes `validation`.
  4. `prepareCfdPost`: writes `session.cse` (`renderSessionCse`: loading, velocity contour, `massFlow()` expressions on the guessed inlet/outlet) and `LOAD_CFDPOST.md` (`renderLoadMemo`, in French: kinematic pressure if incompressible, polyhedra, empty patches, transient mode). Runs even if validation failed.
  `finalize` writes `REPORT.md` (`renderReport`) and computes the artifacts; `success` = all steps `success` or `warning`.
- `getExportStatus(viewer, projectId)`. `{ profile, validation, artifacts }` from disk, or null if there is neither a profile nor a CGNS.
- `readExportArtifact(viewer, projectId, file: keyof EXPORT_FILES): Promise<Buffer>`. 404 `NOT_FOUND` if the artifact does not exist.
- `EXPORT_STEP_ORDER`. Re-export of `EXPORT_STEPS`.
**Depends on**: `lib/exportStorage`, `lib/caseStorage`, `lib/commandRunner`, `lib/openfoamCommand`, `config/env`. **Used by**: `export.controller`.
**Notes**: env variables read: `PVBATCH_BIN`, `PVBATCH_XVFB`, `PVBATCH_PYTHONPATH`, `FOAM_TO_CGNS_SCRIPT`, `CGNS_INSPECT_SCRIPT`, `EXPORT_ALL_TIMES`, `MESH_PYTHON_BIN`, `CHECK_MESH_BIN`, `CONVERSION_STEP_TIMEOUT_MS`. The `CgnsMergeTime.py` script has no override variable (`bundledScript('', …)`). Fix references: C1 (numeric sort of the series and times via sidecar), M16 (time folders in exponential notation). The patch parser `parsePatchFaceCounts` and `parseSolver` are local regexes, distinct from those in `lib/openfoamCase`. The `readArtifacts` comment says the CGNS download "is the zip", whereas the controller prefers `out.cgns` and only falls back to the zip on 404.

## `apps/api/src/modules/projects/files.controller.ts`
**Role**: HTTP adapters for case files, and the shared multipart parser `parseCaseUpload` (reused by the CGNS, meshes, templates and meshing routes).
**Exports**:
- `parseCaseUpload: RequestHandler`. First refuses based on `Content-Length` > `MAX_UPLOAD_TOTAL_MB` (413 `PAYLOAD_TOO_LARGE`, fix H9) before any buffering; then in-memory multer (`fileSize` = `MAX_UPLOAD_MB`, `files: 5000`, `preservePath: true` to keep the relative paths of a folder upload). `LIMIT_FILE_SIZE` → 413; other `MulterError` → 400 `INVALID_ARCHIVE`.
- `getCaseFilesController` (200 `{ entries }`), `importCaseFilesController` (field `archive` = zip, otherwise `files` parts with `originalname` as the relative path; 201 `{ written, entries }`), `resetCaseController` (200), `downloadCaseController` (zip, `Content-Disposition: attachment; filename="case-<id>.zip"`), `verifyCaseController` (200 `{ verification }`), `scaffoldCaseController` (201), `verifyRunnableController` (200 `{ runnable }`), `scaffoldSolverController` (201), `syncBoundariesController` (calls `syncBoundaryFields` in `merge` mode), `getCaseFileContentController` (200 `{ file }`), `saveCaseFileContentController` (raw text body), `createCaseFileController` (201), `deleteCaseFileController`, `deleteCaseDirController`, `moveCaseEntryController`.
**Depends on**: `files.service`, `multer`, `config/env`. **Used by**: `projects.routes`, `templates.routes`, `meshing.routes`.
**Notes**: `syncBoundariesController` forces `merge` mode so as not to overwrite the BCs set via the overlay (inlet totalPressure, outlet anchor). Pitfall: `createCaseFileController` reads `content` from the body, but `createFileSchema` only declares `path` and the `validate` middleware replaces `req.body` with the zod result (unknown keys stripped), so `content` is always `undefined` via this route.

## `apps/api/src/modules/projects/files.schemas.ts`
**Role**: zod schemas for the case-file endpoints.
**Exports**:
- `scaffoldSolverSchema`. `z.preprocess(v => v ?? {}, …)` to tolerate a POST without a body; `solver` ∈ `SOLVER_IDS` and `turbulence` ∈ `TURBULENCE_MODEL_IDS`, both optional. Type `ScaffoldSolverInput`.
- `filePathQuerySchema` (non-empty `?path=`), `createFileSchema` (non-empty `path`), `movePathSchema` (`from`, `to`) and their types.
**Used by**: `projects.routes`, `templates.routes`, `templates.controller` (type `MovePathInput`).

## `apps/api/src/modules/projects/files.service.ts`
**Role**: logic of a project's OpenFOAM case folder: tree, import, reset, zip, verification of mandatory files, base scaffolding and "Make runnable" per solver/turbulence model, synchronization of the `boundaryField`s with the mesh, file-by-file editing. Any visible member can read and write.
**Exports**:
- Types: `CaseVerification` (`hasMesh`, `missingMesh`, `presentBase`, `missingBase`, `complete`, `canScaffold`), `UploadedFile`, `ImportPayload` (`archive?` or `files?`), `ImportResult`, `ScaffoldResult`, `CaseFileContent`, `RunnableCheck` (`hasMesh`, `missingMesh`, `missingFiles`, `runnable`, `solver`, `scaffoldable`, `maxCores`), `ScaffoldSolverResult` (`created`, `removed`, `runnable`, `entries`), `SyncBoundariesResult`, `SyncBoundaryOptions` (`mode?: 'rebuild' | 'merge'`).
- `getCaseFiles(viewer, projectId): Promise<CaseEntry[]>`.
- `importCaseFiles(viewer, projectId, payload)`. Zip → `extractArchive`, folder → `writeUploadedFiles`, nothing → 400 `NO_FILES_UPLOADED`.
- `resetCase(viewer, projectId)`. `clearCase`, returns the empty tree.
- `buildCaseArchive(viewer, projectId): Promise<Buffer>`. 404 `NOT_FOUND` if the case is empty, otherwise `zipCase`.
- `verifyCase(viewer, projectId)`. Presence of `MESH_FILES` and `BASE_FILE_PATHS` (via `computeVerification`).
- `scaffoldCase(viewer, projectId)`. Writes only the missing `BASE_FILE_PATHS` with `renderBaseFile(file, patches)` (patches read from `boundary`); never overwrites.
- `computeRunnable(projectId): Promise<RunnableCheck>` (no access check, used by `runs.service`). Three levels: (1) configurable solver (`isConfigurableSolver`): required files from `SOLVER_CATALOG[solver].requiredFiles` specialized to the model (`requiredFilesForModel`) + correct system numerics (`systemNumericsNeedsRepair` on the three files); (2) solver known to `SOLVER_LIBRARY` but not configurable: mesh + `system/` trio is enough (`scaffoldable: false`); (3) `foamRun`/unknown/undefined: never runnable, missing files computed against the `simpleFoam` set. `maxCores` = `SOLVER_TOTAL_CORES` if > 0, otherwise `os.cpus().length`.
- `verifyRunnable(viewer, projectId)`. Access + `computeRunnable`.
- `scaffoldSolver(viewer, projectId, solver = 'simpleFoam', turbulence?)`. Sequence: `ensureZeroFromOrig` (copies `0.orig/` → `0/` if `0/` is missing); effective model = explicit choice, otherwise the case's model, otherwise `kOmegaSST` (unknown → `kOmegaSST`). Non-configurable solver: generic skeleton (missing `BASE_FILE_PATHS`), `setApplication` in controlDict, `turbulenceProperties` rewritten only if `turbulence` is provided. Configurable solver: for each required file, `system/` trio rewritten if `systemNumericsNeedsRepair`, `0/p` rewritten if `pFieldNeedsRepair` (kinematic vs absolute dimensions), other files only if missing; `setApplication` forced; `turbulenceProperties` rewritten if the content differs; turbulence fields: creation of the fields read by the model (with `carryTurbulenceInlet` to carry the mixing-length inlet over between `omega` and `epsilon`), refresh of the self-managed wall BCs on the kept fields (`refreshWallBcs`), deletion of the fields not read in `0/` and `0.orig/` (listed in `removed`).
- `syncBoundaryFields(viewer, projectId, options?)`. 409 `NO_MESH` without `boundary`; `ensureZeroFromOrig`; for each file outside `polyMesh` and outside `0.orig/`, ≤ `EDITABLE_FILE_MAX_BYTES`, containing `boundaryField`: `rebuildFieldBoundary` (`rebuild` mode, default, existing BCs discarded) or `mergeFieldBoundary` (`merge` mode, existing BCs kept, new patches get a generic default), with the case's turbulence model.
- `readCaseFileContent(viewer, projectId, relPath)`. 404 `NOT_FOUND`, 413 `FILE_TOO_LARGE` beyond `EDITABLE_FILE_MAX_BYTES`.
- `saveCaseFileContent(viewer, projectId, relPath, content)`. The file must exist (404), 413 if too large.
- `createCaseFile(viewer, projectId, relPath, content = '')`. `sanitizeRelative`, 409 `FILE_EXISTS`, 413 `FILE_TOO_LARGE`.
- `deleteCaseFileContent(viewer, projectId, relPath)`. 404 if missing.
- `deleteCaseDirContent(viewer, projectId, relPath)`. Delegates to `deleteCaseDir` (the 404 comes from the lib).
- `moveCaseEntry(viewer, projectId, from, to)`. Delegates to `moveCasePath` (404 / 409 `FILE_EXISTS` / 400 `VALIDATION_ERROR` for a folder moved into itself, per the function's doc).
**Depends on**: `lib/caseStorage`, `lib/fileTreeStorage`, `lib/openfoamCase`, `@dive/shared` (solver catalog, turbulence models), `config/env`, `projects.service`. **Used by**: the `files` controllers, `conversion.service`, `mesh.service`, `meshes.service`, `boundary.service`, `runs.service` (`computeRunnable`), `templates.*` (types).
**Notes**: `systemNumericsNeedsRepair` is marker-driven: fvSolution (pRef for incompressible, `SIMPLE`/`PIMPLE` dictionary, presence/absence of `rho`, linear solver for each transported field via `fvSolutionCoversField`), fvSchemes (`div(phi,U)`, `steadyState` depending on the regime, `div(phi,e)` depending on the family, `div(phi,<field>)`), controlDict (`application` = solver, `endTime` > 1 for steady, > 0 for transient). Thus a second "Make runnable" is idempotent and a change of solver/model rewrites the trio. `caseTurbulenceModel` is duplicated in `mesh.service` and `boundary.service`. `computeRunnable` recomputes the core budget instead of calling `lib/cores.coreBudget`. Historical "simpleFoam" comments although the gate covers several solvers.
**WS-I (2026-09-30)**: `importCaseFiles` clears the mesh origin when a `constant/polyMesh/` file is written; `resetCase` clears it through `clearCase`.

## `apps/api/src/modules/projects/freeSurface.controller.ts`
**Role**: HTTP adapters of the Free surface tool (WS-I) and the project lock middleware.
**Exports**: `freeSurfaceLock(when?)` (409 `FREE_SURFACE_IN_PROGRESS` while a job runs for `:id`; `when` narrows it, e.g. case target only), `getFreeSurfaceController` (200 overview), `startFreeSurfaceController` (202 `{ job }`), `getFreeSurfaceJobController`, `stopFreeSurfaceJobController` (200 `{ job }`), `deleteFreeSurfaceJobController` (204), `downloadFreeSurfaceFileController` (attachment).
**Used by**: `projects.routes.ts`.

## `apps/api/src/modules/projects/freeSurface.schemas.ts`
**Role**: zod schemas of the Free surface routes: `freeSurfaceStartSchema` (lid / inlet patch words, `sourceSessionId` slug, optional kit settings with bounds, `iterations` 1/2/3, `axis`, `rings` with r1 > r0, `datumY`), `freeSurfaceSelectionSchema` (query `lidPatch?`, `inletPatch?`, `sessionId?`), `freeSurfaceJobParamSchema`, `freeSurfaceFileParamSchema`; types `FreeSurfaceStartInput`, `FreeSurfaceSelectionQuery`.

## `apps/api/src/modules/projects/freeSurface.service.ts`
**Role**: The Free surface (lid iteration) tool, WS-I: readiness checks (spec §2), job start / stop / delete / files, boot reconciliation, and the in-process job runner that re-implements the kit driver with argv-only commands (export `postProcess -func lidSurfaces`, `lidkit_surface.py`, `lidkit_fitlid.py`, meshing via `pipelineStages`, WS-F hand-off, solve, post figure).
**Exports**:
- `isFreeSurfaceActive(projectId)`: the project lock (in-memory registry).
- `getFreeSurfaceOverview(viewer, projectId, selection)`: `{ checks, defaults, origin, jobs }`.
- `getFreeSurfaceJob`, `startFreeSurfaceJob` (409 `FREE_SURFACE_IN_PROGRESS` / `RUN_IN_PROGRESS`, 422 `FREE_SURFACE_NOT_READY` = the blocking check's message; writes `base.stl`, `job.json`, runs `runJob` in the background), `stopFreeSurfaceJob` (idempotent; stops the meshing run or the solver run of the current stage), `deleteFreeSurfaceJob` (409 while active), `readFreeSurfaceFile` (allow-listed, 404 otherwise), `reconcileOrphanFreeSurfaceJobs()` (`running` ⇒ `interrupted`).
**Depends on**: `polyMeshLevels`, `lidkit`, `freeSurfaceStorage`, `meshOriginStorage`, `pipelineStages`, `meshing.service` (`isSessionRunning`, `stopMeshingRun`), `runs.service.stopRun`, `caseStorage`, `openfoamCommand`, `commandRunner`.
**Notes**: stages persisted before they start; after the WS-F hand-off the case's time dirs > 0, `processor*` and `postProcessing/` are removed; the fit fails when it adds open edges without cut solids (kit rule); figures only when `import matplotlib` works in the kit interpreter. Feature sheet: `brain/features/free-surface.md`.

## `apps/api/src/modules/projects/mesh.controller.ts`
**Role**: HTTP adapters for the 3D viewer of the case mesh ("Visualize" tab) and for editing its patches / backup.
**Exports**:
- `getMeshManifestController` (200 `{ manifest }`), `getMeshGeometryController` (GLB `model/gltf-binary`, `Cache-Control: private, max-age=0, must-revalidate`), `getMeshEdgesController` (octet-stream; 404 `NOT_FOUND` if no edges), `rebuildMeshController`, `renameMeshPatchController`, `setMeshPatchTypeController`, `autoPatchController` (200 `{ result }`), `editMeshPatchesController`, `getMeshBackupController` (200 `{ backup }`), `saveMeshBackupController`, `restoreMeshBackupController` (200 `{ manifest }`), `meshFromMeshingController` (200 `{ result }`, WS-F).
**Depends on**: `mesh.service`. **Used by**: `projects.routes` (`/:id/mesh/*`).
**Notes**: missing edges yield 404 here but 204 in `meshes.controller` for a library source (contract inconsistency).
**WS-I (2026-09-30)**: `getMeshOriginController` (GET `/mesh-origin`, 200 `{ origin }`).

## `apps/api/src/modules/projects/mesh.schemas.ts`
**Role**: zod schemas for the actions on the case mesh.
**Exports**:
- `renamePatchSchema`. Non-empty `from`; `to` ≤ 80 characters, regex `^[A-Za-z_][A-Za-z0-9_-]*$`.
- `autoPatchSchema`. `featureAngle` coerced to a number, [0, 180], default 45.
- `setPatchTypeSchema`. `patch` + `type` ∈ `MESH_PATCH_SETTINGS` (geometric types + inlet/outlet roles).
- `editPatchesSchema`. Non-empty `edits` of `{ from, to, type ∈ MESH_PATCH_SETTINGS }`.
- `meshFromMeshingSchema`. `sessionId` trimmed, 1..200, `^[A-Za-z0-9_-]+$`; `target` ∈ `MESH_TO_PROJECT_TARGETS`, default `case`; `name?` trimmed 1..120.
- Types `RenamePatchInput`, `AutoPatchInput`, `SetPatchTypeInput`, `EditPatchesInput`, `MeshFromMeshingInput`.
**Notes**: the JSDoc of `editPatchesSchema` mentions `MESH_PATCH_TYPES` whereas the code validates `MESH_PATCH_SETTINGS`.

## `apps/api/src/modules/projects/mesh.service.ts`
**Role**: 3D rendering of the case mesh (offline extraction of the boundary surfaces to GLB + JSON manifest, cached in the `viz/` store) and editing operations on `boundary` with propagation into the `0/` fields, single-slot backup/restore, and `autoPatch`.
**Exports**:
- `getMeshManifest(viewer, projectId): Promise<MeshManifest>`. 409 `NO_MESH` if the five `MESH_FILES` are not all present (`hasPolyMesh`); rebuilds if `vizIsStale`; unreadable manifest → 502 `MESH_BUILD_FAILED`; patch types corrected by `enrichPatchTypes` (`boundary` is authoritative over the type written by the extractor).
- `getMeshGeometry(viewer, projectId): Promise<Buffer>`. 409 `MESH_NOT_BUILT` if the GLB does not exist (the manifest must be requested first).
- `getMeshEdges(viewer, projectId): Promise<Buffer | null>`.
- `renameMeshPatch(viewer, projectId, from, to)`. 422 `VALIDATION_ERROR` (`isValidPatchName`), 409 `NO_MESH`, 404 if `from` is missing, 409 `PATCH_EXISTS`; rewrites `boundary` then each file ≤ 2 MB containing `boundaryField` (`renameFieldBoundaryPatch`). No prior backup.
- `setPatchType(viewer, projectId, patch, type: MeshPatchSetting)`. Validates the type (422), writes the geometric type (an inlet/outlet role is stored as `patch`), then `propagateFieldType` in each field: constraint → same type forced; role → preset `fieldBcBody(field, role)`; `wall` → wall BC according to the model; `patch` → resets `zeroGradient` if the BC was a constraint or a wall. No prior backup.
- `editMeshPatches(viewer, projectId, edits: MeshPatchEdit[])`. All-or-nothing validation (duplicate `from` 422, unknown `from` 404, invalid name 422, unsupported type 422, collision of final names 409 `PATCH_EXISTS`), `ensureOriginalBackup`, collision-free renames (`applyRenames` with placeholders `__DIVE_TMP_<i>__`), types set on the final names, same treatment in the fields.
- `getMeshBackup(viewer, projectId): Promise<MeshBackupInfo | null>`.
- `saveMeshBackup(viewer, projectId)`. 409 `NO_MESH`; `writeBackup(projectId, 'manual')`.
- `restoreMeshBackup(viewer, projectId): Promise<MeshManifest>`. 404 if no backup; `restoreBackup`, `clearAppliedAssembly` (cancels the assembly record), `buildViz`, enriched manifest.
- `rebuildMesh(viewer, projectId)`. 409 `NO_MESH`; forced `buildViz`.
- `importMeshFromMeshing(viewer, projectId, input: MeshFromMeshingInput): Promise<MeshFromMeshingResult>` (WS-F). `assertProjectVisible` first, then `requireMeshedSession` (404 / 409 `MESH_IN_PROGRESS` / 409 `MESHING_NOT_MESHED`); case target: 409 `RUN_IN_PROGRESS` if a `Run` is `queued`/`running`. Copies the session polyMesh to `meshes/.work/from-meshing-<ts>-<rand>/constant/polyMesh`, edits the staged `boundary` (`removeEmptyBoundaryPatches` `only: ['domainBoundary']`; case: `forceChamberPatchTypes`), then library → `meshes.service.addMeshingPartToLibrary`; case → `ensureOriginalBackup` if the case is not empty, `replaceCasePolyMesh`, `clearAppliedAssembly`, `scaffoldCase` if no `system/controlDict`, `syncBoundaryFields` `merge` (failure swallowed), response `{ target, entries, notes, retyped, syncedFields }`. Staging removed in `finally`; no render work (`vizIsStale` by mtime).
- `AutoPatchResult` (interface) and `autoPatchMesh(viewer, projectId, featureAngle)`. Sequence: 409 `NO_MESH`; `ensureOriginalBackup`; `scaffoldCase` if there is no controlDict; text backup of `boundary` then `collapseBoundaryToSinglePatch` (so that numbering restarts at `auto0`); `AUTO_PATCH_BIN <angle> -overwrite -case <caseDir>` (timeout `CONVERSION_STEP_TIMEOUT_MS`). Success: `removeEmptyBoundaryPatches`, then `syncBoundaryFields` (`rebuild` mode) whose result or failure is appended as `[sync]` to stderr. Failure: restores the `boundary` from before the collapse. Never throws on a tool failure.
**Depends on**: `lib/openfoamCase`, `lib/vizStorage`, `lib/meshBackupStorage`, `lib/meshStorage.clearAppliedAssembly`, `lib/commandRunner`, `lib/openfoamCommand`, `files.service` (`scaffoldCase`, `syncBoundaryFields`). **Used by**: `mesh.controller`.
**Notes**: `buildViz` (internal) runs `MESH_PYTHON_BIN extractPatches.py <caseDir> <glb> <manifest>` (script `EXTRACT_PATCHES_SCRIPT` or `apps/api/scripts/extractPatches.py`), synchronously within the request, bounded by `MESH_BUILD_TIMEOUT_MS`; missing script → 500 `SCRIPT_MISSING`; failure or missing GLB → 502 `MESH_BUILD_FAILED`. No lock: two concurrent calls each rebuild. Edits to `boundary` make the cache stale by mtime. Asymmetry: `editMeshPatches` and `autoPatchMesh` take a backup, `renameMeshPatch` and `setPatchType` do not. Name error message says "letters, digits, underscore" whereas the shared regex also accepts the hyphen.
**WS-I (2026-09-30)**: `importMeshFromMeshing` (case target) writes `mesh-origin.json` after `replaceCasePolyMesh` (session `origin.chamberHash` carried); `getMeshOrigin(viewer, projectId)`.

## `apps/api/src/modules/projects/meshes.controller.ts`
**Role**: HTTP adapters for the multi-mesh library and the merge/assembly.
**Exports**:
- `importMeshController`. Picks the `meshFile` part (.cgns/.msh), otherwise `archive` (zip), otherwise the `files` parts (folder); none → 400 `NO_FILES_UPLOADED`. Name = text field `name` if provided, otherwise the file name without extension, the zip name, or the root folder (`folderNameOf`, ignores `polyMesh`), default "Imported mesh". 201.
- `listMeshesController`, `deleteMeshController`, `getMeshPatchesController`, `getMeshSourceManifestController`, `getMeshSourceGeometryController` (GLB, private cache), `getMeshSourceEdgesController` (204 if no edges), `autoPatchMeshSourceController`, `renameMeshSourcePatchController`, `editMeshSourcePatchesController`, `mergeMeshesController` (200 `{ result }`), `getMergePlanController` (200 `{ plan }`), `getAssemblyController` (200 `{ assembly }`), `saveMergePlanController`.
**Depends on**: `meshes.service`. **Used by**: `projects.routes` (`/:id/meshes/*`).

## `apps/api/src/modules/projects/meshes.schemas.ts`
**Role**: zod schemas for the merge plan and for edits of library sources.
**Exports**:
- `mergePlanSchema`. `order` (≥ 1 non-empty id; the first can be the sentinel `MERGE_BASE_CASE`), `interfaces` (default `[]`, each entry `aMeshId`, `aPatch`, `bMeshId`, `bPatch`, `coupling` ∈ `nonConformal | nonConformalCyclic | stitch`, default `nonConformal`, `nonConformalCyclic` normalized to `nonConformal`), `stitches` (legacy, default `[]`), `transforms` (default `[]`, `meshId` + `translation` [3] + `rotation` quaternion [4], finite numbers). Type `MergePlanInput`.
- `meshIdParamSchema` (`id`, `meshId`).
- `meshSourceRenamePatchSchema` (non-empty `from`, `to`; word validity is checked by the service).
- `meshSourceAutoPatchSchema` (`featureAngle` coerced, finite, [0, 180], no default unlike `autoPatchSchema`).
- `meshSourceEditPatchesSchema` (`edits` of `{ from, to, type ∈ MESH_PATCH_TYPES }`, empty array accepted).
- Corresponding inferred types.

## `apps/api/src/modules/projects/meshes.service.ts`
**Role**: per-project library of reusable polyMesh meshes (stored outside the case under `meshes/`, see `meshStorage`), "Assembly v2" merge pipeline that combines an ordered subset into the case's `constant/polyMesh`, and per-source 3D rendering for the "Assemble" tab.
**Exports**:
- Types `MergeRunResult` (`MergeResult` + `entries`), `MeshImportPayload` (`name`, `archive?`, `files?`, `meshFile?`), `ImportMeshOutcome` (`mesh?`, `meshes`, `conversion?`), `MeshSourceAutoPatchOutcome`.
- `listMeshes(viewer, projectId): Promise<MeshSource[]>` (patches parsed from each `boundary`).
- `getMeshPatches(viewer, projectId, meshId)`. 404 if the source is missing.
- `addMeshingPartToLibrary(projectId, stagedPolyMeshDir, name, sessionId): Promise<{ mesh, meshes }>`. No access check (caller gated). `uniqueMeshId`, `fs.rename` (fallback `fs.cp`) of the staged polyMesh into `meshes/<id>/constant/polyMesh`, `writeMeshMeta` kind `meshing` + `origin.sessionId`. `MeshSource` now carries `kind`.
- `autoPatchMeshSource(viewer, projectId, meshId, featureAngle)`. Writes a temporary `system/` trio into the source folder, collapses the `boundary` into a single patch, runs `AUTO_PATCH_BIN <angle> -overwrite -case <meshDir>`, then removes the empty patches (success) or restores the `boundary` (failure), and deletes `system/`. Does not throw on a tool failure.
- `renameMeshSourcePatch(viewer, projectId, meshId, from, to)`. 422 `VALIDATION_ERROR`, 404, 409 `NO_MESH` / `PATCH_EXISTS`; rewrites only the source's `boundary` (no `0/` fields).
- `editMeshSourcePatches(viewer, projectId, meshId, edits)`. Same all-or-nothing validations as `editMeshPatches` but types limited to `MESH_PATCH_TYPES`, with no field scan and no backup; the mtime bump makes the source's rendering stale.
- `importMesh(viewer, projectId, payload)`. `meshFile` → `importMeshFromFile` (internal: `meshFileFormat`, `uniqueMeshId`, writes `source.<ext>` into `src/`, `convertMeshFileToCase`, keeps the source only if the `boundary` exists, writes the meta, returns the conversion report in all cases; unsupported format → 400 `NO_MESH`). Otherwise `importMeshArchive` or `importMeshFolder`; without `boundary` the source is deleted and 400 `NO_MESH`. Nothing → 400 `NO_FILES_UPLOADED`.
- `removeMesh(viewer, projectId, meshId)`. 404 if missing.
- `getMergePlan(viewer, projectId)` / `saveMergePlan(viewer, projectId, plan)`. Reads / persists the draft (`persistPlan`: `order` deduplicated, `interfaces` normalized, `stitches` and `transforms` kept).
- `runMerge(viewer, projectId, plan): Promise<MergeRunResult>`. Sequence:
  0. Validation: empty deduplicated `order` → 409 `NO_MESHES`; `MERGE_BASE_CASE` not in position 0 or case without `boundary` → 422 `INVALID_MERGE_PLAN`; id missing from the library → 422; part without `boundary` → 422; interface to a part outside the plan → 422 `INVALID_MERGE_PLAN`; unknown patch → 422 `STITCH_PATCH_NOT_FOUND`. Re-merge guard: if base = case AND an applied assembly is recorded AND a backup exists, `restoreBackup` before anything else (avoids stacking an assembly on an already merged case). The plan is persisted.
  1. Name resolution: the base keeps all its names; an added part keeps a name unless it collides with an earlier part, in which case it becomes `<meshId>_<patch>` (counter `_2`, `_3` if needed), with one note per rename.
  2. `prepare`: `resetMeshWork` creates the `.work/` folder, one sub-case `m1`, `m2`… per part. Base = case: `stageCaseMaster` (copy of the case polyMesh + `system/` trio). Otherwise `stageSource`: copy of the polyMesh, rigid transform applied to the `points` (`transformMeshPoints`, never on the base), `system/` trio, renaming of the colliding patches only.
  3. `mergeMeshes`: for each added part, `MERGE_MESHES_BIN <masterDir> <addDir> -overwrite` (ESI v2406 positional form, cwd = master), one step per part.
  4. `splitMeshRegions` (if ≥ 2 parts): `SPLIT_MESH_REGIONS_BIN -makeCellZones -overwrite -case <master>` BEFORE any coupling, to get one cellZone per part; `labelCellZones` renames the zones to `base` / the part id if the number of zones equals the number of parts (otherwise generated names kept, note). Rename failure swallowed.
  5. Coupling per interface: `nonConformal` → in-place textual retyping of both patches to `cyclicAMI` (`setCyclicAmiPair`, crossed `neighbourPatch`, `transform noOrdering`), verified afterwards (otherwise `failed` step); `stitch` → `STITCH_MESH_BIN <a> <b> -partial -overwrite -case <master>`, then nFaces check: if no face merged, the step is requalified as `failed`; a partial merge adds a note.
  6. `cleanup`: removal of 0-face patches (`cleanupMasterBoundary`), SKIPPED as soon as a non-conformal pair exists.
  7. `checkMesh -case <master>`; notes if "Failed N mesh checks" (`countCheckMeshFailures`) and if the minimum AMI `sum(weights)` is < 0.5 (`lowestAmiWeight`).
  8. Promotion: `ensureOriginalBackup` if the case is not empty, `caseStorage.replaceCasePolyMesh` (replaces `constant/polyMesh`), `syncBoundaryFields` in `merge` mode (base = case, physics kept) or `rebuild` (library base), sync error swallowed. `writeAppliedAssembly({ plan, baseIsCase, appliedAt })` only on success.
  Each step failure short-circuits via `finalizeMerge(..., promoted = false)` without touching the case; `success` = promoted AND all steps `success`; `boundaryPatches` re-read only on success; `cellZones` returned. Per-step timeout: `MERGE_STEP_TIMEOUT_MS`.
- `getAppliedAssembly(viewer, projectId): Promise<AppliedAssembly | null>`. Feeds the Disassemble UI.
- `getMeshSourceManifest`, `getMeshSourceGeometry`, `getMeshSourceEdges(viewer, projectId, meshId)`. 404 if the source is missing; manifest and geometry trigger `ensureMeshSourceViz` (build if stale, via `buildMeshSourceViz`: `MESH_PYTHON_BIN extractPatches.py <meshDir> <glb> <manifest>`, cache under `meshes/<id>/.viz/`, 500 `SCRIPT_MISSING` / 502 `MESH_BUILD_FAILED`). The geometry is a standalone build trigger (no 409 as on the case side).
**Depends on**: `lib/meshStorage`, `lib/meshSourceVizStorage`, `lib/meshImport`, `lib/meshTransform`, `lib/meshBackupStorage`, `lib/openfoamCase`, `lib/caseStorage`, `lib/commandRunner`, `lib/openfoamCommand`, `files.service.syncBoundaryFields`. **Used by**: `meshes.controller`.
**Notes**: internal helpers `normalizeCoupling` / `planInterfaces` (`interfaces` take precedence; otherwise the legacy `stitches` become `stitch` interfaces, without double counting). `applyRenames`, `pathExists`, `extractPatchesScript`, `summarizeVizFailure` are deliberately duplicated from `mesh.service`. Doc/code inconsistency: the file header still describes `nonConformalCyclic` via `createNonConformalCouples`, whereas the code does a textual `cyclicAMI` retyping (ESI does not have that tool) with the value `nonConformal`. The `STITCH_TOL` variable is unused (ESI has no `-tol`). The `MERGE_BASE_CASE` sentinel passes `min(1)` on the schema side.

## `apps/api/src/modules/projects/projects.controller.ts`
**Role**: HTTP adapters for project CRUD and collaborators.
**Exports**: `listProjectsController` (200 `{ projects }`), `createProjectController` (201 `{ project }`), `getProjectController`, `renameProjectController`, `deleteProjectController` (204), `addCollaboratorController`, `removeCollaboratorController` (200 `{ project }`).
**Depends on**: `projects.service`. **Used by**: `projects.routes`.
**Notes**: `requireViewer` (internal) throws 401 `UNAUTHENTICATED` defensively; this helper is copied verbatim into each controller of the module.

## `apps/api/src/modules/projects/projects.routes.ts`
**Role**: Express router of the module, mounted on `/api/v1/projects`. Applies `requireAuth` to all routes, then `validate({ params, body, query })` and `asyncHandler` on each handler.
**Exports**:
- `createProjectsRouter(): Router`. Routes: CRUD `/` and `/:id`; `/:id/collaborators[/:userId]`; files `/:id/files` (GET list, DELETE reset), `/files/import`, `/files/download`, `/files/verify`, `/files/scaffold`, `/files/sync-boundaries`, `/files/content` (GET/PUT/POST/DELETE), `/files/dir` (DELETE), `/files/move`; runnability `/:id/runnable` and `/runnable/scaffold`; CGNS `/:id/cgns` (GET/POST/DELETE) and `/cgns/convert`; library `/:id/meshes`, `/meshes/import`, `/meshes/plan` (GET/PUT), `/meshes/merge`, `/meshes/assembly`, then `/meshes/:meshId/{patches,manifest,geometry,edges,auto-patch,patches/rename}`, `PUT /meshes/:meshId/patches`, `DELETE /meshes/:meshId`; case mesh `/:id/mesh/{manifest,geometry,edges,rebuild,patches/rename,patches/type,auto-patch,from-meshing}`, `PUT /mesh/patches`, `/mesh/backup` (GET/POST) and `/mesh/backup/restore`; `/:id/boundary-conditions/apply`; export `/:id/export` (POST/GET) and `/export/download/:artifact`; templates `/:id/apply-template/:templateId/preview`, `/files`, and root; runs `/:id/runs` (GET/POST), `/runs/:runId`, `/runs/:runId/log`, `/runs/:runId/stop`.
**Depends on**: all controllers/schemas of the module, `templates.controller`/`templates.schemas`, middlewares `asyncHandler`, `requireAuth`, `validate`. **Used by**: `app.ts`.
**Notes**: `parseFileContent = express.text({ type: '*/*', limit: EDITABLE_FILE_MAX_BYTES })` only for `PUT /files/content` (the global JSON limit is 16 kb). The static sub-paths of `/meshes` (`import`, `plan`, `merge`, `assembly`) are declared BEFORE the `:meshId` routes so they are never captured as an id. Multipart uploads go through `parseCaseUpload` (or `parseBoundaryUpload`) after params validation. The `validate` middleware returns 422 `VALIDATION_ERROR` and replaces `req.body` with the zod output.
**WS-I (2026-09-30)**: `GET /:id/mesh-origin`, the six `/:id/free-surface…` routes, and `freeSurfaceLock()` on `POST /runs`, `DELETE /files`, `POST /files/import`, `POST /cgns/convert`, `POST /meshes/merge`, `POST /mesh/from-meshing` (case target), `POST /boundary-conditions/apply`, `POST /mesh/backup/restore`.

## `apps/api/src/modules/projects/projects.schemas.ts`
Zod schemas: `createProjectSchema` and `renameProjectSchema` (`title` trimmed, 1 to `PROJECT_TITLE_MAX_LENGTH`), `addCollaboratorSchema` (valid `email`), `projectIdParamSchema` (`id`), `collaboratorParamSchema` (`id`, `userId`), and the types `CreateProjectInput`, `RenameProjectInput`, `AddCollaboratorInput`.

## `apps/api/src/modules/projects/projects.service.ts`
**Role**: project business logic and the visibility rule shared by the whole module (and by `templates`, `chamber`, `dashboard` via the `Viewer` type).
**Exports**:
- `Viewer` (`id`, `role`), `UserSummary`, `PublicProject` (`id`, `title`, `owner`, `collaborators`, `createdAt`, `updatedAt` in ISO).
- `assertProjectVisible(viewer, id): Promise<PublicProject>`. Common guard: 404 `NOT_FOUND` if unknown or invisible.
- `listProjects(viewer)`. Super-admin: everything; otherwise owner or collaborator; sorted `createdAt desc`.
- `getProject(viewer, id)`.
- `createProject(ownerId, input)`. Title trimmed.
- `renameProject(viewer, id, title)`. 403 `FORBIDDEN` if not a manager.
- `deleteProject(viewer, id)`. 403 if not a manager; best-effort `stopProjectRuns(id)` (avoids a ghost mpirun, fix M3), `prisma.project.delete`, then best-effort `removeProjectStorage`.
- `addCollaborator(viewer, id, email)`. 403; email normalized (trim + lowercase); 404 `USER_NOT_FOUND`; 409 `COLLABORATOR_EXISTS` if owner or already a collaborator; `connect`.
- `removeCollaborator(viewer, id, collaboratorId)`. 403; 404 `NOT_FOUND` if not a collaborator; `disconnect`.
**Depends on**: `lib/prisma`, `lib/AppError`, `lib/caseStorage.removeProjectStorage`, `runs.service.stopProjectRuns`. **Used by**: all services of the module, `terminal.gateway`, `templates.service`, and as a type by `chamber`, `dashboard`.
**Notes**: internals `canView` (super-admin, owner or collaborator), `canManage` (super-admin or owner), `findVisibleOrThrow`, `projectInclude` (owner + collaborators sorted by `fullName`). Circular import `projects.service` ↔ `runs.service` (runs imports `assertProjectVisible`, projects imports `stopProjectRuns`).

## `apps/api/src/modules/projects/runs.controller.ts`
**Role**: HTTP adapters for solver runs: `startRunController` (201 `{ run }`), `listRunsController` (200 `{ runs }`), `getRunController` (200 `{ run }`), `getRunLogController` (200, raw payload), `stopRunController` (200 `{ run }`).
**Depends on**: `runs.service`. **Used by**: `projects.routes`.

## `apps/api/src/modules/projects/runs.schemas.ts`
Schemas: `startRunSchema` (optional `solver` ∈ `SOLVER_IDS`, optional `cores` coerced integer 1 to 1024) and `runIdParamSchema` (`id`, `runId`), type `StartRunInput`. The JSDoc says an explicit `solver` "overrides" the controlDict, whereas `resolveSolver` gives priority to the controlDict.

## `apps/api/src/modules/projects/runs.service.ts`
**Role**: the app's first long-running job. Launches an OpenFOAM solver (serial or MPI) in the case folder, writes its output to a persistent `solver.log`, and drives the `Run` row (Prisma) from `queued` to a terminal status (`converged` / `completed` / `diverged` / `failed` / `stopped`). The client follows progress by polling `getRunLog` (no push).
**Exports**:
- `PublicRun` (`id`, `solver`, `cores`, `status`, `exitCode`, `reason`, ISO dates), `RunLogPayload` (`run`, `series`, `logTail`, `logBytes`).
- `startRun(viewer, projectId, input): Promise<PublicRun>`. Sequence: access; pre-check of the project's number of active runs (≥ `SOLVER_MAX_CONCURRENT_RUNS` → 409 `RUN_IN_PROGRESS`); `computeRunnable` (no mesh → 409 `NO_MESH`, not runnable → 422 `NOT_RUNNABLE`); `resolveSolver` (controlDict, otherwise input, otherwise `SOLVER_BIN`; outside `SOLVER_IDS` → 422 `NOT_RUNNABLE`); `clearGracefulStop` (`stopAt writeNow` → `endTime`) and `ensureRunTimeModifiable`; `cores > coreBudget()` → 422 `TOO_MANY_CORES`. Atomic admission under `runExclusive('startRun')`: recount of active runs (409 `RUN_IN_PROGRESS`), global sum of active cores across all projects (overrun → 409 `NOT_ENOUGH_CORES`), creation of the `queued` row inside the lock (fix H2). Then `ensureRunDir`.
  - Serial (`cores = 1`): `planOpenfoamCommand(solver, ['-case', caseDir])` + `runStream` (log to file, timeout `SOLVER_MAX_RUNTIME_MS`), row moved to `running` with `pid`, `command`, `logPath` = `<RUN_DIRNAME>/<runId>/solver.log`; `finalizeRun` wired to `onExit` (fire and forget).
  - Parallel (`cores > 1`): `launchParallelRun` in the background, the response returns the `queued` run.
- `listRuns(viewer, projectId)`. Sorted `createdAt desc`.
- `getRun(viewer, projectId, runId)`. 404 `RUN_NOT_FOUND`.
- `getRunLog(viewer, projectId, runId)`. Reads at most `SOLVER_LOG_MAX_BYTES` from the end of the log (fix H3), `parseResiduals` + `downsampleResiduals`, tail of 20,000 characters, total size.
- `stopRun(viewer, projectId, runId)`. No-op if terminal; adds to `stopRequested`, `requestGracefulStop` (writes `stopAt writeNow;`), then SIGTERM after `RUN_STOP_GRACE_MS` if the handle is still there; without a local handle (after a restart) the row is marked `stopped` directly.
- `stopProjectRuns(projectId)`. No access check: SIGTERM on each active handle of the project and rows marked `stopped` ("Project or account deleted"). Called by `deleteProject` and `users.service`.
- `reconcileOrphanRuns(): Promise<number>`. At boot (`server.ts`): for each active run with a `pid`, `killOrphanIfOurs` (reads `/proc/<pid>/cmdline`, only kills if the command line contains the `caseDir`, SIGTERM then SIGKILL after the grace period; no-op outside Linux, fix H1), then all active rows move to `failed` ("Interrupted by a server restart").
**Depends on**: `lib/streamRunner`, `lib/commandRunner`, `lib/openfoamCommand`, `lib/openfoamCase.renderDecomposeParDict`, `lib/cores.coreBudget`, `lib/runStorage`, `lib/residualParser`, `lib/caseStorage`, `lib/prisma`, `lib/logger`, `files.service.computeRunnable`, `projects.service`. **Used by**: `runs.controller`, `projects.service`, `users.service`, `server.ts`.
**Notes**: parallel pipeline (`launchParallelRun`): writes `system/decomposeParDict` (`renderDecomposeParDict(cores, DECOMPOSE_METHOD)`), `decomposePar -case <dir> -force` (timeout `SOLVER_DECOMPOSE_TIMEOUT_MS`, output copied into the log; failure → `failRun` with the last 3 lines), early exit if a stop is requested during decomposition, then `MPI_BIN <MPI_RUN_FLAGS> -np N <solver> -case <dir> -parallel` via `runStream`, row moved to `running`, then `finalizeRun`. Any exception ends in `failed` (never stuck in `queued`). `finalizeRun`: reads the end of the log, `classifyExit` (spawnError → `failed` "Solver binary not found", stop requested → `stopped`, timeout → `failed`, nan/inf residuals or "floating point exception" → `diverged`, "FOAM FATAL" → `failed`, exit 0 → `converged` if convergence detected otherwise `completed`, other → `failed`), then `reconstructParallel` if `cores > 1` (`reconstructPar -case <dir>` over all times, deletion of `processor0..N-1` on success, errors only logged), and `updateMany` filtered on active statuses (first writer wins). Process-local state: `handles` (Map runId → `StreamHandle`), `stopRequested` (Set), `locks` (FIFO lock). The `runExclusive` lock has a global key `'startRun'` (serializes all projects) and only protects a single API process. `reconstructPar` and `decomposePar` are hard-coded (no env variable), unlike the other binaries.
**WS-I (2026-09-30)**: `awaitRunTerminal(runId, pollMs = 2000)` resolves with the terminal run (waiters woken by `finalizeRun`, `failRun`, the handle-less stop; row poll fallback; 404 `RUN_NOT_FOUND`).

## `apps/api/src/modules/projects/terminal.gateway.ts`
**Role**: WebSocket gateway to an interactive shell (`terminalSession`) whose cwd is the project's storage root. The app's only shell execution surface, disabled unless `TERMINAL_ENABLED=true`.
**Exports**:
- `attachTerminalGateway(server: Server): void`. If disabled: info log and nothing else. Otherwise creates a `WebSocketServer({ noServer: true })` that selects the `bearer` subprotocol (the token is never echoed back), and listens to `upgrade`: path outside `^/api/v1/projects/<id>/terminal$` → 404; `Origin` present and different from `CORS_ORIGIN` → 403; `sessionCount >= TERMINAL_MAX_SESSIONS` → 503; `authenticate` fails → 401; exception → 500. Then `handleUpgrade` and `bridge`.
**Depends on**: `ws`, `lib/jwt.verifyAccessToken`, `lib/prisma`, `lib/role.isRole`, `lib/caseStorage` (`ensureProjectDir`, `projectDirAbsolute`), `lib/terminalSession`, `projects.service`. **Used by**: `server.ts`.
**Notes**: `tokenFromProtocol` reads the JWT as the value following `bearer` in `Sec-WebSocket-Protocol` (the browser cannot set an Authorization header). `authenticate` reloads the user (rejects inactive users or an invalid role) then `assertProjectVisible`. `bridge`: JSON protocol (client `{ type: 'input', data }` / `{ type: 'resize', cols, rows }`; server `ready` with `pty`, `output`, `exit` with `code` and possibly `reason: 'idle-timeout'`), idle timeout `TERMINAL_IDLE_TIMEOUT_MS`, `OPENFOAM_BASHRC` passed as an env variable but not sourced. Pitfalls: the session cap is checked before the asynchronous authentication but `sessionCount` is only incremented in `bridge`, so concurrent upgrades can exceed the cap; the `upgrade` listener answers 404 to any other WebSocket path on the HTTP server.
