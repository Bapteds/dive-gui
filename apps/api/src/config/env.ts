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
    // MPI launcher for the DEFERRED parallel path (decomposePar + mpirun -np N
    // solver -parallel + reconstructPar). Declared now so the env shape is stable.
    MPI_BIN: z.string().min(1).default('mpirun'),
    // Number of trusted reverse-proxy hops in front of the API. 0 = trust none
    // (default, correct for direct exposure / local dev). Set to 1 behind a
    // single proxy/load balancer so the login rate-limiter keys on the real
    // client IP (X-Forwarded-For) instead of the proxy address.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
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
