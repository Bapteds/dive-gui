# Code style and patterns

> Patterns actually used in the code (surveyed across the whole repository on 2026-09-28). New code must look like the neighboring code: same comment density, same naming, same idioms.

## 1. General

- **Strict TypeScript** everywhere. npm workspaces monorepo: `@dive/shared`, `@dive/api`, `@dive/web`, `@dive/mcp`. No pnpm or yarn.
- Prettier: `semi`, `singleQuote`, `trailingComma: all`, `printWidth: 100`. EditorConfig: 2 spaces, LF, UTF-8. `.gitattributes` forces LF (Python scripts and OpenFOAM dicts run under Linux).
- ESLint 9 (flat config) + `typescript-eslint` + `react-hooks` + `react-refresh`.
- **Comments in English**. Every file starts with a header comment stating its role; every export has a one-line JSDoc (`/** GET /users — list every account. */`). Comments explain the *why* (root cause, OpenFOAM constraint, audit reference `H3`, `M16`…).
- No placeholder, `// TODO` or truncated code in anything shipped.

## 2. Shared contract (`packages/shared`)

- **Single source** of the types and constants shared API ↔ web: roles, max lengths, error codes, zod schemas, catalogs (solvers, turbulence, BC object types), chamber model (`computeChamberGeneratorDims`…).
- Dual CJS + ESM build; **rebuild required** (`npm run build:shared`) before typecheck/test of the apps after a change.
- Any validation rule or constant used on both sides goes here, never duplicated in an app.

## 3. Backend (`apps/api`)

**Module layout** `src/modules/<domain>/`:

| File | Role |
|---|---|
| `<domain>.routes.ts` | `create<Domain>Router()`: `Router`, guards (`requireAuth`, `requireRole`), `validate({ body, params, query })`, handlers wrapped in `asyncHandler`. |
| `<domain>.schemas.ts` | zod schemas + inferred types (`CreateUserInput`). |
| `<domain>.controller.ts` | **Thin** HTTP adapters: read `req`, call the service, respond `res.status(x).json({ <resource> })`. No business logic. |
| `<domain>.service.ts` | Business logic, Prisma, FS, processes. Throws `AppError`s. |

Under `projects/`, each subdomain (files, mesh, meshes, conversion, boundary, runs, export) follows the same schemas → controller → service triplet, mounted by `projects.routes.ts`.

**Rules**:
- Expected errors: `throw new AppError(status, 'STABLE_CODE', 'Client-safe message', details?)`. The central `errorHandler` renders `{ error: { code, message } }`. Codes shared in `@dive/shared`.
- Validation only through the `validate` middleware (422 `VALIDATION_ERROR`); it **replaces** `req.body` with the parsed value: a field missing from the schema disappears.
- Project visibility: every service starts with `assertProjectVisible`; an invisible project returns **404** (never 403, no existence leak). Owner-only actions: 403 `FORBIDDEN`.
- Responses wrapped by resource name: `{ user }`, `{ users }`, `{ project }`.
- `requireAuth` re-reads role and `isActive` from the DB on every request.
- External commands: `runCommand` / `streamRunner` with real argv (`execFile`/`spawn`), never an interpolated shell; OpenFOAM tools through `planOpenfoamCommand` (sources `OPENFOAM_BASHRC`); binaries and timeouts read from `config/env.ts`.
- External pipelines (conversion, merge, autoPatch, export): **do not throw** on a tool failure; they return structured steps (`success`/`failed`/`skipped`, truncated output) that the UI displays.
- Disk paths: always through the confinement helpers (`sanitizeRelative`, `confineJoin`); critical writes are atomic (tmp + rename); in-process locks where there is concurrency (`runExclusive`, per-hash chamber lock).
- Configuration: every env variable is declared and validated in `src/config/env.ts` (zod, fail-fast at boot) and documented in `.env.example`.
- Injectable dependencies for tests (command and stream runners; the chamber builder is also faked through the command runner) rather than global mocks.

## 4. Frontend (`apps/web`)

**Organization**:
- `pages/`: one page per route (lazy-loaded), composes features.
- `features/<domain>/`: components, TanStack Query hooks (`use<Domain>.ts`), form schemas, pure testable logic (`chamberForm.ts`, `foamModel.ts`, `placement.ts`) + tests alongside (`*.test.ts(x)`).
- `components/ui/`: tokenized shadcn/Radix primitives; `components/common/`: shared blocks (EmptyState, ErrorState…); `components/layout/`: shell; `components/brand/`: logo, diamond.
- `lib/api/`: one module per domain, typed functions that **unwrap the envelope** (`data.users`); `types.ts`: response types; `client.ts`: fetch + single-flight refresh on 401.
- Import alias `@/` → `apps/web/src/`.

**TanStack Query**:
- Key exported as a constant (`export const usersQueryKey = ['users'] as const`); hierarchical keys `['projects', id, …]`, `['meshing', …]`, `['chamber', hash, …]`.
- Mutations: `setQueryData` with the server response then invalidation of the list; `removeQueries` for 3D renders to rebuild. Caution: invalidating a prefix (`['meshing']`) refreshes every query under that prefix.
- Errors are not swallowed in the hooks: components call `mutateAsync` and map `ApiError.code` to field errors or toasts.
- Polling: short interval while the status is not terminal, stop as soon as a terminal status is seen, retry if there is no data (H5 fix).
- 3D renders: `retry: false`, `staleTime`/`gcTime` 5 min; manifest first, then GLB and edges.
- `QueryClient` defaults: `staleTime` 30 s, `retry` 1, `refetchOnWindowFocus: false`; `queryClient.clear()` on logout.

**Components and forms**:
- Functional components + hooks only; `react-hook-form` + zod for forms.
- Debounced autosave (600 ms file editor, 800 ms meshing configs); the draft is only reloaded on file change, not on the save echo (H4 fix).
- Local preferences in `localStorage` under `dive.<zone>.<projectId>`.
- Editing an OpenFOAM file in Easy mode: rewrite ONE value (`setFoamValue` / `insertFoamField`), preserve the rest of the file.
- Styles: semantic Tailwind classes wired to the tokens only (see `brain/conventions/frontend.md`).

## 5. Python (`apps/api/scripts`)

- Standalone CLI scripts called by the API with argv (`execFile`), never through a shell.
- **Output contract**: success ⇒ `OK:` line on stdout, exit 0; failure ⇒ `KO:` line on stderr, exit 1; incorrect usage ⇒ exit 2. Heavy imports (vtk, pyvista, cadquery) happen INSIDE `main()` after argument parsing.
- Complete header docstring: purpose, CLI usage, dependencies, contract.
- Separate interpreters by use: `CGNS_PYTHON_BIN` (python3 + vtk wheel, never `pvpython`), `MESH_PYTHON_BIN` (pyvista/trimesh/numpy/h5py), `PVBATCH_BIN` (export), `CHAMBER_PYTHON_BIN` (CadQuery). See `brain/architecture/configuration.md`.
- `buildChamber.py`: any change ⇒ geometry tests (`pytest apps/api/scripts/tests`) + purge of the `apps/api/storage/chamber/*` cache.

## 6. Naming

| Element | Convention | Example |
|---|---|---|
| Backend files | `camelCase.ts`, modules `<domain>.<layer>.ts` | `meshStorage.ts`, `runs.service.ts` |
| React components | `PascalCase.tsx` | `ChamberInputsForm.tsx` |
| UI primitives | `kebab-case.tsx` (shadcn convention) | `native-select.tsx` |
| Hooks | `useXxx` in `useXxx.ts` | `useChamberSaves.ts` |
| Error codes | stable `SCREAMING_SNAKE_CASE` | `PROTECTED_ACCOUNT`, `MESH_NOT_BUILT` |
| Env variables | `SCREAMING_SNAKE_CASE` prefixed by domain | `SOLVER_TOTAL_CORES`, `CHAMBER_PYTHON_BIN` |
| Python scripts | `camelCase.py` or `PascalCase.py` (historical) | `buildChamber.py`, `CgnsToVtk.py` |
| Specs / plans | `YYYY-MM-DD-<topic>-design.md` / `YYYY-MM-DD-<topic>.md` | `2026-09-02-simplify-generator-design.md` |

## 7. Known style debt (do not reproduce)

Noted during the 2026-09-28 mapping (do not fix without a request, but do not copy):
- `requireViewer` copied into the 8 controllers of `projects/`; `applyRenames` / `extractPatchesScript` / `pathExists` duplicated between `mesh.service` and `meshes.service`; `caseTurbulenceModel` in 3 copies.
- On the web side: `detectWebgl` and `StageMessage` duplicated in 3 to 4 viewers; `clampCores`/`defaultCores`/`fmt` duplicated between `SnappyConfigForm` and `CfMeshConfigForm`; `MeshingSessionPage` redefines its own run status table.
- Step helpers `tail` / `toStep` are copied in `boundaryData.ts` and `export.service.ts` although shared versions exist in `meshPipelineRun.ts`.
- `transportedTurbulenceFields` exists in both `files.service.ts` and `openfoamCase.ts`, with different handling of a missing model.
- For new code: extract a shared helper rather than duplicating a fourth time.
