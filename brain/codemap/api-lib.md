# Codemap: API lib (cross-cutting helpers)

> Scope: `apps/api/src/lib/**` · Updated: 2026-09-28

## Overview
`apps/api/src/lib/` groups the HTTP-stateless building blocks that the services in `apps/api/src/modules/**` compose. Five families:
- **Application foundation**: `AppError` (business errors rendered by the `errorHandler`), `logger`, `prisma`, `jwt`, `password`, `role`, `serializeUser`, `audit`.
- **Disk storage**: `fileTreeStorage` is the safe core (sanitization, confinement, anti zip-slip, zip-bomb); facades each pin it to a root (`caseStorage`, `cgnsStorage`, `templateStorage`, `meshStorage`, `runStorage`, `vizStorage`, `meshSourceVizStorage`, `meshingStorage`, `meshingVizStorage`, `exportStorage`, `chamberStorage`, `meshBackupStorage`). The full directory tree is described in `brain/architecture/storage-layout.md`.
- **Process execution**: `commandRunner` (one-shot, `execFile`, buffered) and `streamRunner` (long-running, `spawn`, output to a log file), both injectable for tests; `openfoamCommand` wraps an OpenFOAM binary in `bash -c 'source "$OPENFOAM_BASHRC" && exec "$@"'`; `terminalSession` opens an interactive shell (optional node-pty).
- **Meshing / conversion pipelines**: `meshImport` (CGNS/MSH to polyMesh), `boundaryData` (CSV to `constant/boundaryData`), `meshPipelineRun` (shared step runner), `snappyPipeline` + `snappyDicts`, `cfMeshPipeline` + `cfMeshDicts`, plus the pure utilities `stlBounds`, `stlMerge`, `meshPatches`, `meshTransform`, `cores`.
- **OpenFOAM text domain**: `openfoamCase` (generation of dictionaries and `0/` fields, BC presets, MRF/dynamicMesh, parsing and surgical rewriting of `boundary` / `boundaryField`) and `residualParser` (solver log to residual series).

Shared convention: any external tool execution "never throws" on a tool failure; it returns a step report `ImportStep[]` (`success` / `failed` / `skipped`) aggregated by `finalize` into a `MeshImportConversion`.

## `apps/api/src/lib/AppError.ts`
Single operational error class of the API. `AppError(status, code, message, details?)` carries the HTTP status, a stable machine `code` (e.g. `VALIDATION_ERROR`, `NOT_FOUND`, `INVALID_ARCHIVE`) that the front end can test, a displayable message and optional `details` (type `AppErrorDetails = unknown`, never secrets). The constructor restores the prototype chain (`Object.setPrototypeOf`) so that `instanceof` works after transpilation. Rendered by the central `errorHandler` as `{ error: { code, message } }`. Used by nearly all services, middlewares and by `fileTreeStorage` / `jwt`.

## `apps/api/src/lib/audit.ts`
**Role**: audit log of sensitive actions (auth and administration) in the append-only `AuditLog` table. "Best-effort" write: a failure is logged but never propagates. Actor and target are denormalized (id + email) to stay readable after the account is renamed or deleted.
**Exports**:
- `AuditAction`. `as const` object of the codes: `LOGIN`, `LOGOUT`, `PASSWORD_CHANGED`, `PROFILE_UPDATED`, `USER_CREATED`, `USER_UPDATED`, `USER_DELETED`, `USER_DISABLED`, `USER_ENABLED`.
- `AuditActionCode`. Union of the `AuditAction` values.
- `toAuditPrincipal(user: Pick<PublicUser, 'id' | 'email'>): { id, email }`. Reduces a user to the stored fields.
- `recordAudit(input: { action, actor?, target?, metadata? }): Promise<void>`. `prisma.auditLog.create` with `metadata` serialized as JSON; catches any error and calls `logger.error`.
**Depends on**: `prisma`, `logger`, `serializeUser` (type). **Used by**: `modules/auth/auth.controller.ts`, `modules/users/users.service.ts`.
**Notes**: the comment asks to keep the codes in sync with the read/UI labels.

## `apps/api/src/lib/boundaryData.ts`
**Role**: converts a runner outlet CSV profile (draft tube inlet) into `constant/boundaryData/<inlet>/{points, 0/U [, 0/k, 0/omega]}` for a `timeVaryingMappedFixedValue` BC. Modeled on `meshImport`: configurable Python script, a missing interpreter or script is reported as a failed step, injectable runner.
**Exports**:
- `CsvToBoundaryResult`. `{ steps: ImportStep[]; mappedFields: string[] }`; `mappedFields` contains `U` on success, plus `k` / `omega` only if the CSV had those columns.
- `convertCsvToBoundaryData(caseDir: string, csvAbs: string, patch: string): Promise<CsvToBoundaryResult>`. Runs `MESH_PYTHON_BIN csv_to_boundaryData.py <csv> <caseDir> <inlet>` (cwd = `caseDir`, timeout `CSV_TO_BOUNDARY_TIMEOUT_MS`), then detects the files produced under `constant/boundaryData/<patch>/0/`. Does not throw.
**Depends on**: `commandRunner`, `openfoamCommand.commandFailed`, `config/env`. **Used by**: `modules/projects/boundary.service.ts` (which writes the CSV into an `mkdtemp` of `os.tmpdir()`).
**Notes**: env read: `MESH_PYTHON_BIN`, `CSV_TO_BOUNDARY_DATA_SCRIPT` (otherwise `apps/api/scripts/csv_to_boundaryData.py` resolved from `__dirname/../../scripts`), `CSV_TO_BOUNDARY_TIMEOUT_MS`. The script is not run via `planOpenfoamCommand` (direct Python, no bashrc). `tail` / `toStep` / `pathExists` are local copies of those in `meshImport`.

## `apps/api/src/lib/caseStorage.ts`
**Role**: `fileTreeStorage` facade pinned to `<STORAGE_DIR>/projects/<projectId>/case/`. Carries the OpenFOAM-specific normalization on import (removal of wrapper folders, bare `polyMesh` moved under `constant/`). Also provides the project's absolute paths for external processes and the terminal.
**Exports**:
- `CaseEntry`. Alias of `FileEntry`.
- `caseDirAbsolute(projectId): string`. Absolute case root (id validated by `assertSafeId`, the folder may not exist). Passed as `-case` to OpenFOAM tools.
- `projectDirAbsolute(projectId): string`. `projects/<id>` root (cwd of the project terminal).
- `ensureProjectDir(projectId): Promise<string>`. `mkdir -p` of the project root.
- `normalizeCasePaths(rawPaths: string[]): string[]`. Sanitizes each path, strips up to 4 common wrapper segments (never `system`, `constant`, `0` or `polyMesh`), then prefixes `constant/` to any path starting with `polyMesh/`.
- `writeUploadedFiles(projectId, files: {relativePath, data}[]): Promise<string[]>`. Folder upload via `writeNormalizedAt`.
- `extractArchive(projectId, archive: Buffer): Promise<string[]>`. Zip extraction via `extractArchiveAt`; throws `INVALID_ARCHIVE` (400) or `ARCHIVE_TOO_LARGE` (413).
- `listCaseTree`, `caseIsEmpty`, `caseFileExists`, `readCaseFile` (Buffer or null), `writeCaseFile`, `deleteCaseFile`, `deleteCaseDir` (404 `NOT_FOUND` if missing), `moveCasePath` (404 / 400 `VALIDATION_ERROR` / 409 `FILE_EXISTS`), `zipCase` (zip Buffer of files only).
- `removeProjectStorage(projectId): Promise<void>`. `rm -rf` of all of `projects/<id>` (case, cgns, meshes, runs, viz, export, backups).
- `clearCase(projectId): Promise<void>`. `rm -rf` of `case/` only.
**Depends on**: `fileTreeStorage`. **Used by**: `meshBackupStorage`, `vizStorage`, and the services `boundary`, `conversion`, `export`, `files`, `mesh`, `meshes`, `projects`, `runs`, `terminal.gateway`, `templates`, `users`.
**Notes**: all relative paths go through `sanitizeRelative` + `confineJoin` in the core.

## `apps/api/src/lib/cfMeshDicts.ts`
**Role**: pure rendering of `system/meshDict` for `cartesianMesh` (cfMesh) and resolution of the base cell size. Kept separate from `snappyDicts` because cfMesh reads a single `surfaceFile`, in absolute sizes (meters), with a different layer vocabulary. Testable without OpenFOAM.
**Exports**:
- `resolveMaxCellSize(config: CfMeshConfig, bounds: MeshBounds | null): number | null`. `config.maxCellSize` if > 0, otherwise bbox diagonal / 40, otherwise `null` (FMS case with no bbox and no size; the caller must refuse).
- `renderMeshDict(config: CfMeshConfig, surfaceFile: string, maxCellSize: number): string`. Emits `surfaceFile`, `maxCellSize`, optional `minCellSize` / `boundaryCellSize`, one `localRefinement` block per patch that has a `cellSize`, a `boundaryLayers` block if `addLayers.enabled` (with `patchBoundaryLayers`: custom `perPatch` entries, then `nLayers 0` for `noLayerPatches` not already customized; `allowDiscontinuity 0`, `optimiseLayer 1`), and a `renameBoundary/newPatchNames` block for the `patchTypes` that are set.
**Depends on**: `@dive/shared` types. **Used by**: `cfMeshPipeline`.
**Notes**: `nLayers` rounded and clamped to ≥ 1, `thicknessRatio` clamped to ≥ 1. Numbers formatted to 6 significant digits (`fmt`). Its own FoamFile header ("Generated by DIVE Turbinen (cfMesh session)").

## `apps/api/src/lib/cfMeshPipeline.ts`
**Role**: runs the cfMesh pipeline of a meshing session and returns a step report in the same format as snappy. cfMesh is multithreaded (OpenMP): the core count goes through `OMP_NUM_THREADS`, not through `decomposePar`/MPI.
**Exports**:
- `runCfMeshPipeline(caseDir, surfaceNames: string[], bounds: MeshBounds | null, config: CfMeshConfig, stream?: { logFile, controls? }): Promise<MeshImportConversion>`. Steps: resolution of `maxCellSize` (immediate failure with a message if impossible), `cleanPriorMeshArtifacts`, creation of `<case>/.work`, surface preparation (FMS used as is; a single STL used as is; several STLs merged in-process into `.work/combined.stl` via `mergeStlFilesToAscii`, synthetic step `stlMerge`), `surfaceFeatureEdges -angle <featureAngle> <surface> .work/combined.fms` if `extractFeatures` and STL input, writing of `system/{controlDict,fvSchemes,fvSolution,meshDict}`, then `cartesianMesh -case` and `checkMesh -case`. Streaming mode (`runStepsStreaming` to `logFile`) or buffered (`runSteps`). Does not throw on a tool failure.
**Depends on**: `cfMeshDicts`, `snappyDicts` (minimal dicts), `stlMerge`, `meshPipelineRun`, `openfoamCommand`, `config/env`. **Used by**: `modules/meshing/meshing.service.ts`.
**Notes**: env: `CARTESIAN_MESH_BIN`, `CHECK_MESH_BIN`, `SURFACE_FEATURE_EDGES_BIN`, `CFMESH_STEP_TIMEOUT_MS`. The choice to merge in TypeScript (not `surfaceAdd`) is motivated by unreliable behavior on the deployment machine. Files in `.work` do not appear as input surfaces.

## `apps/api/src/lib/cgnsStorage.ts`
**Role**: `fileTreeStorage` facade on `<STORAGE_DIR>/projects/<projectId>/cgns/`, which stores the CGNS sources (and the intermediate `.vtk` of the conversion) away from the case so that a case reset does not touch them. Uploaded names are flattened into a single segment.
**Exports**:
- `CgnsEntry`. Alias of `FileEntry`.
- `cgnsBaseName(rawName): string`. Keeps the basename (separators `\` and `/`) then `sanitizeRelative`.
- `cgnsFileAbsolute(projectId, name): string`. Confined absolute path.
- `writeCgnsUpload(projectId, rawName, data): Promise<string>`. Writes under the basename, returns the stored name.
- `listCgnsFiles(projectId): Promise<CgnsEntry[]>`. `.cgns` files only (the `.vtk` is hidden).
- `cgnsFileExists`, `readCgnsFile`, `deleteCgnsFile` (with pruning of empty parents), `clearCgns`.
**Depends on**: `fileTreeStorage`. **Used by**: `modules/projects/conversion.service.ts`.
**Notes**: `listCgnsFiles` has the same name as an export of `exportStorage` with different semantics (see that section).

## `apps/api/src/lib/chamberStorage.ts`
**Role**: global cache (not tied to a project) of the chamber generator's artifacts, under `<STORAGE_DIR>/chamber/<hash>/`. The key is a content hash of the resolved geometric parameters: same inputs, same build; new parameters, new folder; no mtime-based staleness handling.
**Exports**:
- `CHAMBER_EXPORT_FILES`. `{ stl: 'chamber.stl', step: 'chamber.step', stepMirrored: 'chamber-mirrored.step', trisurface: 'trisurface.zip' }`; `ChamberExportKind` = keys.
- `ChamberPaths`. `{ dir, params, glb, manifest, edges, exportsDir }`.
- `chamberHash(params: Record<string, number | string | boolean>): string`. SHA-1 of the JSON of the `[key, value]` pairs sorted by key, truncated to 16 hex.
- `chamberPaths(hash): ChamberPaths`. `assertSafeId` + `confineJoin` under the chamber root.
- `chamberGlbExists(hash): Promise<boolean>`. Presence of `chamber.glb` (the "already built" criterion).
- `writeChamberParams(hash, params)`. Writes `params.json` (input of `buildChamber.py`).
- `writeChamberWarnings(hash, warnings: string[])` / `readChamberWarnings(hash): Promise<string[]>`. `warnings.json`; tolerant read (`[]` if missing or invalid).
- `ChamberBuildMeta` + `readChamberBuildMeta(hash)`. Reads `build-meta.json` written by the builder; `stepHasVanes` is `true`/`false`, or `null` if missing.
- `readChamberGlb`, `readChamberEdges`, `readChamberExport(hash, kind)`. Buffer or `null`.
- `StoredChamberManifest` + `readChamberManifest(hash)`. `manifest.json` (`MeshPatch[]` array) plus `generatedAt` from the mtime.
**Depends on**: `fileTreeStorage`, `CHAMBER_DIRNAME` (`'chamber'`) from `@dive/shared`. **Used by**: `modules/chamber/chamber.service.ts`, `modules/meshing/meshing.service.ts`.
**Notes**: this module writes neither GLB, manifest nor exports: those come from the Python scripts (`buildChamber.py`, `mirrorStep.py`) launched by `chamber.service`, which serializes builds with an in-memory lock per hash (`withChamberLock`). The header comment lists neither `warnings.json` nor `build-meta.json`.

## `apps/api/src/lib/commandRunner.ts`
**Role**: injectable wrapper of `child_process.execFile` for one-shot tools. Never rejects: non-zero exit, timeout or missing binary become a structured `CommandResult`. Arguments passed as real argv (never a shell).
**Exports**:
- `CommandSpec`. `{ command, args, cwd?, env?, timeoutMs? }`.
- `CommandResult`. `{ command, args, exitCode: number | null, stdout, stderr, durationMs, timedOut, spawnError? }`.
- `CommandRunner`. Function type `(spec) => Promise<CommandResult>`.
- `realCommandRunner`. Real implementation: `execFile` with `timeout`, `maxBuffer` 16 MB, `encoding: 'utf8'`, `windowsHide: true`. A numeric `error.code` gives `exitCode`; a string code (`ENOENT`, `EACCES`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`…) gives `spawnError`; `error.killed` gives `timedOut`.
- `setCommandRunner(runner | null): void`. Replaces the active runner (tests); `null` restores the real one.
- `runCommand(spec): Promise<CommandResult>`. Delegates to the active runner.
**Depends on**: `node:child_process`. **Used by**: `boundaryData`, `meshImport`, `meshPipelineRun`, `openfoamCommand` (type) and the services `chamber`, `meshing`, `conversion`, `export`, `mesh`, `meshes`, `runs`.
**Notes**: the `execFile` timeout kills with `SIGTERM` (Node default). Exceeding `maxBuffer` is reported as `spawnError`, not as an exit.

## `apps/api/src/lib/cores.ts`
`coreBudget(): number` returns the maximum number of cores a parallel job may use: `env.SOLVER_TOTAL_CORES` if it is > 0, otherwise `os.cpus().length`. Single source for `modules/projects/runs.service.ts` and `modules/meshing/meshing.service.ts`.

## `apps/api/src/lib/exportStorage.ts`
**Role**: storage of a project's CFD-Post export artifacts under `<STORAGE_DIR>/projects/<projectId>/export/`, sibling of `case/`, `cgns/`, `viz/`, `runs/`: producing or clearing an export does not touch the case, and a case reset does not delete a produced CGNS.
**Exports**:
- `EXPORT_FILES`. `{ cgns: 'out.cgns', cgnsZip: 'out_cgns.zip', convertScript: 'convert.py', profile: 'profile.json', validation: 'validation.json', session: 'session.cse', memo: 'LOAD_CFDPOST.md', report: 'REPORT.md' }`.
- `exportDirAbsolute(projectId): string`, `exportFilePath(projectId, file): string`.
- `ensureExportDir(projectId)`, `clearExport(projectId)` (best-effort `rm -rf`).
- `exportFileExists(projectId, file): Promise<boolean>`. True only if the file exists and has a size > 0.
- `writeExportFile(projectId, file, content)`. Creates the folder then writes.
- `readExportText`, `readExportBytes`, `readExportJson<T>` (null if missing or invalid JSON).
- `listCgnsFiles(projectId): Promise<string[]>`. Absolute paths of `out.cgns` and `out_<i>.cgns`, sorted by numeric index (`out.cgns` first); excludes the zip. Fixes an earlier lexicographic sort (reference C1).
- `zipCgnsFiles(projectId): Promise<number>`. Zips these files (adm-zip) into `out_cgns.zip`, returns the count (0 if none).
**Depends on**: `fileTreeStorage` (`assertSafeId`, `storageRoot`), `adm-zip`, `EXPORT_DIRNAME`. **Used by**: `modules/projects/export.service.ts`, `export.controller.ts`.
**Notes**: does not use `confineJoin` (fixed file names). Name clash of `listCgnsFiles` with `cgnsStorage` (which returns `FileEntry` items for the `.cgns` sources).

## `apps/api/src/lib/fileTreeStorage.ts`
**Role**: directory-tree storage core parameterized by an absolute root, shared by all facades. Any relative path coming from an upload, an archive or a caller is sanitized then confined to the root before any disk access (defense against zip-slip and `../`). Knows nothing about OpenFOAM: normalization is injected (`PathNormalizer`).
**Exports**:
- `FileEntry` `{ path, type: 'file' | 'directory', size }`, `RawUpload` `{ rawPath, data }`, `PathNormalizer` `(rawPaths) => string[]`, `MoveResult` `{ type, from, to }`.
- `storageRoot(): string`. `path.resolve(process.cwd(), env.STORAGE_DIR)` (default `./storage`).
- `assertSafeId(id): void`. Requires `/^[A-Za-z0-9_-]+$/`, otherwise `AppError(400, 'VALIDATION_ERROR', 'Invalid id')`.
- `sanitizeRelative(input): string`. `\` to `/`, strips leading `/` and `.`/empty segments; rejects a drive letter (`C:`) and any `..` segment; rejects an empty path. Errors: `AppError(400, 'INVALID_ARCHIVE', ...)`.
- `commonWrapperSegment(paths): string | null`. First segment shared by all paths of depth ≥ 2.
- `confineJoin(root, relPath): string`. `path.resolve` then checks that the result is the root or starts with `root + path.sep`, otherwise 400 `INVALID_ARCHIVE`.
- `writeNormalizedAt(root, items, normalize): Promise<string[]>`. Normalizes, confines, `mkdir -p`, writes; returns the sorted unique paths.
- `extractArchiveAt(root, archive, normalize, maxUncompressedBytes = MAX_ARCHIVE_UNCOMPRESSED_MB MB): Promise<string[]>`. Parses the zip (400 `INVALID_ARCHIVE` if invalid or without files), sums the declared uncompressed sizes and throws 413 `ARCHIVE_TOO_LARGE` before any inflation (H9), then `writeNormalizedAt`.
- `comparePaths(a, b): number`. Segment-by-segment sort (keeps `0` and its children before `0.orig`).
- `listTree(root): Promise<FileEntry[]>`. Recursive walk, `[]` if the root does not exist.
- `treeIsEmpty`, `fileExistsAt`, `readFileAt` (null if missing), `writeFileAt` (creates the parents).
- `deleteFileAt(root, rel)`. `unlink` then pruning of empty parents (never the root).
- `deleteDirAt(root, rel)`. 404 `NOT_FOUND` ("Folder not found") if missing or a file; `rm -rf` then pruning.
- `moveAt(root, fromRel, toRel): Promise<MoveResult>`. 404 if the source is missing, 400 `VALIDATION_ERROR` if the destination is identical or a folder is moved into itself, 409 `FILE_EXISTS` if the destination exists; `rename` then pruning.
- `zipTreeAt(root): Promise<Buffer>`. Zip of files only.
- `clearTreeAt(root)`, `removeTreeAt(absDir)`. Forced recursive `fs.rm`.
**Depends on**: `adm-zip`, `config/env`, `AppError`. **Used by**: all `*Storage` facades, plus `meshing.service`, `files.service`, `templates.service`.
**Notes**: `sanitizeRelative` and `confineJoin` return the `INVALID_ARCHIVE` code even outside an archive context (reading or moving a file). `zipTreeAt` reads via `path.join(root, entry.path)` without re-confining (the paths come from `listTree`). `writeNormalizedAt` assumes a normalizer that is 1:1 with the entries (alignment by index).

## `apps/api/src/lib/jwt.ts`
**Role**: signing and verification of access JWTs (short-lived, `sub` + `role`) and refresh JWTs (long-lived, `sub` + `tokenVersion`, stored in an httpOnly cookie; a logout increments the version to revoke).
**Exports**:
- `TokenRole` (alias of `Role`), `AccessTokenPayload` `{ sub, role, type: 'access' }`, `RefreshTokenPayload` `{ sub, tokenVersion, type: 'refresh' }`.
- `signAccessToken({ sub, role }): string`. Secret `JWT_ACCESS_SECRET`, expiry `ACCESS_TOKEN_TTL`.
- `signRefreshToken({ sub, tokenVersion }): string`. Secret `JWT_REFRESH_SECRET`, expiry `${REFRESH_TOKEN_TTL_DAYS}d`.
- `verifyAccessToken(token)` / `verifyRefreshToken(token)`. `jwt.verify` then a shape and `type` guard; `AppError(401, 'UNAUTHENTICATED', ...)` otherwise.
**Depends on**: `jsonwebtoken`, `config/env`, `AppError`, `role.isRole`. **Used by**: `middleware/requireAuth.ts`, `middleware/requireRole.ts`, `modules/auth/auth.service.ts`, `modules/projects/terminal.gateway.ts`.
**Notes**: the `type` field prevents using a refresh token as an access token (on top of distinct secrets).

## `apps/api/src/lib/logger.ts`
Minimal dependency-free console logger: `logger.info` / `warn` / `error(message, ...args)` prefix an ISO timestamp and the level (`[INFO]`, `[WARN]`, `[ERROR]`) and delegate to `console.log` / `console.warn` / `console.error`. Also exports the `Logger` type. Used by `audit`, `middleware/errorHandler.ts`, `server.ts`, `meshing.service`, `runs.service`, `terminal.gateway`. Note: `streamRunner` writes directly via `console.error` without going through it.

## `apps/api/src/lib/meshBackupStorage.ts`
**Role**: single-slot backup of a project's case, to make mesh edits reversible (patch renaming/retyping, autoPatch, merge, BC application). The slot is taken automatically before the first modification (`original`) and can be overwritten manually (`manual`) or restored.
**Exports**:
- `readBackupMeta(projectId): Promise<MeshBackupInfo | null>`. Reads `backups/mesh-backup.json`; null if missing, unreadable or incomplete.
- `backupExists(projectId): Promise<boolean>`.
- `writeBackup(projectId, kind): Promise<MeshBackupInfo>`. Deletes `backups/case/`, then recursive `fs.cp` of `case/`; keeps the original `createdAt`, updates `updatedAt` and `kind`.
- `ensureOriginalBackup(projectId): Promise<void>`. `writeBackup(..., 'original')` only if there is no backup.
- `restoreBackup(projectId): Promise<void>`. `clearCase` then `fs.cp` from `backups/case/` to `case/`.
**Depends on**: `fileTreeStorage`, `caseStorage`. **Used by**: `boundary.service`, `mesh.service`, `meshes.service`.
**Notes**: not atomic (the comment says "atomically-enough"): a crash between deletion and copy leaves an empty or partial slot with the old `mesh-backup.json`. `restoreBackup` neither checks that the backup exists (the caller's job) nor rebuilds the render. `writeBackup` fails if `case/` does not exist (hence the guard in `meshes.service`).

## `apps/api/src/lib/meshImport.ts`
**Role**: converts a single mesh file (`.cgns` or Fluent/Gmsh `.msh`) into the `constant/polyMesh` of a target case, with a step report. Template-free core of mesh file import (mesh library).
**Exports**:
- `MeshFileFormat`. `'cgns' | 'msh'`.
- `meshFileFormat(name): MeshFileFormat | null`. By extension (case-insensitive).
- `convertMeshFileToCase(caseDir, srcAbs, format, workDir): Promise<MeshImportConversion>`. Creates `caseDir`, writes the missing `system/{controlDict,fvSchemes,fvSolution}` via `renderBaseFile`, then: CGNS: `CGNS_PYTHON_BIN CgnsToVtk.py <cgns> <workDir>/<stem>.vtk` (fails if the VTK is not produced), `vtkUnstructuredToFoam -case <caseDir> <vtk>`, `checkMesh`; MSH: `FLUENT_TO_FOAM_BIN <msh> -case <caseDir> [-scale s]`, `checkMesh`. Short-circuits with `skipped` steps. Does not throw on a tool failure.
**Depends on**: `commandRunner`, `openfoamCommand`, `openfoamCase.renderBaseFile`, `config/env`. **Used by**: `modules/projects/meshes.service.ts`.
**Notes**: env: `CGNS_PYTHON_BIN`, `CGNS_TO_VTK_SCRIPT` (otherwise `apps/api/scripts/CgnsToVtk.py`), `VTK_TO_FOAM_BIN`, `FLUENT_TO_FOAM_BIN`, `FLUENT_TO_FOAM_SCALE`, `CHECK_MESH_BIN`, `CONVERSION_STEP_TIMEOUT_MS` (per step). The Python step does not use the OpenFOAM bashrc. `tail`, `toStep`, `skipped`, `finalize` duplicate those in `meshPipelineRun`.

## `apps/api/src/lib/meshPatches.ts`
Pure, defensive parsing of the patch names of a cfMesh input surface, for the per-patch BC type editor. `parseFmsPatches(buffer): FmsPatch[]` reads the first 64 KB as latin1, finds `<n> ( name type name type … )` and returns up to `n` pairs `{ name, type }`. `parseStlSolidNames(buffer): string[]` returns the `solid <name>` names of an ASCII STL, and `[]` for a binary STL (detected by the exact size `84 + n*50`). No exception on malformed input. Also exports `FmsPatch`. Used by `modules/meshing/meshing.service.ts`.

## `apps/api/src/lib/meshPipelineRun.ts`
**Role**: plumbing shared by the snappyHexMesh and cfMesh pipelines: shape of the step report, short-circuiting sequential runner (buffered or streaming to a log), and a preliminary "Allclean".
**Exports**:
- `tail(text): string`. Keeps the last 20,000 characters with a `…(truncated)` prefix.
- `toStep(tool, label, display, result: CommandResult): ImportStep`. Status via `commandFailed`, appends `[runner] <spawnError>` or `[runner] command timed out` to stderr.
- `skipped(tool, label, display): ImportStep`, `finalize(steps): MeshImportConversion` (`success` if all steps succeed).
- `PlannedStep`. `{ tool, label, plan: PlannedCommand }`.
- `runSteps(steps, timeoutMs): Promise<ImportStep[]>`. `runCommand` per step; after a failure, the following steps are `skipped`.
- `StreamRunControls`. `{ onHandle?(handle | null), aborted?(): boolean }` for user stop.
- `runStepsStreaming(steps, timeoutMs, logFile, controls?): Promise<ImportStep[]>`. For each step: appends `\n=== label ===\n$ command\n` to the log, launches `runStream` (output appended to the log), exposes the handle, then re-reads the written byte slice to fill the step's `stdout`. Stops between steps if `aborted()`.
- `cleanPriorMeshArtifacts(caseDir): Promise<void>`. Deletes `constant/polyMesh`, all `processor<N>` and all purely numeric time folders; keeps `system/` and `constant/triSurface/`. Errors ignored.
**Depends on**: `commandRunner`, `openfoamCommand`, `streamRunner`. **Used by**: `snappyPipeline`, `cfMeshPipeline`, `meshing.service`.
**Notes**: in streaming mode, stdout and stderr are interleaved in the log; the step's `stderr` only contains the `[runner]` note. The Allclean avoids the `decomposePar` error "Size N is not equal to the expected length M" caused by a stale `cellLevel`.

## `apps/api/src/lib/meshSourceVizStorage.ts`
**Role**: 3D render cache of a mesh library source, under `projects/<id>/meshes/<meshId>/.viz/{patches.glb, manifest.json, edges.bin}`. Re-rooted copy of `vizStorage`; the hidden folder is ignored by `listMeshSources` and deleted with the source; only `constant/polyMesh` is copied during a merge, so the cache does not leak.
**Exports**:
- `MeshSourceVizPaths` `{ glb, manifest, edges }`, `StoredMeshSourceVizManifest` `{ patches, generatedAt }`.
- `meshSourceVizDir(projectId, meshId)`, `meshSourceVizPaths(projectId, meshId)`.
- `readMeshSourceVizGlb`, `readMeshSourceVizEdges` (Buffer or null), `readMeshSourceVizManifest` (array + ISO mtime, or null).
- `meshSourceVizIsStale(projectId, meshId): Promise<boolean>`. True if the GLB is missing, `edges.bin` is missing, or if the source's `constant/polyMesh/boundary` or `points` is newer than the GLB.
**Depends on**: `meshStorage`. **Used by**: `modules/projects/meshes.service.ts` (which runs `extractPatches.py`).

## `apps/api/src/lib/meshStorage.ts`
**Role**: reusable library of a project's imported polyMesh sources and transient merge workspace, under `projects/<id>/meshes/`. Each source is a mini OpenFOAM case (`constant/polyMesh` + `system/`) whose id is a readable, unique slug.
**Exports**:
- `MeshSourceKind` (`'folder' | 'zip' | 'cgns' | 'msh'`), `MeshMeta` `{ id, name, kind, createdAt }`.
- `meshDirAbsolute(projectId, meshId)` (ids validated + confined), `meshPolyMeshDir`, `meshSrcDir` (`<meshId>/.src`, upload and intermediate files), `meshWorkRoot` (`meshes/.work`).
- `normalizeMeshPaths(rawPaths): string[]`. Every path becomes `constant/polyMesh/<remainder after the last polyMesh segment>` (or the whole path if there is none). 1:1 with the input.
- `slugifyMeshName(name): string`. NFKD, diacritics removed, lowercase, non-alphanumeric runs to `-`, fallback `mesh`.
- `uniqueMeshId(projectId, name): Promise<string>`. Slug suffixed `-2`, `-3`… if the folder exists.
- `writeMeshMeta`, `readMeshMeta` (null if invalid; unknown `kind` coerced to `folder`), `meshSourceExists`.
- `importMeshFolder(projectId, name, files)` / `importMeshArchive(projectId, name, archive)`. Write the normalized tree then `meta.json`; return `MeshMeta`.
- `listMeshSources(projectId): Promise<MeshMeta[]>`. Non-hidden folders with a readable meta, sorted by ascending `createdAt` (default merge order).
- `readMeshBoundary(projectId, meshId)`. `constant/polyMesh/boundary` or null.
- `deleteMeshSource(projectId, meshId)`. `rm -rf` of the source folder.
- `readMergePlan` / `writeMergePlan`. `meshes/merge.json` (`MergePlan`).
- `readAppliedAssembly` / `writeAppliedAssembly` / `clearAppliedAssembly`. `meshes/assembly.json` (`AppliedAssembly`), written only after a successful merge promotion, cleared when the backup is restored.
- `resetMeshWork(projectId): Promise<string>`. Purges then recreates `meshes/.work`.
**Depends on**: `fileTreeStorage`. **Used by**: `meshSourceVizStorage`, `mesh.service`, `meshes.service`.
**Notes**: `uniqueMeshId` is not atomic (folder read then creation); two concurrent imports with the same name can target the same id. `merge.json` and `assembly.json` are read without schema validation (cast).

## `apps/api/src/lib/meshTransform.ts`
**Role**: in-process rigid transformation of a `constant/polyMesh/points` file (`p' = R·p + t`) to "bake" the placement of a part added during an assembly, with bit-for-bit parity with the browser's three.js preview (same `Matrix4.compose` formula, same order of operations, quaternion not renormalized). Chosen instead of OpenFOAM's `transformPoints` and Python (CEO decision, "ASSEMBLY_SPEC §1/§2e").
**Exports**:
- `isIdentityTransform(transform: PartTransform): boolean`. Rotation `(0,0,0,1)` and zero translation, compared strictly.
- `transformMeshPoints(pointsBuffer: Buffer, rotation: Quat, translation: Vec3): Buffer`. Detects `format binary` in the FoamFile header; ASCII: rewrites each `(x y z)` after the header with `String(n)` (shortest round-trip decimal); binary: locates the count then `(`, rewrites `count*3` little-endian doubles in a copy of the buffer. Throws `Error` if the parenthesis or the count cannot be found or if the buffer is too short. Pure.
**Depends on**: `@dive/shared` types. **Used by**: `modules/projects/meshes.service.ts`.
**Notes**: the cited `ASSEMBLY_SPEC` document is not tracked in the repository (to verify). The ASCII rewrite captures any parenthesized triplet after the header.

## `apps/api/src/lib/meshingStorage.ts`
**Role**: storage of standalone meshing sessions (STL to snappyHexMesh or cfMesh to polyMesh), under `<STORAGE_DIR>/meshing/<sessionId>/`, not tied to a project. The session folder is itself the OpenFOAM case. Also manages the streamed log and the lifecycle status of a background run.
**Exports**:
- `MeshingMeta` `{ id, name, engine, createdAt }`.
- `sessionDirAbsolute(sessionId)` (validated + confined), `sessionCaseDir` (identical), `triSurfaceDir`, `sessionPolyMeshDir`, `sessionSystemDir`.
- `slugifySessionName(name)` (fallback `session`).
- `createSession(name, engine): Promise<MeshingMeta>`. Unique id by slug (`-2`, `-3`…), writes `meta.json`.
- `renameSession(sessionId, name)`. Changes only the display name (id and folder stay stable); null if missing.
- `copySessionSetup(sourceId, name?)`. New session with the same engine, copy of `constant/triSurface/` and `config.json`; carries over neither `run.json`, polyMesh, `system/`, `.viz`, nor log/status. Throws `Error` if the source has no meta.
- `readMeta` (unknown or missing engine coerced to `snappy`), `listSessions` (most recent first, hidden folders ignored), `sessionExists`, `deleteSession` (`rm -rf`).
- `sanitizeStlName(rawName): string`. Basename, NFKD without diacritics, characters outside `[A-Za-z0-9._-]` to `_`, `.fms` extension kept, otherwise forced to `.stl`, fallback `surface`.
- `writeStl` (overwrites a file with the same name), `listStl` (`.stl` and `.fms`, sorted), `readStl`, `deleteStl` (boolean).
- `hasResultMesh(sessionId)`. Presence of `points`, `faces`, `owner`, `boundary` in the polyMesh.
- `writeRun` / `readRun`. `run.json` (`MeshingRun`).
- `meshLogAbsolute`, `truncateMeshLog`, `appendMeshLog`, `readMeshLog(sessionId, maxBytes)` (reads at most the last `maxBytes` bytes, returns `{ content, size }`).
- `writeMeshStatus(sessionId, state)`. Writes `status.json.tmp` then `rename` (atomic).
- `readMeshStatus(sessionId)`. Up to 5 attempts 5 ms apart (tolerance for transient ENOENT under WSL `/mnt/c`), then null.
- `listRunningSessionIds()`. Sessions whose persisted status is `running` (reconciliation at startup).
- `writeConfig` / `readConfig`. `config.json` autosaved from the form.
**Depends on**: `fileTreeStorage`, constants `FMS_EXTENSION` / `STL_EXTENSION` / `MESHING_ENGINES`. **Used by**: `meshingVizStorage`, `modules/meshing/meshing.service.ts`.
**Notes**: `writeStl` does not use `sanitizeRelative` but its own `sanitizeStlName` then `confineJoin`. The header comment does not mention `config.json`, `mesh.log` or `status.json` (they are documented further down in the file). Session access is not tied to a user at the storage level.

## `apps/api/src/lib/meshingVizStorage.ts`
**Role**: 3D render cache of a meshing session's resulting mesh, `meshing/<sessionId>/.viz/{patches.glb, manifest.json, edges.bin}`. Near-verbatim copy of `meshSourceVizStorage`.
**Exports**: `MeshingVizPaths`, `StoredMeshingVizManifest`, `meshingVizDir(sessionId)`, `meshingVizPaths(sessionId)`, `readMeshingVizGlb`, `readMeshingVizEdges`, `readMeshingVizManifest`, `meshingVizIsStale(sessionId)` (GLB or edges missing, or the resulting polyMesh's `boundary`/`points` newer than the GLB).
**Depends on**: `meshingStorage`. **Used by**: `modules/meshing/meshing.service.ts`.

## `apps/api/src/lib/openfoamCase.ts`
**Role**: purely textual OpenFOAM domain (no I/O). It defines the lists of required files, generates the `system/`, `constant/` dictionaries and the `0/` fields (generic skeleton or runnable case per solver, sensitive to the turbulence model), renders the BC presets per role and per DIVE component (turbine, pipe, draft tube, chamber), renders MRF / dynamicMesh / decomposeParDict, and provides tolerant parsers and surgical rewrites of `constant/polyMesh/boundary`, `cellZones` and the `boundaryField` blocks. Consumed by the file, mesh, BC and run services.
**Depends on**: `@dive/shared` (`CONSTRAINT_PATCH_TYPES`, `GRAVITY`, `OBJECT_TYPE_TURBULENCE`, `SOLVER_CATALOG`, `turbulenceFieldsFor`, `turbulenceWallBc`, types `BoundaryConditionValues`, `ConfigurableSolverId`, `DrivingMode`, `ObjectType`). **Used by**: `meshImport`, `snappyPipeline` and the services `boundary`, `files`, `mesh`, `meshes`, `runs`.
**Notes**: shared header `foamHeader(class, object, location)` ("Generated by DIVE Turbinen (generic minimal)") and `FOAM_FOOTER`. Component BC numbers go through `fmtFoamNumber` (`toFixed(6)` then `Number`). The file cites `docs/openfoam-fichiers-obligatoires.md` (missing from the repository) and `documents/*_BCs*.txt` (now under `documents/old/`).

### File lists and generic scaffold
- `MESH_FILES`. `constant/polyMesh/{points,faces,owner,neighbour,boundary}`: never generated, only reported as present or missing.
- `BOUNDARY_FILE`. `'constant/polyMesh/boundary'`.
- `BASE_FILE_PATHS` / `BaseFilePath`. `system/controlDict`, `system/fvSchemes`, `system/fvSolution`, `0/U`, `0/p` (no `constant/*Properties`, which depend on the solver).
- `renderBaseFile(path: BaseFilePath, patches: readonly PatchInput[]): string`. Generic, non-runnable skeleton: `application foamRun`, `divSchemes { default none; }`, shared `PBiCGStab` solver and empty SIMPLE; `0/U` and `0/p` with a `boundaryField` covering the patches (or a "No mesh patches detected yet" comment block if the list is empty).
- `PatchInput`. `string | BoundaryPatch`; a bare name is treated as type `patch`.

### Boundary conditions by role and by geometric type
- `fieldBcBody(fieldName: string, geometricType: string, model?: string): string`. Body of a `boundaryField` entry. Constraint type (`CONSTRAINT_PATCH_TYPES`: empty, symmetry, wedge, cyclic…): copied as is. `inlet`: `U` fixedValue 0, `p`/`p_rgh` zeroGradient, `nut`/`alphat` calculated, `k`/`epsilon`/`omega`/`nuTilda`/`R`/`T` fixedValue `$internalField`. `outlet`: `U` inletOutlet, `p` fixedValue 0, turbulence inletOutlet `$internalField`. `wall`: `U` noSlip, `p` zeroGradient, `alphat` `compressible::alphatWallFunction`, otherwise the model's wall function via `turbulenceWallBc` (with `value $internalField`), failing that zeroGradient. Any other type: zeroGradient.
- `ComponentInletOptions` `{ objectType, mode, values, model?, csvFields? }` and `ComponentOutletOptions` `{ objectType, mode, model? }`.
- `componentInletBc(fieldName, opts): string`. `U`: `timeVaryingMappedFixedValue` (`csvProfile` mode), `flowRateInletVelocity` with `volumetricFlowRate constant Q` (plus `extrapolateProfile false` for `chamber`) in `flowRate` mode, otherwise `pressureInletOutletVelocity`. `p`: in `pressure` mode, `totalPressure` with `p0 = GRAVITY * head` (plus `gamma 1` for `turbine` and `chamber`, never for `pipe`); otherwise zeroGradient. `k`: mapped if CSV and a `k` column, otherwise `turbulentIntensityKineticEnergyInlet` (user intensity or the component default). `omega`: mapped if CSV and column, otherwise `turbulentMixingLengthFrequencyInlet`. `epsilon`: `turbulentMixingLengthDissipationRateInlet` (`value uniform 0.1`). Other fields: generic inlet preset.
- `componentOutletBc(fieldName, opts): string`. `U`: `pressureInletOutletVelocity` only for `pipe` in `pressure` mode, otherwise inletOutlet. `p`: always fixedValue 0 (single static pressure anchor, draft tube included). `k` / `omega`: inletOutlet with the component's seed. Others: generic outlet preset.

### Runnable cases per solver (fvSchemes / fvSolution / controlDict)
- `SOLVER_FILE_PATHS` / `SolverFilePath`. `system/{controlDict,fvSchemes,fvSolution}`, `constant/{transportProperties,turbulenceProperties}`, `0/{U,p,k,omega,nut}`.
- `renderSolverFile(solver: ConfigurableSolverId, path: string, patches, model?): string`. Picks the variant from `SOLVER_CATALOG[solver].family` (incompressible or compressible) and `.regime` (steady or transient): simpleFoam, pimpleFoam, rhoSimpleFoam, rhoPimpleFoam. Also renders `constant/thermophysicalProperties` (air, perfect gas, `hePsiThermo`), absolute `0/p` (100000 Pa) for compressible, `0/T`, `0/k`, `0/omega`, `0/nut`, `0/epsilon`, `0/nuTilda`, `0/R`, `0/alphat`. Throws `Error('No solver-file renderer for <path>')` for an unknown path.
- Model-sensitive numerics: the transported fields are `turbulenceFieldsFor(model)` minus `nut` (default `k`/`omega` if the model is undefined, none for laminar/algebraic LES). They each get a `div(phi,<field>)` line (bounded Gauss upwind in steady, Gauss limitedLinear 1 in transient), a place in the regex key of the `U` linear solver, and `residualControl` / `relaxationFactors` entries. Steady: SIMPLE `consistent yes`, `pRefCell 0` (incompressible), residuals 1e-4 (1e-3 for compressible). Transient: `Euler`, PIMPLE `nOuterCorrectors 1`, `nCorrectors 2`, `"<field>.*"` solvers including the `Final` ones, relaxation `".*" 1`, controlDict `adjustTimeStep yes`, `maxCo 1`. `wallDist meshWave` in all runnable fvSchemes.

### Turbulence and decomposition
- `renderTurbulenceProperties(simulationType: 'laminar' | 'RAS' | 'LES', model): string`. `laminar`: only the `simulationType laminar;` line; `LES`: `LESModel` block with `delta cubeRootVol`; otherwise a `RAS { RASModel <model>; }` block.
- `renderDecomposeParDict(numberOfSubdomains, method = 'scotch'): string`. For `simple` or `hierarchical`, adds a coefficients block `n (x y z)` whose product is exactly the number of subdomains, chosen to minimize the max-min spread (fallback `(n 1 1)` if prime).

### Rotating machinery: MRF and dynamicMesh
- `RotorZoneOptions` `{ cellZone, origin, axis, omega (rad/s), nonRotatingPatches? }`.
- `renderMrfProperties(opts): string`. `constant/MRFProperties` with an `MRF1` block (Frozen Rotor, steady, simpleFoam).
- `renderDynamicMeshDict(opts without nonRotatingPatches): string`. Forced rotor: `dynamicFvMesh solidBodyMotionFvMesh`, `motionSolverLibs ("libfvMotionSolvers.so")`, `solidBodyMotionFvMeshCoeffs` with `rotatingMotion`.
- `SixDofRotorOptions` `{ patches, axis, centreOfMass, mass, momentOfInertia, rhoInf, innerDistance, outerDistance, damperCoeff }`.
- `renderDynamicMeshDictFree(opts): string`. Free rotor driven by the fluid: `dynamicMotionSolverFvMesh` + `sixDoFRigidBodyMotion`, Newmark solver, `axis` and `point` constraints (fixed center), `sphericalAngularDamper` damper, starting at rest.
- Note: the section comment mentions `dynamicMotionSolverFvMesh + solidBody` for the forced rotor whereas the code emits `solidBodyMotionFvMesh` (consistent with the function's comment and the `documents/dynamicMeshDict.forcedRotation` template).

### Tolerant parsing (`/* */` and `//` comments stripped)
- `parseApplication(controlDictContent): string | null`. Value of the `application` keyword.
- `parseTurbulenceModel(content): string | null`. `laminar`, otherwise `RASModel`, otherwise `LESModel`.
- `BoundaryPatch` `{ name, type }`, `BoundaryPatchDetail` `{ name, type, nFaces }`.
- `parseBoundaryPatches(content): string[]`. All `name {` names outside `FoamFile`, deduplicated.
- `parseBoundaryPatchesWithTypes(content): BoundaryPatch[]` and `parseBoundaryPatchDetails(content): BoundaryPatchDetail[]`. Same scan by matched blocks (`matchBrace`), default type `patch`, default `nFaces` 0.
- `parseCellZoneNames(content): string[]`. Blocks containing `type cellZone;` (zones created by `splitMeshRegions`, candidates for the rotor cellZone).
- `isValidPatchName(name): boolean`. `/^[A-Za-z_][A-Za-z0-9_-]*$/` (hyphen allowed for Fluent zones).

### Rewrites of `boundary`, `cellZones` and `boundaryField`
- `setApplication(content, solver): string`. Replaces the `application` line (indentation kept) or inserts it after the `// * * *` banner, otherwise at the top.
- `rebuildFieldBoundary(content, fieldName, patches, model?): string`. Replaces the whole `boundaryField` block with `fieldBcBody` entries covering exactly the patches (discards existing BCs).
- `mergeFieldBoundary(content, fieldName, patches, model?): string`. Conservative merge: keeps verbatim the entries whose patch still exists, always keeps quoted regex selectors, removes named entries of patches that are gone, adds a `fieldBcBody` default for each patch without an entry, and resets to the constraint type a kept entry whose patch has become a constraint (e.g. `cyclicAMI` after assembly coupling).
- `renameBoundaryPatch(content, from, to)` and `renameCellZone(content, from, to)`. Rename only a `from {` header (preceded by start, whitespace or `(`).
- `renameFieldBoundaryPatch(content, from, to)`. Same renaming restricted to the `boundaryField` block.
- `collapseBoundaryToSinglePatch(content, patchName = 'defaultFaces'): string`. A single patch with `startFace = min` and `nFaces = sum`, to rerun `autoPatch` from a clean base (`auto0` numbering).
- `removeEmptyBoundaryPatches(content): string`. Removes `nFaces 0` patches and renumbers the list (unchanged if there is nothing to remove).
- `setBoundaryPatchType(content, patch, type): string`. Replaces or inserts `type` in the patch block.
- `setCyclicAmiPair(content, aPatch, bPatch): string`. Rewrites both blocks as cross-referenced `cyclicAMI` (`neighbourPatch`, `transform noOrdering`) keeping `nFaces`/`startFace`; idempotent; replaces the `createNonConformalCouples` utility specific to the .org variant.
- `getFieldPatchType(content, patch): string | null`, `setFieldPatchType(content, patch, bcType)` (entry reduced to `type`), `setFieldPatchBc(content, patch, body)` (entry replaced by a multi-line body).
- `MIXING_LENGTH_INLET_FIELDS` (`['omega', 'epsilon']`), `MixingLengthInletField`.
- `carryTurbulenceInlet(content, newField, siblingContent, siblingField): string`. When switching from k-omega to k-epsilon (or the reverse), carries each mixing-length inlet of the sibling field over to the new field with the matching type, keeping `mixingLength` (default `0.01`) and a `value` seed (1 for omega, 0.1 for epsilon).
- Notes: these functions return the content unchanged when the target block or patch is missing (never an exception). The header regexes of `setBoundaryPatchType` and `setFieldPatch*` use `escapeRegExp`. `removeEmptyBoundaryPatches` assumes there are no nested braces in the patch blocks. `renderSolverFile('constant/turbulenceProperties')` always renders `kOmegaSST` (the chosen model is applied elsewhere via `renderTurbulenceProperties`).

## `apps/api/src/lib/openfoamCommand.ts`
**Role**: single invocation point for OpenFOAM utilities and single failure rule. If `OPENFOAM_BASHRC` is set, the tool runs inside `bash -c 'source "$OPENFOAM_BASHRC" && exec "$@"' bash <bin> <args…>`: the bashrc path goes through an environment variable and the arguments through argv, never interpolated into the script. Otherwise the tool is launched directly (assumed to be on the PATH).
**Exports**:
- `PlannedCommand`. `{ display, command, args, cwd, env }`; `display` is the logical line shown in the UI (`bin args…`).
- `planOpenfoamCommand(bin, args, cwd): PlannedCommand`.
- `commandFailed(result: CommandResult): boolean`. True if `spawnError`, `timedOut` or `exitCode !== 0`.
**Depends on**: `config/env`, `commandRunner` (type). **Used by**: `boundaryData`, `cfMeshPipeline`, `meshImport`, `meshPipelineRun`, `snappyPipeline` and the services `conversion`, `export`, `mesh`, `meshes`, `runs`.
**Notes**: for MPI, `snappyPipeline` passes `MPI_BIN` as `bin` and the OpenFOAM binary in the arguments.

## `apps/api/src/lib/password.ts`
`hashPassword(plain): Promise<string>` hashes with argon2id (library default parameters, salt included in the encoded hash). `verifyPassword(hash, plain): Promise<boolean>` returns `false` instead of throwing on a malformed hash. No plaintext password is ever stored or logged. Used by `auth.service` and `users.service`.

## `apps/api/src/lib/prisma.ts`
Exports `prisma`, the single `PrismaClient` of the API (avoids multiple SQLite connection pools). Used by `audit`, `middleware/requireAuth.ts` and the services `audit`, `auth`, `chamber-saves`, `dashboard`, `projects`, `runs`, `templates`, `users`, as well as `terminal.gateway`.

## `apps/api/src/lib/residualParser.ts`
**Role**: pure parser of an OpenFOAM solver log into a time series of initial residuals plus convergence or divergence signals. The same parser serves the live stream and the full catch-up, so a reload rebuilds exactly the live view.
**Exports**:
- `ParsedResiduals`. `{ samples: ResidualSample[], diverged, converged, foamError, lastTime }`.
- `parseResiduals(log): ParsedResiduals`. One sample per `Time = <n>` header (fallback index if not finite); for each `Solving for <field>, Initial residual = <v>` line: `nan`/`inf` (any case) sets `diverged` and does not record the point; a leading `(` is stripped (ESI vector residuals); a non-numeric token is ignored (not a divergence). `converged` on `solution converged in N iterations`; `foamError` on `FOAM FATAL`, `Floating point exception` or `#0 Foam::error`. Samples without values are discarded.
- `downsampleResiduals(samples, maxPoints = 4000)`. Keeps the recent half dense and decimates the history at a regular step.
**Depends on**: type `ResidualSample`. **Used by**: `modules/projects/runs.service.ts`.
**Notes**: only the initial residual is kept (the final one is a linear solver detail). Do not mark an unreadable token as "diverged": that caused false diagnoses on runs that had reached their maximum iteration count.

## `apps/api/src/lib/role.ts`
Re-exports `ROLES` and `Role` from `@dive/shared`. `isRole(value): value is Role` is a type guard; `toRole(value): Role` coerces any unexpected database value (SQLite stores `role` as a string) to `'USER'`. Used by `jwt`, `serializeUser`, `auth.service`, `projects.service`, `terminal.gateway`, `types/express.d.ts`.

## `apps/api/src/lib/runStorage.ts`
**Role**: storage of a project's solver runs, `projects/<id>/runs/<runId>/solver.log`. Logs are outputs, kept separate from the case so that a reset does not erase them; deleted with the project.
**Exports**:
- `runDirAbsolute(projectId, runId)`, `runLogAbsolute(projectId, runId)`. Ids validated, paths confined.
- `ensureRunDir(projectId, runId): Promise<string>`.
- `appendRunLog(projectId, runId, text): Promise<void>`. Best-effort (errors swallowed); used to trace decomposition and pre-solver tools.
- `runLogSize(projectId, runId): Promise<number>`.
- `readRunLog(projectId, runId, fromByte = 0, maxBytes = Infinity): Promise<{ content, size }>`. Reads from `fromByte` to the end but at most the last `maxBytes` bytes (H3: avoids allocating hundreds of MB per poll).
**Depends on**: `fileTreeStorage`, `RUN_DIRNAME` (`'runs'`). **Used by**: `modules/projects/runs.service.ts` (the solver itself writes to `solver.log` via `streamRunner`).
**Notes**: a read by byte offset can split a multi-byte UTF-8 character (accepted: ASCII logs). Hot-path callers pass `SOLVER_LOG_MAX_BYTES` (32 MiB by default).

## `apps/api/src/lib/serializeUser.ts`
`PublicUser` is the public shape of a user (`id`, `email`, `fullName`, `role`, `isProtected`, `isActive`, `lastLoginAt | null`, `createdAt`, `updatedAt` in ISO 8601). `toPublicUser(user: User): PublicUser` strips `passwordHash` and `tokenVersion` and normalizes the role via `toRole`. The front end depends on this shape. Used by `audit`, `requireAuth`, `auth.service`, `users.service`, `types/express.d.ts`.

## `apps/api/src/lib/snappyDicts.ts`
**Role**: pure renderings of a snappyHexMesh session's dictionaries (kept separate from the solver-oriented files of `openfoamCase`) and computation of the background domain from the STL bbox. The three minimal dictionaries are also reused by cfMesh.
**Exports**:
- `regionNameFor(stlFileName): string`. File stem reduced to an OpenFOAM word (`[A-Za-z0-9_]`, fallback `surface`).
- `SnappyDomain`. `{ boxMin, boxMax, counts, cellSize, locationInMesh }`.
- `computeDomain(bounds, config: SnappyConfig): SnappyDomain`. Cell size = `baseCellSize` or diagonal / 40; box = bbox enlarged by `marginFactor * diagonal`; counts clamped to [1, 500]; keep point = `config.locationInMesh`, otherwise the bbox center (`internal` domain) or a box corner slightly offset inward (`external` domain).
- `renderMeshingControlDict()` (`application snappyHexMesh`, `endTime 1`), `renderMeshingFvSchemes()`, `renderMeshingFvSolution()`: minimal versions sufficient for blockMesh, snappyHexMesh, checkMesh and cartesianMesh.
- `renderBlockMeshDict(domain)`. A single hexahedron, `domainBoundary` patch.
- `renderSurfaceFeatureExtractDict(stlNames, config)`. One `extractFromSurface` block per selected STL (empty or missing `featureSurfaces` = all), `includedAngle` per surface (`featureRefinements`) or global.
- `renderSnappyHexMeshDict(stlNames, domain, config)`. `geometry` (one `triSurfaceMesh` per STL, named by `regionNameFor`), `features` referenced by the verbatim stem of the `.eMesh` file, `refinementSurfaces` (per-surface or global level), layers on the chosen surfaces (`addLayers.surfaces`, empty = all) with `perSurface` overrides, `minThickness` = max(0.25 × `finalLayerThickness`, 1e-6), fixed quality controls (`maxNonOrtho 65`…).
**Depends on**: `@dive/shared` types. **Used by**: `snappyPipeline`, `cfMeshPipeline`.
**Notes**: documented pitfall: the region name is sanitized but the `.eMesh` file keeps the exact stem (hyphens included). Hard-coded castellation constants (`maxLocalCells 1000000`, `maxGlobalCells 5000000`).

## `apps/api/src/lib/snappyPipeline.ts`
**Role**: runs a session's snappyHexMesh pipeline and returns the step report. Serial: `blockMesh`, `surfaceFeatureExtract`, `snappyHexMesh -overwrite`, `checkMesh`. Parallel (cores > 1): `blockMesh`, `surfaceFeatureExtract`, `decomposePar -force`, `mpirun <MPI_RUN_FLAGS> -np N snappyHexMesh -overwrite -parallel`, `reconstructParMesh -constant`, `checkMesh`.
**Exports**:
- `runSnappyPipeline(caseDir, stlNames, bounds: MeshBounds, config: SnappyConfig, stream?): Promise<MeshImportConversion>`. `computeDomain`, `cleanPriorMeshArtifacts`, writing of `system/{controlDict,fvSchemes,fvSolution,blockMeshDict,surfaceFeatureExtractDict,snappyHexMeshDict}` (plus `decomposeParDict` via `renderDecomposeParDict(cores, DECOMPOSE_METHOD)` in parallel), streaming or buffered execution, then deletion of `processor0..N-1` only if `reconstructParMesh` succeeded (otherwise kept for debugging). Does not throw on a tool failure.
**Depends on**: `snappyDicts`, `openfoamCase.renderDecomposeParDict`, `meshPipelineRun`, `openfoamCommand`, `config/env`. **Used by**: `modules/meshing/meshing.service.ts`.
**Notes**: env: `BLOCK_MESH_BIN`, `SURFACE_FEATURE_BIN`, `SNAPPY_HEX_MESH_BIN`, `DECOMPOSE_PAR_BIN`, `RECONSTRUCT_PAR_MESH_BIN`, `CHECK_MESH_BIN`, `MPI_BIN`, `MPI_RUN_FLAGS` (default `--allow-run-as-root --use-hwthread-cpus --oversubscribe`, OpenMPI-specific), `DECOMPOSE_METHOD`, `SNAPPY_STEP_TIMEOUT_MS` (30 min by default, per step).

## `apps/api/src/lib/stlBounds.ts`
**Role**: pure TypeScript parsing of an STL into its axis-aligned bounding box, to size the snappy domain and the keep point without OpenFOAM.
**Exports**:
- `Bounds` `{ min, max }`, `StlParseResult` (`Bounds` + `triangleCount` + `valid`).
- `parseStlBounds(buffer): StlParseResult`. Binary if `length === 84 + n*50`, otherwise ASCII (`vertex x y z`). Non-finite coordinates ignored. Never throws: `valid: false` and box `[0,0,0]` if there are no vertices; `triangleCount = floor(vertices / 3)`.
- `unionBounds(boxes): Bounds | null`. Component-wise union; null if the list is empty or the result is not finite.
**Used by**: `modules/meshing/meshing.service.ts`.

## `apps/api/src/lib/stlMerge.ts`
**Role**: in-process merge of several STLs (ASCII or binary) into a single multi-solid ASCII STL, one solid (hence one cfMesh patch) per file.
**Exports**:
- `mergedSolidNames(fileNames): string[]`. Stem of each file reduced to an OpenFOAM word (NFKD, without diacritics, fallback `surface`), deduplicated by suffixing `_`. Lets the patch type editor know the names without running the merge.
- `mergeStlFilesToAscii(triSurfaceDirAbs, names, outAbs): Promise<{ triangles }>`. Reads each file, re-emits ASCII facets (normal recomputed from the winding if the stored one is zero or non-finite), writes `outAbs`. Throws `Error` if a file is unreadable or has no triangle.
**Used by**: `cfMeshPipeline`, `modules/meshing/meshing.service.ts`.
**Notes**: `isBinaryStl` is duplicated from `stlBounds`. Names are joined with `path.join` without confinement (they come from `listStl`, already sanitized).

## `apps/api/src/lib/streamRunner.ts`
**Role**: injectable, never-throwing runner for long processes (solver, streamed meshing steps). It `spawn`s the process, redirects stdout and stderr in append mode to a log file (observable live, bounded by disk, kept with no client connected) and immediately returns a handle.
**Exports**:
- `StreamSpec`. `{ command, args, cwd, env, logFile, timeoutMs? }`.
- `StreamExit`. `{ exitCode, signal, spawnError?, timedOut? }`.
- `StreamHandle`. `{ pid, onExit: Promise<StreamExit>, stop(signal = 'SIGTERM') }`.
- `StreamRunner`, `realStreamRunner`. `mkdirSync` of the log folder, `createWriteStream(flags: 'a')`, `spawn` with `windowsHide`, pipes without closing the stream, timeout that sends `SIGKILL`. A log write error (disk full, EIO) is caught: the pipes are detached and drained, the process continues until its natural end (C3: otherwise the whole API crashes).
- `setStreamRunner(runner | null)`, `runStream(spec): StreamHandle`.
**Depends on**: `node:child_process`, `node:fs`. **Used by**: `meshPipelineRun`, `meshing.service`, `runs.service`.
**Notes**: asymmetry with `commandRunner`: timeout via `SIGKILL` here, `SIGTERM` there. `stop()` swallows any error. Failure logging via direct `console.error`.

## `apps/api/src/lib/templateStorage.ts`
**Role**: `fileTreeStorage` facade for reusable file templates, `<STORAGE_DIR>/templates/<templateId>/files/<free tree>`. No OpenFOAM structure assumed.
**Exports**:
- `TemplateEntry` (alias `FileEntry`).
- `normalizeTemplatePaths(rawPaths): string[]`. Sanitization only: no wrapper removal or nesting ("what you import is what you get").
- `writeUploadedTemplateFiles`, `extractTemplateArchive` (400 / 413), `listTemplateTree`, `templateFileExists`, `readTemplateFile`, `writeTemplateFile`, `deleteTemplateFile`, `deleteTemplateDir`, `moveTemplatePath`, `clearTemplateFiles`, `removeTemplateStorage` (`rm -rf templates/<id>`).
**Depends on**: `fileTreeStorage`. **Used by**: `templates.service`, `users.service` (purge of a deleted user's templates).
**Notes**: doc/code inconsistency: the header comment announces removal of a common wrapper folder, whereas `normalizeTemplatePaths` does none (its own comment confirms it).

## `apps/api/src/lib/terminalSession.ts`
**Role**: an interactive shell session for the project terminal, independent of the transport (the WebSocket bridge is `terminal.gateway.ts`). Uses a real PTY if the optional `node-pty` dependency loads, otherwise a piped shell (no line editing or resizing).
**Exports**:
- `isPtyAvailable(): boolean`. Loads `node-pty` once via a guarded `require` (package missing or native binary not built = `null`).
- `TerminalSession`. `{ pty, write, resize, onData, onExit, kill }`.
- `createTerminalSession({ cwd, cols, rows, extraEnv? }): TerminalSession`. Shell = `TERMINAL_SHELL` if set, otherwise `powershell.exe -NoLogo` on Windows, otherwise `bash -i`. Env = `process.env` + `extraEnv` + `TERM=xterm-256color`. All operations become no-ops after the shell exits.
**Depends on**: `config/env`, `node:child_process`, `node-pty` (optional). **Used by**: `modules/projects/terminal.gateway.ts` (cwd = `projects/<id>` via `ensureProjectDir`).
**Notes**: in pipe mode, an `error` listener on stdin prevents an EPIPE after the shell dies from bringing down the API (H10). The shell is not confined to the project folder: it is full shell access as the API's system user.

## `apps/api/src/lib/vizStorage.ts`
**Role**: 3D render cache of a project's case mesh, `projects/<id>/viz/{patches.glb, manifest.json, edges.bin}`, produced by `scripts/extractPatches.py`. Sibling of `case/`: importing or resetting the case does not delete the render.
**Exports**:
- `VizArtifactPaths` `{ glb, manifest, edges }`, `StoredVizManifest` `{ patches, generatedAt }`.
- `vizDirAbsolute(projectId)`, `vizArtifactPaths(projectId)`.
- `readVizGlb`, `readVizEdges` (null for an old render without edges), `readVizManifest` (array `[{ name, type, nFaces }]` + ISO mtime).
- `vizIsStale(projectId): Promise<boolean>`. GLB or `edges.bin` missing, or `case/constant/polyMesh/{boundary,points}` newer than the GLB.
**Depends on**: `fileTreeStorage`, `caseStorage`, `VIZ_DIRNAME` (`'viz'`). **Used by**: `modules/projects/mesh.service.ts` (which runs `extractPatches.py` with `MESH_PYTHON_BIN` and `MESH_BUILD_TIMEOUT_MS`).
**Notes**: the header comment does not list `edges.bin`. Invalidation by mtime only: a change to other polyMesh files (`faces`, `owner`) without touching `boundary`/`points` does not refresh the render.
