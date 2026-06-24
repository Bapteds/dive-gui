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
    // ParaView's python used to run the CGNS->VTK script. On Debian: `pvpython`.
    PVPYTHON_BIN: z.string().min(1).default('pvpython'),
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
