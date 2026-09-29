# Feature · Projects (creation, list, detail, collaborators)

> **Status**: in production · **Updated**: 2026-09-29
> **Specs**: no dedicated spec (history in `brain/changelog/2026-06.md` and `2026-08.md`) · **Codemaps**: `brain/codemap/api-projects.md` (`projects.{routes,controller,schemas,service}.ts`, `runs.service.stopProjectRuns`), `brain/codemap/api-lib.md` (`caseStorage`), `brain/codemap/web-core.md` (`ProjectsPage`, `ProjectDetailPage`, `ProjectEditPage`, `lib/api/projects.ts`, `RenameDialog`), `brain/codemap/web-features-projects.md` (`features/projects`)
> **See also**: `brain/architecture/storage-layout.md` (`projects/<id>/`), `brain/architecture/data-model.md` (`Project`, `_ProjectCollaborators`), `brain/features/dashboard.md`, `brain/features/terminal.md`, `brain/features/admin-and-audit.md` (deletion of an owner); tab contents: `case-files.md`, `templates.md`, `mesh-library-and-conversion.md`, `merge-and-assembly.md`, `boundary-conditions.md`, `solver-and-runs.md`, `export-cfdpost.md`

## 1. Purpose
The project is the CFD workspace: an OpenFOAM case, its mesh library, its solver runs and its exports. This sheet covers the container itself: creation, list, rename, deletion, visibility rule, collaborators and detail page (header and tabs). The tab contents belong to their own sheets: `case-files.md` (Detail), `mesh-library-and-conversion.md` (Visualize), `merge-and-assembly.md` (Assemble), `solver-and-runs.md` (Solver), `export-cfdpost.md` (Export). Any signed-in user can create a project; they become its owner.

## 2. User journey
- **List** (`/projects`, nav `Projects`): creation form at the top (title field + orange CTA), then the table of visible projects, most recent first. Columns: title (link to `/projects/:id`), owner (`You` or email), creation date, `Rename` action (shown only to the owner or a super-admin, opens `RenameDialog`). States: skeleton, `ErrorState` "We could not load your projects.", `EmptyState` "No projects yet.". Toasts `Project created.` (the user stays on the list) and `Project renamed.`
- **Detail** (`/projects/:id`): back link `Projects`, `PageHeader` (title + `Created <date>`), on the right the `Terminal` button (only if the terminal is enabled on the server, see `terminal.md`) and the gear menu (`Project menu`):
  - `Project details` (all members): owner and creation date;
  - `Manage collaborators` (owner or super-admin): list of collaborators (`No collaborators yet.`), add by email (`Add collaborator by email`, errors `USER_NOT_FOUND` and `COLLABORATOR_EXISTS` shown on the field), per-row removal without confirmation (`Remove <fullName>`); toasts `Collaborator added.` / `Collaborator removed.`;
  - `Delete project` (owner or super-admin, separated and in danger color): confirmation "Delete <title>? This permanently removes the project and its files for everyone. This action cannot be undone.", then toast `Project deleted.` and return to `/projects`.
- **Loading / error**: `FullPageLoader`, then either `EmptyState` "Project not found" ("It may have been deleted, or you do not have access to it.") for a 404, or "We could not load this project".
- **Tabs** (`ProjectTabs`):

| Tab | Content | Enabled if | Tooltip if disabled |
|---|---|---|---|
| `Detail` | `CaseFilesSection` (case files, import, summary, tools) | always | |
| `Visualize` | `VisualizePanel` (3D viewer, lazy) | the case has a file under `constant/polyMesh/` OR the mesh library is not empty | `Import a polyMesh or a mesh part to enable 3D` |
| `Assemble` | `AssemblyWorkspace` (lazy) | mesh library not empty | `Import a mesh part to enable assembly` |
| `Solver` | `SolverTab` (lazy) | the case has a polyMesh | `Import a polyMesh to enable the solver` |
| `Export` | `ExportTab` (lazy) | the case has a polyMesh | `Import a polyMesh to enable export` |

  A disabled tab is wrapped in a `span tabIndex={0}` so that its tooltip stays reachable from the keyboard. Each lazy panel is mounted only when its tab is active (no 3D build or polling in the background); the active tab is local state, not in the URL, except the INITIAL tab: `?view=detail|visualize|assemble|solver|export` is read once at mount (an unknown value falls back to Detail) and then dropped from the URL (`setSearchParams({}, { replace: true })`). Used by the meshing hand-off, which lands on `/projects/:id?view=visualize` (2026-09-29).
- **Case editor** (`/projects/:id/edit`, from the `Edit` button of `CaseFilesSection`): `ProjectEditPage` wires the project's file hooks onto the shared `FileTreeEditor` (see `case-files.md`).

## 3. Business rules and invariants
- **Visibility**: a project is visible to its owner, its collaborators and any super-admin. For any other user, and for an unknown id, the API returns **404 `NOT_FOUND`**, never 403, so as not to reveal its existence. A super-admin's list contains every project on the platform.
- **Common guard**: `assertProjectVisible(viewer, projectId)` gates all `/projects/:id/**` routes (files, meshes, conversion, boundary conditions, runs, export, applied templates) as well as the terminal WebSocket. The dashboard applies the same rule (duplicated, see `dashboard.md`).
- **Management** (`canManage` = owner or super-admin): only these roles can rename, delete and manage collaborators; a visible collaborator gets 403 `FORBIDDEN`. Everything else (editing the case, importing, starting or stopping a run, exporting, opening the terminal) is open to any member.
- **Title**: `trim`, 1 to `PROJECT_TITLE_MAX_LENGTH` (120) characters (422 `VALIDATION_ERROR` otherwise), same rule for creation and rename. No uniqueness. Renaming changes neither the id nor the disk directory.
- **Collaborators**:
  - added by email (normalized with `trim` + lowercase); 404 `USER_NOT_FOUND` if there is no account; 409 `COLLABORATOR_EXISTS` if the user is the owner or already a collaborator;
  - removal: 404 `NOT_FOUND` if the id is not a collaborator;
  - the account's active state is not checked on add; a collaborator cannot remove themselves (route reserved for managers); ownership is not transferable.
- **Deletion**: `stopProjectRuns` (best-effort: SIGTERM to live solvers, runs marked `stopped`, fix M3), then `prisma.project.delete` (cascade on `Run` and collaborator links), then `removeProjectStorage` (best-effort, `rm -rf` of `projects/<id>/`). A failure to stop or purge never blocks the deletion.
- **Deletion of the owner**: their projects disappear with their account, including for collaborators (C2 🟡, see `admin-and-audit.md`).
- **No audit** of project operations.
- **Serialization**: `PublicProject` = `id`, `title`, `owner` and `collaborators` (summaries `{ id, fullName, email }`, collaborators sorted by name), `createdAt`, `updatedAt`; `ownerId` is never exposed on its own.

## 4. Technical flow

### 4.1 List and creation
`ProjectsPage` → `useProjectsQuery()` (key `['projects']`, `features/projects/useProjects.ts`) → `lib/api/projects.listProjects` → `GET /api/v1/projects` → `requireAuth` → `listProjectsController` → `projects.service.listProjects(viewer)` (filter `OR: [ownerId, collaborators.some]` except for super-admins, sort `createdAt desc`).
Creation: `CreateProjectForm` (zod `createProjectSchema`) → `useCreateProject` → `POST /api/v1/projects` (`createProjectSchema`) → `createProject(ownerId, input)` → 201 `{ project }` → invalidation of `['projects']`.

### 4.2 Detail and tabs
`ProjectDetailPage` → `useProjectQuery(id)` (key `['projects', id]`) → `GET /api/v1/projects/:id` → `getProject` (`findVisibleOrThrow`). `ProjectTabs` reads `useCaseFilesQuery` (key `['projects', id, 'files']`, presence of a `constant/polyMesh/…` path) and `useMeshesQuery` (key `['projects', id, 'meshes']`, library length) to enable the tabs. `canManage` is recomputed on the client from `project.owner.id` and `user.role` to hide menu entries; the server remains the authority.

### 4.3 Rename
`RenameDialog` (from `ProjectsPage`) → `useRenameProject` → `PATCH /api/v1/projects/:id` (`renameProjectSchema`) → `renameProject` (visibility then `canManage`) → `setQueryData(['projects', id])` + invalidation of `['projects']`.

### 4.4 Deletion
`DeleteProjectDialog` → `useDeleteProject` → `DELETE /api/v1/projects/:id` → `deleteProject` → `runs.service.stopProjectRuns` → `prisma.project.delete` → `caseStorage.removeProjectStorage` → 204 → invalidation of `['projects']` + navigation to `/projects`.

### 4.5 Collaborators
`ManageCollaboratorsDialog` / `AddCollaboratorForm` → `useAddCollaborator(id)` → `POST /api/v1/projects/:id/collaborators` `{ email }` (`addCollaboratorSchema`) → `addCollaborator` (Prisma `connect`); `RemoveCollaboratorButton` → `useRemoveCollaborator(id)` → `DELETE /api/v1/projects/:id/collaborators/:userId` → `removeCollaborator` (`disconnect`). Both return `{ project }`, written via `setQueryData(['projects', id])`, then invalidation of `['projects']`.

## 5. Data and storage
- **Prisma**: `Project` (`title`, `ownerId` FK to `User` with cascade, timestamps, `ownerId` index), implicit join `_ProjectCollaborators` (cascade on both sides, unique `(A, B)`), `Run` (FK `projectId` with cascade).
- **Disk**: `STORAGE_DIR/projects/<projectId>/` contains `case/`, `cgns/`, `meshes/`, `runs/<runId>/solver.log`, `viz/`, `export/`, `backups/`; created lazily on the first write (or when the terminal is opened), deleted as a whole by `removeProjectStorage`. Details: `brain/architecture/storage-layout.md`.
- **Client cache**: `['projects']` (list) and `['projects', id]` (detail), plus all the `['projects', id, …]` subtrees of the tabs. Invalidations of `['projects']` are not `exact`: they also refresh these subtrees (K16).

## 6. Configuration and external dependencies
- `STORAGE_DIR` (storage root; relative to the API's current directory if it is relative, see K31).
- No binary required for CRUD. The tabs have their own dependencies (OpenFOAM, Python, ParaView), documented in their sheets and in `README.md` §6.

## 7. Tests
- `apps/api/tests/projects.test.ts`: creation (401, 201, `ownerId` not serialized but stored, 422 blank title), rename (200, 422, 404 for an outsider without leaking existence), list limited to one's own projects, most recent first.
- `apps/api/tests/projectsAccess.test.ts`: visibility (non-member, collaborator, super-admin), `GET /projects/:id` (404 non-member, `owner` + `collaborators`), `DELETE` (204 owner, 403 collaborator, 404 outsider, super-admin allowed), collaborators (add by email, `USER_NOT_FOUND`, `COLLABORATOR_EXISTS` for the owner, 403 for a collaborator, removal).
- `apps/api/tests/users.test.ts`: disk purge of the projects of a deleted account (C2).
- Web: `features/projects/schemas.test.ts` (`createProjectSchema`: trim, empty, shared max length), `pages/ProjectDetailPage.test.tsx` (enabling Visualize and Solver depending on the presence of a polyMesh, replacement of the Detail body), `pages/ProjectEditPage.test.tsx` (editor, autosave).
- Not covered: actual stopping of solvers when a project is deleted (M3 fixed without a dedicated test, to verify), `ProjectsPage`, collaborator dialogs.

## 8. History
- 2026-06-22: project creation and list (owner-scoped), then owner + collaborators + super-admin visibility with 404, collaborators by email, detail page and deletion; delete button moved into a "Danger zone" then, the same day, into a gear menu (`490a1e1`). `brain/changelog/2026-06.md`, commit `179b55e`.
- 2026-06-24: project details moved into the gear menu; `Visualize` tab (`brain/changelog/2026-06.md`); `Solver` tab (`ff025e7`).
- 2026-06-25: `Export` tab (`a4b0b02`).
- 2026-07-01: `Assemble` tab and mesh library in Visualize (`b627ac0`, `0f10a47`, `brain/changelog/2026-07.md`).
- 2026-07-03: `Terminal` button in the header (`020a28a`, see `terminal.md`).
- 2026-07-10: M3, deleting a project stops its solvers (`c32cf82`); unified `ErrorState` / `EmptyState` states (`b6175b4`).
- 2026-08-12: project rename (`PATCH /projects/:id`, `RenameDialog`, `ed32bec`, entry of 2026-08-11 in `brain/changelog/2026-08.md`).

## 9. Known limits and bugs
- `brain/known-issues.md`: **C2** 🟡 (shared projects deleted with their owner), **M3** ✅, **M1** (no "active run" guard on destructive case mutations, in the tabs), **K4** (circular import `projects.service` ↔ `runs.service`), **K16** (`useProjects` invalidates `['projects']` without `exact`: trees, contents and meshes of all projects reloaded), **K31** (storage root dependent on the current directory; a single API instance).
- Findings from code reading (not reproduced):
  - `useProjectQuery` inherits `retry: 1`: a 404 is retried once before "Project not found" is shown;
  - after a deletion, the non-`exact` invalidation can refire requests on the deleted project (silent 404);
  - the `ProjectsPage` skeleton has 3 columns versus 4 in the loaded table;
  - collaborator removal without confirmation; no ownership transfer and no voluntary exit for a collaborator.
- Doc gap: `README.md` §9 lists `/projects/:id` as `GET/DELETE` without the rename `PATCH`, and describes the sub-resources as reserved to "project owner/collaborator" whereas a super-admin also has access.

## 10. Changing this feature
- **New route under `/projects/:id`**: call `assertProjectVisible` first (404, not 403, for an invisible project); reserve for `canManage` whatever touches the container (name, members, existence). Declare static sub-paths before parameterized routes in `projects.routes.ts`.
- **Changing the visibility rule**: modify together `projects.service` (`canView`, `listProjects`), `dashboard.service.projectVisibilityWhere` (local copy) and check `terminal.gateway.ts` (goes through `assertProjectVisible`).
- **New per-project storage**: place it under `projects/<id>/` so that it is purged automatically by `removeProjectStorage`; otherwise add its purge in `deleteProject` AND `users.service.deleteUser`. Any new long-running per-project process must be stopped by `stopProjectRuns` (or equivalent) before deletion.
- **New tab**: trigger + `TabsContent` in `ProjectTabs`, `lazy` panel mounted only if `view === '<tab>'`, enabling condition + tooltip; update `ProjectDetailPage.test.tsx`. The pinned layout depends on the `AppShell` regexes (see `brain/architecture/frontend.md` §3).
- **Contract**: `PROJECT_TITLE_MAX_LENGTH` and the `USER_NOT_FOUND` / `COLLABORATOR_EXISTS` codes live in `packages/shared` (`npm run build:shared` after modification); `PublicProject` is mirrored by the `Project` type in `apps/web/src/lib/api/types.ts`.
- UI: skill sequence of `CLAUDE.md` §0; changelog in the same change.
