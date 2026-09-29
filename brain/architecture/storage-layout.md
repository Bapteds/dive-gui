# Architecture: disk storage tree (`STORAGE_DIR`)

> Sources: `apps/api/src/lib/*Storage.ts`, `fileTreeStorage.ts`, `commandRunner.ts`, `streamRunner.ts`, `openfoamCommand.ts`, `terminalSession.ts`, and the calling services under `apps/api/src/modules/**`. Updated: 2026-09-28.
> Export-by-export detail: `brain/codemap/api-lib.md`.

## Root

`storageRoot()` (in `fileTreeStorage.ts`) is `path.resolve(process.cwd(), env.STORAGE_DIR)`, with `STORAGE_DIR` defaulting to `./storage`. The root therefore depends on the **current directory of the API process**: starting the API from another folder points to another storage. All binary or bulky business data lives here; the SQLite database (Prisma) only holds metadata (users, projects, runs, templates, audit, chamber saves).

Nothing under `STORAGE_DIR` is purged by a periodic job: deletion is always triggered by an action (entity deletion, reset, new run).

## Annotated tree

```text
<STORAGE_DIR>/
├── projects/<projectId>/                 project root (projectDirAbsolute), terminal cwd
│   ├── case/                             project OpenFOAM case (caseStorage)
│   │   ├── system/ constant/ 0/          case files (upload, scaffold, editor)
│   │   ├── constant/polyMesh/            mesh (import, conversion, merge, autoPatch)
│   │   ├── constant/boundaryData/<inlet>/  mapped CSV profile (boundaryData.ts)
│   │   ├── processor<N>/                 parallel decomposition (runs.service)
│   │   └── <time>/                       solver results (0.05, 100, ...)
│   ├── cgns/                             CGNS sources (cgnsStorage)
│   │   ├── <name>.cgns
│   │   └── <name>.vtk                    conversion intermediate (hidden from listing)
│   ├── meshes/                           mesh library (meshStorage)
│   │   ├── <meshId>/                     readable, unique slug (rotor, rotor-2, ...)
│   │   │   ├── meta.json                 { id, name, kind, createdAt }
│   │   │   ├── constant/polyMesh/*       source mesh
│   │   │   ├── system/*                  minimal dicts (file conversion)
│   │   │   ├── .src/                     upload + intermediate VTK (deleted after success)
│   │   │   └── .viz/{patches.glb, manifest.json, edges.bin}   render (meshSourceVizStorage)
│   │   ├── merge.json                    last MergePlan
│   │   ├── assembly.json                 AppliedAssembly (applied assembly)
│   │   └── .work/                        transient merge workspace (+ from-meshing-<ts>-<rand>/ staging)
│   ├── runs/<runId>/solver.log           solver log (runStorage)
│   ├── viz/{patches.glb, manifest.json, edges.bin}   case render (vizStorage)
│   ├── export/                           CFD-Post export (exportStorage)
│   │   ├── out.cgns | out_<i>.cgns       produced CGNS (one time or series)
│   │   ├── out_cgns.zip                  download archive
│   │   ├── convert.py                    copy of the conversion script
│   │   ├── profile.json  validation.json
│   │   ├── session.cse  LOAD_CFDPOST.md  REPORT.md
│   └── backups/                          single backup slot (meshBackupStorage)
│       ├── case/                         full copy of case/
│       └── mesh-backup.json              { createdAt, updatedAt, kind: original|manual }
├── templates/<templateId>/files/<free tree>   file templates (templateStorage)
├── meshing/<sessionId>/                  standalone meshing session = OpenFOAM case (meshingStorage)
│   ├── meta.json                         { id, name, engine, createdAt }
│   ├── config.json                       autosaved form config
│   ├── run.json                          last MeshingRun (step report)
│   ├── status.json                       run state (written via status.json.tmp + rename)
│   ├── mesh.log                          streamed mesher log
│   ├── constant/triSurface/<name>.stl|.fms   input surfaces
│   ├── system/*                          generated dicts (snappy, blockMesh, meshDict, ...)
│   ├── constant/polyMesh/*               resulting mesh
│   ├── .work/combined.stl|combined.fms   cfMesh scratch (STL merge, features)
│   ├── processor<N>/                     parallel snappy decomposition (temporary)
│   └── .viz/{patches.glb, manifest.json, edges.bin}   result render (meshingVizStorage)
└── chamber/<hash16>/                     global chamber generator cache (chamberStorage)
    ├── params.json                       resolved parameters (input of buildChamber.py)
    ├── chamber.glb                       render (one node per patch) = "built" marker
    ├── manifest.json                     MeshPatch[]
    ├── edges.bin                         float32 edge segments
    ├── warnings.json                     builder warnings
    ├── build-meta.json                   { stepHasVanes }
    └── exports/{chamber.stl, chamber.step, chamber-mirrored.step, trisurface.zip}
```

The folder names `viz`, `runs`, `export`, `chamber` come from shared constants (`VIZ_DIRNAME`, `RUN_DIRNAME`, `EXPORT_DIRNAME`, `CHAMBER_DIRNAME` in `packages/shared/src/index.ts`); `case`, `cgns`, `meshes`, `backups`, `templates`, `meshing`, `.work`, `.src`, `.viz` are hardcoded in the storage modules.

## Per-location detail

### `projects/<projectId>/`
- **Written by**: created lazily on the first write of a subfolder, or by `ensureProjectDir` (opening the project terminal in `terminal.gateway.ts`).
- **Lifecycle**: `removeProjectStorage(projectId)` (`rm -rf` of the whole subtree) when a project is deleted (`projects.service`) or when its owning user is deleted (`users.service`), best-effort (`.catch(() => undefined)`).

### `projects/<id>/case/`
- **Written by**: `caseStorage` (`writeUploadedFiles`, `extractArchive`, `writeCaseFile`, `moveCasePath`, `deleteCase*`) from `files.service`; the OpenFOAM tools launched with `-case <caseDirAbsolute>` (CGNS conversion in `conversion.service`, mesh actions in `mesh.service`, merge promotion in `meshes.service`, solver, `decomposePar` and `reconstructPar` in `runs.service`); `boundary.service` (`0/` fields); `convertCsvToBoundaryData` for `constant/boundaryData/<inlet>/{points, 0/U, 0/k?, 0/omega?}`; `restoreBackup`.
- **Read by**: the file editor, `vizStorage.vizIsStale` (mtime of `constant/polyMesh/{boundary,points}`), `extractPatches.py`, the solver, the CFD-Post export (`export.service` runs the conversion with `cwd` = case).
- **Format**: ASCII OpenFOAM dictionaries (or binary for an imported polyMesh).
- **Lifecycle**: `clearCase` (`rm -rf` of `case/` only) for the "Reset" action (`files.service.resetCase`) and in `restoreBackup`. `processor<N>/` are deleted after a successful `reconstructPar` (kept on failure). No atomicity: files are written in place.
- **Normalization on import**: `normalizeCasePaths` strips up to 4 common wrapper folders (never `system`, `constant`, `0`, `polyMesh`) and moves a bare `polyMesh/` under `constant/`.

### `projects/<id>/cgns/`
- **Written by**: `writeCgnsUpload` (sanitized basename, no subfolder); `CgnsToVtk.py` writes the intermediate `.vtk` alongside (`cgnsFileAbsolute`), in `conversion.service`.
- **Read by**: `conversion.service` (`.cgns` listing only, conversion).
- **Lifecycle**: `deleteCgnsFile`, `clearCgns`; survives a case reset.

### `projects/<id>/meshes/`
- **Written by**: `meshStorage.importMeshFolder` / `importMeshArchive` (tree normalized under `constant/polyMesh/`), `meshes.service` for a `.cgns`/`.msh` file (upload to `.src/source.<ext>`, then `convertMeshFileToCase(meshDir, src, format, .src)` which writes a minimal `system/` and `constant/polyMesh`), `writeMeshMeta`, `writeMergePlan`, `writeAppliedAssembly`, `resetMeshWork`.
- **Read by**: `listMeshSources` (non-hidden folders with a valid `meta.json`, ascending `createdAt` order), `readMeshBoundary`, `meshSourceVizStorage`, the merge.
- **Format**: `meta.json`, `merge.json`, `assembly.json` as compact JSON, read without schema validation (cast).
- **Lifecycle**:
  - `.src/` is deleted after a successful conversion; on failure, the whole source is deleted (`deleteMeshSource`).
  - `.work/` is purged and recreated at the start of each merge (`resetMeshWork`), then serves as a staging area (one case copy per part, points transformed by `meshTransform`).
  - `.work/from-meshing-<ts>-<rand>/constant/polyMesh` stages a meshing session's mesh sent to the project (`mesh.service.importMeshFromMeshing`): the `boundary` is edited there, then the polyMesh is copied into `case/` (`replaceCasePolyMesh`) or renamed into `meshes/<slug>/` (kind `meshing`, `meta.json` `origin.sessionId`); the staging dir is removed in a `finally`. A merge starting at the same time would purge it (no lock, single user assumed).
  - `assembly.json` is written only after a successful merge promotion, and cleared (`clearAppliedAssembly`) when the backup is restored.
  - `.viz/` lives in the source folder and disappears with it; only `constant/polyMesh` is copied during staging.
- **Pitfalls**: `uniqueMeshId` reads the folder then picks a free slug, without a lock: two simultaneous imports with the same name can collide. The id is the folder name and is never renamed.

### `projects/<id>/runs/<runId>/solver.log`
- **Written by**: `streamRunner` (solver stdout + stderr, `mpirun` included, in append mode) launched by `runs.service`; `appendRunLog` (best-effort) for `decomposePar` messages and pre-solver notes; `ensureRunDir`.
- **Read by**: `readRunLog(projectId, runId, fromByte, maxBytes)` for the live stream and catch-up, then `residualParser`.
- **Format**: ASCII text, read by byte offsets.
- **Lifecycle**: never purged individually; deleted with the project. Survives a case reset. Reads bounded to `SOLVER_LOG_MAX_BYTES` (32 MiB by default) on the hot path.

### `projects/<id>/viz/`
- **Written by**: `mesh.service.buildViz` (`MESH_PYTHON_BIN extractPatches.py <caseDir> <glb> <manifest>`, timeout `MESH_BUILD_TIMEOUT_MS`), which creates the folder; a missing GLB after exit 0 is treated as a failure (502 `MESH_BUILD_FAILED`).
- **Read by**: `readVizGlb`, `readVizManifest`, `readVizEdges`.
- **Lifecycle**: cache invalidated by `vizIsStale` (GLB or `edges.bin` missing, or `case/constant/polyMesh/{boundary,points}` newer than the GLB). Survives a case reset.

### `projects/<id>/export/`
- **Written by**: `export.service` via `writeExportFile` (`profile.json`, `validation.json`, `session.cse`, `LOAD_CFDPOST.md`, `REPORT.md`), copy of `convert.py`, `pvbatch FoamToCgns.py` conversion (overridable via `FOAM_TO_CGNS_SCRIPT`) which writes `out.cgns` or `out_<i>.cgns` (run with `cwd` = case), time merge `CgnsMergeTime.py` (`cwd` = export folder), `zipCgnsFiles` for `out_cgns.zip`.
- **Read by**: `export.controller` (downloads), `readExport*`, `listCgnsFiles` (numeric sort of the `out_<i>.cgns`).
- **Lifecycle**: `clearExport` (`rm -rf`) at the start of each new export; `exportFileExists` requires a size > 0.

### `projects/<id>/backups/`
- **Written by**: `writeBackup` (`rm -rf backups/case` then recursive `fs.cp` of `case/`, then `mesh-backup.json`); `ensureOriginalBackup` before the first modification (patch editing, autoPatch, BC application, merge); `writeBackup(..., 'manual')` on demand.
- **Read by**: `readBackupMeta`, `backupExists`, `restoreBackup` (`clearCase` then reverse copy).
- **Lifecycle**: a single slot; `createdAt` preserved across overwrites.
- **Atomicity**: none. A crash during `writeBackup` leaves a partial copy with an old `mesh-backup.json` still present; a crash during `restoreBackup` leaves an empty or partial `case/`.

### `templates/<templateId>/files/`
- **Written by**: `templateStorage` from `templates.service` (folder upload, zip, editing, move).
- **Normalization**: `normalizeTemplatePaths` only sanitizes (no wrapper stripping, contrary to what the file header claims).
- **Lifecycle**: `removeTemplateStorage` (`rm -rf templates/<id>`) when the template or its owner is deleted (best-effort); `clearTemplateFiles`.

### `meshing/<sessionId>/`
- **Written by**: `meshingStorage` (`createSession`, `writeConfig`, `writeStl`, `writeRun`, `writeMeshStatus`, `truncateMeshLog`, `appendMeshLog`) from `meshing.service`; `snappyPipeline` / `cfMeshPipeline` (`system/*` dicts, `.work/`, `processor<N>/`, mesh); the OpenFOAM tools via `runStepsStreaming`, which appends to `mesh.log`; `extractPatches.py` for `.viz/`.
- **Read by**: `listSessions` (most recent first), `readMeta`, `readConfig`, `readRun`, `readMeshLog(sessionId, maxBytes)` (bounded tail), `readMeshStatus` (5 attempts, 5 ms apart), `hasResultMesh` (`points`, `faces`, `owner`, `boundary`), `meshingVizIsStale`.
- **Lifecycle**:
  - A run starts with `truncateMeshLog`, `writeMeshStatus('running')`, then `cleanPriorMeshArtifacts` (deletes `constant/polyMesh`, `processor*`, numeric time folders; keeps `system/` and `constant/triSurface/`).
  - Parallel snappy: `processor0..N-1` deleted only if `reconstructParMesh` succeeds.
  - On API startup, `listRunningSessionIds` finds the sessions left `running`; `meshing.service` marks them failed and appends "Interrupted by a server restart" to the log.
  - `copySessionSetup` copies only `constant/triSurface/` and `config.json` (never log, status, run, polyMesh, `system/`, `.viz`).
  - `renameSession` only changes `meta.json`; `deleteSession` does `rm -rf`.
- **Atomicity**: only `status.json` is written atomically (`status.json.tmp` then `rename`), because the log endpoint rereads it while the finalizer rewrites it.
- **Lock**: `meshing.service` holds an in-memory registry `activeMeshRuns` (per session, in this process); no file lock.
- **Not tied to a project or a user** at the storage level.

### `chamber/<hash>/`
- **Key**: `chamberHash(params)` (SHA-1 of the JSON of the sorted key/value pairs, 16 hex). Identical parameters reuse the build; no mtime-based expiry.
- **Written by**: `writeChamberParams` then `CHAMBER_PYTHON_BIN buildChamber.py <params.json> <dir>` (GLB, manifest, edges, exports, `build-meta.json`); `buildChamber.py ... --step` to generate `exports/chamber.step` on demand; `mirrorStep.py <src> <dst>` for `chamber-mirrored.step` (only if `stepHasVanes === true`); `writeChamberWarnings` merges the warnings.
- **Read by**: `chamber.service` (`chamberGlbExists` as the cache test, `readChamber*`), `meshing.service` (chamber to meshing transfer: reads `exports/trisurface.zip` via `readChamberExport`).
- **Lock**: `withChamberLock(hash)` in `chamber.service`, a promise chain per hash: the cache test and the build happen under the lock, so two identical builds cannot write the same folder in parallel; on-demand STEP generation rechecks under the lock. Reads are lock-free.
- **Lifecycle**: no purge in the code read; the cache grows with each distinct parameter set (to verify whether a purge exists elsewhere).

## Path safety rules

All implemented in `apps/api/src/lib/fileTreeStorage.ts` and used by the facades:

1. **Ids as path segments**: `assertSafeId(id)` requires `/^[A-Za-z0-9_-]+$/` (otherwise 400 `VALIDATION_ERROR`). Applied to `projectId`, `templateId`, `meshId`, `runId`, `sessionId` and the chamber hash before any `path.join`.
2. **Relative paths**: `sanitizeRelative(input)` converts `\` to `/`, strips leading `/` and `.` or empty segments, rejects a drive letter (`C:`), any `..` segment and an empty path (400 `INVALID_ARCHIVE`).
3. **Confinement**: `confineJoin(root, rel)` resolves the path and checks that it is the root or starts with `root + path.sep` (400 `INVALID_ARCHIVE` otherwise). All `*At` primitives apply `sanitizeRelative` then `confineJoin`.
4. **Zip-slip**: `extractArchiveAt` passes each `entryName` through the normalizer (which sanitizes) then through `confineJoin` in `writeNormalizedAt`. Directory entries are ignored.
5. **Zip-bomb**: `extractArchiveAt` sums the declared uncompressed sizes (`entry.header.size`) before inflating and throws 413 `ARCHIVE_TOO_LARGE` beyond `MAX_ARCHIVE_UNCOMPRESSED_MB` (2048 MB by default), reference H9.
6. **Flattened names**: `cgnsBaseName` (basename + sanitization), `sanitizeStlName` (basename, charset `[A-Za-z0-9._-]`, extension forced to `.stl` except `.fms`, then `confineJoin`), `slugifyMeshName` / `slugifySessionName` (slug always compliant with `assertSafeId`).
7. **Moves**: `moveAt` refuses to move a folder into itself or a descendant, and to overwrite an existing destination (409 `FILE_EXISTS`).
8. **Pruning**: `deleteFileAt`, `deleteDirAt`, `moveAt` delete parents that became empty, walking up to the root, never beyond.

Deviations to know: `exportStorage` uses only `assertSafeId` (fixed file names, no `confineJoin`); `zipTreeAt` and `stlMerge` join names already coming from a listing or a sanitization without re-confining; the error code `INVALID_ARCHIVE` is returned even for a simple read or a move.

## Command execution rules

1. **Argv, never a shell**: `commandRunner` uses `execFile`, `streamRunner` uses `spawn`, both with an argument array. Names derived from uploads are never interpreted by a shell.
2. **OpenFOAM environment**: `planOpenfoamCommand(bin, args, cwd)` returns, if `OPENFOAM_BASHRC` is set, `bash -c 'source "$OPENFOAM_BASHRC" && exec "$@"' bash <bin> <args…>` with `OPENFOAM_BASHRC` passed as an environment variable: neither the bashrc path nor the arguments are interpolated into the script. Otherwise the binary is launched directly from the PATH. The Python scripts read in this scope (`CgnsToVtk.py` via `meshImport`, `csv_to_boundaryData.py`, and on the services side `extractPatches.py`, `buildChamber.py`, `mirrorStep.py`) are launched directly with their configured interpreter via `runCommand`, without bashrc (the launch mode of `pvbatch` in `export.service` is to verify). MPI goes through `planOpenfoamCommand(MPI_BIN, [...MPI_RUN_FLAGS, '-np', N, <bin>, ..., '-parallel'])`.
3. **Configurable binaries**: each tool has its variable (`CHECK_MESH_BIN`, `BLOCK_MESH_BIN`, `SNAPPY_HEX_MESH_BIN`, `CARTESIAN_MESH_BIN`, `VTK_TO_FOAM_BIN`, `FLUENT_TO_FOAM_BIN`, `MPI_BIN`, `MESH_PYTHON_BIN`, `CGNS_PYTHON_BIN`, `CHAMBER_PYTHON_BIN`…) and each script a path override (`*_SCRIPT`), otherwise `apps/api/scripts/<script>` resolved from `__dirname`.
4. **Never an exception for a process result**: missing binary (`ENOENT`), non-zero exit, timeout and buffer overflow become `spawnError` / `exitCode` / `timedOut`. `commandFailed` is the single failure rule. Pipelines return an `ImportStep[]` report with short-circuit (`skipped` after the first failure); on a Windows machine without OpenFOAM, each step cleanly reports "not found".
5. **Timeouts**:
   - `commandRunner`: `execFile` `timeout` (SIGTERM), `maxBuffer` 16 MB, stdout and stderr truncated to a 20,000-character tail in reports.
   - `streamRunner`: `SIGKILL` at the deadline.
   - Default values: `CONVERSION_STEP_TIMEOUT_MS` 10 min, `CSV_TO_BOUNDARY_TIMEOUT_MS` 10 min, `MESH_BUILD_TIMEOUT_MS` 10 min, `CHAMBER_BUILD_TIMEOUT_MS` 10 min, `MERGE_STEP_TIMEOUT_MS` 10 min, `SNAPPY_STEP_TIMEOUT_MS` 30 min, `CFMESH_STEP_TIMEOUT_MS` 30 min, `SOLVER_DECOMPOSE_TIMEOUT_MS` 30 min, `SOLVER_MAX_RUNTIME_MS` 6 h. Pipeline timeouts apply per step.
6. **Long-running processes (`streamRunner`)**: output redirected in append mode to a log file (`solver.log`, `mesh.log`) instead of being buffered; immediate handle (`pid`, `onExit` which never rejects, `stop(signal)`). A log write error is caught (C3): the process continues, its pipes are drained. `runStepsStreaming` writes a `=== label ===` + `$ command` header per step and rereads the corresponding byte range for the report; `controls.aborted()` and `onHandle` allow user stop.
7. **Injectability**: `setCommandRunner` and `setStreamRunner` replace the runners in tests (`null` restores the real one).
8. **Parallelism**: `coreBudget()` (`SOLVER_TOTAL_CORES` or the number of logical cores) bounds the cores of solver runs and snappy/cfMesh sessions; cfMesh uses `OMP_NUM_THREADS`, snappy and the solver use `decomposePar` + `mpirun`. `runs.service` serializes run admission with an in-memory FIFO lock (`runExclusive('startRun')`, H2).
9. **Project terminal**: `createTerminalSession` launches `TERMINAL_SHELL` or `bash -i` (`powershell.exe -NoLogo` on Windows) with `cwd` = `projects/<id>` and `OPENFOAM_BASHRC` exported (not sourced automatically). It is a full shell not confined to the project folder; `node-pty` is optional (fallback to pipes, with an EPIPE guard, H10); inactivity is cut off by `TERMINAL_IDLE_TIMEOUT_MS` (15 min by default) on the gateway side.

## Locks and concurrency (summary)

| Resource | Mechanism | Scope |
|-----------|-----------|--------|
| `chamber/<hash>/` | `withChamberLock` (promise chain per hash) | API process |
| Solver run start | `runExclusive('startRun')` + `handles` / `stopRequested` | API process |
| Meshing run | `activeMeshRuns` (Map per session) + atomic `status.json` | API process; reconciled at boot |
| `meshes/.work/` | purge at merge start, no lock; `from-meshing-*` staging has a unique name | none |
| `backups/` | none | none |
| Slug ids (`meshes/<id>`, `meshing/<id>`) | read then pick, no lock | none |

All locks are in memory: they assume a **single instance** of the API.
