# Data model

> Sources: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/**`, `apps/api/prisma/seed.ts`, services `auth`, `users`, `projects`, `templates`, `chamber-saves`, `dashboard`, `audit`, `meshing`, `chamber`, `lib/audit.ts`, `lib/serializeUser.ts` · Updated: 2026-09-28

## Overview
The database is a **SQLite** file driven by **Prisma 5** (`DATABASE_URL`, by default `file:./dev.db` relative to `apps/api/prisma/`). Since SQLite has neither enums nor arrays, three conventions recur:
- enumerations are `String` fields validated application-side (zod) and mirrored by unions in `@dive/shared` (`User.role`, `Run.status`, `Run.solver`);
- lists and objects are `String` fields holding JSON (`Template.tags`, `ChamberSave.snapshot`, `AuditLog.metadata`);
- dates are returned as ISO 8601 by the serialization functions (`toPublicUser`, `toPublicProject`, etc.).

Eight models plus one implicit join table. The whole business tree is attached to `User` through cascades, except `AuditLog`, deliberately without a foreign key.

```
User ─┬─< Project (ownerId, CASCADE) ─< Run (projectId, CASCADE)
      ├─<> Project via _ProjectCollaborators (CASCADE on both sides)
      ├─< Template (ownerId, CASCADE)
      ├─< ChamberSave (ownerId, CASCADE)
      └─< Study (ownerId, CASCADE) >─ Project (projectId, CASCADE); Study ─< Evaluation (studyId, CASCADE)
AuditLog (actorId / targetId without FK)
```

A significant part of the state lives **outside the database**, on disk under `STORAGE_DIR`: project case files and their sibling folders (`case/`, `cgns/`, `viz/`, `runs/`, `export/`, `meshes/` including `meshes/assembly.json`), template files (`templates/<id>/files`), meshing sessions (`meshing/<id>` with `status.json` and `mesh.log`), chamber builds (`chamber/<hash>`). Meshing sessions and chamber builds have no row in the database.

## Models

### `User`
Application account. The password is stored only as an argon2 hash.

| Field | Type | Default | Role |
|-------|------|--------|------|
| `id` | String (cuid) | `cuid()` | Primary key. |
| `email` | String, **unique** | | Always stored lowercased and trimmed by the services (login, creation, update, collaborator addition). |
| `fullName` | String | | Display name (1..120). |
| `passwordHash` | String | | argon2 hash; never serialized. |
| `role` | String | `"USER"` | `'SUPER_ADMIN'` or `'USER'`. |
| `isProtected` | Boolean | `false` | `true` only for the super-admin created by the seed. |
| `isActive` | Boolean | `true` | `false` = disabled account. |
| `tokenVersion` | Int | `0` | Refresh token version; incrementing it revokes sessions. Never serialized. |
| `lastLoginAt` | DateTime? | | Timestamp of the last successful login. |
| `createdAt` / `updatedAt` | DateTime | `now()` / `@updatedAt` | |

Relations: `projects` (owned, `ProjectOwner`), `collaboratingOn` (`ProjectCollaborators`), `templates` (`TemplateOwner`), `chamberSaves` (`ChamberSaveOwner`).
Public shape (`PublicUser`, `lib/serializeUser.ts`): `id`, `email`, `fullName`, `role`, `isProtected`, `isActive`, `lastLoginAt`, `createdAt`, `updatedAt`.

### `Project`
Project owned by a user, shareable with collaborators. Carries only a title; case files are on disk.

| Field | Type | Role |
|-------|------|------|
| `id` | String (cuid) | Primary key, also the name of the storage subfolder. |
| `title` | String | 1..120 characters. |
| `ownerId` | String | FK to `User.id`, **`onDelete: Cascade`**. |
| `collaborators` | `User[]` | Implicit many-to-many `ProjectCollaborators`. |
| `runs` | `Run[]` | Solver runs. |
| `createdAt` / `updatedAt` | DateTime | |

Index: `@@index([ownerId])`.

### `_ProjectCollaborators` (implicit join table)
Columns `A` (FK `Project.id`) and `B` (FK `User.id`), both `ON DELETE CASCADE`. Unique index `(A, B)` and index on `B`. Deleting a project or a user removes the links.

### `Run`
One execution of an OpenFOAM solver on a project's case (long-running background task, tied to the API process).

| Field | Type | Default | Role |
|-------|------|--------|------|
| `id` | String (cuid) | | Primary key. |
| `projectId` | String | | FK `Project.id`, **`onDelete: Cascade`**. |
| `solver` | String | | A `SolverId` (validated by `SOLVER_IDS`). |
| `cores` | Int | `1` | Number of MPI subdomains; 1 = serial. |
| `status` | String | `"queued"` | A `RunStatus`: `queued`, `running`, `converged`, `completed`, `diverged`, `failed`, `stopped`. |
| `pid` | Int? | | OS PID during execution. |
| `exitCode` | Int? | | Exit code once terminal. |
| `command` | String | | Logical command line shown in the UI. |
| `logPath` | String | | Storage-relative path of the `solver.log`. |
| `reason` | String? | | Short explanation of a terminal state (divergence, failure, stop). |
| `startedAt` / `finishedAt` | DateTime? | | |
| `createdAt` / `updatedAt` | DateTime | | |

Indexes: `@@index([projectId])` and `@@index([projectId, status])` (guard "is a run active?").

### `Template`
Reusable, shared file template (free tree under `<STORAGE_DIR>/templates/<id>/files`).

| Field | Type | Default | Role |
|-------|------|--------|------|
| `id` | String (cuid) | | Primary key, storage folder name. |
| `name` | String | | 1..120. |
| `description` | String? | | 0..2000; empty string coerced to `null`. |
| `tags` | String | `"[]"` | JSON array of normalized tags (`normalizeTags`: lowercase kebab-case, 24 characters, 12 max). |
| `ownerId` | String | | FK `User.id`, **`onDelete: Cascade`**. |
| `createdAt` / `updatedAt` | DateTime | | |

Index: `@@index([ownerId])`.

### `ChamberSave`
Named, shared save of a `POST /chamber/build` body (the geometry stays in the hash-keyed build cache).

| Field | Type | Role |
|-------|------|------|
| `id` | String (cuid) | Primary key. |
| `name` | String, **unique** | 1..80 characters, globally unique (and case-sensitive at the SQLite level). |
| `ownerId` | String | FK `User.id`, **`onDelete: Cascade`**. |
| `snapshot` | String | JSON of a `ChamberInput` validated by `chamberBuildSchema` on write (defaults included). |
| `createdAt` / `updatedAt` | DateTime | |

Indexes: unique on `name`, `@@index([ownerId])`.

### `Study` (WS-H)
One optimisation study run in a project (its work project). JSON columns are Strings; enumerations validated by zod and mirrored in `@dive/shared`.

| Field | Type | Role |
|-------|------|------|
| `id` | String (cuid) | Primary key. |
| `name` | String | 1..120, not unique. |
| `ownerId` / `projectId` | String | FK `User.id` / `Project.id`, both **`onDelete: Cascade`**. |
| `baseSource` / `baseLabel` / `baseInput` | String | `save` or `meshOrigin`, its label, the JSON `ChamberInput`. |
| `paramSpace` | String | JSON `ParamRange[]` (50 mm grid). |
| `bandPct` | Float | Default 10. |
| `objectives` / `weights` | String | JSON (headLoss + vortex, min) / `{ headLoss, vortex }` (default 0.5 / 0.5). |
| `mode` / `sampler` / `seed` / `vortexMetric` | String / String / Int? / String | `weighted` or `pareto`; `tpe`, `nsga2`, `random`; `maskedQVolume` or `omegaRms`. |
| `maxEvaluations` / `maxDurationHours` | Int (30) / Float? | Budgets. |
| `keepBest` / `keepLast` | Int (3 / 2) | Meshing sessions kept. |
| `meshingSourceId` / `solverSetup` | String | Reference session id / JSON `{ cores }`. |
| `criteria` / `normalisation` | String? | Criteria snapshot (first start) / baseline `{ headLoss, vortex }`. |
| `status` / `reason` | String / String? | `draft`, `running`, `pausing`, `paused`, `completed`, `failed`. |
| `startedAt` / `finishedAt` / `createdAt` / `updatedAt` | DateTime | |

Indexes: `ownerId`, `projectId`, `status`.

### `Evaluation` (WS-H)
One evaluated design. Index 0 = baseline; an interrupted evaluation is re-run in place.

| Field | Type | Role |
|-------|------|------|
| `id` / `studyId` / `index` | String / String / Int | FK `Study.id` **cascade**; unique `(studyId, index)`. |
| `designParams` | String | JSON values of the picked keys (mm). |
| `chamberHash`, `meshingSessionId`, `meshingSessionName`, `sessionDeleted` | String? / Boolean | Build and meshing session (deleted by disk hygiene). |
| `projectId`, `runId` | String? | No FK (runs are purged with the project). |
| `dp0`, `headLoss`, `maskedQVolume`, `omegaRms`, `objective` | Float? | Pa, m, m³, 1/s, weighted objective. |
| `status` / `stage` / `refusalReason` / `runStatus` / `budgetHit` / `warnings` | | `pending`, a stage, `done`, `infeasible`, `failed`, `interrupted`; last stage; reason; run status; time budget flag; JSON `string[]`. |
| `startedAt` / `finishedAt` / `createdAt` / `updatedAt` | DateTime | |

Index `(studyId, status)`.

### `AuditLog`
Append-only log of authentication and administration actions. Never modified or deleted by the application.

| Field | Type | Role |
|-------|------|------|
| `id` | String (cuid) | Primary key. |
| `action` | String | Action code (see rules). |
| `actorId` / `actorEmail` | String? | Actor, denormalized at the time of the action; null for a system event. |
| `targetId` / `targetEmail` | String? | Targeted account, denormalized. |
| `metadata` | String? | Optional JSON (changed fields, roles before/after…). |
| `createdAt` | DateTime | |

Indexes: `createdAt`, `actorId`, `targetId`. **No foreign key**, so that it survives the deletion or renaming of an account.

## Cascades and deletions

| Action | Database effect | Off-database effect |
|--------|-----------|-----------------|
| Delete a `User` (`users.service.deleteUser`) | Cascade: their `Project` (hence their `Run` and collaborator links), their `Template`, their `ChamberSave`, their `Study` rows (and the studies of their projects), their collaboration links on other users' projects. `AuditLog` intact. | Before deletion: `stopProjectRuns` on each owned project and `cleanupStudies` (their studies and those of their projects). After: best-effort deletion of the storage of their projects and templates. Shared chamber saves disappear without warning. |
| Delete a `Project` (`projects.service.deleteProject`) | Cascade: `Run`, `Study` (and `Evaluation`), collaborator links. | `stopProjectRuns` and `cleanupStudies` (pause the running study, remove the studies' meshing sessions and `studies/<id>/`) before, `removeProjectStorage` after (best-effort). |
| Delete a `Study` (`studies.service.deleteStudy`) | Cascade: `Evaluation`. | Pauses the study first (waits for the runner), removes its meshing sessions and `studies/<id>/`. |
| Delete a `Template` | Row only. | `removeTemplateStorage` best-effort. |
| Delete a `ChamberSave` | `deleteMany` (idempotent). | None (the hash-keyed build stays cached). |

## Migration history

| Date | Migration | Change |
|------|-----------|------------|
| 2026-06-19 | `20260619093204_init` | `User` table (without `isActive` or `lastLoginAt`), unique index on `email`. |
| 2026-06-22 | `20260622061744_add_audit_log_and_account_status` | `AuditLog` table + 3 indexes; `User` rebuilt (copy into `new_User`) to add `isActive` (default true) and `lastLoginAt`. |
| 2026-06-22 | `20260622070404_add_project` | `Project` table, cascading FK `ownerId`, `ownerId` index. |
| 2026-06-22 | `20260622072302_add_project_collaborators` | `_ProjectCollaborators` join (cascade on both sides, unique `(A, B)`, index `B`). |
| 2026-06-22 | `20260622121210_add_template` | `Template` table (without tags), cascading FK `ownerId`, index. |
| 2026-06-24 | `20260624102016_add_run_model` | `Run` table (without `cores`), cascading FK `projectId`, indexes `projectId` and `(projectId, status)`. |
| 2026-07-02 | `20260702130000_add_template_tags` | `Template.tags` non-null TEXT, default `'[]'`. |
| 2026-07-03 | `20260703120000_add_run_cores` | `Run.cores` non-null INTEGER, default 1. |
| 2026-08-31 | `20260831142110_chamber_saves` | `ChamberSave` table, unique `name`, `ownerId` index, cascading FK. |
| 2026-09-30 | `20260930085427_optimisation_studies` | `Study` (cascading FKs owner + project, indexes owner / project / status) and `Evaluation` (cascading FK study, unique `(studyId, index)`, index `(studyId, status)`), WS-H. |

Applying them: `npm run db:migrate` (`prisma migrate dev`) in development, `prisma migrate deploy` at startup in production (`start` script of `@dive/api`). The test database does not use migrations: the vitest `globalSetup` runs `prisma db push --force-reset` on `prisma/test.db` (according to the CI comment).

## Data-related business rules

### Protected super-admin
- Only the seed (`prisma/seed.ts`) creates an `isProtected: true` account; `createUser` always forces `isProtected: false`.
- The seed is an `upsert` on `SEED_ADMIN_EMAIL`: on every run it reimposes `role: 'SUPER_ADMIN'`, `isProtected: true`, the name and the password hash from the environment.
- A protected account cannot change role (409 `PROTECTED_ROLE`), be disabled (409 `PROTECTED_ACCOUNT`) or be deleted (409 `PROTECTED_ACCOUNT`).
- A super-admin can neither disable themselves (409 `SELF_DISABLE_FORBIDDEN`) nor delete themselves (409 `SELF_DELETE_FORBIDDEN`).

### `tokenVersion` and sessions
- The refresh token (httpOnly cookie `refresh_token`, path `/api/v1/auth`, lifetime `REFRESH_TOKEN_TTL_DAYS`) embeds `tokenVersion`; `POST /auth/refresh` rejects it (401) if the version no longer matches.
- Increments: logout; changing one's own password (the current device's cookie is reissued with the new version); by an admin, an effective role change, a new password or a deactivation. A write with no actual change does not increment.
- The access token (`ACCESS_TOKEN_TTL`, 15 minutes by default) is not tied to `tokenVersion`: it remains valid until expiry after a logout. However `requireAuth` reloads the user on every request, so deletion, deactivation and role change apply immediately.

### `isActive`
- Disabled: `POST /auth/login` returns 403 `ACCOUNT_DISABLED` (only after the password check, so as not to reveal that the account exists); refresh and every authenticated route return 401 `UNAUTHENTICATED`; the terminal WebSocket refuses the upgrade.
- Reactivation via `PATCH /users/:id { isActive: true }` (audit `USER_ENABLED`).

### Emails
Uniqueness ensured by the unique index and by a prior check (409 `EMAIL_TAKEN`, including on a concurrent P2002 violation). Always compared lowercased.

### Project visibility
- **View**: owner, collaborator or any `SUPER_ADMIN`. A third party gets 404 `NOT_FOUND` (never 403) so as not to reveal that the project exists. This rule (`assertProjectVisible`) also protects files, runs, meshes, export, template application, dashboard and terminal.
- **Manage** (rename, delete, add/remove a collaborator): owner or super-admin, otherwise 403 `FORBIDDEN`.
- Adding a collaborator by email: 404 `USER_NOT_FOUND` if unknown, 409 `COLLABORATOR_EXISTS` if it is the owner or an existing collaborator.

### Templates (`Template`) and chamber saves (`ChamberSave`)
- Shared: any authenticated user lists, reads and applies/loads.
- Modification, renaming, deletion: author or super-admin, otherwise 403 `FORBIDDEN` (no 404 masking here).
- `ChamberSave.name` unique: 409 `NAME_TAKEN` on creation and on rename.
- Applying a template to a project depends on the project's visibility, not on template ownership.

### Solver runs
- `status` follows the cycle `queued` then `running` then a terminal state; `ACTIVE_RUN_STATUSES` (`queued`, `running`) is used by the concurrency guard (409 `RUN_IN_PROGRESS`, `SOLVER_MAX_CONCURRENT_RUNS` per project) and by the global core budget (409 `NOT_ENOUGH_CORES`).
- On API startup, any run still active in the database is set to `failed` (`reconcileOrphanRuns`), since the child process was tied to the old process.
- Meshing runs have no row: their status is in `status.json` and follows the same reconciliation (`reconcileOrphanMeshingRuns`).

### Audit log
- Actions (`lib/audit.ts`): `LOGIN`, `LOGOUT`, `PASSWORD_CHANGED`, `PROFILE_UPDATED`, `USER_CREATED`, `USER_UPDATED`, `USER_DELETED`, `USER_DISABLED`, `USER_ENABLED`.
- Best-effort writes (`recordAudit` never throws). Failed logins are not logged.
- Reading: `GET /api/v1/audit-logs?limit=` (super-admin, 1..200, default 50), without exposing `actorId`/`targetId`.
