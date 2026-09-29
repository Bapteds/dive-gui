# Codemap: API core and cross-cutting modules

> Scope: `apps/api/{package.json,tsconfig.json,vitest.config.ts,.env.example}`, `apps/api/prisma/**`, `apps/api/src/{app.ts,server.ts}`, `apps/api/src/{config,middleware,types}/**`, `apps/api/src/modules/{audit,auth,chamber,dashboard,meshing,templates,users}/**` · Updated: 2026-09-28

## Overview
`src/server.ts` builds the application via `createApp()` (`src/app.ts`), reconciles orphaned solver runs and mesh runs, listens on `PORT`, then attaches the terminal WebSocket gateway. `createApp()` stacks `helmet`, `cors` (single origin `CORS_ORIGIN`, credentials), `express.json({ limit: '16kb' })`, `cookie-parser`, the public routes `/health` and `/api/v1/config`, then mounts one router per module under `/api/v1`, and finally `notFoundHandler` and `errorHandler`.
Every module follows the same split: `*.routes.ts` (wiring of `requireAuth` / `requireRole` / `validate` / `asyncHandler`), `*.schemas.ts` (zod, often backed by constants from `@dive/shared`), `*.controller.ts` (thin adapter that builds a `Viewer`/`Actor` from `req.user` and sets the HTTP status), `*.service.ts` (business logic, Prisma, disk, external processes). Business errors are `AppError(status, code, message)` rendered as `{ error: { code, message } }`.
Configuration is centralized in `src/config/env.ts` (zod, frozen object, failure at load time). Relational persistence is SQLite via Prisma (`prisma/schema.prisma`); mesh sessions and chamber builds are stored only on disk under `STORAGE_DIR`.
The `projects` module (outside the scope of this sheet) provides `Viewer`, `assertProjectVisible`, `stopProjectRuns` and `parseCaseUpload`, reused by dashboard, templates, meshing, chamber and users.

## `apps/api/prisma/migrations/20260619093204_init/migration.sql`
Creates the `User` table (`id`, `email`, `fullName`, `passwordHash`, `role` default `'USER'`, `isProtected` default false, `tokenVersion` default 0, `createdAt`, `updatedAt`) and the unique index `User_email_key`.

## `apps/api/prisma/migrations/20260622061744_add_audit_log_and_account_status/migration.sql`
Creates `AuditLog` (no foreign key) and its indexes `createdAt`, `actorId`, `targetId`. Redefines `User` (copy into `new_User`, drop, rename, `foreign_keys` pragmas turned off during the operation) to add `isActive` (default true) and `lastLoginAt` (nullable).

## `apps/api/prisma/migrations/20260622070404_add_project/migration.sql`
Creates `Project` (`id`, `title`, `ownerId`, timestamps) with the foreign key `ownerId` to `User` as `ON DELETE CASCADE`, and the index `Project_ownerId_idx`.

## `apps/api/prisma/migrations/20260622072302_add_project_collaborators/migration.sql`
Creates the Prisma implicit join table `_ProjectCollaborators` (`A` to `Project`, `B` to `User`, both cascading), the unique index `(A, B)` and the index on `B`.

## `apps/api/prisma/migrations/20260622121210_add_template/migration.sql`
Creates `Template` (`id`, `name`, `description` nullable, `ownerId` cascading to `User`, timestamps) and the index `Template_ownerId_idx`.

## `apps/api/prisma/migrations/20260624102016_add_run_model/migration.sql`
Creates `Run` (`projectId` cascading to `Project`, `solver`, `status` default `'queued'`, `pid`, `exitCode`, `command`, `logPath`, `reason`, `startedAt`, `finishedAt`, timestamps) and the indexes `projectId` and `(projectId, status)`.

## `apps/api/prisma/migrations/20260702130000_add_template_tags/migration.sql`
Adds `Template.tags` (TEXT, not null, default `'[]'`, serialized JSON array).

## `apps/api/prisma/migrations/20260703120000_add_run_cores/migration.sql`
Adds `Run.cores` (INTEGER, not null, default 1).

## `apps/api/prisma/migrations/20260831142110_chamber_saves/migration.sql`
Creates `ChamberSave` (`id`, `name`, `ownerId` cascading to `User`, `snapshot` TEXT, timestamps), the unique index `ChamberSave_name_key` and the index `ChamberSave_ownerId_idx`.

## `apps/api/prisma/migrations/migration_lock.toml`
Prisma lock: `provider = "sqlite"`.

## `apps/api/prisma/schema.prisma`
**Role**: Prisma schema of the API (SQLite datasource `env("DATABASE_URL")`, generator `prisma-client-js` with `binaryTargets = ["native", "debian-openssl-3.0.x"]` so that a client generated on Windows runs on Debian 12).
**Models**:
- `User`: identity, `role` as String (`'SUPER_ADMIN' | 'USER'`, no SQLite enum), `isProtected`, `isActive`, `tokenVersion`, `lastLoginAt`; relations `projects` (`ProjectOwner`), `collaboratingOn` (`ProjectCollaborators`), `templates`, `chamberSaves`.
- `Project`: `title`, `owner` (cascade), `collaborators` (implicit many-to-many), `runs`; index `ownerId`.
- `Run`: solver execution, `status`/`solver` as String validated on the application side; indexes `projectId` and `(projectId, status)`.
- `Template`: `name`, `description?`, `tags` (JSON text), `owner` (cascade); files on disk under `<STORAGE_DIR>/templates/<id>/files`.
- `ChamberSave`: unique `name`, `snapshot` (JSON of `ChamberInput`), `owner` (cascade).
- `AuditLog`: append-only log, denormalized actor and target, no foreign key.
**Used by**: `lib/prisma` (client), all Prisma services. Full details in `brain/architecture/data-model.md`.

## `apps/api/prisma/seed.ts`
**Role**: idempotently provisions the permanent super-admin. Reads `SEED_ADMIN_EMAIL` (trim + lowercase), `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` from `env`, hashes the password (argon2 via `lib/password`) and runs an `upsert` on the email.
**Effects**: on both create and update, forces `role: 'SUPER_ADMIN'`, `isProtected: true`, `fullName` and `passwordHash` (the env password always becomes valid again). `process.exitCode = 1` on failure; Prisma disconnect in `finally`.
**Depends on**: `src/config/env`, `src/lib/password`, `src/lib/prisma`, `src/lib/logger`. **Used by**: `npm run db:seed` (`tsx prisma/seed.ts`).

## `apps/api/src/config/env.ts`
**Semi-spiral (2026-09-29)**: `CHAMBER_SPIRAL_TIMEOUT_MS` (default 300000) bounds one `designSemiSpiral.py` run.
**Role**: validated configuration for the whole API. Loads `.env` via `dotenv/config` (without overwriting variables already present, which vitest relies on), validates `process.env` with a zod schema, throws an `Error` listing every invalid variable, then exports a frozen object.
**Exports**:
- `Env`: type inferred from the schema.
- `env: Readonly<Env>`: 71 variables (server, JWT, CORS, storage and upload limits, OpenFOAM/Python/ParaView toolchains, snappy and cfMesh meshing, merge, chamber, CFD-Post export, solver runs and MPI, proxy, terminal, seed).
- Internal: `PROD_SECRET_MIN_LENGTH = 32`, `DEV_PLACEHOLDER_SECRETS` (the two sample JWT secrets and `ChangeMe!2026`).
**Notes**: in `production`, `superRefine` requires JWT secrets of at least 32 characters, different from each other and not equal to the placeholders, and rejects the placeholder seed password. `SEED_ADMIN_*` are mandatory even to start the server. `MESH_PYTHON_BIN` and `CHAMBER_PYTHON_BIN` have a platform-dependent default (`python` on Windows). Four variables are declared but never read: `STITCH_TOL`, `NCC_COUPLE_BIN`, `FOAM_DICTIONARY_BIN`, `POST_PROCESS_BIN`. Full table in `brain/architecture/configuration.md`.

## `apps/api/src/middleware/asyncHandler.ts`
Exports `asyncHandler(handler): RequestHandler`: wraps a possibly asynchronous handler and forwards any rejected promise to `next`, so that `errorHandler` runs. Used by all routers (including around `requireAuth`, which is itself asynchronous).

## `apps/api/src/middleware/errorHandler.ts`
**Role**: renders the normalized envelope `{ error: { code, message } }`.
**Exports**:
- `notFoundHandler(req, res)`. 404 `NOT_FOUND` with `Route not found: <METHOD> <url>`.
- `errorHandler(err, _req, res, _next)`. Status read from `status` or `statusCode` (default 500); code read from `code`, otherwise `INTERNAL_SERVER_ERROR` (500) or `ERROR`; message masked as `Internal server error` for a 500. Always logs the error via `logger.error`.
**Notes**: the `details` field of `AppError` (for example the list of zod issues built by `validate`) is never serialized: the client only receives the first summarized message. A third-party error carrying a non-HTTP `code` (for example a Node system error with no `status`) goes out as a 500 with that raw code.

## `apps/api/src/middleware/rateLimit.ts`
Exports `loginRateLimiter` (`express-rate-limit`): 10 attempts per 15 minutes per IP (1000 if `process.env.NODE_ENV === 'test'`), standard `RateLimit-*` headers, 429 `RATE_LIMITED` response. Applied only to `POST /auth/login`. The real IP behind a proxy depends on `TRUST_PROXY`.

## `apps/api/src/middleware/requireAuth.ts`
**Role**: requires an access token `Authorization: Bearer <jwt>`.
**Exports**: `requireAuth(req, _res, next): Promise<void>`. Extracts the token, verifies it (`verifyAccessToken`, 401 `UNAUTHENTICATED` if invalid), reloads the user from the database on every request, rejects a deleted or disabled account (401 `UNAUTHENTICATED`, message `This account has been disabled`), then populates `req.user` with `toPublicUser(user)`.
**Notes**: the role then used by `requireRole` comes from the database, not the token, so a role change applies on the next request. `tokenVersion` is not checked here (only refresh checks it).

## `apps/api/src/middleware/requireRole.ts`
Exports `requireRole(role: TokenRole): RequestHandler`: 401 `UNAUTHENTICATED` if `req.user` is missing, 403 `FORBIDDEN` if the role differs. Must follow `requireAuth`. Used by `users` and `audit` with `'SUPER_ADMIN'`.

## `apps/api/src/middleware/validate.ts`
**Role**: zod validation of requests.
**Exports**:
- `ValidationSchemas` (`body?`, `params?`, `query?`).
- `validate(schemas): RequestHandler`. Parses each part, rewrites `req.body` (full replacement), `req.params` and `req.query` (`Object.assign`) and stores the result in `req.validated`. A `ZodError` becomes 422 `VALIDATION_ERROR` with the first issue as the message (`path: message`) and the full list in `details`.
**Notes**: since `req.body` is replaced by the zod output, any key not declared in the schema is removed before the controller (for example `content` in `POST /projects/:id/files/content`, which the controller nevertheless reads). For `query`, `Object.assign` keeps undeclared keys.

## `apps/api/src/modules/audit/audit.controller.ts`
Exports `listAuditLogsController(req, res)`: reads `req.validated.query.limit` (fallback `AUDIT_DEFAULT_LIMIT`) and responds `200 { logs }`.

## `apps/api/src/modules/audit/audit.routes.ts`
Exports `createAuditRouter(): Router`, mounted on `/api/v1/audit-logs`. The whole router requires `requireAuth` then `requireRole('SUPER_ADMIN')`; a single route `GET /` validated by `listAuditLogsQuerySchema`.

## `apps/api/src/modules/audit/audit.schemas.ts`
Exports `AUDIT_DEFAULT_LIMIT = 50`, `AUDIT_MAX_LIMIT = 200`, `listAuditLogsQuerySchema` (`limit` coerced to an integer 1..200, default 50) and the type `ListAuditLogsQuery`.

## `apps/api/src/modules/audit/audit.service.ts`
**Role**: read-only access to the audit log (writing lives in `lib/audit`).
**Exports**:
- `PublicAuditLog` (`id`, `action`, `actorEmail`, `targetEmail`, `metadata` object or null, `createdAt` ISO). `actorId`/`targetId` are not exposed.
- `listAuditLogs(limit: number): Promise<PublicAuditLog[]>`. The `limit` most recent entries (`createdAt desc`); `metadata` re-parsed as JSON tolerantly.
**Depends on**: `lib/prisma`. **Used by**: `audit.controller`.

## `apps/api/src/modules/auth/auth.controller.ts`
**Role**: HTTP adapters for authentication; they handle the refresh cookie and auditing.
**Exports**:
- `loginController`: `login`, sets the cookie, audit `LOGIN`, `200 { accessToken, user }`.
- `refreshController`: reads the `refresh_token` cookie, `refresh`, rotates the cookie, `200 { accessToken, user }`.
- `logoutController`: `revokeRefreshTokens` (increments `tokenVersion`), clears the cookie, audit `LOGOUT`, `204`.
- `meController`: `200 { user: req.user }`.
- `updateMeController`: `updateOwnProfile`, audit `PROFILE_UPDATED`, `200 { user }`.
- `changePasswordController`: `changePassword`, re-sets the cookie at the new version (the current device stays logged in, other sessions are revoked), audit `PASSWORD_CHANGED`, `200 { accessToken, user }`.
**Depends on**: `auth.service`, `auth.cookies`, `lib/audit`. **Used by**: `auth.routes`.
**Notes**: login failures are not audited (only success is).

## `apps/api/src/modules/auth/auth.cookies.ts`
Exports `REFRESH_COOKIE_NAME = 'refresh_token'`, `setRefreshCookie(res, token)` (lifetime `REFRESH_TOKEN_TTL_DAYS` days) and `clearRefreshCookie(res)`. Common options: `httpOnly`, `sameSite: 'lax'`, `secure` in production, `path: '/api/v1/auth'` (the cookie is only sent to auth routes).

## `apps/api/src/modules/auth/auth.routes.ts`
Exports `createAuthRouter(): Router`, mounted on `/api/v1/auth`. `POST /login` (public, `loginRateLimiter`, `loginSchema`), `POST /refresh` (public, cookie), `POST /logout`, `GET /me`, `PATCH /me` (`updateMeSchema`), `POST /change-password` (`changePasswordSchema`), the last four behind `requireAuth`.

## `apps/api/src/modules/auth/auth.schemas.ts`
Exports `loginSchema` (email trim + format, non-empty password with no minimum), `updateMeSchema` (`fullName` 1..`FULL_NAME_MAX_LENGTH`), `changePasswordSchema` (`currentPassword` non-empty, `newPassword` `PASSWORD_MIN_LENGTH`..`PASSWORD_MAX_LENGTH`) and the types `LoginInput`, `UpdateMeInput`, `ChangePasswordInput`.

## `apps/api/src/modules/auth/auth.service.ts`
**Role**: Express-independent authentication logic.
**Exports**:
- `AuthResult` (`accessToken`, `refreshToken`, `user: PublicUser`).
- `login(email, password): Promise<AuthResult>`. Normalized email; identical 401 `INVALID_CREDENTIALS` for unknown email and wrong password; disabled account: 403 `ACCOUNT_DISABLED`, checked only after the password; updates `lastLoginAt`; access token `{ sub, role }`, refresh `{ sub, tokenVersion }`.
- `refresh(refreshToken?): Promise<AuthResult>`. 401 `UNAUTHENTICATED` if the cookie is missing, the token is invalid, the user is gone, `tokenVersion` differs (revoked) or the account is disabled.
- `revokeRefreshTokens(userId): Promise<void>`. Increments `tokenVersion`.
- `updateOwnProfile(userId, { fullName }): Promise<PublicUser>`.
- `changePassword(userId, currentPassword, newPassword): Promise<AuthResult>`. 401 if the account is gone, 400 `INVALID_PASSWORD` if the current password is wrong; new hash and `tokenVersion` increment; returns a new token pair.
**Depends on**: `lib/jwt`, `lib/password`, `lib/prisma`, `lib/role`, `lib/serializeUser`. **Used by**: `auth.controller`.
**Notes**: the comment on `revokeRefreshTokens` calls it "safe even if the user has been deleted", but a `prisma.user.update` on a missing id throws a Prisma error (P2025), hence a 500 (a nearly impossible case since `requireAuth` reloaded the user just before).

## `apps/api/src/modules/chamber/chamber-saves.controller.ts`
Chamber save adapters: `listChamberSavesController` (`200 { saves }`), `createChamberSaveController` (`201 { save }`), `updateChamberSaveController` (`200 { save }`), `deleteChamberSaveController` (`204`). Each builds a `Viewer` (`id`, `role`) from `req.user`.

## `apps/api/src/modules/chamber/chamber-saves.schemas.ts`
Exports `chamberSaveCreateSchema` (`name` trim 1..`CHAMBER_SAVE_NAME_MAX`, `snapshot: chamberBuildSchema`), `chamberSaveUpdateSchema` (`name?`, `snapshot?`, at least one of the two) and `chamberSaveIdParamSchema`. The snapshot is validated by the same schema as the build, so a save cannot contain a non-buildable state; the schema defaults are materialized in it.

## `apps/api/src/modules/chamber/chamber-saves.service.ts`
**Role**: named, shared saves of `POST /chamber/build` bodies. Any authenticated user lists and loads; only the author or a super-admin edits, renames or deletes.
**Exports**:
- `listChamberSaves(): Promise<ChamberSaveSummary[]>`. Sorted `updatedAt desc`, owner reduced to `{ id, fullName }`, `snapshot` re-parsed.
- `createChamberSave(viewer, input)`. 409 `NAME_TAKEN` on uniqueness violation (P2002).
- `updateChamberSave(viewer, id, input)`. 404 `NOT_FOUND`, 403 `FORBIDDEN` (not the author), 409 `NAME_TAKEN`, 404 if the row disappears between check and write (P2025).
- `deleteChamberSave(viewer, id)`. Access check then `deleteMany` (idempotent under concurrent deletion).
**Depends on**: `lib/prisma`, `@dive/shared` (types). **Used by**: `chamber-saves.controller`.

## `apps/api/src/modules/chamber/chamber.controller.ts`
**Semi-spiral (2026-09-29)**: the build response also carries `spiral` (`ChamberSpiralSummary | null`).
**Role**: adapters for the chamber generator.
**Exports**:
- `buildChamberController`: `200 { hash, outputs, warnings, stepHasVanes }`.
- `getChamberManifestController`: `200 { manifest }`.
- `getChamberGeometryController`: raw GLB `model/gltf-binary`, `Cache-Control: private, max-age=0, must-revalidate`.
- `getChamberEdgesController`: `application/octet-stream` or `204` if missing.
- `getChamberExportController`: attachment according to `EXPORT_META` (`stl`: `chamber.stl` `application/sla`; `step`: `chamber.step`; `stepMirrored`: `chamber-mirrored.step`; `trisurface`: `chamber-trisurface.zip`), `immutable` cache for one year.

## `apps/api/src/modules/chamber/chamber.routes.ts`
Exports `createChamberRouter(): Router`, mounted on `/api/v1/chamber`, entirely behind `requireAuth`. `POST /build`, then the `/saves` routes (GET, POST, PUT `/:id`, DELETE `/:id`) declared before the `/:hash` routes so that `saves` is never captured as a hash, then `GET /:hash/manifest`, `/:hash/geometry`, `/:hash/edges` and `/:hash/export/:kind`.

## `apps/api/src/modules/chamber/chamber.schemas.ts`
**Semi-spiral (2026-09-29)**: `semiSpiral` (default false) and `spiralFlowVelocity` (`CHAMBER_SPIRAL_FLOW_RANGE` 0.3..3, default 0.922); `superRefine` refuses `semiSpiral` with `feetEnabled` ("The semi-spiral casing needs Feet off for now. …", path `feetEnabled`; the API default for Feet is on).
**Role**: zod schemas for the chamber routes: build body (inputs X1..X4, constraints, relations, geometric options) and hash and export parameters.
**Exports**:
- `chamberBuildSchema`. x1/x2/x3 bounded by `CHAMBER_INPUT_RANGES`; `constraints` and `relations` as `z.record` keyed by `CHAMBER_OUTPUT_KEYS`; dimensions in positive mm bounded by `CHAMBER_DIMENSION_MAX_MM`; defaults: `relationsMaster` true, `footAngleDeg` 40, `variant` stepped, `guideVanes` false, `chamferEnabled` true, `feetEnabled` true, `vaneAngleDeg` 50 (45..55), `vaneCount` 16 (literal 16 or 18, from `CHAMBER_VANE_COUNTS`), `outletRatio` 0.45 (0.35..0.5), `partScale` 1 (> 0, ≤ 5), `simplifyGenerator` false, `coneChamferEnabled` false (+ optional `coneChamferSize` in positive mm; both designs, the foot chamfer of spec 2026-09-29-cone-foot-chamfer; its height bounds are the builder's (and, With cone, the form's), not the API's); `x4` positive ≤ `CHAMBER_X4_MAX`. `superRefine`: `hollowLength` required if `variant === 'hollow'`.
- `chamberHashParamSchema`, `chamberExportParamSchema` (`kind`: `stl`, `step`, `stepMirrored`, `trisurface`) and the associated types.
**Notes**: the `footAngleDeg` default is 40 here and in the service, whereas the `ChamberInput` documentation in `@dive/shared` says 45.

## `apps/api/src/modules/chamber/chamber.service.ts`
**Semi-spiral (2026-09-29)**: `buildChamber` computes the outputs on `chamberSpiralModelInput(input)` and, when `semiSpiral`, overlays `applyChamberSpiralToOutputs(…, null)` before the refusals (derived rows exempt); then `designSpiral(chamberSpiralInputs(…))` (internal: `spiralHash` = SHA-1 of the sorted inputs + `SPIRAL_ALGORITHM`, lock `spiral:<hash>`, cache `readChamberSpiral`, run `designSemiSpiral.py` with `CHAMBER_SPIRAL_TIMEOUT_MS`, `summarizeSpiralFailure`, `parseSpiralResult` validates 10 vertices + quality and builds the mm summary) runs BEFORE hashing; `resolveGeometryParams(input, outputs, spiral)` adds `semiSpiral` + `spiral {inputs, vertices, quality}` and leaves out `length`, B1, LT, the four chamfers and `chamferEnabled`. Spiral warnings come first in `warnings.json`; `ChamberBuildResult.spiral` = summary or null.
**Role**: evaluates the empirical model (`@dive/shared`) then delegates geometry to `scripts/buildChamber.py` (CadQuery). Builds are keyed by a parameter hash, stored under `<STORAGE_DIR>/chamber/<hash>` and shared by the whole team.
**Exports**:
- `ChamberBuildResult` (`hash`, `outputs`, `warnings`, `stepHasVanes: boolean | null`).
- `buildChamber(input: ChamberInput): Promise<ChamberBuildResult>`. Computes the outputs; rejects with 422 `VALIDATION_ERROR` non-positive final dimensions (chamfers exempted if `chamferEnabled === false`), Min > Max ranges, the blank-generator minimum (`blankGeneratorHeightRefusal`) and, with guide vanes, a typed Runner case Ø more than 5 mm below LE Ø (`runnerCaseBelowLeRefusal`, spec 2026-09-29); builds the parameters in meters (`resolveGeometryParams`), computes the hash, then under a per-hash lock: returns the cache if the GLB exists, otherwise writes `params`, launches `CHAMBER_PYTHON_BIN script params dir` with `CHAMBER_BUILD_TIMEOUT_MS`, and persists `WARN:`/`WARNING:` warnings. Errors: 500 `SCRIPT_MISSING`, 502 `CHAMBER_BUILD_FAILED`.
- `getChamberManifest(hash)` and `getChamberGeometry(hash)`. 409 `CHAMBER_NOT_BUILT` if missing.
- `getChamberEdges(hash): Promise<Buffer | null>`.
- `getChamberExport(hash, kind)`. Reads the artifact; for missing `step` and `stepMirrored`, generates on demand under the lock (re-runs the builder with `--step`, then `mirrorStep.py` for the mirrored version, allowed only if `stepHasVanes === true`, otherwise 409 `CHAMBER_NOT_BUILT`). 404 `NOT_FOUND` if still missing.
- Internal: `withChamberLock(hash, fn)` (mutex via promise chain, in process memory), `extractBuilderWarnings`, `buildChamberScript`, `mirrorStepScript`, `summarizeFailure(result, action)` (a `KO:` line is shown alone as "Cannot <action>. …"; otherwise spawn / timeout / exit-code messages with a "Technical details" tail), `resolveGeometryParams` (default length `2 × width`, `outletOuterD = X1`, `dFirst`/`dMiddle` not scaled, hollow variant: generator parameters taken from `computeChamberGeneratorDims`, heights omitted if `simplifyGenerator`, `coneChamferEnabled: true` + `coneChamferSize` (m, from `chamberConeChamferMm`, blank = `CHAMBER_CONE_CHAMFER_SIZE_MM`) passed only when the Cone chamfer is on, both designs; `vaneCount` passed only when guide vanes and not 16, so 16-vane and vane-less keys never change), `generateStep`, `generateMirroredStep`.
**Depends on**: `@dive/shared`, `lib/commandRunner`, `lib/chamberStorage`, `config/env`. **Used by**: `chamber.controller`; `lib/chamberStorage.readChamberExport` also serves `meshing.service` (transfer into a session).
**Notes**: `x4` never enters the hash (only resolved dimensions do). The lock is process-local: several API instances could build the same hash in parallel.

## `apps/api/src/modules/dashboard/dashboard.controller.ts`
Exports `getDashboardController`: builds the `Viewer` and responds `200` with `getDashboard(viewer)`.

## `apps/api/src/modules/dashboard/dashboard.routes.ts`
Exports `createDashboardRouter()`, mounted on `/api/v1/dashboard`: `requireAuth` then `GET /`.

## `apps/api/src/modules/dashboard/dashboard.service.ts`
**Role**: single aggregate queried by the home page: machine metrics (`node:os`) and runs visible to the user.
**Exports**:
- `ServerMetrics` (`cpuPercent`, `cores`, `memUsedBytes`, `memTotalBytes`, `loadAvg1`, `uptimeSec`), `DashboardRun`, `DashboardProject` (`runCount`, `converged` = converged+completed, `diverged` = diverged+failed, `other`), `DashboardData` (`metrics`, `activeRuns`, `recentRuns`, `runCounts`, `recentProjects`).
- `getDashboard(viewer): Promise<DashboardData>`. CPU sampled over about 150 ms; at most 12 active runs (`startedAt desc`), 8 recent runs, per-status counts initialized to 0 for each `RUN_STATUSES`, 6 recent projects with their counters.
**Notes**: visibility is duplicated locally (`projectVisibilityWhere`) with the same rule as `listProjects` (owner, collaborator or super-admin).

## `apps/api/src/modules/meshing/meshing.controller.ts`
**Role**: adapters for the Meshing page (global sessions, not tied to a project).
**Exports**: `listSessionsController` (`{ sessions }`), `createSessionController` (201), `copySessionController` (201), `fromChamberController` (201), `getSessionController`, `renameSessionController`, `deleteSessionController` (`200 { ok: true }`), `uploadStlController` (multipart fields `files` or `stl`; 400 `NO_STL` if empty; 201), `downloadStlController` (`application/sla`), `deleteStlController`, `runSnappyController` (`202 { session, status }`), `getRunLogController` (`{ log }`), `stopRunController`, `saveConfigController`, `getMeshManifestController`, `getMeshGeometryController` (GLB), `getMeshEdgesController` (204 if missing), `downloadSessionController` (zip `meshing-<id>.zip`).

## `apps/api/src/modules/meshing/meshing.routes.ts`
Exports `createMeshingRouter()`, mounted on `/api/v1/meshing`, behind `requireAuth`: `GET /`, `POST /`, `POST /copy`, `POST /from-chamber`, `GET|PATCH|DELETE /:id`, `POST|GET|DELETE /:id/stl`, `POST /:id/run`, `GET /:id/run/log`, `POST /:id/run/stop`, `PUT /:id/config`, `GET /:id/mesh/{manifest,geometry,edges}`, `GET /:id/download`. Upload reuses `parseCaseUpload` from the projects module.

## `apps/api/src/modules/meshing/meshing.schemas.ts`
**Role**: zod schemas for the meshing routes: session creation, rename and copy, transfer from Chamber, snappy/cfMesh configuration.
**Exports**:
- `createSessionSchema` (`name` 1..120, `engine` default `snappy`), `renameSessionSchema`, `copySessionSchema` (`sourceId`, `name?`).
- `fromChamberSchema`. Discriminated union on `mode`: `new` (`chamberHash`, `name`, `engine`), `existing` (`chamberHash`, `sessionId`), `copyFrom` (`chamberHash`, `sourceId`, `name?`).
- `sessionIdParamSchema`, `stlNameQuerySchema` (`name`).
- `runSnappySchema` (integer refinement levels 0..10 with `max >= min`, layers 1..20, ratio 1..5, `cores` 1..1024) and `runCfMeshSchema` (positive or null sizes, `patchTypes` restricted to `CFMESH_PATCH_TYPES`, `localRefinement`, `perPatch`, `noLayerPatches`), combined in `meshingConfigSchema` (discriminated union on `engine`).
- Types `CreateSessionInput`, `RenameSessionInput`, `CopySessionInput`, `FromChamberInput`, `StlNameQuery`, `RunSnappyInput`, `RunCfMeshInput`, `MeshingConfigInput`.

## `apps/api/src/modules/meshing/meshing.service.ts`
**Role**: logic for standalone mesh sessions (STL/FMS to snappyHexMesh or cfMesh to `constant/polyMesh`). Each session is a disposable OpenFOAM case under `<STORAGE_DIR>/meshing/<id>`, with no database row; access is controlled only by authentication (sessions shared by the whole team).
**Exports**:
- `StlUpload` (`name`, `data`).
- `listMeshingSessions()`, `createMeshingSession(name, engine)`, `getMeshingSession(id)`, `renameMeshingSession(id, name)`, `copyMeshingSession(sourceId, name?)`, `removeMeshingSession(id)` (first kills an active run with SIGKILL). 404 `NOT_FOUND` if the session is missing.
- `importChamberIntoMeshing(input: FromChamberInput)`. Reads the build's `trisurface` zip (409 `CHAMBER_NOT_BUILT` if missing), extracts the per-patch STLs except `domain.stl` (422 `INVALID_STL` if none), then goes through `addStlFiles` on a new, existing or copied session.
- `addStlFiles(id, uploads)`. snappy: only readable `.stl`; cfMesh: `.stl` files or a single `.fms`, never both. Errors 400 `NO_STL`, 422 `INVALID_STL`.
- `readStlBytes(id, name)`, `removeStlFile(id, name)` (404 if the file is missing).
- `isMeshRunActive(id): boolean`.
- `isSessionRunning(id): Promise<boolean>`. Registry entry OR persisted `status.json` `running`.
- `requireMeshedSession(id): Promise<MeshingMeta>`. Gate of the meshing -> project hand-off: 404 `NOT_FOUND` "Meshing session not found.", 409 `MESH_IN_PROGRESS`, 409 `MESHING_NOT_MESHED` (no complete polyMesh, `hasCompleteResultMesh`). Used by `projects/mesh.service.importMeshFromMeshing`.
- `startMeshingRun(id, config)`. Checks the engine (400 `ENGINE_MISMATCH`), one run per session (409 `MESH_IN_PROGRESS`), at least one surface (400 `NO_STL`), readable bounds for snappy; caps cores to the machine budget (`coreBudget`); registers the run in memory, resets `mesh.log`, writes `status.json` (`running`) and the config, then launches `finishMeshingRun` in the background (snappy or cfMesh pipeline, report, terminal status `succeeded`/`failed`/`stopped`, removal of the stale render).
- `getMeshingLog(id): Promise<MeshingLogPayload>`. Reads at most `SOLVER_LOG_MAX_BYTES` of the log and returns its last 20,000 characters; the report is attached only once the run has finished.
- `stopMeshingRun(id)`. Marks the stop, SIGTERM then SIGKILL after `RUN_STOP_GRACE_MS`; with no live process, flips an orphaned `running` status to `stopped`. Idempotent.
- `reconcileOrphanMeshingRuns(): Promise<number>`. At startup, sets sessions left `running` to `failed`.
- `saveMeshingConfig(id, config)`. Autosave (same engine check and core capping).
- `getResultManifest(id)` (409 `NO_MESH` without polyMesh; builds the render via `extractPatches.py` if stale; 500 `SCRIPT_MISSING`, 502 `MESH_BUILD_FAILED`), `getResultGeometry(id)` (409 `MESH_NOT_BUILT`), `getResultEdges(id)`, `downloadSessionZip(id)`.
**Depends on**: `lib/meshingStorage`, `lib/meshingVizStorage`, `lib/snappyPipeline`, `lib/cfMeshPipeline`, `lib/stlBounds`, `lib/meshPatches`, `lib/stlMerge`, `lib/chamberStorage`, `lib/cores`, `lib/commandRunner`, `adm-zip`. **Used by**: `meshing.controller`, `server.ts` (reconciliation).
**Notes**: the active run registry is in memory: a restart loses the processes (hence the reconciliation). `reconcileOrphanMeshingRuns` returns the number of ids listed by `listRunningSessionIds`, not the number actually modified.

## `apps/api/src/modules/templates/templates.controller.ts`
**Role**: adapters for shared file templates, plus three handlers mounted on the projects router.
**Exports**: `listTemplatesController` (`{ templates }`), `getTemplateController`, `createTemplateController` (201), `updateTemplateController`, `deleteTemplateController` (204), `getTemplateFilesController` (`{ entries }`), `importTemplateFilesController` (`archive` field for a zip, otherwise `files` fields; `201 { written, entries }`), `getTemplateFileContentController` (`{ file }`), `saveTemplateFileContentController` (raw text body), `createTemplateFileController` (201), `deleteTemplateFileController`, `deleteTemplateDirController`, `moveTemplateEntryController`, and for `/projects/:id/apply-template/:templateId`: `previewApplyTemplateController` (`{ preview }`), `applyTemplateController`, `applyTemplateFilesController`.

## `apps/api/src/modules/templates/templates.routes.ts`
Exports `createTemplatesRouter()`, mounted on `/api/v1/templates`, behind `requireAuth`. CRUD `/` and `/:id`, files `/:id/files`, `/:id/files/import` (`parseCaseUpload`), `/:id/files/content` (GET, PUT with `express.text({ type: '*/*', limit: EDITABLE_FILE_MAX_BYTES })`, POST, DELETE), `/:id/files/dir` (DELETE), `/:id/files/move` (POST). Reuses `filePathQuerySchema` and `movePathSchema` from the projects module.

## `apps/api/src/modules/templates/templates.schemas.ts`
Exports `createTemplateSchema` (`name`, `description?`, raw `tags?` up to 24 items of 72 characters, `file?` `{ path, content }`), `updateTemplateSchema` (at least one field), `templateIdParamSchema`, `createFileSchema` (`path`), `applyDecisionSchema` (`overwrite|keep`), `applyDecisionsSchema` (`decisions?` as a record), `applyTemplateFilesSchema` (`paths` 1..1000), `applyTemplateParamSchema` (`id`, `templateId`) and the associated types.

## `apps/api/src/modules/templates/templates.service.ts`
**Role**: shared reusable templates. Reading and applying are open to any authenticated user; editing is reserved for the author or a super-admin (`canManageTemplate`, 403 `FORBIDDEN`); applying to a project is controlled by project visibility (`assertProjectVisible`).
**Exports**:
- `UserSummary`, `PublicTemplate` (`tags` re-parsed), `TemplateFileContent`, `TemplateImportResult`, `ApplyPreview` (`files`, `conflicts`, `newFiles`), `ApplyResult` (`applied`, `skipped`, `entries`).
- `listTemplates()` (`createdAt desc`), `getTemplate(id)`, `createTemplate(viewer, input)` (tags normalized by `normalizeTags`; optional initial file, 413 `FILE_TOO_LARGE` above 2 MB), `updateTemplate`, `deleteTemplate` (best-effort disk removal).
- `getTemplateFiles(id)`, `importTemplateFiles(viewer, id, payload)` (400 `NO_FILES_UPLOADED`), `readTemplateFileContent` (404, 413), `saveTemplateFileContent` (404 if the file does not exist, 413), `createTemplateFile` (409 `FILE_EXISTS`, 413), `deleteTemplateFileContent`, `deleteTemplateDirContent`, `moveTemplateEntry`.
- `previewApplyTemplate(viewer, projectId, templateId)`, `applyTemplate(viewer, projectId, templateId, decisions)` (conflicts recomputed server-side; an existing file is overwritten only if the decision is `overwrite`; binary copy with no size cap), `applyTemplateFiles(viewer, projectId, templateId, paths)` (always overwrites the chosen paths present in the template, the others are `skipped`).
**Depends on**: `lib/templateStorage`, `lib/caseStorage`, `lib/fileTreeStorage.sanitizeRelative`, `projects.service`. **Used by**: `templates.controller`.
**Notes**: `createTemplate` creates the database row before checking the size of the initial file: a 413 leaves an empty template created. The JSON creation body goes through the global 16 KB limit, which in practice caps the initial file well below 2 MB.

## `apps/api/src/modules/users/users.controller.ts`
Back-office adapters: `listUsersController` (`{ users }`), `getUserController`, `createUserController` (201), `updateUserController`, `deleteUserController` (204). `requireActor` provides `{ id, email }` for the guards and the audit.

## `apps/api/src/modules/users/users.routes.ts`
Exports `createUsersRouter()`, mounted on `/api/v1/users`, entirely behind `requireAuth` + `requireRole('SUPER_ADMIN')`: `GET /`, `POST /`, `GET|PATCH|DELETE /:id`.

## `apps/api/src/modules/users/users.schemas.ts`
Exports `roleSchema` (re-export), `createUserSchema` (`fullName`, `email`, `password`, `role`, all required), `updateUserSchema` (same fields optional plus `isActive?`, at least one field), `userIdParamSchema` and the types `CreateUserInput`, `UpdateUserInput`, `UserIdParam`.

## `apps/api/src/modules/users/users.service.ts`
**Role**: account management by the super-admin, with hard rules: unique lowercase email, protected super-admin cannot be demoted, disabled or deleted, users cannot disable or delete themselves. Every mutation is audited.
**Exports**:
- `Actor` (`id`, `email`).
- `listUsers()`. Sort: protected first, then role alphabetically (`SUPER_ADMIN` before `USER`), then seniority.
- `getUser(id)`. 404 `NOT_FOUND`.
- `createUser(input, actor)`. 409 `EMAIL_TAKEN`; `isProtected` always false; audit `USER_CREATED`.
- `updateUser(id, input, actor)`. 409 `PROTECTED_ROLE`, `PROTECTED_ACCOUNT`, `SELF_DISABLE_FORBIDDEN`, `EMAIL_TAKEN`; increments `tokenVersion` on an effective role change, new password or deactivation; audit `USER_DISABLED`, `USER_ENABLED` or `USER_UPDATED` (changed fields, `roleFrom`/`roleTo`).
- `deleteUser(id, actor)`. 409 `PROTECTED_ACCOUNT`, `SELF_DELETE_FORBIDDEN`; stops runs of owned projects, deletes the user (database cascade), best-effort cleanup of storage for owned projects and templates; audit `USER_DELETED`.
**Depends on**: `lib/prisma`, `lib/password`, `lib/audit`, `lib/caseStorage`, `lib/templateStorage`, `projects/runs.service.stopProjectRuns`. **Used by**: `users.controller`.
**Notes**: deleting a user also cascade-deletes their chamber saves, even though they are shared with the team.

## `apps/api/src/types/express.d.ts`
Global augmentation of `Express.Request`: `user?: PublicUser & { role: Role }` (set by `requireAuth`) and `validated?: { body?, params?, query? }` (set by `validate`).

## `apps/api/src/app.ts`
**Role**: factory for the Express application, without listening (imported directly by the supertest tests).
**Exports**: `createApp(): Express`. `trust proxy` = `TRUST_PROXY`; `helmet()`; `cors({ origin: CORS_ORIGIN, credentials: true })`; `express.json({ limit: '16kb' })`; `cookieParser()`; `GET /health` (`{ status: 'ok' }`); public `GET /api/v1/config` (`{ terminalEnabled }`); routers `auth`, `users`, `audit-logs`, `projects`, `templates`, `meshing`, `chamber`, `dashboard` under `/api/v1`; then `notFoundHandler` and `errorHandler`.
**Used by**: `server.ts`, tests.

## `apps/api/src/server.ts`
**Role**: process bootstrap. Creates the app, launches `reconcileOrphanRuns()` (active solver runs from a previous process set to `failed`) and `reconcileOrphanMeshingRuns()` without awaiting them, listens on `env.PORT`, then `attachTerminalGateway(server)` (no-op if `TERMINAL_ENABLED` is `false`).
**Depends on**: `app`, `config/env`, `lib/logger`, `projects/runs.service`, `meshing/meshing.service`, `projects/terminal.gateway`.

## `apps/api/.env.example`
**Since 2026-09-29**: a `Chamber Creation` block documents `CHAMBER_SPIRAL_TIMEOUT_MS=300000` (the other chamber variables are still missing, K33).
Template of the API environment variables, grouped by feature with operational comments (target Debian, OpenFOAM ESI, xvfb for pvbatch, OpenMPI flags, terminal disabled by default, `TRUST_PROXY`, seed). Eleven schema variables are missing from it (`MAX_UPLOAD_TOTAL_MB`, `MAX_ARCHIVE_UNCOMPRESSED_MB`, `BLOCK_MESH_BIN`, `SURFACE_FEATURE_BIN`, `SNAPPY_HEX_MESH_BIN`, `SNAPPY_STEP_TIMEOUT_MS`, `CHAMBER_PYTHON_BIN`, `BUILD_CHAMBER_SCRIPT`, `MIRROR_STEP_SCRIPT`, `CHAMBER_BUILD_TIMEOUT_MS`, `SOLVER_DECOMPOSE_TIMEOUT_MS`), despite the "Keep this in sync" instruction in `env.ts`. The `NCC_COUPLE_BIN` comment still describes the OpenFOAM.org v12 utility, whereas the current coupling is a textual cyclicAMI retyping.

## `apps/api/package.json`
**Role**: package `@dive/api` (CommonJS). Scripts: `dev` (`tsx watch src/server.ts`), `postinstall` and `prisma:generate` (`prisma generate`), `build` (generate + `tsc`), `start` (`prisma migrate deploy && node dist/server.js`), `typecheck`, `test` (`vitest run`), `db:migrate` (`prisma migrate dev`), `db:deploy`, `db:seed`, `db:reset` (`prisma migrate reset --force`).
**Dependencies**: `@dive/shared`, `@prisma/client` 5, `express` 4, `helmet`, `cors`, `cookie-parser`, `express-rate-limit`, `jsonwebtoken`, `argon2`, `multer` 2, `adm-zip`, `ws`, `zod`, `dotenv`; optional: `node-pty` (PTY terminal, otherwise falls back to a "piped" shell). Dev: `prisma`, `vitest` 2, `supertest`, `tsx`, types.

## `apps/api/tsconfig.json`
Extends the base; `module: CommonJS`, `moduleResolution: Node`, `outDir: dist`, `rootDir: src`, `lib: ES2022`, `types: ["node"]`. The Python scripts (`apps/api/scripts`) are not compiled, hence paths resolved as `../../../scripts/…` from `src` as well as from `dist`.

## `apps/api/vitest.config.ts`
**Role**: API test configuration. `node` environment, variables injected via `test.env` (which win over `.env` because `dotenv` does not overwrite): `NODE_ENV=test`, `DATABASE_URL=file:./test.db` (hence `prisma/test.db`), test JWT secrets, `STORAGE_DIR=./test-storage`, scripts `CGNS_TO_VTK_SCRIPT` and `EXTRACT_PATCHES_SCRIPT` pointed at stubs in `tests/fixtures`, `RUN_STOP_GRACE_MS=50`, `SOLVER_TOTAL_CORES=8`, test seed credentials.
**Notes**: `globalSetup: ./tests/globalSetup.ts`, `fileParallelism: false` (a single shared SQLite database), `include: tests/**/*.test.ts`, `testTimeout` 20 s (argon2 intentionally slow), `hookTimeout` 30 s.
