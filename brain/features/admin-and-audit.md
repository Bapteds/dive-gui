# Feature · Account back office and audit log

> **Status**: in production (back office); audit log in production on the API side, without UI · **Updated**: 2026-09-28
> **Specs**: no dedicated spec; visual direction `brain/design/design-system.md` §6 and §7.3 (partly outdated, see §9) · **Codemaps**: `brain/codemap/api-core.md` (modules `users`, `audit`, `prisma/seed.ts`), `brain/codemap/api-lib.md` (`audit.ts`, `caseStorage.removeProjectStorage`, `templateStorage`), `brain/codemap/api-projects.md` (`runs.service.stopProjectRuns`), `brain/codemap/web-features-platform.md` (`features/admin`), `brain/codemap/web-core.md` (`AdminPage`, `lib/api/users.ts`, `guards.tsx`, `nav.ts`)
> **See also**: `brain/features/auth-and-accounts.md` (sessions, `tokenVersion`), `brain/architecture/data-model.md` (cascades)

## 1. Purpose
Lets the super-admin manage the list of accounts that can access the platform: create, edit (name, email, role, password), disable, re-enable and delete an account. The seeded super-admin account is permanent and protected against any mistake. Every sensitive authentication and administration action is recorded in an append-only audit log, readable only through the API (`GET /api/v1/audit-logs`). Access restricted to the `SUPER_ADMIN` role.

## 2. User journey
- **Access**: nav item `Administration` (`/admin`, icon `Users`) visible only to `SUPER_ADMIN` (`visibleNavItems`). Any other user who types the URL sees the internal 403 view "Access restricted" (guard `RequireRole`, no redirect).
- **Page** (`AdminPage`): title `Administration`, subtitle `Manage who can access the platform.`, single orange CTA `Add user` in the header. States: table skeleton (`UsersTableSkeleton`); error (`ErrorState` "We could not load the accounts." + retry); empty (`EmptyState` "No users yet.", almost unreachable since the operator is always in the list); otherwise `UsersTable`.
- **Table** (`UsersTable`): columns `Name`, `Email`, `Role` (badge), `Status` (`Active` / `Disabled`), `Last login` (hidden below `lg`), `Created` (hidden below `md`), actions. Local search on name + email (`Escape` clears, `x of y` counter in `aria-live`), sort by header (`aria-sort`, asc then desc then server order). The operator's own row is tinted.
- **Row actions**:
  - `Edit` (always enabled): `UserFormDialog` in edit mode. Role locked to `Super admin` for the protected account; password left empty = unchanged. Toast `Changes saved.`
  - `Disable`: confirmation `DisableUserDialog` (signed out everywhere + login blocked), toast `Account disabled.`
  - `Enable`: direct action without confirmation, toast.
  - `Delete`: destructive confirmation `DeleteUserDialog` naming `fullName (email)`, toast `User deleted.`
  - Visual guards: `Disable` and `Delete` are `aria-disabled` (focusable, with an explanatory tooltip, click has no effect) on the protected super-admin and on the operator's own row.
- **Creation**: `Add user` opens `UserFormDialog` (Full name, Email, Role, Password required); toast `User created.` Errors: `EMAIL_TAKEN` on the email field, `VALIDATION_ERROR` on the name, `PROTECTED_ROLE` and others as a toast. Dialogs stay open during the request and block closing; `UnsavedChangesPrompt` protects a modified form.
- **Audit log**: no page. The former `/activity` page was removed on 2026-06-22; reading goes through `GET /api/v1/audit-logs?limit=N` (super-admin).

## 3. Business rules and invariants
- **Required role**: all routes `/api/v1/users/**` and `/api/v1/audit-logs` go through `requireAuth` then `requireRole('SUPER_ADMIN')` (403 `FORBIDDEN` otherwise). The role is re-read from the database on every request.
- **Protected super-admin** (`isProtected: true`): created only by the seed (`npm run db:seed`, idempotent `upsert` that forces `SUPER_ADMIN` + `isProtected` and rewrites the password from the env). `createUser` always forces `isProtected: false`. It can be neither demoted (409 `PROTECTED_ROLE`), nor disabled (409 `PROTECTED_ACCOUNT`), nor deleted (409 `PROTECTED_ACCOUNT`). Its name, email and password remain editable by any super-admin.
- **No self-sabotage**: an operator can neither disable themselves (409 `SELF_DISABLE_FORBIDDEN`) nor delete themselves (409 `SELF_DELETE_FORBIDDEN`), protected or not. However, nothing prevents a non-protected super-admin from demoting themselves.
- **Email**: unique, `trim` + lowercase; 409 `EMAIL_TAKEN` on both creation and update (prior check + safety net on the P2002 unique constraint).
- **Validation**: creation = `fullName` (1..120), `email`, `password` (8..200), `role` all required; update = same fields optional + `isActive`, at least one field (422 otherwise).
- **Revocation**: `tokenVersion` is incremented if the role actually changes, if a password is provided, or if the account goes from active to disabled. A no-op (same role, re-enabling, simple rename) revokes nothing.
- **Disabling**: immediate effect on the API (`requireAuth` ⇒ 401 on the next request), refresh refused, login ⇒ 403 `ACCOUNT_DISABLED`. An already open terminal session is not cut (WebSocket auth only happens at upgrade). Re-enabling: login possible again.
- **Deletion** (decision C2), in this order:
  1. guards (protected, self, 404);
  2. collection of owned projects and templates;
  3. `stopProjectRuns` on each owned project (SIGTERM to live solvers, runs marked `stopped`, reason "Project or account deleted");
  4. `prisma.user.delete`: database cascade to their `Project` rows (and thus their `Run` and collaborator links), their `Template`, their `ChamberSave`, their collaboration links on other users' projects;
  5. best-effort disk purge: `projects/<id>/` of each owned project and `templates/<id>/` of each owned template;
  6. audit `USER_DELETED`.
  **Shared** projects owned by the account also disappear for their collaborators, and chamber saves (shared with the team) are deleted without warning: product decision pending (C2 🟡). Meshing sessions and the chamber cache are not tied to any user and are not affected.
- **Audit log**:
  - best-effort write (`recordAudit` catches and logs any error, never blocks the action);
  - actor and target denormalized (id + email at the time of the action), no foreign key: entries survive deletion or renaming of the account;
  - codes (`AuditAction`): `LOGIN`, `LOGOUT`, `PASSWORD_CHANGED`, `PROFILE_UPDATED`, `USER_CREATED` (metadata `role`), `USER_UPDATED` (metadata `changed`, `roleFrom`/`roleTo`), `USER_DISABLED`, `USER_ENABLED`, `USER_DELETED` (metadata `role`);
  - an update that also changes the status is logged as `USER_DISABLED` / `USER_ENABLED` (the most significant event);
  - not logged: login failures, operations on projects, templates, runs, meshes and chamber;
  - reading: `GET /audit-logs?limit=` (integer 1..200, default 50), most recent first; `actorId` and `targetId` are not exposed. No pagination beyond the last 200 entries, no retention or purge.

## 4. Technical flow

### 4.1 Account list and mutations
`AdminPage` → `useUsersQuery()` (key `['users']`, `features/admin/useUsers.ts`) → `lib/api/users.listUsers` → `GET /api/v1/users` → `listUsersController` → `users.service.listUsers` (sort: protected first, then role alphabetically, then seniority).
Mutations: `useCreateUser` (`POST /users`), `useUpdateUser` (`PATCH /users/:id`, also for `{ isActive }`), `useDeleteUser` (`DELETE /users/:id`); each invalidates `['users']`. API side: `users.routes` (`validate` with `createUserSchema` / `updateUserSchema` / `userIdParamSchema`) → `users.controller` (`requireActor` builds `{ id, email }`) → `users.service` (`createUser`, `updateUser`, `deleteUser`, `getUser`) → Prisma, `lib/password`, `lib/audit`.
Deletion: `users.service.deleteUser` → `projects/runs.service.stopProjectRuns` → `prisma.user.delete` → `lib/caseStorage.removeProjectStorage` + `lib/templateStorage.removeTemplateStorage` → `recordAudit`.

### 4.2 Audit write
`lib/audit.recordAudit({ action, actor?, target?, metadata? })` → `prisma.auditLog.create` (`metadata` serialized as JSON). Called by `auth.controller` (login, logout, profile, password) and `users.service` (creation, update, status, deletion).

### 4.3 Audit read
`GET /api/v1/audit-logs` → `requireAuth` + `requireRole('SUPER_ADMIN')` → `validate({ query: listAuditLogsQuerySchema })` → `listAuditLogsController` → `audit.service.listAuditLogs(limit)` (`createdAt desc`, `metadata` re-parsed tolerantly) → `200 { logs }`. No web-side wrapper and no MCP tool.

## 5. Data and storage
- **Prisma**: `User` (see `auth-and-accounts.md`), `AuditLog` (`action`, `actorId?`, `actorEmail?`, `targetId?`, `targetEmail?`, `metadata?` JSON text, `createdAt`; indexes `createdAt`, `actorId`, `targetId`). Cascades from `User`: `Project` (and `Run`, `_ProjectCollaborators`), `Template`, `ChamberSave`. Details: `brain/architecture/data-model.md` ("Cascades and deletions").
- **Disk** (`STORAGE_DIR`): deleting an account purges `projects/<projectId>/` and `templates/<templateId>/` of the owned resources. See `brain/architecture/storage-layout.md`.
- **Client cache**: `['users']` (global staleTime 30 s, retry 1).

## 6. Configuration and external dependencies
- `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`: protected account created or realigned by `npm run db:seed` (`tsx prisma/seed.ts`). Required at API startup; the placeholder password is refused in production.
- No other feature-specific variable. Depends on binaries only indirectly (stopping solvers by signal).

## 7. Tests
- `apps/api/tests/users.test.ts`: 401/403, list (protected first, no secrets), creation (effective login, `EMAIL_TAKEN`, 422), read, `PATCH` (`PROTECTED_ROLE`, role no-op accepted, `EMAIL_TAKEN`, 422 empty body), `DELETE` (204, disk purge of owned projects "C2", `PROTECTED_ACCOUNT`, `SELF_DELETE_FORBIDDEN`, 404), revocation via `tokenVersion`.
- `apps/api/tests/accountStatus.test.ts`: disable / re-enable, `PROTECTED_ACCOUNT`, `SELF_DISABLE_FORBIDDEN` (tested on a non-protected super-admin), `lastLoginAt`.
- `apps/api/tests/audit.test.ts`: 401/403, entries `LOGIN`, `USER_CREATED` (metadata `role`), `USER_DISABLED`, `limit` parameter, 422 on `limit=9999`. Order is only checked via `limit`.
- Web: `features/admin/UsersTable.test.tsx` (`aria-disabled` guards on protected and self, `Enable` always allowed, badges, `aria-sort`, accessible names `Delete <fullName>` / `Disable <fullName>` / `Enable <fullName>`).
- Not covered: admin dialogs, `admin/schemas.ts`, `AdminPage`, seed.

## 8. History
- 2026-06-19: CRUD `/users` and hard rules (`PROTECTED_ACCOUNT`, `PROTECTED_ROLE`, `SELF_DELETE_FORBIDDEN`, `EMAIL_TAKEN`), idempotent seed; web back office (table, dialogs, protected super-admin); revocation via `tokenVersion` on role change or password reset. `brain/changelog/2026-06.md` (entries of 2026-06-19: Lot 1+2, Lot 4, self-service account), commit `179b55e`.
- 2026-06-22: disable / re-enable (`isActive`, `SELF_DISABLE_FORBIDDEN`), `lastLoginAt`, search and sort, `AuditLog` table + `GET /audit-logs` + `/activity` page, then removal of the whole Activity UI (backend kept). `brain/changelog/2026-06.md` (entries of 2026-06-22: "App web" lot, then move of Delete project and removal of the Activity page).
- 2026-07-10: C2, deleting an account stops solvers and purges storage of owned projects and templates (`c32cf82`, `brain/changelog/2026-07.md`).

## 9. Known limits and bugs
- `brain/known-issues.md`: **C2** ✅ + 🟡 (shared projects and chamber saves deleted with the account: reassign ownership or block deletion, to be decided), **L4** (`revokeRefreshTokens` and a vanished user), **L12** (the seed rewrites the super-admin password on every run), **L3** (validation `details` do not reach the client), **K27** (`SortableHead` defined inside render: possible focus loss after sorting; `admin/schemas.ts` hardcodes `max(120)` instead of `FULL_NAME_MAX_LENGTH`), **K28** (focus on the first invalid field uncertain in `UserFormDialog`).
- Reading findings (not reproduced):
  - a non-protected super-admin can demote themselves; the UI does not lock it (only the protected account has a frozen role);
  - the password and email of the protected account can be changed by another super-admin;
  - changing one's own password from the back office increments `tokenVersion` without a new cookie: the operator will be signed out at the next refresh;
  - `UserFormDialog` switches zod resolver depending on the mode on the same instance (whether react-hook-form picks it up is to verify);
  - the audit of a deletion is written after the cascade: a (best-effort) write failure would leave a deletion without a trace.
- Doc drift: `brain/design/design-system.md` §7.3 still describes columns `Name, Email, Role, Created, Actions (Edit, Delete)` and an empty state "only super-admin exists"; the real table has `Status`, `Last login`, the `Disable/Enable` action, and the empty state only shows for a truly empty list. `README.md` §9 lists `GET/POST /users, /users/:id` without `PATCH` or `DELETE`.

## 10. Changing this feature
- Guards exist twice: server (`users.service`, source of truth) and UI (`UsersTable`, `UserFormDialog`). Any new rule must be set on the server with a shared error code (`SERVER_ERROR_CODES` in `packages/shared`, then `npm run build:shared`), then mirrored in the UI.
- New user-owned resource with disk storage or processes: add it to `deleteUser` (stop before the cascade, purge after), otherwise it becomes orphaned. Keep `stopProjectRuns` BEFORE `prisma.user.delete` (the `Run` rows disappear with the cascade).
- New audit code: `AuditAction` (`lib/audit.ts`); the comment asks to keep the read labels in sync. Never make an action fail because of the audit.
- The accessible names of the `UsersTable` buttons are a test contract.
- Reintroducing an audit UI: recreate a `lib/api` wrapper and types (removed on 2026-06-22), and plan cursor pagination if more than 200 entries must be readable.
- Any UI change follows the skill sequence in `brain/conventions/frontend.md` §1; update `brain/design/design-system.md` §7.3 and `brain/changelog/` in the same change.
