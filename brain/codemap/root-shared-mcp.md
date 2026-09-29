# Codemap: Root, shared contract and MCP server

> Scope: `.github/workflows/ci.yml`, `apps/mcp/**`, `packages/shared/**`, root files (`.editorconfig`, `.gitattributes`, `.gitignore`, `.mcp.json`, `.nvmrc`, `.prettierrc.json`, `eslint.config.js`, `package.json`, `tsconfig.base.json`) · Updated: 2026-09-28

## Overview
The monorepo is an npm workspace (`packages/*`, `apps/*`): `@dive/shared` (shared TypeScript + zod contract), `@dive/api` (Express/Prisma), `@dive/web` (React/Vite) and `@dive/mcp` (MCP server). The root `dev` script first compiles `@dive/shared` then starts API and web in parallel via `concurrently`; `typecheck`, `test` and `build` also rebuild `@dive/shared` first, because the API consumes its `dist/` output (CJS) whereas the web imports it directly from `src/index.ts` via a Vite alias.
`packages/shared/src/index.ts` is the single source of constants, literal unions, payload interfaces and several pure computations (solver catalog, turbulence fields, chamber empirical model, Gen Dim v3). Any change to an API payload must go through this file.
`apps/mcp` is a thin HTTP layer on top of the `/api/v1` API: a service account logs in, then each MCP tool is an authenticated REST call.
GitHub CI (`ci.yml`) runs lint, typecheck, tests and build (job `verify`) and, separately, the Python chamber geometry tests (job `geometry`).

## `.github/workflows/ci.yml`
**Role**: CI pipeline triggered on push to `main` and on every pull request, with cancellation of superseded runs (`concurrency: ci-${{ github.ref }}`). Two independent jobs on `ubuntu-latest`.
**Jobs**:
- `verify`: Node 20 (npm cache), `npm ci`, `npm run prisma:generate -w @dive/api`, `npm run build:shared`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` with `VITE_API_URL=http://localhost:4000/api/v1` injected for the web bundle.
- `geometry`: Python 3.12 (pip cache on `apps/api/scripts/requirements-geometry.txt`), installation of the pinned wheels (CadQuery/OCC), then `pytest apps/api/scripts/tests -v`. This job is the authority for chamber geometry: locally, without cadquery, the suite is skipped.
**Notes**: the comment states that the API's vitest `globalSetup` runs `prisma db push --force-reset` (isolated SQLite database), hence Prisma client generation before the tests. CI uses Node 20 whereas `.nvmrc` says 24 (both satisfy `engines.node >=20`).

## `apps/mcp/src/client.ts`
**Role**: HTTP client for the DIVE API for a long-running Node process. It reproduces the web client's authentication model, but replaces the httpOnly cookie refresh with a re-login on 401. Instantiated once by `server.ts` and shared by all tools.
**Exports**:
- `ApiError extends Error` (`status: number`, `code: string`). Error carrying the HTTP status and the `code` from the `{ error: { code, message } }` envelope. Client-side synthetic codes: `TIMEOUT` and `NETWORK_ERROR` (status 0), `UNKNOWN` if the body is not JSON.
- `FilePart` (`field`, `path`, `filename?`). Local file read from disk for a multipart upload.
- `DiveClient` (constructor `new DiveClient(config: Config)`). Holds the `Bearer` token and a single login promise (single-flight). Public methods: `get<T>(path, query?)`, `post<T>(path, json?, query?)`, `put<T>(path, json?, query?)`, `delete<T>(path, query?)`, `putText<T>(path, text, query?)` (body `text/plain;charset=utf-8`, for saving case files), `postForm<T>(path, fields?, files?, query?)` (reads each file with `readFile` and attaches it as a `Blob`). Getter `baseUrl`.
- Private methods: `login()` (POST `/auth/login` with the service account credentials, caches `accessToken`), `ensureToken()`, `url()` (skips `undefined` query parameters), `rawFetch()` (timeout via `AbortController`), `readError()`, `request()` (on 401: drops the token, a single re-login, a single retry; any non-OK response throws `ApiError`), `decode()` (tolerates 204 and empty bodies).
**Depends on**: `./config.js` (type `Config`), `node:fs/promises`, `node:path`, Node global `fetch`/`FormData`/`Blob`. **Used by**: `apps/mcp/src/server.ts`.
**Notes**: the internal `LoginResponse` interface declares `user.displayName?`, whereas the API returns a `PublicUser` with `fullName` (field unused here, so no effect).

## `apps/mcp/src/config.ts`
**Role**: loads `apps/mcp/.env` (path resolved from the file, so independent of the working directory chosen by Claude Code) with `dotenv`, then validates the variables.
**Exports**:
- `Config` (`apiUrl`, `email`, `password`, `timeoutMs`).
- `loadConfig(): Config`. Reads `DIVE_API_URL` (trailing slashes removed), `DIVE_MCP_EMAIL`, `DIVE_MCP_PASSWORD` (mandatory, otherwise an `Error` saying to copy `.env.example`) and `DIVE_MCP_TIMEOUT_MS` (default 60000, must be a positive integer).
**Depends on**: `dotenv`. **Used by**: `server.ts` (and the type by `client.ts`).

## `apps/mcp/src/server.ts`
**Role**: entry point of the MCP server `dive-mcp` v0.1.0 over stdio transport. Registers 32 tools that call the API via `DiveClient`, then connects (`main`). Logs go to stderr, stdout being the MCP channel.
**Exports**: none (script). Internal functions:
- `ok(value)`: serializes as indented JSON in an MCP text content (`(empty response)` if empty).
- `fail(err)`: `isError` result with `API error <status> [<code>]: <message>` for an `ApiError`.
- `tool(name, meta, handler)`: wraps `server.registerTool`; `readOnlyHint` is inferred from the name prefix (`list_`, `get_`, `read_`, `verify_`), `destructiveHint` comes from `meta.destructive`.
**Read tools**: `list_projects` (GET `/projects`), `get_project` (GET `/projects/:id`), `get_dashboard` (GET `/dashboard`), `list_case_files` (GET `/projects/:id/files`), `read_case_file` (GET `/projects/:id/files/content?path=`), `verify_case` (GET `/files/verify`), `get_runnable` (GET `/runnable`), `list_runs`, `get_run`, `get_run_log` (GET `/runs/:runId/log`), `list_meshes` (GET `/meshes`), `get_mesh_manifest` (GET `/mesh/manifest`, builds the render on demand), `list_cgns`, `get_export_status` (GET `/export`), `list_templates` (GET `/templates`), `list_users` (GET `/users`, requires `SUPER_ADMIN`).
**Action tools**: `create_project` (POST `/projects`), `delete_project`*, `write_case_file`* (text PUT `/files/content?path=`), `create_case_file` (POST `/files/content` `{ path }`), `delete_case_file`*, `import_case_zip` (multipart field `archive` read from a local path), `scaffold_case` (POST `/files/scaffold`), `scaffold_solver` (POST `/runnable/scaffold` `{ solver?, turbulence? }`), `sync_boundaries` (POST `/files/sync-boundaries`), `start_run`* (POST `/runs`; `cores` sent only if > 1), `stop_run`*, `convert_cgns` (POST `/cgns/convert` `{ cgnsFile, templateId }`), `merge_meshes`* (POST `/meshes/merge` with the raw plan), `auto_patch_mesh`* (POST `/mesh/auto-patch` `{ featureAngle }`), `apply_boundary_conditions`* (multipart: JSON text field `payload` + optional `csv` file), `run_export`* (POST `/export`). The asterisk marks `destructive: true`.
**Depends on**: `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`), `zod`, `./config.js`, `./client.js`. **Used by**: `.mcp.json` (`npx tsx apps/mcp/src/server.ts`), the package's `dev`/`start` scripts.
**Notes**: the `merge_meshes` description mentions "couples/patchPairs" whereas the actual `MergePlan` schema expects `order`, `interfaces`, `transforms` (and legacy `stitches`). No tool covers chamber, meshing, template writes, collaborators or mesh backup.

## `apps/mcp/.env.example`
Configuration template for the MCP server: `DIVE_API_URL` (includes `/api/v1`; deployed example `http://192.168.5.51/api/v1` behind a reverse proxy on port 80, or `http://localhost:4000/api/v1` in dev), `DIVE_MCP_EMAIL`, `DIVE_MCP_PASSWORD` (dedicated service account), `DIVE_MCP_TIMEOUT_MS` (60000). The real `.env` file is ignored by git.

## `apps/mcp/README.md`
**Role**: documentation of the MCP server: principle (HTTP wrapper, re-login on 401 because the access token lives 15 minutes), setup (service account, `.env`, `npm install`, registration via `.mcp.json`, standalone test `npm run start -w @dive/mcp`), list of tools (read / actions) and tools flagged destructive.
**Notes**: specifies that uploads (`import_case_zip`, the CSV of `apply_boundary_conditions`) read a local path on the machine running the MCP server. Only `list_users` requires `SUPER_ADMIN`.

## `apps/mcp/package.json`
Package `@dive/mcp` (ESM, `type: module`). Scripts: `dev` (`tsx watch src/server.ts`), `start` (`tsx src/server.ts`), `build` and `typecheck` (`tsc -p tsconfig.json`). Dependencies: `@modelcontextprotocol/sdk ^1.12.0`, `dotenv`, `zod`; dev: `tsx`, `typescript`, `@types/node`. Does not depend on `@dive/shared`.

## `apps/mcp/tsconfig.json`
Extends `tsconfig.base.json`; `module`/`moduleResolution` `NodeNext` (hence imports suffixed with `.js`), `outDir: dist`, `rootDir: src`, `lib` ES2022 + DOM (for `fetch`, `FormData`, `Blob`), `types: ["node"]`.

## `packages/shared/src/index.ts`
**Role**: shared API/web contract. Contains constants (often `as const` with the derived type union), payload interfaces, a zod schema (`roleSchema`) and pure functions. No dependency other than `zod`. The backend imports it via `@dive/shared` (CJS build), the web via the Vite alias to the source.
**Depends on**: `zod`. **Used by**: `apps/api` (zod schemas, services, `lib/`), `apps/web` (forms, labels, chamber live preview, API types).

### Roles and validation limits
- `ROLES = ['SUPER_ADMIN', 'USER']`, `Role`, `roleSchema` (`z.enum(ROLES)`). Account roles; the super-admin is permanent. `roleSchema` is re-exported by `users.schemas.ts`.
- `PASSWORD_MIN_LENGTH = 8`, `PASSWORD_MAX_LENGTH = 200`, `FULL_NAME_MAX_LENGTH = 120`, `PROJECT_TITLE_MAX_LENGTH = 120`.
- `TEMPLATE_NAME_MAX_LENGTH = 120`, `TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000`, `TEMPLATE_TAG_MAX_LENGTH = 24`, `TEMPLATE_TAGS_MAX = 12`.
- `normalizeTag(raw: string): string`. Trim, lowercase, spaces to hyphens, removal of everything except `a-z0-9-`, merging and trimming of hyphens, cut at 24 characters; an "all garbage" input yields `''`.
- `normalizeTags(tags: readonly string[]): string[]`. Normalizes, removes empties, deduplicates while preserving order and caps at 12. Used by `templates.service`.
- `EDITABLE_FILE_MAX_BYTES = 2 MB`. Maximum size of a file that can be opened/saved in the editor (limit of the text parser on the save routes).

### CGNS import and 3D visualization
- `CGNS_EXTENSION = '.cgns'`. Not referenced in `apps/` (dead export to date).
- `CONVERSION_STEPS = ['cgnsToVtk', 'vtkToFoam', 'checkMesh']`, `ConversionStepId`. Steps of the CGNS to OpenFOAM pipeline (`CgnsToVtk.py`, `vtkUnstructuredToFoam`, `checkMesh`).
- `VIZ_DIRNAME = 'viz'`. Folder of 3D render artifacts, sibling of `case/` and `cgns/` in project storage.
- `MeshPatch` (`name`, `type`, `nFaces` before triangulation, `edgeOffset?`, `edgeCount?`: slice of the `edges.bin` buffer, in vertices of 3 float32). `MeshManifest` (`patches`, `generatedAt` ISO).
- `MeshPatchEdit` (`from`, `to`, `type: MeshPatchSetting`). One row of a batch patch edit.
- `MeshBackupInfo` (`createdAt`, `updatedAt`, `kind: 'original' | 'manual'`). Single mesh backup slot.

### Patch types and flow roles
- `MESH_PATCH_TYPES = ['patch', 'wall', 'symmetry', 'symmetryPlane', 'empty', 'wedge']`, `MeshPatchType`. Geometric types assignable to a single patch (cyclic, cyclicAMI, processor excluded).
- `PATCH_ROLES = ['inlet', 'outlet']`, `PatchRole`. Semantic roles: the polyMesh type stays `patch`, a BC preset is applied to the `0/` fields.
- `MESH_PATCH_SETTINGS`, `MeshPatchSetting`. Union of the two previous lists (`setPatchType` / `editMeshPatches` schemas).
- `isPatchRole(value: string): value is PatchRole`.
- `CONSTRAINT_PATCH_TYPES = ['empty', 'symmetry', 'symmetryPlane', 'wedge', 'cyclic', 'cyclicAMI', 'processor']`. Types whose field BC must be identical to the geometric type; `cyclicAMI` is included for the non-conformal coupling of Assembly v3 (ESI v2406).

### Per-component boundary condition presets
- `OBJECT_TYPES = ['turbine', 'pipe', 'draftTube', 'chamber']`, `ObjectType`.
- `DRIVING_MODES = ['pressure', 'flowRate', 'csvProfile']`, `DrivingMode`. Imposed total pressure (Q as result), imposed flow rate, or mapped CSV profile (draft tube only).
- `OBJECT_TYPE_MODES: Record<ObjectType, readonly DrivingMode[]>`. turbine: `pressure`; pipe: `pressure`, `flowRate`; draftTube: `csvProfile`; chamber: `flowRate`, `pressure`.
- `ObjectTypeInfo`, `OBJECT_TYPE_LIBRARY` (labels and summaries, overlay order); `DrivingModeInfo`, `DRIVING_MODE_LIBRARY`.
- `GRAVITY = 9.81`. Conversion of net head to kinematic pressure `p0 = g * H`.
- `TurbulenceDefaults` (`intensity`, `mixingLength`, `kSeed`, `omegaSeed`), `OBJECT_TYPE_TURBULENCE`. 5% / 0.07 / 0.06 / 10 for turbine, pipe, chamber; 8% / 0.02 / 0.1 / 50 for draftTube.
- `BoundaryConditionValues` (`head?`, `flowRate?`, `intensity?`, `mixingLength?`).

### Rotor and BC application
- `ROTOR_MODES = ['frozenRotor', 'movingRotor']`, `RotorMode`, `RotorModeInfo` (with `file`), `ROTOR_MODE_LIBRARY`. frozenRotor writes `constant/MRFProperties` (steady MRF, simpleFoam); movingRotor writes `constant/dynamicMeshDict` (sliding mesh, pimpleFoam + cyclicAMI).
- `MOVING_ROTOR_KINDS = ['forced', 'free']`, `MovingRotorKind`, `MovingRotorKindInfo`, `MOVING_ROTOR_KIND_LIBRARY`.
- `SixDofRotorConfig` (`patches`, `axis`, `centreOfMass`, `mass`, `momentOfInertia`, `rhoInf`, `innerDistance`, `outerDistance`, `damperCoeff`). Free 6-DoF rotor.
- `RotorConfig` (`mode`, `cellZone`, `origin`, `axis`, `omega` in rad/s, `nonRotatingPatches?`, `movingKind?` default `forced`, `sixDof?` required if free).
- `ApplyBoundaryConditionsRequest` (`objectType`, `mode`, `inlet`, `outlet`, `walls`, `values`, `rotor?`). JSON body of the overlay; the CSV travels as multipart.
- `AppliedRotor`, `AppliedBoundaryConditions` (including touched `fields` and `p0?`), `ApplyBoundaryConditionsResult` (`success`, `applied`, `csvSteps?: ImportStep[]`, `notes`).

### Mesh library and assembly (merge)
- `MESHES_DIRNAME = 'meshes'`. Folder of a project's polyMesh source library. Not referenced in `apps/`.
- `MERGE_STEP_KINDS = ['prepare', 'mergeMeshes', 'splitMeshRegions', 'stitchMesh', 'nonConformalCouple', 'cleanup', 'checkMesh']`, `MergeStepKind`. Variable number of steps, hence a non-unique `kind`.
- `MESH_SOURCE_KINDS = ['folder', 'zip', 'cgns', 'msh', 'meshing']`, `MeshSourceKind`.
- `MeshSource` (`id` = folder name, `name`, `kind?`, `patches`, `createdAt`).
- Meshing -> project hand-off (WS-F): `MESH_TO_PROJECT_TARGETS = ['case', 'library']` (first = default), `MeshToProjectTarget`, `MeshFromMeshingRequest` (`sessionId`, `target`, `name?`), `MeshFromMeshingResult` (`target`, `entries?`, `mesh?`, `meshes?`, `notes`, `retyped?`, `syncedFields?`), `CHAMBER_PATCH_TYPES` (mirror of `buildChamber.py` `PATCH_TYPES`, parity test `apps/api/tests/chamberPatchTypes.test.ts`).
- `StitchPair` (legacy conformal pair); `MERGE_BASE_CASE = '__case__'` (sentinel: start from the project's case mesh).
- `InterfaceCoupling = 'nonConformal' | 'stitch'`. `nonConformal` (default) retypes both patches to `cyclicAMI` in place via text editing; `stitch` is the conformal `stitchMesh` merge. The old literal `nonConformalCyclic` is normalized on the API side.
- `MeshInterface` (pair + `coupling`), `PartTransform` (`meshId`, `translation`, `rotation` quaternion x,y,z,w three.js-style; no scale), `MergePlan` (`order`, `interfaces`, `transforms?`, deprecated `stitches?`).
- `AppliedAssembly` (`plan`, `baseIsCase`, `appliedAt`). Recorded in `meshes/assembly.json` on each successful promotion; drives Disassemble and the "restore-first" guard.
- `MergeStep` (`kind`, `label`, `command`, `status: success|failed|skipped`, `exitCode`, `stdout`, `stderr`, `durationMs`), `MergeResult` (`success`, `steps`, `notes`, `boundaryPatches`, `cellZones`).

### Mesh file import
- `MESH_IMPORT_EXTENSIONS = ['.cgns', '.msh']`, `MeshImportExtension`. Not referenced in `apps/`.
- `ImportStep` (`tool`, `label`, `command`, `status`, `exitCode`, `stdout`, `stderr`, `durationMs`), `MeshImportConversion` (`success`, `steps`). Reused by the mesh and CSV reports.

### Mesh sessions (snappyHexMesh / cfMesh)
- `MESHING_DIRNAME = 'meshing'` (not referenced in `apps/`), `STL_EXTENSION = '.stl'`, `FMS_EXTENSION = '.fms'`.
- `MESHING_ENGINES = ['snappy', 'cfmesh']`, `MeshingEngine` (fixed at session creation). `DOMAIN_TYPES = ['internal', 'external']`, `DomainType` (snappy only).
- `MeshBounds` (`min`, `max`), `SurfaceRefinement` (`min`, `max`), `SurfaceLayerSpec`, `AddLayersConfig` (`enabled`, `surfaces?`, `nLayers`, `relativeSizes`, `finalLayerThickness`, `expansionRatio`, `perSurface?`), `FeatureRefinement` (`includedAngle`, `level`).
- `SnappyConfig` (`engine: 'snappy'`, `domainType`, `baseCellSize | null`, `marginFactor`, `surfaceRefinement`, `surfaceRefinements?`, `featureLevel`, `featureAngle`, `featureRefinements?`, `featureSurfaces?`, `locationInMesh | null`, `addLayers`, `cores`). `null` means "derive from the STL bounds on the server side".
- `DEFAULT_SNAPPY_CONFIG`: internal, `marginFactor` 0.1, refinement 1..2, `featureLevel` 2, `featureAngle` 150, layers disabled (3, relative, 0.5, 1.2), 1 core.
- `CfMeshPatchLayerSpec`, `CfMeshLayersConfig` (`thicknessRatio`, `maxFirstLayerThickness`, `perPatch?`, `noLayerPatches?`), `CFMESH_PATCH_TYPES = ['patch', 'wall', 'symmetry', 'symmetryPlane', 'empty']`, `CfMeshPatchType`, `MeshingPatch` (`name`, `type | null`), `CfMeshLocalRefinement` (`cellSize`).
- `CfMeshConfig` (`engine: 'cfmesh'`, `maxCellSize | null`, `minCellSize | null`, `boundaryCellSize | null`, `extractFeatures`, `featureAngle`, `addLayers`, `patchTypes?`, `localRefinement?`, `cores` = OpenMP threads). `DEFAULT_CFMESH_CONFIG`: null sizes, extraction enabled, angle 45, layers disabled, 1 core.
- `MeshingConfig = SnappyConfig | CfMeshConfig`; `defaultMeshingConfig(engine: MeshingEngine): MeshingConfig`.
- `CHAMBER_TRANSFER_EXCLUDED_STL = 'domain.stl'`. Pre-merged STL never transferred from a chamber build to a session.
- `StlFile` (`name`, `sizeBytes`), `MeshingRun` (`config`, `result`, `at`).
- `MeshingRunStatus = 'running' | 'succeeded' | 'failed' | 'stopped'`, `ACTIVE_MESHING_STATUSES = ['running']`, `isMeshingRunActive(status): boolean` (false for `idle`/`undefined`), `MeshingRunState` (`status.json` sidecar), `MeshingLogPayload` (`status | 'idle'`, `startedAt`, `finishedAt`, `logTail`, `logBytes`, `run`).
- `MeshingSessionSummary` (`id`, `name`, `engine`, `createdAt`, `stlCount`, `hasMesh`), `MeshingSession` (+ `stls`, `bounds`, `lastRun`, `savedConfig`, `maxCores`, `runStatus`, `patches`).

### Solver runs and CFD-Post export
- `RUN_DIRNAME = 'runs'`, `EXPORT_DIRNAME = 'export'`. Sibling folders of the case, never erased by a case reset.
- `EXPORT_STEPS = ['inspect', 'convert', 'validate', 'cfdpost']`, `ExportStepId`, `ExportStep` (extra status `warning`).
- `CaseProfile` (`latestTime`, `steady`, `incompressible`, `solver`, `turbulenceModel`, `fields`, `hasPolyhedra`, `patches`, `emptyPatches`, `inletGuess`, `outletGuess`), `ValidationCheck` (`verdict: pass|fail|info`), `ExportValidation`, `ExportArtifacts` (`cgns`, `session`, `memo`, `report`), `ExportResult`.
- `RUN_STATUSES = ['queued', 'running', 'converged', 'completed', 'diverged', 'failed', 'stopped']`, `RunStatus`. Mirror of the `Run.status` text column.
- `ACTIVE_RUN_STATUSES = ['queued', 'running']` (concurrency guard), `isTerminalRunStatus(status: RunStatus): boolean`.

### Solver catalog
- `SOLVER_IDS`, `SolverId`. 42 entries: 41 ESI v2406 binaries grouped by family, plus `foamRun` (placeholder accepted but never runnable).
- `ConfigurableSolverId = SolverId`; `isConfigurableSolver(id: string)`. True for every id in `SOLVER_LIBRARY` except `foamRun`.
- `SolverParamDef` (`key`, `label`, `help?`, `kind: enum|scalar|integer|bool|vector|text`, `options?`, `example?`, `file`, `path`). "Easy mode" parameter written into a case file at a dictionary path.
- `SolverSpec` (`id`, `label`, `summary`, `regime`, `family: incompressible|compressible|multiphase|potential`, `requiredFiles`, `easyParams`, `tier: full|base`).
- `INCOMPRESSIBLE_RANS_FILES` (`system/` trio, `transportProperties`, `turbulenceProperties`, `0/U p k omega nut`), `COMPRESSIBLE_RANS_FILES` (with `thermophysicalProperties`, `0/T`, `0/alphat`; absolute `0/p`).
- Internal (not exported): `RAS_MODEL_OPTIONS`, the parameters `turbulenceParam`, `nuParam`, `muParam`, `initialUParam`, `initialTParam`, `initialPParam`, `endTimeParam`, `writeIntervalParam`, `residualPParam`, `relaxPParam`, `deltaTParam`, `adjustTimeStepParam`, `maxCoParam`, `consistentParam` (SIMPLEC, `SIMPLE.consistent`), the lists `COMPRESSIBLE_CATEGORIES`, `FULL_TEMPLATE_CATEGORIES` (incompressible, compressible, supersonic), `NON_FLOW_CATEGORIES`, and `buildSolverSpec(info)`, which composes the parameters by category and regime (transient: `deltaT`/`adjustTimeStep`/`maxCo`; full steady: p residual, p relaxation, SIMPLEC).
- `SOLVER_CATEGORIES` (12 families, display order), `SolverCategory`, `SolverInfo` (`id`, `label`, `summary`, `category`, `regime?`), `SOLVER_LIBRARY` (41 entries, without `foamRun`).
- `SOLVER_CATALOG: Record<SolverId, SolverSpec>`, `CONFIGURABLE_SOLVER_IDS`, `SOLVER_SPECS`. Generated from `SOLVER_LIBRARY` via `buildSolverSpec`.
**Notes**: `buildSolverSpec` never produces `family: 'multiphase'` or `'potential'` (only incompressible/compressible); non-compressible families get the incompressible RANS file set as a base. `SOLVER_CATALOG` is typed `Record<SolverId, …>` but has no `foamRun` entry.

### Turbulence models
- `TurbulenceModelSpec` (`id`, `label`, `summary`, `simulationType: laminar|RAS|LES`, `fields`). `TURBULENCE_APPROACHES`, `TurbulenceApproach`.
- `TURBULENCE_MODELS`. 20 models: `laminar`; RANS `kOmegaSST` (default), `kOmega`, `kEpsilon`, `realizableKE`, `RNGkEpsilon`, `LaunderSharmaKE`, `kOmegaSSTLM`, `SpalartAllmaras`, `LRR`, `SSG`; LES/DES `Smagorinsky`, `kEqn`, `dynamicKEqn`, `WALE`, `dynamicLagrangian`, `SpalartAllmarasDES`, `SpalartAllmarasDDES`, `SpalartAllmarasIDDES`, `kOmegaSSTDES`. `fields` lists the `0/` fields read by the model.
- `TURBULENCE_FIELD_NAMES = ['k', 'epsilon', 'omega', 'nut', 'nuTilda', 'R']`. Used to delete unread fields when the model changes.
- `turbulenceFieldsFor(modelId: string): string[]`. Copy of `fields`; unknown id: falls back to `['k', 'omega', 'nut']`.
- `turbulenceWallBc(fieldName: string, modelId: string): string | null`. Wall function: `k`/`R` to `kqRWallFunction`, `epsilon` to `epsilonWallFunction`, `omega` to `omegaWallFunction`, `nuTilda` to `fixedValue`, `nut` to `nutkWallFunction` if the model reads `k`, otherwise `nutUSpaldingWallFunction`; `null` if the field is not read.
- `TURBULENCE_MODEL_IDS`, `TurbulenceModelId`. Literal tuple for zod, must be kept aligned by hand with `TURBULENCE_MODELS`.

### Residuals
- `RESIDUAL_FIELDS = ['Ux', 'Uy', 'Uz', 'p', 'k', 'omega', 'epsilon', 'nuTilda']`, `ResidualField`. Chart order and palette.
- `ResidualSample` (`time`, `values: Partial<Record<string, number>>`).

### Chamber: empirical model X1..X3
- `CHAMBER_DIRNAME = 'chamber'`, `CHAMBER_UNIT = 'mm'`.
- `CHAMBER_INPUT_RANGES`: x1 700..2420, x2 1.8..14.9, x3 1..23.
- `CHAMBER_OUTPUT_KEYS`, `ChamberOutputKey`. The 12 outputs (JSON keys read by `buildChamber.py`).
- `ChamberConfidence` (`Good|High|Moderate|Low`), `ChamberForm` (`linear|power`), `ChamberRelationKind` (`refine|combination`).
- `ChamberRelation` (`kind`, `defaultOn`, `label`, `description`, `partner?`, `refineCoeffs?`, `terms?`, `constant?`, `empirical?`). `refine` refines an output with a partner's measured Exact value; `combination` computes `constant + Σ coeff × partner.final`.
- `ChamberOutputSpec` (`key`, `label`, `form`, `cvError`, `confidence`, `coeffs`, `relation?`), `CHAMBER_OUTPUT_SPECS`:

| Key | Label | Form | CV % | Confidence | Relation (default ON) |
|-----|---------|-------|------|-----------|----------------------|
| `width` | B Kammer | linear | 18.8 | Moderate | refine from `distFromSideChamfer1` |
| `height` | H Kammer | linear | 28.6 | Moderate | `= LEB + LEOW` |
| `distFromSideChamfer1` | B1 | linear | 32.0 | Low | refine from `width` |
| `chamferLength1` | LF1 | linear | 20.6 | Moderate | none |
| `chamferWidth1` | BF1 | linear | 20.6 | Moderate | `= LF1` |
| `chamferLength2` | LF2 | linear | 18.6 | Moderate | `= LF1` |
| `chamferWidth2` | BF2 | linear | 22.0 | Moderate | `= LF2` |
| `distFromEnd` | LT | linear | 27.2 | Moderate | `= LF1 + LF2` |
| `dLast` | LE (Durchmesser) | linear | 8.1 | Good | `= 255.16 + 3.4954 × HLE` (empirical) |
| `hMiddle` | HLE | linear | 5.8 | High | none |
| `hMiddlePlusFirst` | LEB | power | 24.9 | Moderate | `= 2 × HLE` |
| `hLast` | LEOW | linear | 38.9 | Low | none |

- `ChamberRelationInfo`, `CHAMBER_RELATIONS`. Derived from the specs that have a relation (list of UI toggles).
- `CHAMBER_GRID_MM = 50`; `snapToChamberGrid(valueMm: number): number` (rounds to the nearest multiple of 50).
- `CHAMBER_DIMENSION_MAX_MM = 100_000`. Upper bound for any entered dimension (API, web form).
- `ChamberConstraint` (`min?`, `max?`, `exact?`).
- `CHAMBER_VANE_COUNT_MIN = 8`, `CHAMBER_VANE_COUNT_MAX = 32`, `CHAMBER_VANE_COUNT_DEFAULT = 16` (spec 2026-09-29-guide-vane-count-any, replacing `CHAMBER_VANE_COUNTS` / `ChamberVaneCount`; mirrored by `VANE_COUNT_MIN`/`_MAX` in `buildChamber.py`; used by the API schema/service and the web form).
- `CHAMBER_VARIANTS = ['stepped', 'hollow']`, `ChamberVariant`. `CHAMBER_WALL_THICKNESS_MM = 50`. `CHAMBER_CONE_CHAMFER_SIZE_MM = 50` (default Cone chamfer size, spec 2026-09-29-cone-foot-chamfer). `chamberConeChamferMm(input)` (since 2026-09-29): the LE-part widening in mm (size or 50 when on, else 0), used by the API params and `chamberSpiralInputs`.
- Semi-spiral casing (spec 2026-09-29-semi-spiral-casing): `CHAMBER_SPIRAL_FLOW_RANGE` ({min 0.3, max 3, default 0.922}), `CHAMBER_SPIRAL_CLEARANCE_M` 0.2, `CHAMBER_SPIRAL_PHI_START_DEG` 160, `CHAMBER_SPIRAL_DERIVED_KEYS` (B1, LF1, BF1, LF2, BF2, LT), types `ChamberSpiralVertex`, `ChamberSpiralBoxDims`, `ChamberSpiralSummary`, `ChamberSpiralInputs`; `chamberSpiralBoxDims(vertices)` (the box values, **mirrored** like `spiral_box` of the builder: B1 = −x_in, chamfer 1 = L2), `chamberSpiralInputs(input, outputs)` (tool inputs in m: D_LE = max(dFirst, dMiddle, dLast + 2 × Cone chamfer) × partScale), `chamberSpiralModelInput(input)` (drops constraints on the derived rows while the spiral is on), `applyChamberSpiralToOutputs(outputs, boxMm | null)` (derived rows → status `from spiral`, final = spiral value or NaN). `ChamberStatus` gains `'from spiral'`; `CHAMBER_PATCH_TYPES` gains `tongue: 'wall'`.
- `CHAMBER_D_FIRST_OVER_LAST = 1.14703`, `CHAMBER_D_MIDDLE_OVER_LAST = 0.8`. Default diameter ratios; the Python script keeps its own copy, which must be kept in sync.

### Chamber: generator dimensions (Gen Dim v3)
- `CHAMBER_GENERATOR_FRAME_DIAMETERS_MM`. Catalog diameter per frame code (26: 572, 36: 745, 38: 753, 45: 976, 46: 933, 48: 986, 62: 1242, 77: 1545, 115: 2225); only 26/46/48/62/115 are reachable by the rules.
- `CHAMBER_X4_MAX = 100_000`.
- `ChamberGeneratorDims` (`x4Auto`, `x4Used`, `frame`, `lengthCode`, `auto`, `resolved`).
- `computeChamberGeneratorDims(input: { x1, x2, x3, x4?, centralDiameter?, centralHeight?, domeHeight? }): ChamberGeneratorDims`. `x4Auto = 0.9·9.81·X2·X3`; frame: 115 if X4 > 1560, otherwise if X4 ≤ 175 then 26 (X1 ≤ 940) or 46, otherwise 48 (X1 ≤ 683) or 62; length code `round((132.21 − 0.8294·R − 0.0825·X1 + 13.861·X3)/5)·5` clamped to 30..215; auto height `71.258 + 0.45856·Ø + 6.2368·L`; auto dome `79.609 + 0.21315·Ø`. An entered Ø rebases height and dome; an entered height does not change the dome. Pure function, no range validation.

### Chamber: build request, saves and output computation
- `ChamberInput`. Body of `POST /chamber/build`: `x1..x3`, `x4?`, `constraints?`, `relationsMaster?`, `relations?`, `variant?`, `footAngleDeg?`, `guideVanes?`, `chamferEnabled?`, `feetEnabled?`, `vaneAngleDeg?` (45..55, base 50), `vaneCount?` (number, whole 8..32; chord × 16/n about the pivot, same solidity; guide vanes only), `outletRatio?` (0.35..0.50), `partScale?`, `lengthOverride?`, `hollowLength?` (required for hollow), `wallThickness?`, `dFirst?`, `dMiddle?`, `centralDiameter?`, `centralHeight?`, `domeHeight?`, `simplifyGenerator?`, `coneChamferEnabled?` / `coneChamferSize?` (both designs: 45° foot chamfer on the lower outer edge of the LE part, which is widened by the size above it, mm, × partScale, default 50), `semiSpiral?` / `spiralFlowVelocity?` (semi-spiral casing, both designs, default off / 0.922 m/s).
- `CHAMBER_SAVE_NAME_MAX = 80`, `ChamberSaveOwner` (`id`, `fullName`), `ChamberSaveSummary` (`id`, `name`, `snapshot: ChamberInput`, `owner`, `createdAt`, `updatedAt`).
- `ChamberStatus` (`within range`, `capped at max`, `raised to min`, `set exact`, `! min>max`, `from relation`).
- `ChamberOutput` (`key`, `label`, `form`, `model`, `final`, `status`, `relationLabel?`, `cvError`, `confidence`, `refined`, `userDriven`, `noEffect?`).
- `evalChamberSpec(spec, x1, x2, x3, partnerKnown?): number`. Refine fit if the relation is refine and the partner is known, otherwise power or linear law.
- `resolveChamberFinal` (internal): Exact wins; min > max gives `! min>max` and keeps the model value; otherwise clamping.
- `computeChamberOutputs(input: ChamberInput): ChamberOutput[]`. Pass 1: outputs with no relation, a disabled relation or a refine relation (reads the partner's Exact from `constraints`); pass 2: active `combination` relations resolved to a fixed point (chaining LEB then H Kammer). Estimates are rounded to the 50 mm grid; an identity fed by a user value propagates it as is (`userDriven`), an `empirical` relation always re-rounds. `hLast` gets `noEffect` if the `height` relation is inactive or if `height` has an Exact. `relationsMaster === false` turns off all relations.
- `nonPositiveChamberFinals(outputs): ChamberOutput[]`. Outputs with `final <= 0` excluding `noEffect`; the API rejects the build before launching CadQuery.
- `blankGeneratorHeightRefusal(input, outputs): string | null` (named `closedGeneratorHeightRefusal` until 2026-09-29). Blank `centralHeight` in Closed generator or With cone + Simplify generator: message when `partScale × (LEB + Gen Dim v3 height + Gen Dim dome height) > H Kammer` (dome from `auto.domeHeight`; With cone: only when generator + dome exceed `hollowLength`); names the H Kammer to reach (next 50 mm) and the Part scale that fits. The API refuses with 422 before the builder.
- `runnerCaseClearanceRefusal(input, outputs): string | null` (WS-A v2, spec 2026-09-29-runner-case-below-le; replaced `runnerCaseBelowLeRefusal`) + `CHAMBER_RUNNER_CASE_OUTLET_CLEARANCE_MM = 20` (mirrors `RUNNER_CASE_OUTLET_CLEARANCE`) + `CHAMBER_RUNNER_CASE_SNAP_MM = 5` (mirrors `SNAP_D_TOL`, the builder's flush snap). Guide vanes and a typed `dFirst`: message when `partScale × dFirst < x1 + 20` ("With guide vanes the runner case must clear the outlet: Runner case Ø (…[, … at Part scale s]) must be at least Runner Ø + 20 mm (…). Increase Runner case Ø, clear it (auto ≈ …), or turn Guide vanes off."), else null (below LE Ø the builder adds the ledge). Called by `chamber.service.buildChamber` (422).

### Server error codes
- `SERVER_ERROR_CODES`, `ServerErrorCode`. List of `{ error: { code } }` envelope codes known to the web client (which adds its own transport codes). `MESH_IN_PROGRESS` and `MESHING_NOT_MESHED` added on 2026-09-29.
**Notes**: inconsistencies found with the API. Codes declared but never emitted by `apps/api/src`: `CONVERSION_FAILED`, `MESH_MERGE_FAILED`, `BC_APPLY_FAILED`. Codes emitted but missing from the list: `NAME_TAKEN` (chamber saves), `ENGINE_MISMATCH` and `MESH_IN_PROGRESS` (meshing), `NOT_ENOUGH_CORES` and `TOO_MANY_CORES` (runs), `ARCHIVE_TOO_LARGE` (archives), as well as `INTERNAL_SERVER_ERROR` and `ERROR` (errorHandler defaults).

## `packages/shared/package.json`
Package `@dive/shared` v0.1.0, dual build: CJS (`dist/cjs`, with `.d.ts` declarations) and ESM (`dist/esm`). `exports` field: `types` and `require` to CJS, `import` to ESM. Scripts `build` (both `tsc`) and `typecheck`. Single dependency: `zod ^3.23.0`. Since `dist/` is ignored by git, the API only compiles after `npm run build:shared`.

## `packages/shared/tsconfig.esm.json`
Extends the base; `module: ES2022`, `moduleResolution: node`, `declaration: false`, `outDir: dist/esm`, `rootDir: src`.

## `packages/shared/tsconfig.json`
Extends the base; `module: CommonJS`, `moduleResolution: node`, `declaration: true`, `outDir: dist/cjs`, `rootDir: src`.

## `.editorconfig`
UTF-8, LF line endings, 2-space indentation, final newline, trailing whitespace trimmed (disabled for `*.md`).

## `.gitattributes`
Normalizes the whole repository to LF (`* text=auto eol=lf`), because the team develops on Windows and deploys on Debian; forces LF for `*.sh` and `*.py`. Marks images, fonts, `*.db` and CFD artifacts (`*.cgns`, `*.vtk`, `*.vtu`, `*.msh`) as binary.

## `.gitignore`
Ignores `node_modules/`, `dist/`, `build/`, `coverage/`, `.env` and `.env.*` files (except `.env.example`), SQLite databases (`*.db`, `*.db-journal`, `apps/api/prisma/dev.db*`), the storage `apps/api/storage/` and `apps/api/test-storage/`, Python caches, logs, `.DS_Store` and `*.local`.

## `.mcp.json`
Declares the MCP server `dive` for Claude Code: `npx tsx apps/mcp/src/server.ts` (launched from the repository root).

## `.nvmrc`
Node version `24`.

## `.prettierrc.json`
Semicolons, single quotes, trailing commas everywhere, width 100.

## `eslint.config.js`
**Role**: ESLint 9 "flat" configuration of the monorepo via `tseslint.config`. Ignores `**/dist`, `**/node_modules`, `apps/api/prisma/migrations`, `**/*.config.js`, `**/*.config.ts`. Applies `js.configs.recommended` and `tseslint.configs.recommended`, the `@typescript-eslint/no-unused-vars` rule with an exemption for identifiers prefixed with `_`, Node globals for `apps/api/**/*.ts`, and for `apps/web/**/*.{ts,tsx}` browser globals, `react-hooks` (recommended rules) and `react-refresh/only-export-components` (warn, `allowConstantExport`).
**Notes**: no dedicated section for `apps/mcp` or `packages/shared` (only the base rules apply). No typed (type-aware) linting.

## `package.json`
**Role**: root of the `dive-turbinen` workspace (private, ESM, `engines.node >=20`).
**Scripts**: `dev` (build shared then API + web via `concurrently`), `dev:api`, `dev:web`, `build:shared`, `build` (shared, API, web), `lint` (`eslint .`), `format` (`prettier --write .`), `typecheck` and `test` (shared then API then web; the MCP is not included), `db:migrate`, `db:seed`, `db:reset` (delegated to `@dive/api`).
**Notes**: devDependencies limited to tooling (ESLint 9, typescript-eslint 8, Prettier 3, TypeScript 5.5, concurrently 9, globals).

## `tsconfig.base.json`
Common TypeScript base: `target ES2022`, `strict`, `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. Each package sets its own `module`.

## `package-lock.json`
**Role**: npm lockfile for the whole monorepo (workspaces), used by `npm ci` in CI and in production. Never edit it by hand; regenerate it via `npm install`.

## `AGENTS.md`
**Role**: instructions common to every AI agent (project, session protocol, golden rules, commands, brain map, design in brief). Loaded at every session; imported by `CLAUDE.md`.

## `CLAUDE.md`
**Role**: Claude Code entry point: imports `AGENTS.md` (`@AGENTS.md`) and adds the Claude-specific parts (memory, changelog hook, UI skills, index, Windows shells).

## `README.md`
**Role**: technical reference for humans (architecture, prerequisites, dev, configuration, Debian deployment, CFD tools per feature, commands, auth, REST API, links to the brain).

## `.claude/settings.json`
**Role**: shared Claude Code project settings: declares the `Stop` hook that runs `.claude/hooks/check-changelog.sh`.

## `.claude/hooks/check-changelog.sh`
**Role**: `Stop` hook (bash, Git Bash / WSL / Linux) that blocks the end of turn once if an uncommitted code file is newer than the latest entry in `brain/changelog/`. Anti-loop guard `stop_hook_active`, depends only on `git` and `date -r`.

## `brain/codemap/build-index.py`
**Role**: generates `brain/INDEX.md` (one line per repository file) from the `**Role**` sections of the codemap sheets and the intro line of Markdown documents; `--check` exits with an error if a file is not documented. Python standard library only.

## `brain/assets/chamber-parameter-map.html`
**Role**: standalone interactive mind map of the Chamber Creation parameters and their relations (deliverable of 2026-08-04, v2 model: without Gen Dim v3 or the recent geometric options).

