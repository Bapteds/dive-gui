# Playbook: Add an environment variable

> When to use: a new setting for the API (binary path, timeout, limit, feature flag), the web bundle (`VITE_*`) or the MCP server · Related: `brain/architecture/configuration.md`, `brain/codemap/api-core.md` (`env.ts`, `.env.example`, `vitest.config.ts`), `brain/known-issues.md` K33 · Updated: 2026-09-28

## Before you start
- Read `brain/architecture/configuration.md`: the variable may already exist (70+ are declared; some are declared but never read, e.g. `STITCH_TOL`, `NCC_COUPLE_BIN`).
- Decide with the user: name (SCREAMING_SNAKE_CASE, prefixed by domain: `SOLVER_TOTAL_CORES`, `CHAMBER_PYTHON_BIN`), default (the app must boot on a dev box without setting it), required or optional, production-only constraints.
- Server-controlled on/off flag the web must know about? Prefer exposing it through `GET /api/v1/config` (model: `terminalEnabled` in `apps/api/src/app.ts`, read by `apps/web/src/lib/api/config.ts`) over a `VITE_*` variable: no web rebuild, one source of truth.

## Steps

### API
1. **Declare and validate** in `envSchema` in `apps/api/src/config/env.ts`, inside the matching commented section (`--- Chamber Creation ---`, `--- Project terminal ---`…), with a comment explaining what it does and why the default is safe. Idioms used in the file:
   ```ts
   // Wall-clock timeout (ms) for one <tool> run.
   FEATURE_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
   // Binary name (on PATH) or absolute path.
   FEATURE_BIN: z.string().min(1).default('featureTool'),
   // Empty => the script bundled in apps/api/scripts/ (resolved from the module, cwd-independent).
   FEATURE_SCRIPT: z.string().default(''),
   // Boolean flags are strings; compare with env.FEATURE_ENABLED === 'true'.
   FEATURE_ENABLED: z.enum(['true', 'false']).default('false'),
   // Platform-dependent interpreter default (model: MESH_PYTHON_BIN, CHAMBER_PYTHON_BIN).
   FEATURE_PYTHON_BIN: z.string().min(1).default(process.platform === 'win32' ? 'python' : 'python3'),
   ```
   A variable without `.default()` is required: the API refuses to boot without it (already the case for `SEED_ADMIN_*`, even outside seeding). Avoid new required variables.
2. **Production-only checks** go in the `.superRefine` block at the end of `envSchema` (inert unless `NODE_ENV === 'production'`), with `ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FEATURE_X'], message })`. Model: the JWT secret length / placeholder / equality checks.
3. **Read it** only through `import { env } from '../config/env'` (typed, frozen). Do not read `process.env.X` directly (the only exceptions today: `NODE_ENV` in `middleware/rateLimit.ts`, `DATABASE_URL` read by Prisma).
4. **Document it** in `apps/api/.env.example`: comment block + `FEATURE_X="<same default>"`, in the section matching `env.ts`. Keep the example value equal to the schema default unless the example deliberately shows a server value (then say so in the comment).
5. **Tests**. Vitest injects `test.env` from `apps/api/vitest.config.ts`; those values win over `apps/api/.env` (dotenv never overrides an existing variable). A variable absent from `test.env` is read from the developer's `apps/api/.env`. If the value changes test behaviour, pin it in `test.env` with a comment (models: `RUN_STOP_GRACE_MS: '50'`, `SOLVER_TOTAL_CORES: '8'`, script stubs `EXTRACT_PATCHES_SCRIPT: './tests/fixtures/extractPatches.py'`). `env` is frozen at import, so a test cannot flip it per case: inject behaviour (runner, argument) instead.

### Web (`VITE_*`)
1. Declare it in `ImportMetaEnv` in `apps/web/src/vite-env.d.ts`.
2. Read it with `import.meta.env.VITE_X`, lazily, and fail with an actionable message when missing (model: `getBaseUrl` in `apps/web/src/lib/api/client.ts`).
3. Document it in `apps/web/.env.example`. If the CI build needs it, add it to the `npm run build` step env in `.github/workflows/ci.yml` (model: `VITE_API_URL`).
4. Values are baked into `apps/web/dist` at build time and public to every visitor: never a secret.

### MCP
Read and validate it in `loadConfig()` (`apps/mcp/src/config.ts`, `required()` for mandatory values, parsed default otherwise) and document it in `apps/mcp/.env.example`.

### Deployment
- API variables are read once at boot: edit `/home/app/apps/api/.env` on the server, then `systemctl restart dive-api`. The unit also sets `Environment=NODE_ENV=production` (see `brain/operations/installation.md` §5.3).
- `VITE_*` variables need a web rebuild on the server (`npm run build`) after editing `apps/web/.env`; nginx then serves the new `apps/web/dist`.

## Verify
- `npm run typecheck`; `cd apps/api && npx vitest run <suites that read the variable>`.
- Boot check without the variable set: `npm run dev:api` must start (the default applies). With an invalid value (e.g. `FEATURE_TIMEOUT_MS=abc`), boot must fail with `Invalid environment configuration:` listing the variable.
- `npm run lint`.

## Update the brain
- [ ] `brain/architecture/configuration.md`: a row in the matching table (variable, `env.ts` default, `.env.example` value, role, constraints, read by); the "Test overrides" section if pinned in `vitest.config.ts`.
- [ ] Changelog entry with a **Deployment** line: which server `.env` must change, or "default is fine, nothing to do".
- [ ] Feature sheet §6 (configuration) of the feature that reads it.
- [ ] `brain/codemap/api-core.md` sections for `env.ts` / `.env.example` if their role changed, then `python brain/codemap/build-index.py`.
- [ ] `brain/known-issues.md` K33 if you close (or widen) a gap between `env.ts` and `.env.example`.

## Pitfalls
- Adding the variable to `env.ts` but not to `.env.example`: 11 variables already have this gap (K33, including `CHAMBER_PYTHON_BIN`), so operators do not know they exist.
- A "boolean" declared with `z.coerce.boolean()` would turn the string `'false'` into `true`; use `z.enum(['true', 'false'])` like the rest of the file.
- Relying on a variable in tests without pinning it: suites then depend on each developer's `.env`. This is exactly why `conversion.test.ts` / `meshes.test.ts` fail locally when `.env` sets `OPENFOAM_BASHRC` (`brain/known-issues.md` §8).
- A relative `STORAGE_DIR` or script path resolves against the API process working directory (`/home/app/apps/api` under systemd), not the repo root.
- `VITE_API_URL` must be absolute in production: the terminal derives its WebSocket URL by replacing `http` with `ws` (`terminalWsUrl` in `features/terminal/TerminalView.tsx`).
