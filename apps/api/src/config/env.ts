// Centralized, validated environment configuration.
// Loads variables from .env, validates them with zod, and exposes a typed,
// frozen `env` object. Importing this module fails fast with a clear error
// if any required variable is missing or malformed.
import 'dotenv/config';
import { z } from 'zod';

/**
 * Schema for all environment variables consumed by the API.
 * Keep this in sync with `.env.example`.
 */
/**
 * Minimum secret length accepted in production. Short secrets are brute-forceable
 * and must never reach a deployed environment.
 */
const PROD_SECRET_MIN_LENGTH = 32;

/** Known development placeholders that must not be reused in production. */
const DEV_PLACEHOLDER_SECRETS = new Set([
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'ChangeMe!2026',
]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
    JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
    ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
    // Root directory under which uploaded OpenFOAM case files are stored, one
    // subtree per project. Resolved relative to the API process working
    // directory. Defaults to ./storage (i.e. apps/api/storage in local dev).
    STORAGE_DIR: z.string().min(1).default('./storage'),
    // Maximum size (in MB) accepted for a single uploaded case file. CFD meshes
    // can be large (the points/owner files especially), so this is generous.
    // Note: uploads are currently buffered in memory, so very large values cost
    // RAM per concurrent upload; raise deliberately on a server with headroom.
    MAX_UPLOAD_MB: z.coerce.number().int().positive().default(1024),
    // --- CGNS -> OpenFOAM mesh conversion toolchain ---------------------------
    // The conversion runs external binaries that exist on the Debian deploy
    // target (not on a Windows dev box). Every command is configurable so the
    // same code runs unchanged wherever the tools live; sensible Linux defaults
    // assume they are on PATH. When a binary is absent the pipeline reports a
    // clear per-step "not found" instead of crashing.
    //
    // Python interpreter used to run the CGNS->VTK script. The script uses only
    // the standalone VTK wheel (`pip install vtk`), NOT paraview.simple, so it
    // must run under a plain `python3` that imports that wheel. Do NOT use
    // `pvpython`: it preloads ParaView's bundled VTK, and importing a different
    // pip-installed VTK on top of it mixes two incompatible builds in one
    // process — the CGNS reader's SetFileName silently no-ops ("File name not
    // set") and the process segfaults.
    CGNS_PYTHON_BIN: z.string().min(1).default('python3'),
    // Absolute path to the CGNS->VTK ParaView script. Empty => the script
    // bundled with the API at apps/api/scripts/CgnsToVtk.py (resolved relative to
    // the module, cwd-independent). Set this only to point at a script kept
    // elsewhere.
    CGNS_TO_VTK_SCRIPT: z.string().default(''),
    // OpenFOAM mesh utilities (on PATH once the OpenFOAM environment is sourced).
    VTK_TO_FOAM_BIN: z.string().min(1).default('vtkUnstructuredToFoam'),
    CHECK_MESH_BIN: z.string().min(1).default('checkMesh'),
    // autoPatch: divides the external boundary faces into patches by feature
    // angle, used by the "Auto-patch boundaries" action on the Visualize tab.
    AUTO_PATCH_BIN: z.string().min(1).default('autoPatch'),
    // --- Meshing sessions (STL -> snappyHexMesh -> polyMesh) -------------------
    // The standalone "Meshing" page runs a classic OpenFOAM meshing pipeline on
    // uploaded STL surfaces: blockMesh (background box) -> surfaceFeatureExtract
    // (feature edges) -> snappyHexMesh -overwrite (castellate+snap+layers) ->
    // checkMesh. Same operational model as every other OpenFOAM tool here
    // (configurable, sourced via OPENFOAM_BASHRC, absent on a Windows dev box ->
    // a clean per-step "not found" rather than a crash).
    BLOCK_MESH_BIN: z.string().min(1).default('blockMesh'),
    // ESI v2406 ships BOTH surfaceFeatureExtract (reads system/surfaceFeatureExtractDict)
    // and the newer surfaceFeatures (reads system/surfaceFeaturesDict). The classic
    // name is the snappy-tutorial pairing and the default here; swapping to
    // surfaceFeatures means also changing the generated dict (kept in snappyDicts.ts).
    SURFACE_FEATURE_BIN: z.string().min(1).default('surfaceFeatureExtract'),
    SNAPPY_HEX_MESH_BIN: z.string().min(1).default('snappyHexMesh'),
    // Per-step wall-clock timeout (ms). snappyHexMesh on a fine STL is slow, so this
    // is generous (30 min/step), like the merge/conversion pipelines.
    SNAPPY_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
    // Parallel meshing (cores > 1): the background mesh is split with decomposePar,
    // snappyHexMesh runs under `mpirun -np N … -parallel`, then reconstructParMesh
    // reassembles constant/polyMesh. Shares the SOLVER MPI knobs (MPI_BIN,
    // MPI_RUN_FLAGS, DECOMPOSE_METHOD, SOLVER_TOTAL_CORES) so there is one parallel
    // story for the whole app; only the mesh-reconstruction binary differs from the
    // solver's field-oriented reconstructPar. Same operational model as every other
    // OpenFOAM tool here (configurable, sourced via OPENFOAM_BASHRC, absent on a
    // Windows dev box -> a clean per-step "not found" rather than a crash).
    DECOMPOSE_PAR_BIN: z.string().min(1).default('decomposePar'),
    RECONSTRUCT_PAR_MESH_BIN: z.string().min(1).default('reconstructParMesh'),
    // --- Meshing engine: cfMesh (cartesianMesh) ------------------------------
    // Alternative to snappyHexMesh, bundled with ESI OpenFOAM.com v2406. Reads
    // system/meshDict and meshes the volume bounded by a single surfaceFile (a
    // merged STL or an FMS) into constant/polyMesh. It is MULTITHREADED (OpenMP),
    // not MPI-decomposed, so the run's core count is passed as OMP_NUM_THREADS
    // rather than through decomposePar. surfaceAdd folds several STLs into one
    // surface; surfaceFeatureEdges extracts feature edges into an FMS. Same
    // operational model as every other OpenFOAM tool (configurable, sourced via
    // OPENFOAM_BASHRC, absent on a Windows dev box -> clean per-step "not found").
    CARTESIAN_MESH_BIN: z.string().min(1).default('cartesianMesh'),
    SURFACE_FEATURE_EDGES_BIN: z.string().min(1).default('surfaceFeatureEdges'),
    SURFACE_ADD_BIN: z.string().min(1).default('surfaceAdd'),
    // Per-step wall-clock timeout (ms) for a cfMesh step. Generous (30 min), like snappy.
    CFMESH_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
    // --- Multi-mesh merge (Merge meshes flow) ---------------------------------
    // mergeMeshes combines several imported polyMesh sources into one master
    // mesh; stitchMesh then conformally fuses chosen patch pairs (e.g. one part's
    // outlet against the next part's inlet) into internal interfaces, yielding a
    // single continuous domain. Same operational model as the other OpenFOAM
    // tools above (configurable, sourced via OPENFOAM_BASHRC, absent on a Windows
    // dev box -> a clean per-step "not found" rather than a crash).
    MERGE_MESHES_BIN: z.string().min(1).default('mergeMeshes'),
    STITCH_MESH_BIN: z.string().min(1).default('stitchMesh'),
    // stitchMesh face-matching tolerance (relative to local edge length). OpenFOAM
    // v11+ replaced the old -partial/-perfect modes with a single -tol value; empty
    // means "use stitchMesh's own default" (1e-4). Raise it for separately-built
    // parts whose interface faces only approximately coincide.
    STITCH_TOL: z.string().default(''),
    // Assembly v2: the OpenFOAM.org v12 NON-conformal coupling utility. Replaces
    // the deprecated cyclicAMI/createPatch path — it KEEPS both parts' cells +
    // patches and adds a coupled `nonConformalCyclic_on_*` pair for the touching
    // interface patches (flow interpolates, no node coincidence required). Invoked
    // with the two patch names POSITIONAL: `createNonConformalCouples -overwrite
    // <a> <b> -case <master>`. Same operational model as the other OpenFOAM tools
    // (configurable, sourced via OPENFOAM_BASHRC, absent on a Windows dev box -> a
    // clean per-step "not found" rather than a crash).
    NCC_COUPLE_BIN: z.string().min(1).default('createNonConformalCouples'),
    // Per-step wall-clock timeout (ms) for a merge command (mergeMeshes /
    // stitchMesh / checkMesh on a large combined mesh). Generous, like conversion.
    MERGE_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
    // Fluent/Ansys .msh -> constant/polyMesh, for the "Import mesh file" path
    // (a single .msh becomes a polyMesh without going through the CGNS chain).
    // Point this at `gmshToFoam` instead if your .msh is a Gmsh mesh — same
    // invocation shape (<file> -case <dir>). FLUENT_TO_FOAM_SCALE, when set, adds
    // `-scale <factor>` (e.g. 0.001 to convert mm to m).
    FLUENT_TO_FOAM_BIN: z.string().min(1).default('fluent3DMeshToFoam'),
    FLUENT_TO_FOAM_SCALE: z.string().default(''),
    // Optional path to an OpenFOAM `etc/bashrc`. When set, OpenFOAM utilities run
    // inside `bash -c 'source <bashrc> && exec "$@"'` so their environment is
    // available; arguments are passed as real argv (never interpolated), so this
    // is injection-safe. Leave empty when the tools are already on PATH.
    OPENFOAM_BASHRC: z.string().default(''),
    // Per-step wall-clock timeout (ms) for a conversion command. A large mesh's
    // checkMesh can take a while, so this is generous; raise on big cases.
    CONVERSION_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
    // --- 3D mesh viewer (Visualize tab) ---------------------------------------
    // The viewer's geometry is extracted offline by a one-shot Python script
    // (extractPatches.py, reusing PyVista) into a compact GLB + manifest, cached
    // on disk. Same operational footprint as the CGNS conversion above.
    //
    // Python interpreter used to run extractPatches.py. The deploy target is
    // Debian (`python3`); on a Windows dev box the launcher is usually `python`,
    // so default by platform. Override with MESH_PYTHON_BIN when it differs (or
    // when the interpreter is not on PATH).
    MESH_PYTHON_BIN: z.string().min(1).default(process.platform === 'win32' ? 'python' : 'python3'),
    // Absolute path to the boundary-patch extractor. Empty => the script bundled
    // with the API at apps/api/scripts/extractPatches.py (resolved relative to
    // the module, cwd-independent). Set only to point at a script kept elsewhere.
    EXTRACT_PATCHES_SCRIPT: z.string().default(''),
    // Wall-clock timeout (ms) for a single mesh-extraction run. The one-time VTK
    // read of a large ASCII mesh dominates; generous, like the conversion above.
    MESH_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
    // --- Draft-tube inlet profile (boundary-condition overlay) ----------------
    // The DraftTube object type maps a runner-exit velocity profile onto its inlet
    // via timeVaryingMappedFixedValue, which reads constant/boundaryData (NOT a CSV
    // directly). csv_to_boundaryData.py converts an uploaded CSV into that format.
    // Pure Python (csv + pathlib only, no VTK) so it runs under MESH_PYTHON_BIN; an
    // absent interpreter on a Windows dev box yields a clean "not found" step, like
    // the other bundled scripts. Empty CSV_TO_BOUNDARY_DATA_SCRIPT => the script
    // bundled at apps/api/scripts/csv_to_boundaryData.py (resolved cwd-independent).
    CSV_TO_BOUNDARY_DATA_SCRIPT: z.string().default(''),
    CSV_TO_BOUNDARY_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
    // --- OpenFOAM -> CGNS export for CFD-Post (Export tab) ---------------------
    // Writing CGNS is a ParaView-only capability (core VTK has a CGNS reader but
    // NO writer), so the convert step runs under ParaView's `pvbatch`. The reader
    // utilities (foamDictionary, checkMesh) and reference postProcess run as
    // OpenFOAM tools; the CGNS re-read for validation uses the standalone VTK
    // wheel under MESH_PYTHON_BIN (no ParaView needed to read). Every binary is
    // configurable so the same code runs wherever the tools live on the server.
    PVBATCH_BIN: z.string().min(1).default('pvbatch'),
    // Importing paraview.simple instantiates a rendering pipeline controller that
    // SEGFAULTS on a headless server with no GL context (ParaView without OSMesa).
    // The standard fix is to give it a virtual X display via `xvfb-run`. When
    // 'true' (default), the convert step runs `xvfb-run -a pvbatch …` (requires
    // `apt install xvfb`); set 'false' only if pvbatch has working offscreen GL
    // (an OSMesa build), in which case it runs `pvbatch --force-offscreen-rendering`.
    PVBATCH_XVFB: z.enum(['true', 'false']).default('true'),
    // A pip-installed `vtk` wheel in the system site-packages SHADOWS ParaView's
    // own VTK for the python pvbatch uses, which crashes paraview.simple on import
    // (PyVTKObject wrapping SIGSEGV — a VTK ABI mismatch). When set, this is
    // PREPENDED to pvbatch's PYTHONPATH so ParaView's own vtkmodules win — point
    // it at the directory that holds ParaView's VTK python (e.g. where
    // `paraview/` and its `vtkmodules/` live). Non-destructive alternative to
    // isolating the pip vtk in a venv. Empty => leave PYTHONPATH untouched.
    PVBATCH_PYTHONPATH: z.string().default(''),
    // foamDictionary reads controlDict (application, times) in the inspect step.
    FOAM_DICTIONARY_BIN: z.string().min(1).default('foamDictionary'),
    // postProcess computes best-effort OpenFOAM reference values in the validate
    // step (a tool-name/version mismatch degrades gracefully, never fails).
    POST_PROCESS_BIN: z.string().min(1).default('postProcess'),
    // Absolute paths to the bundled export scripts. Empty => the scripts shipped
    // with the API at apps/api/scripts/{FoamToCgns,CgnsInspect}.py (resolved
    // relative to the module, cwd-independent). Set only to override.
    FOAM_TO_CGNS_SCRIPT: z.string().default(''),
    CGNS_INSPECT_SCRIPT: z.string().default(''),
    // Export the WHOLE time series (one CGNS per solved time, zipped) vs only the
    // latest time. ParaView's CGNS writer cannot pack a transient series into one
    // file, so "all" produces out_<i>.cgns files that the backend zips. Default
    // 'true' (the time evolution); 'false' exports just the final result.
    EXPORT_ALL_TIMES: z.enum(['true', 'false']).default('true'),
    // --- OpenFOAM solver run (Solver tab) -------------------------------------
    // The app's first long-running background job. A run spawns the solver
    // (e.g. simpleFoam) in the case directory, pipes its output to a persisted
    // log, and drives a `Run` row to a terminal state. The solver binary lives on
    // the Debian deploy target; on a Windows dev box it is absent, so a real run
    // reports a clean "not found" (spawn ENOENT -> failed) instead of crashing.
    // The default solver here is only a fallback; the run reads the actual solver
    // from the case's controlDict `application`.
    SOLVER_BIN: z.string().min(1).default('simpleFoam'),
    // Hard wall-clock cap for a single run (ms); the child is killed past it.
    // Default 6 h — steady RANS cases can run long; raise on big jobs.
    SOLVER_MAX_RUNTIME_MS: z.coerce.number().int().positive().default(21600000),
    // Maximum concurrent runs *per project*. v1 enforces exactly one (a second
    // start is rejected with RUN_IN_PROGRESS); a queue is deferred.
    SOLVER_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(1),
    // Cap (bytes) on a persisted solver.log. The residual stream dwarfs the
    // 16 MB one-shot command buffer, so this is generous (32 MB).
    SOLVER_LOG_MAX_BYTES: z.coerce.number().int().positive().default(33554432),
    // Grace period (ms) after a graceful stop request (writing `stopAt writeNow`)
    // before escalating to SIGTERM/SIGKILL.
    RUN_STOP_GRACE_MS: z.coerce.number().int().positive().default(30000),
    // MPI launcher for the parallel path (decomposePar + mpirun -np N solver
    // -parallel + reconstructPar).
    MPI_BIN: z.string().min(1).default('mpirun'),
    // Flags passed to mpirun BEFORE `-np N`, space-separated. The default makes a
    // requested core count actually map to MPI slots, which is the usual cause of a
    // parallel run failing with "There are not enough slots available in the system":
    //  - --allow-run-as-root : no-op unless the API runs as root (e.g. a container).
    //  - --use-hwthread-cpus : count hardware threads (hyperthreads) as slots, so the
    //    slot count matches os.cpus().length (the budget the UI offers), not just the
    //    physical-core count OpenMPI uses by default on a hyperthreaded host.
    //  - --oversubscribe     : allow N ranks even when N exceeds the slot count, so the
    //    user's chosen core count is always honoured (the app already caps it by budget).
    // Override for a non-OpenMPI launcher (these flags are OpenMPI-specific).
    MPI_RUN_FLAGS: z
      .string()
      .default('--allow-run-as-root --use-hwthread-cpus --oversubscribe'),
    // Mesh decomposition method written to system/decomposeParDict for a parallel run.
    // `scotch` (default) is automatic, balanced and needs no coefficients, but requires
    // the scotch decomposition library in the OpenFOAM build. If that library is absent
    // (every parallel run then fails at decomposePar), set `hierarchical` or `simple`:
    // a valid n = (x y z) coefficient block is generated automatically from the core count.
    DECOMPOSE_METHOD: z.string().min(1).default('scotch'),
    // Global core budget for parallel runs across ALL projects. A new run is
    // rejected (409 NOT_ENOUGH_CORES) when the sum of active runs' cores plus the
    // requested cores would exceed this — preventing oversubscription across
    // projects. 0 = use the machine's logical core count (os.cpus().length).
    SOLVER_TOTAL_CORES: z.coerce.number().int().min(0).default(0),
    // Timeout (ms) for the parallel pre/post steps (decomposePar / reconstructPar),
    // separate from the long solver runtime. Default 30 min.
    SOLVER_DECOMPOSE_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
    // Number of trusted reverse-proxy hops in front of the API. 0 = trust none
    // (default, correct for direct exposure / local dev). Set to 1 behind a
    // single proxy/load balancer so the login rate-limiter keys on the real
    // client IP (X-Forwarded-For) instead of the proxy address.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // --- Project terminal (Terminal button) -----------------------------------
    // A per-project interactive shell over WebSocket, scoped to the project directory
    // (its working directory). DISABLED BY DEFAULT: it runs a real shell as the API's
    // OS user, and while its cwd is the project dir, a shell can still read outside it
    // — this is a deliberate exception to the app's otherwise shell-free, path-confined
    // model. Enable ONLY on a trusted, single-tenant deployment, and remember any
    // project collaborator would get a shell too. When 'false', the WebSocket endpoint
    // refuses every upgrade and the web client hides the Terminal button.
    TERMINAL_ENABLED: z.enum(['true', 'false']).default('false'),
    // Shell launched for a project terminal. Empty => platform default: an interactive
    // `bash -i` on Linux/macOS (falls back to `sh` if bash is absent via the shell
    // itself), `powershell.exe` on Windows. Set to e.g. /bin/bash to override.
    TERMINAL_SHELL: z.string().default(''),
    // Idle timeout (ms): a terminal with no client activity for this long is killed.
    // Default 15 min. Bounds abandoned shells so they do not accumulate.
    TERMINAL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
    // Hard cap on concurrent terminal sessions across the whole server (backpressure).
    TERMINAL_MAX_SESSIONS: z.coerce.number().int().positive().default(20),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(1, 'SEED_ADMIN_PASSWORD is required'),
    SEED_ADMIN_NAME: z.string().min(1, 'SEED_ADMIN_NAME is required'),
  })
  // Production must not run on weak or placeholder secrets. These checks are
  // inert in development/test so local onboarding stays frictionless.
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;

    const secretFields = [
      { key: 'JWT_ACCESS_SECRET', value: data.JWT_ACCESS_SECRET },
      { key: 'JWT_REFRESH_SECRET', value: data.JWT_REFRESH_SECRET },
    ] as const;

    for (const { key, value } of secretFields) {
      if (value.length < PROD_SECRET_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be at least ${PROD_SECRET_MIN_LENGTH} characters in production`,
        });
      }
      if (DEV_PLACEHOLDER_SECRETS.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is a development placeholder and must be replaced in production`,
        });
      }
    }

    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET in production',
      });
    }

    if (DEV_PLACEHOLDER_SECRETS.has(data.SEED_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SEED_ADMIN_PASSWORD'],
        message: 'SEED_ADMIN_PASSWORD is a development placeholder and must be replaced in production',
      });
    }
  });

/** Inferred, fully-typed shape of the validated environment. */
export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Surface a readable summary of every invalid/missing variable, then abort.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

/** Validated, immutable environment configuration for the whole API. */
export const env: Readonly<Env> = Object.freeze(parsed.data);
