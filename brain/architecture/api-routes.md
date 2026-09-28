# REST and WebSocket API routes

> Sources: `apps/api/src/app.ts`, `apps/api/src/middleware/**`, `apps/api/src/modules/*/*.routes.ts`, associated controllers and schemas, `apps/api/src/modules/projects/terminal.gateway.ts` · Updated: 2026-09-28

## Common conventions

**Prefix**: all business routes live under `/api/v1` (routers mounted in `createApp()`). Outside the prefix: `GET /health`. The web client and the MCP server configure a base URL that already includes `/api/v1` (`VITE_API_URL`, `DIVE_API_URL`).

**Error envelope**: always `{ "error": { "code": string, "message": string } }`.
- `AppError(status, code, message)` carries the status and code; `errorHandler` masks the message of 500s (`Internal server error`, code `INTERNAL_SERVER_ERROR`). The `details` field of an `AppError` is never returned.
- zod validation (`validate`): 422 `VALIDATION_ERROR`, message = first issue (`path: message`).
- Unknown route: 404 `NOT_FOUND` (`Route not found: <METHOD> <url>`).
- Multipart upload (`parseCaseUpload`): 413 `PAYLOAD_TOO_LARGE` if `Content-Length` exceeds `MAX_UPLOAD_TOTAL_MB` or if a file exceeds `MAX_UPLOAD_MB`; any other multer error: 400 `INVALID_ARCHIVE`. Limit of 5000 files, file names kept with their path (`preservePath`).
- JSON body limited to 16 kB (`express.json`); file content saves use a dedicated text parser (`express.text({ type: '*/*' })`, limit `EDITABLE_FILE_MAX_BYTES` = 2 MB).

**Authentication**:
- JWT access token in `Authorization: Bearer <token>` (lifetime `ACCESS_TOKEN_TTL`, 15 min by default), checked by `requireAuth`, which reloads the user from the database on every request (401 `UNAUTHENTICATED` if the token is missing/invalid, or the account is deleted or disabled).
- Refresh token in the httpOnly cookie `refresh_token` (SameSite Lax, Secure in production, path `/api/v1/auth`), exchanged via `POST /auth/refresh`.
- `requireRole('SUPER_ADMIN')`: 403 `FORBIDDEN` for any other role.
- **Project visibility**: under `/projects/:id/**`, the service checks owner, collaborator or super-admin (`assertProjectVisible`), otherwise 404 `NOT_FOUND`. "Manage" (rename, delete, collaborators): owner or super-admin, otherwise 403 `FORBIDDEN`.
- **Ownership** (templates, chamber saves): read open to any authenticated user, write restricted to the author or a super-admin (403 `FORBIDDEN`).
- Only rate-limited route: `POST /auth/login` (10 attempts / 15 min / IP, 429 `RATE_LIMITED`).

Access column legend: **Public** = no token; **Auth** = `requireAuth`; **Admin** = `requireAuth` + `requireRole('SUPER_ADMIN')`; **Visible** = Auth + project visibility; **Manage** = Auth + project owner/super-admin; **Author** = Auth + resource author/super-admin.

## System

| Method | Path | Access | Handler | Response |
|---------|--------|-------|---------|---------|
| GET | `/health` | Public | inline `app.ts` | `200 { status: 'ok' }` |
| GET | `/api/v1/config` | Public | inline `app.ts` | `200 { terminalEnabled: boolean }` (public flags read by the web app on load) |

## Auth (`/api/v1/auth`, `auth.routes.ts`)

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| POST | `/api/v1/auth/login` | Public + `loginRateLimiter` | `loginController` → `login` | body `loginSchema` (`email`, `password`) | `200 { accessToken, user }` + refresh cookie; audit `LOGIN` | 401 `INVALID_CREDENTIALS`, 403 `ACCOUNT_DISABLED`, 429 `RATE_LIMITED` |
| POST | `/api/v1/auth/refresh` | Public (cookie) | `refreshController` → `refresh` | none | `200 { accessToken, user }` + rotated cookie | 401 `UNAUTHENTICATED` (cookie missing, revoked, account disabled) |
| POST | `/api/v1/auth/logout` | Auth | `logoutController` → `revokeRefreshTokens` | none | `204` + cookie cleared; audit `LOGOUT` | 401 |
| GET | `/api/v1/auth/me` | Auth | `meController` | none | `200 { user }` | 401 |
| PATCH | `/api/v1/auth/me` | Auth | `updateMeController` → `updateOwnProfile` | body `updateMeSchema` (`fullName`) | `200 { user }`; audit `PROFILE_UPDATED` | 422 |
| POST | `/api/v1/auth/change-password` | Auth | `changePasswordController` → `changePassword` | body `changePasswordSchema` (`currentPassword`, `newPassword` 8..200) | `200 { accessToken, user }` + reissued cookie; audit `PASSWORD_CHANGED` | 400 `INVALID_PASSWORD`, 422 |

## Users (`/api/v1/users`, `users.routes.ts`)

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| GET | `/api/v1/users` | Admin | `listUsersController` → `listUsers` | none | `200 { users }` | 403 |
| POST | `/api/v1/users` | Admin | `createUserController` → `createUser` | body `createUserSchema` (`fullName`, `email`, `password`, `role`) | `201 { user }`; audit `USER_CREATED` | 409 `EMAIL_TAKEN` |
| GET | `/api/v1/users/:id` | Admin | `getUserController` → `getUser` | params `userIdParamSchema` | `200 { user }` | 404 `NOT_FOUND` |
| PATCH | `/api/v1/users/:id` | Admin | `updateUserController` → `updateUser` | params + body `updateUserSchema` (optional fields + `isActive`, at least one) | `200 { user }`; audit `USER_UPDATED`/`USER_DISABLED`/`USER_ENABLED` | 404, 409 `PROTECTED_ROLE`, `PROTECTED_ACCOUNT`, `SELF_DISABLE_FORBIDDEN`, `EMAIL_TAKEN` |
| DELETE | `/api/v1/users/:id` | Admin | `deleteUserController` → `deleteUser` | params | `204`; audit `USER_DELETED` | 404, 409 `PROTECTED_ACCOUNT`, `SELF_DELETE_FORBIDDEN` |

## Audit (`/api/v1/audit-logs`, `audit.routes.ts`)

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/audit-logs` | Admin | `listAuditLogsController` → `listAuditLogs` | query `listAuditLogsQuerySchema` (`limit` 1..200, default 50) | `200 { logs }` (most recent first) |

## Dashboard (`/api/v1/dashboard`, `dashboard.routes.ts`)

| Method | Path | Access | Controller → service | Response |
|---------|--------|-------|----------------------|---------|
| GET | `/api/v1/dashboard` | Auth (data filtered by project visibility) | `getDashboardController` → `getDashboard` | `200 { metrics, activeRuns, recentRuns, runCounts, recentProjects }` |

## Projects (`/api/v1/projects`, `projects.routes.ts`)
The whole router sits behind `requireAuth`. Unless stated otherwise, params are validated by `projectIdParamSchema` (`id`). The "notable" codes of the files, CGNS, meshes, BC, runs and export subgroups come from the projects module services (collected by search; their exact per-route attribution is to verify in the module's codemap sheets).

### Project and collaborators

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| GET | `/api/v1/projects` | Auth (filtered list) | `listProjectsController` → `listProjects` | none | `200 { projects }` | |
| POST | `/api/v1/projects` | Auth | `createProjectController` → `createProject` | body `createProjectSchema` (`title` 1..120) | `201 { project }` | 422 |
| GET | `/api/v1/projects/:id` | Visible | `getProjectController` → `getProject` | params | `200 { project }` | 404 |
| PATCH | `/api/v1/projects/:id` | Manage | `renameProjectController` → `renameProject` | params + body `renameProjectSchema` (`title`) | `200 { project }` | 403, 404 |
| DELETE | `/api/v1/projects/:id` | Manage | `deleteProjectController` → `deleteProject` | params | `204` (stops runs, deletes storage) | 403, 404 |
| POST | `/api/v1/projects/:id/collaborators` | Manage | `addCollaboratorController` → `addCollaborator` | params + body `addCollaboratorSchema` (`email`) | `200 { project }` | 403, 404 `USER_NOT_FOUND`, 409 `COLLABORATOR_EXISTS` |
| DELETE | `/api/v1/projects/:id/collaborators/:userId` | Manage | `removeCollaboratorController` → `removeCollaborator` | params `collaboratorParamSchema` | `200 { project }` | 403, 404 |

### Case files
Codes found in `files.service`: 400 `NO_FILES_UPLOADED`, 404 `NOT_FOUND`, 409 `FILE_EXISTS`, 409 `NO_MESH`, 413 `FILE_TOO_LARGE`; in `lib/fileTreeStorage`: 400 `INVALID_ARCHIVE`, 400 `VALIDATION_ERROR` (invalid path), 413 `ARCHIVE_TOO_LARGE`.

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/projects/:id/files` | Visible | `getCaseFilesController` → `getCaseFiles` | params | `200 { entries }` |
| DELETE | `/api/v1/projects/:id/files` | Visible | `resetCaseController` → `resetCase` | params | `200` (service result) |
| POST | `/api/v1/projects/:id/files/import` | Visible | `parseCaseUpload` then `importCaseFilesController` → `importCaseFiles` | params; multipart `archive` (zip) or `files` (folder) | `201 { written, entries }` |
| GET | `/api/v1/projects/:id/files/download` | Visible | `downloadCaseController` → `buildCaseArchive` | params | `200` zip `case-<id>.zip` |
| GET | `/api/v1/projects/:id/files/verify` | Visible | `verifyCaseController` → `verifyCase` | params | `200 { verification }` |
| POST | `/api/v1/projects/:id/files/scaffold` | Visible | `scaffoldCaseController` → `scaffoldCase` | params | `201` (result) |
| GET | `/api/v1/projects/:id/runnable` | Visible | `verifyRunnableController` → `verifyRunnable` | params | `200 { runnable }` |
| POST | `/api/v1/projects/:id/runnable/scaffold` | Visible | `scaffoldSolverController` → `scaffoldSolver` | params + body `scaffoldSolverSchema` (`solver?` ∈ `SOLVER_IDS`, `turbulence?` ∈ `TURBULENCE_MODEL_IDS`, missing body tolerated) | `201` (result) |
| POST | `/api/v1/projects/:id/files/sync-boundaries` | Visible | `syncBoundariesController` → `syncBoundaryFields(…, { mode: 'merge' })` | params | `200` (result) |
| GET | `/api/v1/projects/:id/files/content?path=` | Visible | `getCaseFileContentController` → `readCaseFileContent` | params + query `filePathQuerySchema` | `200 { file }` |
| PUT | `/api/v1/projects/:id/files/content?path=` | Visible | `parseFileContent` then `saveCaseFileContentController` → `saveCaseFileContent` | params + query; raw text body ≤ 2 MB | `200 { file }` |
| POST | `/api/v1/projects/:id/files/content` | Visible | `createCaseFileController` → `createCaseFile` | params + body `createFileSchema` (`path`) | `201` (result) |
| DELETE | `/api/v1/projects/:id/files/content?path=` | Visible | `deleteCaseFileController` → `deleteCaseFileContent` | params + query | `200` (result) |
| DELETE | `/api/v1/projects/:id/files/dir?path=` | Visible | `deleteCaseDirController` → `deleteCaseDirContent` | params + query | `200` (result) |
| POST | `/api/v1/projects/:id/files/move` | Visible | `moveCaseEntryController` → `moveCaseEntry` | params + body `movePathSchema` (`from`, `to`) | `200` (result) |

Pitfall: `createCaseFileController` reads an optional `content` from the body, but `createFileSchema` does not declare it and `validate` replaces `req.body` with the zod output, so `content` is always stripped.

### CGNS and conversion
Codes found in `conversion.service`: 400 `INVALID_CGNS`, 404 `NOT_FOUND`.

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/projects/:id/cgns` | Visible | `listCgnsController` → `listCgns` | params | `200 { files }` |
| POST | `/api/v1/projects/:id/cgns` | Visible | `parseCaseUpload` then `uploadCgnsController` → `uploadCgns` | params; multipart `file` (otherwise first file) | `201` (result); 400 `NO_FILES_UPLOADED` |
| DELETE | `/api/v1/projects/:id/cgns?name=` | Visible | `deleteCgnsController` → `removeCgns` | params + query `cgnsNameQuerySchema` | `200` (result) |
| POST | `/api/v1/projects/:id/cgns/convert` | Visible | `convertCgnsController` → `convertCgnsToFoam` | params + body `convertCgnsSchema` (`cgnsFile`, `templateId`) | `200 { result }` (per-step report) |

### Mesh library and assembly
Codes found in `meshes.service`: 400 `NO_FILES_UPLOADED`, 400/409 `NO_MESH`, 404 `NOT_FOUND`, 409 `NO_MESHES`, 409 `PATCH_EXISTS`, 422 `INVALID_MERGE_PLAN`, 422 `STITCH_PATCH_NOT_FOUND`, 422 `VALIDATION_ERROR`, 500 `SCRIPT_MISSING`, 502 `MESH_BUILD_FAILED`. The static routes (`import`, `plan`, `merge`, `assembly`) are declared before `/:meshId`. The `/:meshId` routes validate `meshIdParamSchema` (`id`, `meshId`).

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/projects/:id/meshes` | Visible | `listMeshesController` → `listMeshes` | params | `200 { meshes }` |
| POST | `/api/v1/projects/:id/meshes/import` | Visible | `parseCaseUpload` then `importMeshController` → `importMesh` | params; multipart `meshFile` (.cgns/.msh), `archive` (zip) or `files` (folder), text field `name?` | `201` (result) |
| GET | `/api/v1/projects/:id/meshes/plan` | Visible | `getMergePlanController` → `getMergePlan` | params | `200 { plan }` (or null) |
| PUT | `/api/v1/projects/:id/meshes/plan` | Visible | `saveMergePlanController` → `saveMergePlan` | params + body `mergePlanSchema` | `200 { plan }` |
| POST | `/api/v1/projects/:id/meshes/merge` | Visible | `mergeMeshesController` → `runMerge` | params + body `mergePlanSchema` (`order` ≥ 1, `interfaces`, `stitches`, `transforms`; `nonConformalCyclic` normalized) | `200 { result }` |
| GET | `/api/v1/projects/:id/meshes/assembly` | Visible | `getAssemblyController` → `getAppliedAssembly` | params | `200 { assembly }` (or null) |
| GET | `/api/v1/projects/:id/meshes/:meshId/patches` | Visible | `getMeshPatchesController` → `getMeshPatches` | `meshIdParamSchema` | `200 { patches }` |
| GET | `/api/v1/projects/:id/meshes/:meshId/manifest` | Visible | `getMeshSourceManifestController` → `getMeshSourceManifest` | `meshIdParamSchema` | `200 { manifest }` (render built on demand) |
| GET | `/api/v1/projects/:id/meshes/:meshId/geometry` | Visible | `getMeshSourceGeometryController` → `getMeshSourceGeometry` | `meshIdParamSchema` | `200` GLB `model/gltf-binary` |
| GET | `/api/v1/projects/:id/meshes/:meshId/edges` | Visible | `getMeshSourceEdgesController` → `getMeshSourceEdges` | `meshIdParamSchema` | `200` octet-stream or `204` |
| POST | `/api/v1/projects/:id/meshes/:meshId/auto-patch` | Visible | `autoPatchMeshSourceController` → `autoPatchMeshSource` | `meshIdParamSchema` + body `meshSourceAutoPatchSchema` (`featureAngle` 0..180, required) | `200` (result) |
| POST | `/api/v1/projects/:id/meshes/:meshId/patches/rename` | Visible | `renameMeshSourcePatchController` → `renameMeshSourcePatch` | `meshIdParamSchema` + body `meshSourceRenamePatchSchema` (`from`, `to`) | `200` (result) |
| PUT | `/api/v1/projects/:id/meshes/:meshId/patches` | Visible | `editMeshSourcePatchesController` → `editMeshSourcePatches` | `meshIdParamSchema` + body `meshSourceEditPatchesSchema` (`edits[]` with `type` ∈ `MESH_PATCH_TYPES`) | `200` (result) |
| DELETE | `/api/v1/projects/:id/meshes/:meshId` | Visible | `deleteMeshController` → `removeMesh` | `meshIdParamSchema` | `200` (result) |

### Case mesh (Visualize), BC and backup
Codes found in `mesh.service`: 404 `NOT_FOUND`, 409 `MESH_NOT_BUILT`, 409 `NO_MESH`, 409 `PATCH_EXISTS`, 422 `VALIDATION_ERROR`, 500 `SCRIPT_MISSING`, 502 `MESH_BUILD_FAILED`; in `boundary.service`: 409 `NO_MESH`, 422 `INVALID_BC_PLAN`, 422 `BC_CSV_REQUIRED`.

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/projects/:id/mesh/manifest` | Visible | `getMeshManifestController` → `getMeshManifest` | params | `200 { manifest }` (built on demand) |
| GET | `/api/v1/projects/:id/mesh/geometry` | Visible | `getMeshGeometryController` → `getMeshGeometry` | params | `200` GLB |
| GET | `/api/v1/projects/:id/mesh/edges` | Visible | `getMeshEdgesController` → `getMeshEdges` | params | `200` octet-stream; **404 `NOT_FOUND`** if missing (the other `edges` routes return 204) |
| POST | `/api/v1/projects/:id/mesh/rebuild` | Visible | `rebuildMeshController` → `rebuildMesh` | params | `200 { manifest }` |
| POST | `/api/v1/projects/:id/mesh/patches/rename` | Visible | `renameMeshPatchController` → `renameMeshPatch` | params + body `renamePatchSchema` (`from`, `to` OpenFOAM word ≤ 80) | `200` (result) |
| POST | `/api/v1/projects/:id/mesh/patches/type` | Visible | `setMeshPatchTypeController` → `setPatchType` | params + body `setPatchTypeSchema` (`patch`, `type` ∈ `MESH_PATCH_SETTINGS`) | `200` (result) |
| POST | `/api/v1/projects/:id/mesh/auto-patch` | Visible | `autoPatchController` → `autoPatchMesh` | params + body `autoPatchSchema` (`featureAngle` 0..180, default 45) | `200 { result }` |
| PUT | `/api/v1/projects/:id/mesh/patches` | Visible | `editMeshPatchesController` → `editMeshPatches` | params + body `editPatchesSchema` (`edits[]` ≥ 1) | `200` (result) |
| POST | `/api/v1/projects/:id/boundary-conditions/apply` | Visible | `parseBoundaryUpload` then `applyBoundaryConditionsController` → `applyBoundaryConditions` | params; multipart: text field `payload` (JSON validated in the controller by `applyBoundaryConditionsSchema`) + file `csv?` | `200 { result }`; 422 `VALIDATION_ERROR` if the JSON is invalid; 413 `PAYLOAD_TOO_LARGE`; multer error: 400 `VALIDATION_ERROR` |
| GET | `/api/v1/projects/:id/mesh/backup` | Visible | `getMeshBackupController` → `getMeshBackup` | params | `200 { backup }` (or null) |
| POST | `/api/v1/projects/:id/mesh/backup` | Visible | `saveMeshBackupController` → `saveMeshBackup` | params | `200 { backup }` |
| POST | `/api/v1/projects/:id/mesh/backup/restore` | Visible | `restoreMeshBackupController` → `restoreMeshBackup` | params | `200 { manifest }` |

### CFD-Post export
Codes found in `export.service`: 404 `NOT_FOUND`.

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| POST | `/api/v1/projects/:id/export` | Visible | `runExportController` → `runExport` | params | `200 { result }` (synchronous 4-step pipeline) |
| GET | `/api/v1/projects/:id/export` | Visible | `getExportStatusController` → `getExportStatus` | params | `200 { status }` (or null) |
| GET | `/api/v1/projects/:id/export/download/:artifact` | Visible | `downloadExportArtifactController` → `readExportArtifact` | params `exportArtifactParamSchema` (`artifact` ∈ `cgns`, `session`, `memo`, `report`) | `200` attachment; for `cgns`, falls back to the multi-time-step zip if `out.cgns` is missing |

### Applying a template (templates mounted on projects)

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| GET | `/api/v1/projects/:id/apply-template/:templateId/preview` | Visible | `previewApplyTemplateController` → `previewApplyTemplate` | params `applyTemplateParamSchema` | `200 { preview }` (`files`, `conflicts`, `newFiles`) | 404 (project or template) |
| POST | `/api/v1/projects/:id/apply-template/:templateId/files` | Visible | `applyTemplateFilesController` → `applyTemplateFiles` | params + body `applyTemplateFilesSchema` (`paths` 1..1000) | `200 { applied, skipped, entries }` | 404 |
| POST | `/api/v1/projects/:id/apply-template/:templateId` | Visible | `applyTemplateController` → `applyTemplate` | params + body `applyDecisionsSchema` (`decisions?`: path to `overwrite`/`keep`) | `200 { applied, skipped, entries }` | 404 |

### Solver runs
Codes found in `runs.service`: 404 `RUN_NOT_FOUND`, 409 `NO_MESH`, 409 `RUN_IN_PROGRESS`, 409 `NOT_ENOUGH_CORES`, 422 `NOT_RUNNABLE`, 422 `TOO_MANY_CORES`. The `/:runId` routes validate `runIdParamSchema` (`id`, `runId`).

| Method | Path | Access | Controller → service | Validation | Response |
|---------|--------|-------|----------------------|------------|---------|
| GET | `/api/v1/projects/:id/runs` | Visible | `listRunsController` → `listRuns` | params | `200 { runs }` |
| POST | `/api/v1/projects/:id/runs` | Visible | `startRunController` → `startRun` | params + body `startRunSchema` (`solver?` ∈ `SOLVER_IDS`, `cores?` 1..1024 coerced) | `201 { run }` |
| GET | `/api/v1/projects/:id/runs/:runId` | Visible | `getRunController` → `getRun` | `runIdParamSchema` | `200 { run }` |
| GET | `/api/v1/projects/:id/runs/:runId/log` | Visible | `getRunLogController` → `getRunLog` | `runIdParamSchema` | `200` (run + residual series + log tail) |
| POST | `/api/v1/projects/:id/runs/:runId/stop` | Visible | `stopRunController` → `stopRun` | `runIdParamSchema` | `200 { run }` |

### Terminal (WebSocket)

| Protocol | Path | Access | Handler |
|-----------|--------|-------|---------|
| WS (HTTP upgrade) | `/api/v1/projects/:id/terminal` (`id`: `[A-Za-z0-9_-]+`) | Visible, via a token passed as subprotocol | `attachTerminalGateway` (HTTP server `upgrade` listener) then `bridge` |

Details:
- Active only if `TERMINAL_ENABLED=true`; otherwise no listener is attached.
- The browser opens `new WebSocket(url, ['bearer', <jwt>])`; the server selects the `bearer` subprotocol (the token is never echoed back).
- Pre-handshake refusals in raw HTTP: 404 (other path), 403 (`Origin` header present and different from `CORS_ORIGIN`), 503 (`TERMINAL_MAX_SESSIONS` reached), 401 (invalid token, account missing, disabled or unknown role, project not visible), 500 (internal error).
- Client messages: `{ type: 'input', data }`, `{ type: 'resize', cols, rows }`. Server messages: `{ type: 'ready', pty }`, `{ type: 'output', data }`, `{ type: 'exit', code, reason? }` (`reason: 'idle-timeout'` after `TERMINAL_IDLE_TIMEOUT_MS`).
- The shell runs in the project storage folder, with `OPENFOAM_BASHRC` passed as an environment variable if configured (not sourced automatically).

## File templates (`/api/v1/templates`, `templates.routes.ts`)
The whole router sits behind `requireAuth`. Params `templateIdParamSchema` (`id`). Common codes: 404 `NOT_FOUND`, 403 `FORBIDDEN` (write by a non-author).

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| GET | `/api/v1/templates` | Auth | `listTemplatesController` → `listTemplates` | none | `200 { templates }` | |
| POST | `/api/v1/templates` | Auth | `createTemplateController` → `createTemplate` | body `createTemplateSchema` (`name`, `description?`, `tags?`, `file?`) | `201 { template }` | 413 `FILE_TOO_LARGE`, 400 `VALIDATION_ERROR` (path) |
| GET | `/api/v1/templates/:id` | Auth | `getTemplateController` → `getTemplate` | params | `200 { template }` | 404 |
| PATCH | `/api/v1/templates/:id` | Author | `updateTemplateController` → `updateTemplate` | params + body `updateTemplateSchema` | `200 { template }` | 403, 404 |
| DELETE | `/api/v1/templates/:id` | Author | `deleteTemplateController` → `deleteTemplate` | params | `204` | 403, 404 |
| GET | `/api/v1/templates/:id/files` | Auth | `getTemplateFilesController` → `getTemplateFiles` | params | `200 { entries }` | 404 |
| POST | `/api/v1/templates/:id/files/import` | Author | `parseCaseUpload` then `importTemplateFilesController` → `importTemplateFiles` | params; multipart `archive` or `files` | `201 { written, entries }` | 400 `NO_FILES_UPLOADED`, 413 |
| GET | `/api/v1/templates/:id/files/content?path=` | Auth | `getTemplateFileContentController` → `readTemplateFileContent` | params + query `filePathQuerySchema` | `200 { file }` | 404, 413 `FILE_TOO_LARGE` |
| PUT | `/api/v1/templates/:id/files/content?path=` | Author | `parseFileContent` then `saveTemplateFileContentController` → `saveTemplateFileContent` | params + query; text body ≤ 2 MB | `200 { file }` | 404 (file does not exist), 413 |
| POST | `/api/v1/templates/:id/files/content` | Author | `createTemplateFileController` → `createTemplateFile` | params + body `createFileSchema` (`path`) | `201 { path, entries }` | 409 `FILE_EXISTS` |
| DELETE | `/api/v1/templates/:id/files/content?path=` | Author | `deleteTemplateFileController` → `deleteTemplateFileContent` | params + query | `200 { entries }` | 404 |
| DELETE | `/api/v1/templates/:id/files/dir?path=` | Author | `deleteTemplateDirController` → `deleteTemplateDirContent` | params + query | `200 { entries }` | |
| POST | `/api/v1/templates/:id/files/move` | Author | `moveTemplateEntryController` → `moveTemplateEntry` | params + body `movePathSchema` | `200 { from, to, entries }` | |

## Meshing (`/api/v1/meshing`, `meshing.routes.ts`)
The whole router sits behind `requireAuth`; there is no notion of owner (shared sessions). Params `sessionIdParamSchema` (`id`). Missing session: 404 `NOT_FOUND`.

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| GET | `/api/v1/meshing` | Auth | `listSessionsController` → `listMeshingSessions` | none | `200 { sessions }` | |
| POST | `/api/v1/meshing` | Auth | `createSessionController` → `createMeshingSession` | body `createSessionSchema` (`name`, `engine` default snappy) | `201 { session }` | |
| POST | `/api/v1/meshing/copy` | Auth | `copySessionController` → `copyMeshingSession` | body `copySessionSchema` | `201 { session }` | 404 |
| POST | `/api/v1/meshing/from-chamber` | Auth | `fromChamberController` → `importChamberIntoMeshing` | body `fromChamberSchema` (`mode`: `new` / `existing` / `copyFrom`) | `201 { session }` | 409 `CHAMBER_NOT_BUILT`, 422 `INVALID_STL`, 404 |
| GET | `/api/v1/meshing/:id` | Auth | `getSessionController` → `getMeshingSession` | params | `200 { session }` | 404 |
| PATCH | `/api/v1/meshing/:id` | Auth | `renameSessionController` → `renameMeshingSession` | params + body `renameSessionSchema` | `200 { session }` | 404 |
| DELETE | `/api/v1/meshing/:id` | Auth | `deleteSessionController` → `removeMeshingSession` | params | `200 { ok: true }` | 404 |
| POST | `/api/v1/meshing/:id/stl` | Auth | `parseCaseUpload` then `uploadStlController` → `addStlFiles` | params; multipart `files` or `stl` | `201 { session }` | 400 `NO_STL`, 422 `INVALID_STL`, 413 |
| GET | `/api/v1/meshing/:id/stl?name=` | Auth | `downloadStlController` → `readStlBytes` | params + query `stlNameQuerySchema` | `200` `application/sla` | 404 |
| DELETE | `/api/v1/meshing/:id/stl?name=` | Auth | `deleteStlController` → `removeStlFile` | params + query | `200 { session }` | 404 |
| POST | `/api/v1/meshing/:id/run` | Auth | `runSnappyController` → `startMeshingRun` | params + body `meshingConfigSchema` (union on `engine`) | `202 { session, status }` (background task) | 400 `ENGINE_MISMATCH`, 400 `NO_STL`, 409 `MESH_IN_PROGRESS` |
| GET | `/api/v1/meshing/:id/run/log` | Auth | `getRunLogController` → `getMeshingLog` | params | `200 { log }` | 404 |
| POST | `/api/v1/meshing/:id/run/stop` | Auth | `stopRunController` → `stopMeshingRun` | params | `200 { session }` (idempotent) | 404 |
| PUT | `/api/v1/meshing/:id/config` | Auth | `saveConfigController` → `saveMeshingConfig` | params + body `meshingConfigSchema` | `200 { session }` | 400 `ENGINE_MISMATCH` |
| GET | `/api/v1/meshing/:id/mesh/manifest` | Auth | `getMeshManifestController` → `getResultManifest` | params | `200 { manifest }` | 409 `NO_MESH`, 500 `SCRIPT_MISSING`, 502 `MESH_BUILD_FAILED` |
| GET | `/api/v1/meshing/:id/mesh/geometry` | Auth | `getMeshGeometryController` → `getResultGeometry` | params | `200` GLB | 409 `MESH_NOT_BUILT` |
| GET | `/api/v1/meshing/:id/mesh/edges` | Auth | `getMeshEdgesController` → `getResultEdges` | params | `200` octet-stream or `204` | 404 |
| GET | `/api/v1/meshing/:id/download` | Auth | `downloadSessionController` → `downloadSessionZip` | params | `200` zip `meshing-<id>.zip` | 404 |

## Chamber (`/api/v1/chamber`, `chamber.routes.ts`)
The whole router sits behind `requireAuth`. The `/saves` routes are declared before `/:hash`.

| Method | Path | Access | Controller → service | Validation | Response | Notable errors |
|---------|--------|-------|----------------------|------------|---------|------------------|
| POST | `/api/v1/chamber/build` | Auth | `buildChamberController` → `buildChamber` | body `chamberBuildSchema` | `200 { hash, outputs, warnings, stepHasVanes }` (idempotent, cached by hash) | 422 `VALIDATION_ERROR` (dimension ≤ 0, Min > Max, missing `hollowLength`), 500 `SCRIPT_MISSING`, 502 `CHAMBER_BUILD_FAILED` |
| GET | `/api/v1/chamber/saves` | Auth | `listChamberSavesController` → `listChamberSaves` | none | `200 { saves }` | |
| POST | `/api/v1/chamber/saves` | Auth | `createChamberSaveController` → `createChamberSave` | body `chamberSaveCreateSchema` (`name`, `snapshot`) | `201 { save }` | 409 `NAME_TAKEN` |
| PUT | `/api/v1/chamber/saves/:id` | Author | `updateChamberSaveController` → `updateChamberSave` | params `chamberSaveIdParamSchema` + body `chamberSaveUpdateSchema` | `200 { save }` | 403, 404, 409 `NAME_TAKEN` |
| DELETE | `/api/v1/chamber/saves/:id` | Author | `deleteChamberSaveController` → `deleteChamberSave` | params | `204` | 403, 404 |
| GET | `/api/v1/chamber/:hash/manifest` | Auth | `getChamberManifestController` → `getChamberManifest` | params `chamberHashParamSchema` | `200 { manifest }` | 409 `CHAMBER_NOT_BUILT` |
| GET | `/api/v1/chamber/:hash/geometry` | Auth | `getChamberGeometryController` → `getChamberGeometry` | params | `200` GLB | 409 `CHAMBER_NOT_BUILT` |
| GET | `/api/v1/chamber/:hash/edges` | Auth | `getChamberEdgesController` → `getChamberEdges` | params | `200` octet-stream or `204` | |
| GET | `/api/v1/chamber/:hash/export/:kind` | Auth | `getChamberExportController` → `getChamberExport` | params `chamberExportParamSchema` (`kind` ∈ `stl`, `step`, `stepMirrored`, `trisurface`) | `200` attachment, immutable 1-year cache; STEP and mirrored STEP generated on first download | 404 `NOT_FOUND`, 409 `CHAMBER_NOT_BUILT`, 500, 502 |

## Route count summary
System 2, auth 6, users 5, audit 1, dashboard 1, projects 63 REST + 1 WebSocket, templates 13, meshing 18, chamber 9: 118 REST routes and 1 WebSocket.
