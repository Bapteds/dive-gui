# Feature · CFD-Post export (OpenFOAM to CGNS)

> **Status**: in production, with points to validate on the Debian server (C1, H7) · **Updated**: 2026-09-28
> **Specs**: no dedicated spec in `brain/specs/` (decisions tracked in `brain/changelog/2026-06.md`: « Onglet Export », « Pivot », « Re-pivot ») · **Codemaps**: `brain/codemap/web-features-platform.md` (section `features/export`), `brain/codemap/api-projects.md` (`export.*`), `brain/codemap/api-lib.md` (`exportStorage`), `brain/codemap/api-scripts.md` (`FoamToCgns.py`, `CgnsMergeTime.py`, `CgnsInspect.py`), `brain/codemap/root-shared-mcp.md` (solver runs and CFD-Post export)

## 1. Purpose

Converts a solved OpenFOAM case into a CGNS file that the user opens in Ansys CFD-Post (without going through Fluent), together with a CFD-Post `.cse` session, a load memo and a report. By default, the whole time series is merged into **a single transient CGNS** that CFD-Post plays on its timeline. Data stay cell-centered and polyhedra are not decomposed. Access: any visible member of the project; an invisible project returns 404.

## 2. User journey

- `Export` tab of `/projects/:id` (`ExportTab`, lazy-loaded; trigger disabled while the case has no `constant/polyMesh/`).
- No export: `EmptyState` "No export yet". During the export, before any step has been received: `RunningState` (`role="status"`). The request is synchronous: the button stays in `loading` until all 4 steps are done.
- Single action: `Export to CGNS`, or `Re-export` if a CGNS already exists. Network or access error: toast "Could not run the export.".
- Report (`PipelineReport`): 4 numbered rows (`Inspect case`, `Convert to CGNS`, `Validate the CGNS`, `CFD-Post session`) with a status pill (`OK`, `Caveat`, `Failed`, `Skipped`), exit code, duration, and `LogDisclosure` (command, stdout, stderr; open by default on failure).
- `ProfileCard`: solver, kinematic or Pa pressure, last solved time, turbulence model, fields, patches, excluded empty patches.
- `ValidationCard`: `pass` / `fail` / `info` checks.
- `Downloads`: one button per available artifact (`CGNS (transient)`, `CFD-Post session`, `Load memo`, `Report`), per-button spinner, toast "Could not download that file." on error.
- `CfdPostMemo`: reminders (`Load Results`, a single transient CGNS, pressure p/ρ if incompressible, empty patches excluded).

## 3. Business rules and invariants

- **A result is required**: `inspect` fails ("No solved results to export…") if no numeric time directory > 0 exists; the following steps are then `skipped`.
- **Time directories**: regex `TIME_DIR_RE` = `^\d+(\.\d+)?([eE][+-]?\d+)?$`, so scientific notation (`1e-05`, `2.5e+03`) is accepted (M16). Comparisons are always numeric.
- **Numeric sort of the series** (C1): `out_<i>.cgns` is sorted by numeric index (`out_2` before `out_10`) via `seriesIndex`; `exportStorage.listCgnsFiles` applies the same sort.
- **Real times via sidecar** (C1): `FoamToCgns.py` writes `out.cgns.times` (ParaView's `TimestepValues`, index aligned with `_<i>`); the API uses it if every index of the series has a value there, otherwise it falls back to a numeric scan of the case time directories. If the time list does not match the number of files, `CgnsMergeTime.py` numbers 0..N-1.
- **Multi-zone merge** (H7): every zone carrying a `FlowSolution_t` is animated (`FlowSolution0..N-1`, `ZoneIterativeData`, `FlowSolutionPointers`), matched by zone name with a positional fallback; `BaseIterativeData` + `TimeValues`, `SimulationType = TimeAccurate` added if missing.
- **`EXPORT_ALL_TIMES`** (default `true`): full series then merge. At `false`: only the last solved time, written to `out.cgns`.
- **Best-effort merge**: success (exit 0 and `out.cgns` present): the series and the sidecar are deleted. Failure: `out_cgns.zip` of the series, and the last file of the series is used for validation.
- **Statuses**: `inspect` becomes `warning` (non-blocking) if `checkMesh` fails (unknown polyhedra). Validation is `fail` as soon as one check fails, but the `cfdpost` step still runs. Global `success` = all steps `success` or `warning`.
- **An export deletes the previous one** (`clearExport`); it never touches the case, and a case reset does not delete the export.
- **Case profile** (`CaseProfile`): solver read from `controlDict` (local regex), `steady` if the solver is in `STEADY_SOLVERS` (simpleFoam, rhoSimpleFoam, porousSimpleFoam, SRFSimpleFoam, potentialFoam, adjointShapeOptimizationFoam), compressible if `constant/thermophysicalProperties` exists or if the solver starts with `rho`, `sonic` or `compressible`, model read from `momentumTransport` then `turbulenceProperties`, patches and empty patches (`nFaces 0`), guesses `inletGuess` / `outletGuess` (name containing "inlet" / "outlet").
- **Validation checks**: "Fields present", "Cell-centred data", "Mesh non-empty", "No empty zones" (pass/fail) and "Velocity max (|U|)" (info, first leaf that provides a velocity).
- **CGNS download**: the controller serves `out.cgns` (`application/octet-stream`) if it exists, otherwise `out_cgns.zip` (`application/zip`); a missing artifact returns 404, an unknown artifact 422.

## 4. Technical flow

### Trigger
`ExportTab` → `useRunExport` → `POST /api/v1/projects/:id/export` → `runExportController` → `runExport(viewer, id)`: `assertProjectVisible`, `clearExport` + `ensureExportDir`, then the 4 steps. On HTTP success, `onSuccess` writes `{ profile, validation, artifacts }` into `['projects', id, 'export']` via `setQueryData` (no invalidation); the mutation also resolves when `result.success` is false.

### Step 1, `inspect`
`latestSolvedTime` (largest time directory > 0 and its field files) → reads `controlDict`, `thermophysicalProperties`, `momentumTransport`/`turbulenceProperties`, `constant/polyMesh/boundary` → `checkMesh -case <dir> -latestTime` (via `planOpenfoamCommand`) only to count polyhedra → `profile.json`.

### Step 2, `convert`
Creates `case.foam` in the case, resolves the script (`FOAM_TO_CGNS_SCRIPT` or `apps/api/scripts/FoamToCgns.py`) and copies a version of it to `export/convert.py`. Command, with `cwd` = case:
- `PVBATCH_XVFB=true` (default): `xvfb-run -a <PVBATCH_BIN> FoamToCgns.py <case.foam> <export/out.cgns> <all|last time> <fields>`;
- otherwise: `<PVBATCH_BIN> --force-offscreen-rendering FoamToCgns.py …`.
`PVBATCH_PYTHONPATH` is prepended to `PYTHONPATH` (so that ParaView's VTK shadows a pip `vtk` wheel). This launch does not go through `OPENFOAM_BASHRC`. The script (`paraview.simple`, `OpenFOAMReader`, polyhedra not decomposed, all available cell arrays enabled) writes in **HDF5** (`UseHDF5=1`, required by the h5py merge): `out_<i>.cgns` + `out.cgns.times` in `all` mode, `out.cgns` otherwise. `OK:` / `KO:` contract.
Then, if a series exists: numeric sort, times (sidecar or scan), `MESH_PYTHON_BIN CgnsMergeTime.py <out.cgns> <t0,t1,…> <out_0.cgns> …` with `cwd` = export directory (no override variable for this script). Success: series and sidecar deleted. Failure: `zipCgnsFiles` then a `[merge] WARNING…` note in the step stdout. The step fails if no CGNS is produced; the diagnostics add an xvfb hint (missing binary) and the pip VTK / ParaView conflict.

### Step 3, `validate`
`MESH_PYTHON_BIN CgnsInspect.py <cgns>` (script `CGNS_INSPECT_SCRIPT` or bundled, `vtkCGNSReader` reader from the `vtk` wheel) → last JSON line (`cellArrays`, `pointArrays`, `nZones`, `nCells`, `nPoints`, `emptyZones`, `velocityMax`) → checks → `validation.json`.

### Step 4, `cfdpost`
`session.cse` (`renderSessionCse`: `load filename=out.cgns`, velocity contour on `/DOMAIN`, `massFlow()` expressions on the guessed inlet and outlet) and `LOAD_CFDPOST.md` (`renderLoadMemo`, in French). `finalize` writes `REPORT.md` and computes the artifacts (`cgns` true if the zip or `out.cgns` is non-empty).

### Persistent status
`useExportStatusQuery` → `GET /projects/:id/export` → `getExportStatus`: `profile.json`, `validation.json` and artifacts re-read from disk, or `null` if there is neither a profile nor a CGNS.

### Download
`downloadArtifact` → `GET /projects/:id/export/download/:artifact` (`cgns`, `session`, `memo`, `report`) as an authenticated Blob → temporary anchor named after `ARTIFACT_FILENAMES` (`out.cgns`, `session.cse`, `LOAD_CFDPOST.md`, `REPORT.md`) → `revokeObjectURL`. Server headers: `Content-Disposition: attachment`, `Cache-Control: private, max-age=0, must-revalidate`.

## 5. Data and storage

No Prisma model. Everything lives under `STORAGE_DIR/projects/<id>/export/` (constants `EXPORT_FILES`): `out.cgns` or `out_<i>.cgns` (+ transient `out.cgns.times`), `out_cgns.zip`, `convert.py`, `profile.json`, `validation.json`, `session.cse`, `LOAD_CFDPOST.md`, `REPORT.md`. The `case/case.foam` file is created in the case. `exportFileExists` requires a size > 0. `exportStorage` only uses `assertSafeId` (fixed names). Web cache: `['projects', id, 'export']`, also refreshed by any invalidation of the `['projects', id]` prefix.

## 6. Configuration and external dependencies

- `PVBATCH_BIN` (default `pvbatch`), `PVBATCH_XVFB` (`true`: `xvfb-run -a` mandatory on a server without GL; `false` only for an OSMesa ParaView), `PVBATCH_PYTHONPATH` (ParaView's `vtkmodules` directory in case of a `PyVTKObject` SIGSEGV when importing `paraview.simple`).
- `FOAM_TO_CGNS_SCRIPT`, `CGNS_INSPECT_SCRIPT` (overrides), `EXPORT_ALL_TIMES` (`true`), `CONVERSION_STEP_TIMEOUT_MS` (10 min per command), `CHECK_MESH_BIN`, `OPENFOAM_BASHRC` (for `checkMesh` only).
- `MESH_PYTHON_BIN`: must have `h5py` and `numpy` (merge) and the `vtk` wheel (validation). Without h5py, the merge exits with `KO:` and the export falls back to the zip.
- Debian packages: `paraview`, `xvfb` (README §5.4).
- `FOAM_DICTIONARY_BIN` and `POST_PROCESS_BIN` are declared in `env.ts` but never read.
- Missing tool: `failed` step with the runner's message (and the xvfb hint), never an exception.

## 7. Tests

- `apps/api/tests/export.test.ts`: 4 steps in order, profile (`simpleFoam`, `steady`, `incompressible`, `latestTime`, fields, patches, `inletGuess`), validation `pass`, artifacts; `inspect` failure without a solved time; `convert` failure when pvbatch writes nothing; `null` status before any export; download of the merged `out.cgns`; fallback to `out_cgns.zip` when the merge fails; 404 and 422; 404 invisible project. "C1" test with 12 frames: numeric order passed to `CgnsMergeTime.py` and times read from the sidecar. Fake runner dispatched on `checkMesh` and on script names in the arguments.
- No test for `ExportTab` / `useExport` (K30), and no Python test for the export scripts.

## 8. History

- 2026-06-25: OpenFOAM to CGNS Export tab (4-step pipeline, xvfb, `PVBATCH_PYTHONPATH`, zipped series); pivot to EnSight (`foamToEnsight`) then re-pivot the same day back to CGNS, with merge into one transient CGNS via `CgnsMergeTime.py` and switch of `FoamToCgns.py` to HDF5 (`brain/changelog/2026-06.md`).
- 2026-06-29: diagnosis of the empty timeline in CFD-Post (`pTotal` functionObject of the template without `writeControl`, fix on the server template side) and restoration of `stopAt endTime` when launching a run.
- 2026-07-10: v1.0.1 fixes C1 (numeric sort + time sidecar), M16 (scientific notation), H7 (all zones animated) (`brain/changelog/2026-07.md`).

## 9. Known limits and bugs

- **C1** ⚠️ fixed, to validate on the server: the `FoamToCgns.py` code does write `out.cgns.times` (best-effort, write error ignored); it remains to confirm with the production ParaView that `FileNameSuffix="_%d"` indexes the steps in the order of `TimestepValues`.
- **H7** ⚠️ fixed, to validate: open an assembly with at least 2 zones in CFD-Post and check that all of them animate.
- **M11**: leaving the Export tab during an export loses the in-progress state (invites launching a concurrent export).
- **M19**: `CgnsInspect.py` can segfault on a corrupted CGNS. **M20**: downloads buffered in memory (server and client).
- **K7**: the `readArtifacts` comment says the CGNS download "is the zip" whereas the controller prefers `out.cgns`. **K9** / **L21**: the `FoamToCgns.py` docstring announces ADF whereas the code writes HDF5; `fields` argument ignored (all fields are written); `velocityMax` on the first zone only. **K10**: `CgnsMergeTime.py` checks h5py before the number of arguments. **K28**: `ExportTab` shows neither loading nor error for the status query. **K29**: two homonymous `listCgnsFiles` (`cgnsStorage`, `exportStorage`).
- **Merge failing after the copy** (reading finding, not reproduced): `CgnsMergeTime.py` first copies the first step into `out.cgns` and then modifies it; if it then fails, `out.cgns` stays on disk and the API does not delete it. The controller would then serve this partial `out.cgns` instead of the fallback zip. The fallback test does not cover this case (the fake runner does not write `out.cgns` on failure).
- **Fallback zip name** (reading finding): when the server serves `out_cgns.zip`, the front still names the file `out.cgns` (`ARTIFACT_FILENAMES`), because the anchor's `download` attribute takes precedence.
- The export request is synchronous: a large case can exceed a reverse proxy's timeouts (each command has its own 10-min timeout by default).
- Misleading labels: the `Inspect case` row of the UI and the command of the failure step cite `foamDictionary`, which is never invoked.

### Points to validate on the Debian server
1. `xvfb-run` and `pvbatch` present; `paraview.simple` imports without SIGSEGV (otherwise `PVBATCH_PYTHONPATH`).
2. `MESH_PYTHON_BIN` with `h5py`, `numpy`, `vtk`.
3. Series > 10 steps: correct order and times in CFD-Post (C1).
4. Multi-zone case: all zones animated (H7).
5. Time directories in scientific notation exported (M16).
6. CFD-Post properly loads the transient HDF5 CGNS and the `.cse` session.

## 10. Changing this feature

- Artifact names live in three places: `EXPORT_FILES` (`exportStorage.ts`), `ARTIFACT_HEADERS` (`export.controller.ts`) and `ARTIFACT_FILENAMES` (`useExport.ts`). The shared types (`EXPORT_STEPS`, `CaseProfile`, `ExportValidation`, `ExportArtifacts`) are in `packages/shared`.
- The Python contract is `OK:` on stdout / `KO:` on stderr, except `CgnsInspect.py`, which prints a JSON line: do not break the reading of the last line.
- `FoamToCgns.py` must **never** run under `CGNS_PYTHON_BIN`, nor `CgnsToVtk.py` under `pvpython` (two VTKs in the same process: segfault).
- Any change to the series (`out_<i>` name, sidecar) requires reviewing `seriesIndex`, `readSeriesTimes`, `listCgnsFiles` and the "C1" test of `export.test.ts`, whose fake runner recognizes scripts by their name in the arguments and `checkMesh` by the raw `spec.command` (sensitive to `OPENFOAM_BASHRC`, see `brain/known-issues.md` §8).
- Update this sheet, the codemaps and `brain/changelog/` in the same change.
