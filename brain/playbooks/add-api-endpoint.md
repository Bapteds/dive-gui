# Playbook: Add an API endpoint

> When to use: a new REST route in an existing module, or a brand new module under `apps/api/src/modules/` · Related: `brain/architecture/api-routes.md`, `brain/conventions/code-style.md` §3, `brain/conventions/testing.md` §7, `brain/codemap/api-core.md`, `brain/codemap/api-projects.md`, `brain/codemap/root-shared-mcp.md` · Updated: 2026-09-28

## Before you start
- Read `brain/STATUS.md`, the feature sheet in `brain/features/`, and the neighbouring rows of `brain/architecture/api-routes.md`.
- Settle with the user (one question at a time): method + path, access level (Auth, Admin, Visible, Management, Author: see the legend in `api-routes.md`), response envelope name (`{ user }`, `{ result }`…), error codes, and whether the web client and the MCP server need it. Non-trivial feature: spec first in `brain/specs/YYYY-MM-DD-<topic>-design.md`.
- Pick your model to copy:
  - global CRUD resource: the `users` module (`apps/api/src/modules/users/users.{routes,schemas,controller,service}.ts`);
  - project-scoped action: the `export` trio (`apps/api/src/modules/projects/export.{schemas,controller,service}.ts`), mounted in `projects.routes.ts`.
- Anything that shells out to OpenFOAM or Python: also follow `integrate-external-tool.md`.

## Steps
1. **Shared contract first** (only if the type or rule is used by both API and web). Add the type, zod schema or constant to `packages/shared/src/index.ts`. A new error code goes into `SERVER_ERROR_CODES` (same file), otherwise the web cannot compare `ApiError.code` against it without a TS error (`ApiErrorCode` in `apps/web/src/lib/api/types.ts` is built from it). Then `npm run build:shared`.
2. **Schemas** in `<domain>.schemas.ts`. Model: `users.schemas.ts` (`createUserSchema`, `updateUserSchema` with `.refine` rejecting an empty PATCH, `userIdParamSchema`, exported `z.infer` types). For a project route, reuse `projectIdParamSchema` (`projects.schemas.ts`); if the route has more params, the params schema must also declare `id`, because `validate` parses the whole `req.params` (model: `exportArtifactParamSchema` in `export.schemas.ts`).
3. **Service** in `<domain>.service.ts`. Business logic, Prisma, FS; throws `AppError(status, 'STABLE_CODE', 'client-safe message')` (`apps/api/src/lib/AppError.ts`). Project-scoped services start with the visibility gate (model: `runExport` in `export.service.ts`, `applyBoundaryConditions` in `boundary.service.ts`):
   ```ts
   /** Run <feature> on the project's case. @throws 404 NOT_FOUND if not visible. */
   export async function runFeature(viewer: Viewer, projectId: string): Promise<FeatureResult> {
     await assertProjectVisible(viewer, projectId); // 404, never 403 (no existence leak)
     // ...
   }
   ```
   Management-level action from a sibling module (`canManage` is private to `projects.service.ts`): call `assertProjectVisible` first (404), then `if (viewer.role !== 'SUPER_ADMIN' && project.owner.id !== viewer.id) throw new AppError(403, 'FORBIDDEN', ...)`. Author-owned resources (templates, chamber saves): read open to any authenticated user, write 403 for non-author (model: `templates.service.ts`).
4. **Controller** in `<domain>.controller.ts`: thin adapter, no logic. Model: `runExportController` (`export.controller.ts`, with its local `requireViewer`) or `createUserController` (`users.controller.ts`, `requireActor`). One-line JSDoc per export, respond `res.status(200).json({ result })`, `201` on create, `204` on delete. `requireViewer` is already duplicated in 8 controllers (known debt, `code-style.md` §7): reuse the one in the file you extend; for a new controller file, ask the user before extracting a shared helper.
5. **Router**.
   - Existing project module: add the route in `createProjectsRouter()` (`projects.routes.ts`). The router already runs `requireAuth`. Pattern: `router.post('/:id/<feature>', validate({ params: projectIdParamSchema, body: featureSchema }), asyncHandler(runFeatureController));`. Put more specific paths before generic ones.
   - Admin-only: guard at router level like `createUsersRouter()`: `router.use(asyncHandler(requireAuth)); router.use(requireRole('SUPER_ADMIN'));`.
   - New module: export `create<Domain>Router()` and mount it in `createApp()` (`apps/api/src/app.ts`) with `app.use('/api/v1/<domain>', ...)`, before `notFoundHandler` / `errorHandler`.
   - JSON bodies are capped at 16 kB (`express.json` in `app.ts`). Bigger payloads need a dedicated parser (model: `parseFileContent` in `projects.routes.ts`) or multipart (`parseCaseUpload`, `parseBoundaryUpload`).
6. **Web client**. API function in `apps/web/src/lib/api/<domain>.ts` (project sub-routes live in `lib/api/projects.ts`, e.g. `runExport`), using `apiClient.get/post/put/patch/delete` and unwrapping the envelope (`return data.result;`). Response wrapper type in `lib/api/types.ts` (model: `ExportRunResponse`), payload types imported from `@dive/shared`. Hook in `features/<domain>/use<Domain>.ts`: exported key constant (`exportStatusQueryKey = (projectId) => ['projects', projectId, 'export'] as const`), mutation that `setQueryData`s the server answer and/or invalidates the list (models: `features/export/useExport.ts`, `features/admin/useUsers.ts`, `features/projects/useBoundaryConditions.ts`). Do not swallow errors in hooks. Any JSX: follow `brain/conventions/frontend.md` first.
7. **Tests** (write them first, see them fail). `apps/api/tests/<domain>.test.ts` from the template in `testing.md` §7, helpers from `tests/helpers.ts` (`app`, `resetDatabase`, `createTestUser`, `createProtectedAdmin`, `authHeader`). Assert `res.status` AND `res.body.error.code`. Cover: 401 without token, 404 for a stranger on a project route (403 `FORBIDDEN` for a USER on an admin route), 422 `VALIDATION_ERROR`, success shape, each business error, super-admin allowed. Web: mock `@/lib/api/<module>` with `vi.mock` (`testing.md` §8).
8. **MCP tool** (only if the user wants Claude to drive it). In `apps/mcp/src/server.ts`, next to similar tools: `tool('run_feature', { title, description, inputSchema: projectId, destructive: true }, async ({ projectId }) => client.post(`/projects/${projectId}/feature`));`. Names starting with `list_`, `get_`, `read_`, `verify_` are flagged read-only automatically. Client methods: `get`, `post`, `put`, `delete`, `putText`, `postForm` (`apps/mcp/src/client.ts`).

## Verify
- `npm run build:shared` (if `packages/shared` changed).
- `cd apps/api && npx vitest run tests/<domain>.test.ts` plus direct neighbours (e.g. `tests/projectsAccess.test.ts` for a project route). Green = all pass, no skipped test you added.
- Web: `cd apps/web && npx vitest run src/features/<domain>`.
- `npm run typecheck` (shared + API + web) and `npm run lint`. MCP is not in the root typecheck: `npm run typecheck -w @dive/mcp`.

## Update the brain
- [ ] `brain/changelog/YYYY-MM.md`: new entry at the top (format in `brain/changelog/README.md`), with the **Tests** line.
- [ ] `brain/architecture/api-routes.md`: new row (method, path, access, controller -> service, validation, response, notable errors).
- [ ] Codemap: section of each new file, updated exports of touched files (`api-core.md`, `api-projects.md`, `web-*.md`, `api-tests.md`, `root-shared-mcp.md`), then `python brain/codemap/build-index.py` (never edit `brain/INDEX.md` by hand).
- [ ] Feature sheet `brain/features/<feature>.md` (flow, rules, tests); `brain/features/mcp-server.md` if a tool was added.
- [ ] `brain/STATUS.md` if the state changed.

## Pitfalls
- 403 instead of 404 on an invisible project leaks its existence: always 404 via `assertProjectVisible`.
- `validate` replaces `req.body` with the parsed value: a field missing from the schema silently disappears.
- A 500 `AppError` keeps its code but `errorHandler` replaces the message with `Internal server error`; use 4xx/502 for messages the user must read.
- The error code is used in the service but missing from `SERVER_ERROR_CODES`: already the case for `NAME_TAKEN`, `MESH_IN_PROGRESS`, `NOT_ENOUGH_CORES`, `TOO_MANY_CORES`, `ENGINE_MISMATCH`, `ARCHIVE_TOO_LARGE`. Do not add to that list.
- Forgetting `npm run build:shared`: API and web compile against the old `dist`.
- Invalidating a broad prefix (`['projects', id]`) refetches every query below it, 3D renders included; target the exact key.
- Synchronous CFD actions must not throw on tool failure: return a step report (`integrate-external-tool.md`).
