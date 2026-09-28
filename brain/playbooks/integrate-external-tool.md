# Playbook: Integrate an external tool (OpenFOAM utility or bundled Python script)

> When to use: the API must run an OpenFOAM utility, ParaView `pvbatch`, or a Python script from `apps/api/scripts/` · Related: `brain/codemap/api-lib.md` (`commandRunner`, `openfoamCommand`, `streamRunner`, `meshPipelineRun`, `boundaryData`), `brain/codemap/api-scripts.md`, `brain/conventions/code-style.md` §3 and §5, `brain/conventions/testing.md` §2 and §7, `brain/architecture/configuration.md` · Updated: 2026-09-28

## Before you start
- Read the feature sheet and the codemap of the pipeline you extend. Check `brain/architecture/configuration.md`: the binary or interpreter variable may already exist.
- Decide with the user: which tool and version (production is **ESI OpenFOAM v2406**, openfoam.com, not .org: option sets differ, e.g. no `stitchMesh -tol`), inputs and produced artifacts, synchronous step report vs long async run with a live log, what counts as failure.
- Models to copy:
  - one Python script, one step: `convertCsvToBoundaryData` in `apps/api/src/lib/boundaryData.ts`;
  - multi-step OpenFOAM pipeline with short-circuit: `PlannedStep` + `runSteps` in `apps/api/src/lib/meshPipelineRun.ts` (used by `snappyPipeline.ts`, `cfMeshPipeline.ts`), and `runExport` in `apps/api/src/modules/projects/export.service.ts`;
  - long process with a live log: `runStepsStreaming` (`meshPipelineRun.ts`) and `runStream` in `runs.service.ts`.

## Steps
1. **Configuration** (see `add-env-var.md`): one `*_BIN` per binary (default = name on PATH), one `*_TIMEOUT_MS` (reuse `CONVERSION_STEP_TIMEOUT_MS` / `MESH_BUILD_TIMEOUT_MS` only if the semantics match), one `*_SCRIPT` override defaulting to `''` for a bundled script. Pick the interpreter by dependency set, never mix them:
   - `CGNS_PYTHON_BIN`: python3 + `vtk` wheel, never `pvpython` (VTK conflict, segfault);
   - `MESH_PYTHON_BIN`: pyvista, trimesh, numpy, h5py (`requirements.txt`), also pure-Python helpers like `csv_to_boundaryData.py`;
   - `CHAMBER_PYTHON_BIN`: CadQuery venv (`requirements-geometry.txt`), separate from the mesh venv;
   - `PVBATCH_BIN` (+ `xvfb-run -a` when `PVBATCH_XVFB=true`): only for writing CGNS.
2. **Resolve the script path** cwd-independently, override first (models: `csvToBoundaryDataScript` in `boundaryData.ts`, `bundledScript` in `export.service.ts`):
   ```ts
   const configured = env.FEATURE_SCRIPT.trim();
   if (configured) return configured;
   // scripts/ is not compiled: 2 levels up from src/lib (or dist/lib), 3 from src/modules/<x>.
   return path.resolve(__dirname, '../../scripts/feature.py');
   ```
   Check it exists before running. In a step report: a `failed` step whose stderr says `... not found at <path>. Set FEATURE_SCRIPT to its absolute path.` Outside a step report (render, chamber build): `AppError(500, 'SCRIPT_MISSING', ...)`.
3. **Build the command as argv, never a shell string**.
   - OpenFOAM utility: `const plan = planOpenfoamCommand(env.FEATURE_BIN, ['-case', caseDir], caseDir);` then `runCommand({ ...plan, timeoutMs: env.FEATURE_TIMEOUT_MS })` (`apps/api/src/lib/openfoamCommand.ts`). It sources `OPENFOAM_BASHRC` when set and keeps `plan.display` (the logical line) for the UI.
   - Python / other: `runCommand({ command: env.MESH_PYTHON_BIN, args: [script, input, outDir], cwd, env: process.env, timeoutMs })` (`apps/api/src/lib/commandRunner.ts`).
   - Paths passed as args come from the confinement helpers (`caseDirAbsolute`, `sanitizeRelative`, `confineJoin`), never raw user input.
4. **Report steps, never throw on a tool failure**. `runCommand` always resolves a `CommandResult` (`exitCode`, `stdout`, `stderr`, `timedOut`, `spawnError` for ENOENT). Convert with `toStep` from `meshPipelineRun.ts` (status `success` / `failed`, output tail 20 000 chars, `[runner] ENOENT...` or `[runner] command timed out` appended) and `commandFailed` from `openfoamCommand.ts`. After a failure, the remaining steps are `skipped` (`runSteps` does it; manual model: `skipped()` + early return in `runExport`). The shared step types in `packages/shared/src/index.ts` use `'success' | 'failed' | 'skipped'` (`ImportStep`, conversion steps) and add `'warning'` for `ExportStep`. The endpoint answers 200 with `success: false`; the UI renders the stepper. Reuse the `meshPipelineRun.ts` helpers instead of copying `tail`/`toStep` again (already duplicated in `boundaryData.ts` and `export.service.ts`).
5. **Check artifacts, not only the exit code**: a step succeeds only if its output exists (models: the chamber build checks `chamber.glb` in `chamber.service.ts`; the CGNS convert step fails when no CGNS is produced).
6. **Long runs**: use `runStream` (`apps/api/src/lib/streamRunner.ts`, `StreamSpec` with `logFile`, returns `{ pid, onExit, stop }`) or `runStepsStreaming`; answer 202/201 immediately, persist status on disk, let the UI poll. In-memory handles mean one API instance only.
7. **Python script contract** (header docstring with purpose, CLI usage, dependencies, contract; model: `apps/api/scripts/extractPatches.py`):
   - success: a line starting `OK:` on stdout, exit 0;
   - failure: a line starting `KO:` on stderr, exit 1 (wrap the body in `try/except Exception`, re-raise `SystemExit`);
   - usage error (wrong argc): usage on stderr, exit 2;
   - heavy imports (`vtk`, `pyvista`, `cadquery`, `numpy`) inside `main()` after argument parsing;
   - write outputs atomically when a reader may race (model: `mirrorStep.py`, `mkstemp` + `os.replace`); machine-readable data as the last stdout line (model: `CgnsInspect.py` JSON parsed by `validateCgns`).
   New dependency: add it to `apps/api/scripts/requirements.txt` or `requirements-geometry.txt` (pinned there).
8. **Tests** (`apps/api/tests/<feature>.test.ts`, template in `testing.md` §7):
   - `setCommandRunner(fake)` in `beforeEach`, `setCommandRunner(null)` in `afterEach` (same for `setStreamRunner`);
   - match OpenFOAM tools on `logicalCommand(spec).command` from `tests/helpers.ts`, never `spec.command` (with `OPENFOAM_BASHRC` set the real command is `bash`); match Python scripts on `spec.args.some((a) => a.includes('Feature.py'))` (model: `successRunner` in `export.test.ts`);
   - the fake writes what the real tool would (files in `caseDir`, JSON on stdout), since the service checks artifacts;
   - cover success, non-zero exit, missing binary (`exitCode: null, spawnError: 'ENOENT: ...'`), timeout (`timedOut: true`), later steps `skipped`, 401 and stranger 404;
   - a script that is not in the repo gets a stub in `apps/api/tests/fixtures/` + a `*_SCRIPT` entry in `apps/api/vitest.config.ts` (models: `CGNS_TO_VTK_SCRIPT`, `EXTRACT_PATCHES_SCRIPT`).

## Verify
- `cd apps/api && npx vitest run tests/<feature>.test.ts` twice: once with `OPENFOAM_BASHRC` empty in `apps/api/.env`, once set to any path (the fake never runs it). Both green.
- Manual run on a dev box without the tool: the endpoint answers 200 with a `failed` step carrying `[runner] ENOENT ...`, and nothing crashes.
- Python syntax at least: `python -m py_compile apps/api/scripts/<script>.py`.
- `npm run typecheck`, `npm run lint`.

## Update the brain
- [ ] Changelog entry with **"to validate on the Debian server"** listing exactly what could not run locally (tool, version, expected output).
- [ ] `brain/architecture/configuration.md` (new variables) and `apps/api/.env.example`.
- [ ] Codemap `api-lib.md` / `api-projects.md` / `api-scripts.md` (new script section), `api-tests.md`; then `python brain/codemap/build-index.py`.
- [ ] Feature sheet §4 (flow) and §6 (external dependencies, behaviour when the tool is missing); `brain/architecture/storage-layout.md` if new files persist on disk.
- [ ] `brain/operations/installation.md` if the server needs a new package or venv dependency.

## Pitfalls
- Fakes keyed on `spec.command` pass in CI and break locally once `.env` sets `OPENFOAM_BASHRC`: `conversion.test.ts`, `meshes.test.ts` (and `checkMesh` in `export.test.ts`) have this bug today (`brain/known-issues.md` §8).
- A fake that returns exit 0 without writing artifacts makes the service report failure.
- `execFile` buffers at most 16 MB of output (`MAX_BUFFER` in `commandRunner.ts`); a chatty tool overflows into a `spawnError`. Use the streaming runner for verbose solvers or meshers.
- Existing scripts drift from the contract: `mirrorStep.py` exits 1 on a usage error, `csv_to_boundaryData.py` prints no `OK:`/`KO:` line. Do not copy them for the contract; copy `extractPatches.py`.
- Absolute server paths end up in step reports (`brain/known-issues.md` L21): keep `display` readable, never put secrets in argv.
- Chamber builder change (`buildChamber.py`): purge `apps/api/storage/chamber/*` locally and `$STORAGE_DIR/chamber/*` on the server (cache keyed on parameters, not code), and run the real pytest suite.
