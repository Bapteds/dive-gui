# Codemap: web features (platform)

> Scope: `apps/web/src/features/{account,admin,auth,dashboard,export,files,templates,terminal,visualize}/**` · Updated: 2026-09-28

## Overview
These nine folders group the "platform" building blocks of the React front end (excluding chamber, meshing, solver, assembly, projects): session and account (`auth`, `account`), account administration (`admin`), home dashboard (`dashboard`), CGNS export (`export`), generic tree-based file editor (`files`), shared templates (`templates`), optional terminal (`terminal`) and three.js 3D viewer of boundary patches (`visualize`).
All data goes through TanStack Query: each folder exposes a hooks file (`useAccount`, `useUsers`, `useDashboard`, `useExport`, `useTemplates`, `useMesh`) that wraps the `@/lib/api/*` wrappers and documents keys + invalidations. Components call `mutateAsync` and map `ApiError.code` themselves to field errors or toasts (`@/components/ui/sonner`).
Entry points: `AuthProvider` (mounted in `app/providers.tsx`), pages `AccountPage`, `AdminPage`, `HomePage`, `TemplatesPage`, `TemplateEditPage`, `ProjectEditPage`, `ProjectDetailPage` (which loads `VisualizePanel` and `ExportTab` via `lazy`, and renders `ProjectTerminalButton`).
Key convention: everything related to a project is prefixed `['projects', projectId, ...]` (`'files'`, `'export'`, `'mesh', 'manifest'|'glb'|'edges'|'backup'`), templates by `['templates', ...]`. Since TanStack invalidations are prefix-based, invalidating `['projects', id, 'files']` or `['templates']` also refreshes all sub-keys (file contents, trees).
Forms: react-hook-form + `zodResolver`, `mode: 'onBlur'`, local zod schemas (`schemas.ts`) fed by the constants from `@dive/shared`. Radix dialogs (`Dialog`, `AlertDialog`) stay open during the request (`event.preventDefault()` on the action) and block closing while a mutation is in flight.

## `apps/web/src/features/account/`
Self-service "My account" page. `AccountPage` composes `ProfileSection` (editable display name, read-only email and role) and `ChangePasswordSection`, each inside a thin-bordered `SettingsSection`. No query: two mutations (`useUpdateProfile`, `useChangePassword`) that replace the session user via `useAuth().setUser` on success. Each section reports its "dirty" state through `onDirtyChange` for the page-leave guard. Vitest + Testing Library tests with the API and auth context mocked.

### `apps/web/src/features/account/ChangePasswordSection.test.tsx`
**Covers**: a mismatched confirmation blocks submission and shows `The passwords do not match.` without calling the API; a server `ApiError('INVALID_PASSWORD')` becomes the field error `That password is incorrect.` (call checked with `('wrong-password', 'Brand-New-Pass-1')`); a success clears the fields and calls `setUser` once.
**Technique**: `vi.hoisted` for `changePasswordMock` / `setUserMock`, `vi.mock('@/lib/api/auth')` and `vi.mock('@/features/auth/AuthProvider')` (`useAuth` returns `{ setUser }`), `QueryClient` with `retry: false`, `userEvent.setup()`.
**Notable cases**: the success returns an `accessToken` and a full `User`, which mirrors the `/auth/change-password` contract.

### `apps/web/src/features/account/ChangePasswordSection.tsx`
**Role**: password change form (current, new, confirmation) with a show/hide toggle `PasswordInput`. `onBlur` validation via `changePasswordSchema`. A help line states that the change signs out other devices (the server revokes the other sessions).
**Exports**:
- `ChangePasswordSection({ onDirtyChange?: (dirty: boolean) => void } = {})`. Renders a `<form noValidate>` inside `SettingsSection` (title `Password`). States: `submitting` = `useChangePassword().isPending` disables the fields and puts the `Update password` button in `loading`. Success: `reset` to empty + `toast.success('Password updated.')`. Errors: `INVALID_PASSWORD` to field error `currentPassword` + focus; `VALIDATION_ERROR` to `newPassword` with the server message; other `ApiError` as a toast of the message; otherwise a generic toast. `onInvalid` focuses the first field in error according to `FIELD_ORDER`.
**Depends on**: `useChangePassword` (`./useAccount`), `changePasswordSchema`, `SettingsSection`, `Field`, `PasswordInput`, `Button`. **Used by**: `pages/AccountPage.tsx`.
**Notes**: `onInvalid` reads `errors` captured at render time (not the argument provided by `handleSubmit`): focusing the first invalid field on the very first submit is to verify. Same pattern in `admin/UserFormDialog.tsx`.

### `apps/web/src/features/account/ProfileSection.test.tsx`
**Covers**: email and role label (`User`) displayed as text, no field labeled `Email`; `Save changes` button disabled as long as the name has not changed, then `updateMe('Katharina Vogel-Brandt')` and `setUser` called once.
**Technique**: same hoisted mocks as the password test (`@/lib/api/auth`, `useAuth`), fixture `baseUser: User`, `QueryClientProvider` without retry.
**Notable cases**: checks the human label produced by `RoleBadge`, not the enum.

### `apps/web/src/features/account/ProfileSection.tsx`
**Role**: account identity. Email and role rendered as a `<dl>` (managed by the back office, muted note displayed); only `fullName` is editable, with its own save action.
**Exports**:
- `ProfileSection({ user: User, onDirtyChange? })`. `useForm` on `profileSchema`, `defaultValues` from `user.fullName`; a `useEffect` re-`reset`s when `user.fullName` changes elsewhere. `Save changes` button `disabled={!isDirty}` and `loading` during `useUpdateProfile`. Success: `reset` with the returned name + `toast.success('Profile updated.')`. `VALIDATION_ERROR` to field error `fullName`; other errors as toasts.
**Depends on**: `useUpdateProfile`, `profileSchema`, `RoleBadge`, `SettingsSection`. **Used by**: `pages/AccountPage.tsx`.
**Notes**: the name is `trim()`med before sending (the schema trims too).

### `apps/web/src/features/account/SettingsSection.tsx`
Presentational component `SettingsSection({ title, description, children, className? })` (interface `SettingsSectionProps` exported): bordered `<section>` (`rounded-md border bg-surface shadow-sm`) with an `h2` header + a description line separated from the body by a hairline. Documented choice: no brand diamond per section (to avoid a template look). Used by `ProfileSection` and `ChangePasswordSection`.

### `apps/web/src/features/account/schemas.test.ts`
**Covers**: `profileSchema` trims and accepts a valid name, rejects a blank name and a 121-character name; `changePasswordSchema` accepts a valid case, requires the current password, enforces 8 characters, puts the mismatch error on `confirmPassword` and the "same as current" error on `newPassword`.
**Technique**: pure `safeParse`, inspection of `error.issues[].path`.
**Notable cases**: the 120 limit is implicitly that of `FULL_NAME_MAX_LENGTH`.

### `apps/web/src/features/account/schemas.ts`
**Role**: zod schemas for the account forms.
**Exports**:
- `profileSchema`: `fullName` trim, min 1 (`Enter your full name.`), max `FULL_NAME_MAX_LENGTH`. Type `ProfileFormValues`.
- `changePasswordSchema`: `currentPassword` min 1, `newPassword` min `PASSWORD_MIN_LENGTH`, `confirmPassword` min 1; two `refine`s (match on `confirmPassword`, difference from the current one on `newPassword`). Type `ChangePasswordFormValues`.
**Depends on**: `@dive/shared` (`FULL_NAME_MAX_LENGTH`, `PASSWORD_MIN_LENGTH`). **Used by**: both sections and their tests.

### `apps/web/src/features/account/useAccount.ts`
**Role**: TanStack mutations for the current account. No query key, no invalidation: synchronization happens through the auth context.
**Exports**:
- `useUpdateProfile()`: `mutationFn(fullName)` to `updateMe` (`PATCH /auth/me`); `onSuccess({ user })` calls `setUser(user)`.
- `useChangePassword()`: `mutationFn({ currentPassword, newPassword })` to `changePassword` (`POST /auth/change-password`); `onSuccess` likewise.
**Depends on**: `@/lib/api/auth`, `useAuth`. **Used by**: `ProfileSection`, `ChangePasswordSection`.
**Notes**: errors are not swallowed (callers use `mutateAsync`). The comment says the access token stays current after a password change: this is not done in this hook, it is the responsibility of `lib/api/auth.changePassword` (to verify in the `lib/api` sheet).

## `apps/web/src/features/admin/`
Account administration screen (`AdminPage`, restricted to super-admins). A single query `['users']` feeds `UsersTable` (or `UsersTableSkeleton` while loading); three dialogs (`UserFormDialog` create/edit, `DisableUserDialog`, `DeleteUserDialog`) trigger mutations that all invalidate `['users']`. Two business guards run through the whole folder: the protected super-admin (`isProtected`) can be neither deleted, disabled nor demoted, and the operator can neither delete nor disable themselves. The visible guards are on the UI side; the matching server codes are handled defensively. Design reference: `brain/design/design-system.md` sections 6 and 7.3.

### `apps/web/src/features/admin/DeleteUserDialog.tsx`
**Role**: destructive confirmation for deleting an account.
**Exports**:
- `DeleteUserDialog({ open, onOpenChange, user: User | null })`. `AlertDialog` naming `fullName (email)`. Clicking `Delete user` calls `preventDefault` to keep the dialog open, then `useDeleteUser().mutateAsync(user.id)`. During the request: `Cancel` and the action disabled, `Loader2` spinner, `aria-busy`. Success: `toast.success('User deleted.')` and close. Errors: `PROTECTED_ACCOUNT`, `SELF_DELETE_FORBIDDEN` as dedicated toasts, otherwise the server or generic message.
**Depends on**: `useDeleteUser`. **Used by**: `pages/AdminPage.tsx`.
**Notes**: `user` can be `null` while closing (fallback text).

### `apps/web/src/features/admin/DisableUserDialog.tsx`
**Role**: disable confirmation (sign-out everywhere + login blocked). Re-enabling has no dialog (direct action from the table).
**Exports**:
- `DisableUserDialog({ open, onOpenChange, user: User | null })`. Same mechanics as `DeleteUserDialog`, via `useUpdateUser().mutateAsync({ id, input: { isActive: false } })`. Toast `Account disabled.`. Handled codes: `PROTECTED_ACCOUNT`, `SELF_DISABLE_FORBIDDEN`.
**Depends on**: `useUpdateUser`. **Used by**: `pages/AdminPage.tsx`.

### `apps/web/src/features/admin/UserFormDialog.tsx`
**Role**: unified create / edit account dialog. `edit` mode if `user` is provided.
**Exports**:
- `UserFormDialog({ open, onOpenChange, user?: User | null })`. `useForm<UserFormFields>` with `zodResolver(userFormSchema(mode)) as never`; `reset` on each open (empty on create, prefilled on edit). Role via `Controller` + Radix `Select` (`ROLE_LABELS`: `Super admin`, `User`), locked if the edited account is protected (`roleLocked`, dedicated help text). Initial focus on `fullName` via `onOpenAutoFocus`, except on coarse pointers (`(pointer: coarse)`) to avoid opening the keyboard. `UnsavedChangesPrompt when={open && isDirty && !submitting}`.
- Submission: on edit, `fullName`/`email` trimmed, role forced to `SUPER_ADMIN` if locked, `password` sent only if entered; on create, full payload. Toasts `Changes saved.` / `User created.` then close. Errors: `EMAIL_TAKEN` on `email`, `VALIDATION_ERROR` on `fullName`, `PROTECTED_ROLE` as a toast, default as a toast.
**Depends on**: `useCreateUser`, `useUpdateUser`, `userFormSchema`, `UnsavedChangesPrompt`, `Field`, `PasswordInput`. **Used by**: `pages/AdminPage.tsx`.
**Notes**: the resolver depends on `mode` while the same instance can switch from create to edit; whether react-hook-form picks up the new resolver is to verify. Focus on the first invalid field: same caveat as in `ChangePasswordSection`.

### `apps/web/src/features/admin/UsersTable.test.tsx`
**Covers**: delete guards (protected super-admin and self as `aria-disabled="true"`, button not natively disabled and therefore focusable, click has no effect); delete allowed on a normal account (`onDelete(normalUser)`); symmetric disable guards; `Enable ...` action always allowed on an inactive account; badges `Active` ×3 / `Disabled` ×1; `Name` header with initial `aria-sort="none"`.
**Technique**: direct render inside `TooltipProvider`, four `User` fixtures (protected, self, normal, disabled), `vi.fn()` for the callbacks, `element.click()`.
**Notable cases**: the accessible names of the buttons (`Delete <fullName>`, `Disable <fullName>`, `Enable <fullName>`) are a contract.

### `apps/web/src/features/admin/UsersTable.tsx`
**Role**: table of the account fleet: search, sort, badges, per-row actions.
**Exports**:
- `UsersTable({ users, currentUserId, onEdit, onDelete, onToggleActive })`. Local search (name + email, `Escape` clears), `x of y` counter in `aria-live`. Sort by header (`SortableHead`, `aria-sort`, asc then desc; `null` keeps the server order, super-admin first). Columns `Last login` hidden below `lg`, `Created` below `md`. The operator's row is tinted `bg-primary-tint/40`. Empty row `No accounts match “…”.`. Actions: `Edit` always enabled, `Disable`/`Enable` and `Delete` via `GuardedIconButton` (guard = `aria-disabled` + explanatory `Tooltip` + `preventDefault`).
**Depends on**: `RoleBadge`, `StatusBadge`, primitives `Table`, `Tooltip`, `Input`. **Used by**: `pages/AdminPage.tsx`.
**Notes**: `SortableHead` is a component defined inside the render body: its identity changes on every render, so the headers are remounted (possible focus loss after a sort click). `compareUsers` puts `null` dates at the bottom in asc but at the top in desc (global inversion acknowledged in a comment). Dates formatted `en-GB` (`07 Jun 2026`). The empty message also shows for an empty fleet with no search (text with empty quotes) if the page does not handle that case beforehand.

### `apps/web/src/features/admin/UsersTableSkeleton.tsx`
**Role**: loading placeholder that mirrors the real table structure (identical headers, identical responsive columns).
**Exports**:
- `UsersTableSkeleton({ rows = 5 })`. `aria-hidden` body filled with `Skeleton`.
**Used by**: `pages/AdminPage.tsx`.

### `apps/web/src/features/admin/schemas.ts`
**Role**: zod schemas for the account form, differentiated by mode on the password rule.
**Exports**:
- `createUserSchema` (`fullName`, `email`, `role` = `z.enum(ROLES)`, `password` min `PASSWORD_MIN_LENGTH`), `editUserSchema` (empty password accepted then transformed to `undefined`, otherwise min required).
- Types `CreateUserFormValues`, `EditUserFormValues` (`z.input`).
- `userFormSchema(mode: 'create' | 'edit')`.
**Depends on**: `@dive/shared` (`PASSWORD_MIN_LENGTH`, `ROLES`). **Used by**: `UserFormDialog`.
**Notes**: `fullName` has a hard-coded max of `120` whereas `account/schemas.ts` uses `FULL_NAME_MAX_LENGTH` (same value today, drift risk). No dedicated test.

### `apps/web/src/features/admin/useUsers.ts`
**Role**: TanStack hooks for the account fleet.
**Exports**:
- `usersQueryKey = ['users']`.
- `useUsersQuery()`: `listUsers` (`GET /users`).
- `useCreateUser()`: `createUser` (`POST /users`), invalidates `['users']`.
- `useUpdateUser()`: `updateUser(id, input)` (`PATCH /users/:id`), invalidates `['users']`.
- `useDeleteUser()`: `deleteUser(id)` (`DELETE /users/:id`), invalidates `['users']`.
**Depends on**: `@/lib/api/users`. **Used by**: `AdminPage`, the three dialogs.
**Notes**: the comment refers to the global `QueryClient` defaults (`staleTime` 30 s, `retry` 1) defined in the providers.

## `apps/web/src/features/auth/`
Client-side session management. `AuthProvider` restores the session on mount via the httpOnly refresh cookie, exposes `login`/`logout`/`setUser` and clears the whole TanStack cache on logout (explicit or forced by the API client). The access token lives only in memory in `lib/api/client`. The context is isolated in `auth-context.ts` for Fast Refresh compatibility. `useAuth` is consumed everywhere (route guards, layout, pages, dialogs); tests mock it systematically.

### `apps/web/src/features/auth/AuthProvider.tsx`
**Role**: owner of the session state and provider of `AuthContext`. Must be mounted inside the `QueryClientProvider` (it calls `useQueryClient`).
**Exports**:
- `AuthProvider({ children })`. State `user` + `status` (`'loading'` initially). Single bootstrap: `authApi.refresh()` (`POST /auth/refresh`) which already returns the user (no `me()` call), otherwise `unauthenticated`. `login(email, password)` via `POST /auth/login`. `logout()`: `POST /auth/logout` then, in `finally`, reset and `queryClient.clear()` (comment C4: prevent a next user from seeing the previous user's cache). The API client's `setLogoutHandler` is wired so that a failed refresh does the same. Exposed `setUser` = `applyUser`. Memoized context value; `mountedRef` prevents setState after unmount.
- `useAuth()`: reads the context, throws `useAuth must be used within an AuthProvider` outside the provider.
**Depends on**: `@/lib/api/auth`, `setLogoutHandler` (`@/lib/api/client`), `./auth-context`. **Used by**: `app/providers.tsx`, `app/guards.tsx`, `components/layout/*`, pages, `account/useAccount`, `templates/ApplyTemplateFlow`, `chamber/ChamberSavesMenu`, `projects/ConvertToFoamFlow`.
**Notes**: no test in the folder. `login` does not clear the cache (it is cleared on every session exit).

### `apps/web/src/features/auth/auth-context.ts`
Component-free module: type `AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'`, interface `AuthContextValue` (`user`, `status`, `login`, `logout`, `setUser`) and `AuthContext = createContext<AuthContextValue | null>(null)`. Separated from the provider so that React Fast Refresh accepts the component file.

## `apps/web/src/features/dashboard/`
Building blocks of the home dashboard (`HomePage`): hand-made SVG charts (no chart library, same discipline as the solver's `ResidualChart`), a palette mapped onto the brand tokens, and a hook polling the `/dashboard` aggregate every 3 s (server metrics + the user's runs).

### `apps/web/src/features/dashboard/DashboardCharts.tsx`
**Role**: SVG chart primitives; colors arrive as CSS variables from `dashboardColors.ts`.
**Exports**:
- `Sparkline({ values: number[], color: string })`. Fewer than 2 values: empty 34 px block. Otherwise a stretched `200x40` SVG (`preserveAspectRatio="none"`), values clamped 0 to 100, 10 % area + polyline `vector-effect: non-scaling-stroke`. `aria-hidden`.
- `DistributionBar({ segments: { value, color }[], className?, label? })`. Segmented bar (proportional flex); zero total = `var(--color-border)` track; `role="img"` + `aria-label` only if `label`.
- `Donut({ segments, size = 132, unit = 'total runs' })`. Ring via `strokeDasharray` (thickness 16), total centered in `font-mono`, `role="img"` with `aria-label` `"<total> <unit>"`; zero total = neutral ring.
**Used by**: `pages/HomePage.tsx`.
**Notes**: no dedicated test (possible coverage via `HomePage.test.tsx`, to verify). `DistributionBar` uses `rounded-full`, a minor deviation from the 8 to 16 px radius rule.

### `apps/web/src/features/dashboard/dashboardColors.ts`
**Role**: dashboard palette expressed only in tokens (`var(--color-*)` or brand Tailwind classes).
**Exports**:
- `TONE`: `primary`, `primaryLight`, `accent`, `success`, `danger`, `neutral`.
- `usageColor(pct: number): string`: `danger` from 90, `accent` from 75, otherwise `primary`.
- `RUN_STATUS_COLOR: Record<RunStatus, string>`: `queued`/`stopped` neutral, `running` light blue, `converged` success, `completed` blue, `diverged` orange, `failed` danger.
- `RUN_STATUS_PILL: Record<RunStatus, string>`: pill classes (`bg-*-tint text-*`) for the same statuses.
**Used by**: `pages/HomePage.tsx`.

### `apps/web/src/features/dashboard/useDashboard.ts`
Exports `dashboardQueryKey = ['dashboard']` and `useDashboardQuery()`: `getDashboard` (`GET /dashboard`), `refetchInterval` 3000 ms (`POLL_MS`), `refetchIntervalInBackground: false`. No mutation or invalidation. Used by `pages/HomePage.tsx`.

## `apps/web/src/features/export/`
A project's "Export" tab: converts a solved OpenFOAM case to CGNS readable by Ansys CFD-Post (without Fluent). The server runs a 4-step pipeline (`inspect`, `convert`, `validate`, `cfdpost`); the mutation returns the full report even when a tool fails. The tab is loaded via `lazy` by `ProjectDetailPage` (trigger disabled without polyMesh). Artifacts are downloaded as authenticated Blobs.

### `apps/web/src/features/export/ExportTab.tsx`
**Role**: body of the Export tab: single action, step report, case profile, validation, downloads and CFD-Post loading memo.
**Exports**:
- `ExportTab({ projectId: string })`. Data: `run.data` (execution in this session) takes priority over `status.data` (last persisted export). Primary button `Export to CGNS`, or `Re-export` if a CGNS exists, `loading` during the mutation, error as a toast. States: `RunningState` (`role="status"`) if a mutation is in flight without steps; `NoExportYet` (inline `EmptyState`) if nothing; otherwise the report.
- Internal subcomponents: `PipelineReport` (4 rows according to `STEP_META`), `StepRow` (numbered badge colored by status, exit code, duration), `StatusChip` (icon + word: `OK`, `Caveat`, `Failed`, `Skipped`), `LogDisclosure` (collapsible, open by default on failure, `$ command` + stdout + stderr in red, focusable scrollable area), `ProfileCard` (solver, kinematic pressure or Pa, last time, turbulence, fields, patches, excluded empty patches), `ValidationCard` + `Verdict` (`pass`/`fail`/`info`), `Downloads` (one button per available artifact, per-button spinner), `CfdPostMemo` (reminders: `Load Results`, single transient CGNS, pressure p/rho if incompressible, empty patches excluded), `formatDuration`.
**Depends on**: `useExportStatusQuery`, `useRunExport`, `downloadArtifact`, `EmptyState`, `Diamond`. **Used by**: `pages/ProjectDetailPage.tsx` (lazy).
**Notes**: the loading/error states of the status query are not rendered (while loading or on error, the tab shows the empty state). No test. `warning` chip labels in `text-cta-hover` (dark orange for contrast).

### `apps/web/src/features/export/useExport.ts`
**Role**: TanStack hooks for the CGNS export and a download helper.
**Exports**:
- `exportStatusQueryKey(projectId) = ['projects', projectId, 'export']`.
- `useExportStatusQuery(projectId, enabled = true)`: `getExportStatus` (`GET /projects/:id/export`), `ExportStatus | null`.
- `useRunExport(projectId)`: `runExport` (`POST /projects/:id/export`); `onSuccess` writes `{ profile, validation, artifacts }` into the status key via `setQueryData` (no invalidation). Also resolves when `result.success` is false: inspect the result, not only `onError`.
- `downloadArtifact(projectId, artifact: ExportArtifact): Promise<void>`: `downloadExportArtifact` (`GET /projects/:id/export/download/:artifact` as a Blob), temporary anchor with a default name (`out.cgns`, `session.cse`, `LOAD_CFDPOST.md`, `REPORT.md`), then `revokeObjectURL`.
**Depends on**: `@/lib/api/projects`. **Used by**: `ExportTab`.
**Notes**: the object URL is revoked immediately after `click()` (works in mainstream browsers, to verify if large downloads fail). An invalidation of `['projects', id]` also refreshes this status (prefix).

## `apps/web/src/features/files/`
Generic file editor and folder-import utilities. `FileTreeEditor` knows neither project nor template: it receives a `FileTreeResource` (seven hooks already bound to an id), which allows using it for a project's case (`ProjectEditPage`, `solver/SolverFilesStep`) and for a template (`TemplateEditPage`, hooks from `useTemplates`). Keys and invalidations are therefore the responsibility of the injected resource. `folderImport.ts` turns a `webkitdirectory` selection into selectable groups displayed by `FolderImportDialog`.

### `apps/web/src/features/files/FileTreeEditor.tsx`
**Role**: two-pane editor (tree on the left, CodeMirror editor or "easy" form on the right) with autosave, creation, deletion, and moving by drag and drop or menu. Full screen: the parent pins the height to the viewport.
**Exports**:
- `interface FileTreeResource`: `useFiles(): UseQueryResult<CaseEntry[]>`, `useContent(path | null): UseQueryResult<CaseFileContent>`, `useSave()` (`{ path, content }`), `useCreate()` (`{ path }` to `CreateCaseFileResponse`), `useDelete()`, `useDeleteDir()`, `useMove()` (`{ from, to }`).
- `FileTreeEditor({ resource, canEdit = true, emptyFilesHint?, enableEasyMode = false })`. State `selectedPath` + `draft`. The draft is only reloaded when the file changes (`loadedPathRef`, fix H4: the save echo must not overwrite typing in progress). Autosave after `AUTOSAVE_DELAY_MS = 600`; the pending change is flushed immediately before switching files. `UnsavedChangesPrompt when={isDirty}`. After a move or delete, `selectedPath` is rewritten or cleared (including for descendants of a folder).
- Internal components: `FileListSidebar` (states: 6-row skeleton, error + `Try again`, empty = `emptyFilesHint` or `No files yet.`, list; `New file` button if `canEdit`; the whole list is the "root level" drop target), `FileRow` (14 px indentation per level, `GripVertical` handle, files = `aria-current` buttons, folders = non-interactive labels but drop targets), `RowActions` (`DropdownMenu modal={false}` because it renders inside the solver's Dialog; valid destinations via `canMoveInto`; deletion), `DeleteEntryDialog` (file or recursive folder), `EditorPanel` (empty, skeleton, `FILE_TOO_LARGE`, error + retry, `CaseFileForm` or `CaseFileEditor`), `ModeToggle`/`ModeButton` (`Easy`/`Advanced`, `aria-pressed`), `SaveStatus` (`Save failed` + `Retry`, `Saving…`, `Editing…`, `All changes saved`), `EditorEmpty` (diamond), `NewFileDialog` (trim, leading `/` stripped, `..` refused, `FILE_EXISTS` as a field error), `DeleteFileButton`.
- Helpers: `basename`, `destinationPath(dir, from)`, `canMoveInto(dir, from)` (not itself, not a descendant, not the current parent).
**Depends on**: `features/projects/CaseFileEditor`, `CaseFileForm`, `foamForm` (`foamEasyModeAvailable`, `matchFoamFileDef`), `UnsavedChangesPrompt`, `Diamond`. **Used by**: `pages/ProjectEditPage.tsx`, `pages/TemplateEditPage.tsx`, `features/solver/SolverFilesStep.tsx` (`templates/useTemplates.ts` only mentions it in a comment).
**Notes**: easy mode is chosen by default for a recognized file, via a `setState` during render (`modeForPath`). A drop on a file row bubbles up to the list and moves to the root. `hasFiles` only counts files: a tree containing only folders shows the empty state. Non-token classes: `text-white` on destructive actions, `rounded-[6px]` on `ModeButton`. No test in scope.

### `apps/web/src/features/files/FolderImportDialog.tsx`
**Role**: after a folder is selected, let the user tick the immediate children to import.
**Exports**:
- `FolderImportDialog({ picked: PickedFolder | null, importing: boolean, onConfirm(files: UploadFile[]), onCancel })`. Open if `picked` is non-null. Initial selection = everything, re-seeded during render when the key `${root}:${children.length}` changes. `Select all`/`Deselect all`, one native checkbox per child (folder/file icon, file count, size via `formatBytes`). Checkbox `Keep the <root> folder` (default: root stripped). `Import N files` button disabled at 0, `loading` during `importing`; closing blocked during the import.
**Depends on**: `uploadPath`, types from `./folderImport`. **Used by**: `pages/TemplateEditPage.tsx`.
**Notes**: two successive selections of folders with the same name and the same number of children do not re-initialize the selection; `keepRoot` persists from one selection to the next.

### `apps/web/src/features/files/folderImport.test.ts`
**Covers**: `groupPickedFolder` (null if empty, grouping by immediate child, folders before files then alphabetical order, fallback to the name without prefix) and `uploadPath` (root stripped by default, kept on request, bare name unchanged).
**Technique**: helper `pickedFile(relativePath)` that sets `webkitRelativePath` via `Object.defineProperty`.

### `apps/web/src/features/files/folderImport.ts`
**Role**: pure logic for grouping a folder selection.
**Exports**:
- Types `FolderChild` (`name`, `isDir`, `files`, `size`), `PickedFolder` (`root`, `children`), `UploadFile` (`file`, `path`).
- `uploadPath(file: File, keepRoot: boolean): string`: storage path from `webkitRelativePath`, root stripped unless `keepRoot`.
- `groupPickedFolder(files: File[]): PickedFolder | null`: `isDir` if at least 3 segments, name = 2nd segment (or 1st without prefix), folders sorted first.
**Used by**: `FolderImportDialog`, `pages/TemplateEditPage.tsx`, `templates/useTemplates.ts` (type `UploadFile`).

## `apps/web/src/features/templates/`
File templates shared between users. `useTemplates.ts` provides the roster CRUD (`['templates']`), a template's file tree and file contents (same shapes as the case-file hooks, to plug in `FileTreeEditor`), folder/zip import, and application to a project (conflict preview, full or per-file application). Three UIs: `TemplateFormDialog` (metadata, `TemplatesPage` page), `ApplyTemplateFlow` ("Verify case" wizard of `CaseFilesSection`), `TemplateFilePicker` (the solver's "Add from template file").

### `apps/web/src/features/templates/ApplyTemplateFlow.tsx`
**Role**: three-step wizard opened after a case verification: choice, template selection, conflict resolution.
**Exports**:
- `ApplyTemplateFlow({ projectId, verification: CaseVerification | null, onClose, onApplyMinimal, applyingMinimal })`. Returns `null` if `verification` is null (hooks called before). Steps `choice` → `picker` → `conflicts`. `handlePick`: `usePreviewApplyTemplate`; with no conflict, applies directly; otherwise moves to conflicts. `applied()`: if the `applyBoundaries` checkbox (default true) is ticked, `useSyncBoundaries(projectId).mutateAsync()` (error as a toast, but the success toast still follows), then toast `Applied N file(s)...` and close. Closing blocked while `busy`.
- Internals: `ChoiceDialog` (list `missingBase`, note if `!hasMesh`, `Use a saved template…`, `Ignore`, orange CTA `Add minimal base files` if `canScaffold`), `PickerDialog` (`useTemplatesQuery`: spinner, error + retry, empty with a `/templates` link, list with author `You` or the owner's email, spinner on the row in progress; "boundary type and name" checkbox), `ConflictsDialog` (`Keep`/`Overwrite` radio per file, default `keep`, new-file counter, CTA `Apply (overwrite N)`).
**Depends on**: `useApplyTemplate`, `usePreviewApplyTemplate`, `useTemplatesQuery`, `useSyncBoundaries` (`features/projects/useCaseFiles`), `useAuth`. **Used by**: `features/projects/CaseFilesSection.tsx` (mounted only if `pendingVerification`).
**Notes**: orange CTA obtained with inline classes `bg-cta font-bold text-white hover:bg-cta-hover` (no `Button` variant; `text-white` outside tokens). No test.

### `apps/web/src/features/templates/TemplateFilePicker.tsx`
**Role**: "Add from template file" dialog: pick a template, then files to copy into the case (they overwrite files at the same path).
**Exports**:
- `TemplateFilePicker({ projectId, open, onOpenChange, onImported?(applied: string[]) })`. `useTemplatesQuery(open)`, `useTemplateFilesQuery(templateId, !!templateId)`, `useApplyTemplateFiles(projectId)`. Reset on open, selection cleared when the template changes. `NativeSelect` (tags in parentheses), search, checkboxes, `Import N file(s)` button disabled at 0. States: no template chosen, loading, empty or no match.
**Used by**: `features/solver/SolverFilesStep.tsx`.
**Notes**: no error state: an error on the file list displays as `This template has no files.`, an error on the roster leaves the select empty. Closing is not blocked during the import.

### `apps/web/src/features/templates/TemplateFormDialog.tsx`
**Role**: create / edit a template's metadata (name, tags, description); on create, choice of starting point: empty set or a single file entered inline.
**Exports**:
- `TemplateFormDialog({ open, onOpenChange, template?, onCreated?(template) })`. `useForm` on `templateFormSchema`, `reset` on open. `KindButton` (segmented, `aria-pressed`) drives `kind` via `setValue(..., { shouldDirty: true })`; `path` + `content` fields if `kind === 'file'`. Tags parsed by `parseTagInput`, empty description sent as `undefined`. Toasts `Template created.` / `Template updated.`. `VALIDATION_ERROR` as a field error on `name`. `UnsavedChangesPrompt`.
**Depends on**: `useCreateTemplate`, `useUpdateTemplate`, `./schemas`. **Used by**: `pages/TemplatesPage.tsx`.

### `apps/web/src/features/templates/schemas.test.ts`
**Covers**: `parseTagInput` (commas and line breaks, trim, empties removed, empty or `undefined` input); `templateFormSchema` requires a path for `kind: 'file'` and accepts an empty set without a path.

### `apps/web/src/features/templates/schemas.ts`
**Role**: template form schema.
**Exports**:
- `templateFormSchema`: `name` (max `TEMPLATE_NAME_MAX_LENGTH`), `tags` (max 400), `description` (max `TEMPLATE_DESCRIPTION_MAX_LENGTH`), `kind` (`'set' | 'file'`, default `'set'`), `path` (max 300), `content`; `superRefine` requires `path` if `kind === 'file'`. Type `TemplateFormValues`.
- `parseTagInput(raw?: string): string[]`.
**Depends on**: `@dive/shared`.
**Notes**: the doc mentions a "comma/space" list but the regex only splits on commas and line breaks (spaces stay inside a tag; normalization on the server side).

### `apps/web/src/features/templates/useTemplates.ts`
**Role**: all TanStack hooks for templates and their application to a project.
**Exports**:
- Keys: `templatesQueryKey = ['templates']`, `templateQueryKey(id) = ['templates', id]`, `templateFilesQueryKey(tid) = ['templates', tid, 'files']`, `templateFileContentQueryKey(tid, path) = ['templates', tid, 'files', 'content', path]`.
- `useTemplatesQuery(enabled = true)`: `GET /templates`. `useTemplateQuery(id)`: `GET /templates/:id` (enabled if `id`).
- `useCreateTemplate()`: `POST /templates`, invalidates `['templates']`. `useUpdateTemplate()`: `PATCH /templates/:id`, invalidates `['templates']` and writes `templateQueryKey(id)`. `useDeleteTemplate()`: `DELETE /templates/:id`, invalidates `['templates']`.
- `useTemplateFilesQuery(tid, enabled = true)`: `GET /templates/:id/files`. `useTemplateFileContentQuery(tid, path | null)`: `GET /templates/:id/files/content?path=` (enabled only if `path`).
- `useImportTemplate(tid)`: folder (`UploadFile[]`) or zip to `POST /templates/:id/files/import` (multipart), `setQueryData` of the tree with `result.entries`.
- `useCreateTemplateFile(tid)`: `POST /templates/:id/files/content` `{ path }`, writes the tree. `useDeleteTemplateFile(tid)`: `DELETE .../files/content?path=`, writes the tree and `removeQueries` for that file's content. `useDeleteTemplateDir(tid)`: `DELETE .../files/dir?path=`, writes the tree and removes all contents. `useMoveTemplatePath(tid)`: `POST .../files/move`, likewise. `useSaveTemplateFile(tid)`: text `PUT` `.../files/content?path=`, writes the content locally (`size` via `Blob`) and invalidates the tree.
- `usePreviewApplyTemplate(projectId)`: mutation on `GET /projects/:id/apply-template/:tid/preview` (no cache). `useApplyTemplate(projectId)`: `POST /projects/:id/apply-template/:tid` (+ `decisions`), writes `caseFilesQueryKey(projectId)`. `useApplyTemplateFiles(projectId)`: `POST .../apply-template/:tid/files` `{ paths }`, likewise.
**Depends on**: `@/lib/api/templates`, `@/lib/api/projects`, `caseFilesQueryKey` (`features/projects/useCaseFiles`). **Used by**: the three components of the folder, `TemplatesPage`, `TemplateEditPage`.
**Notes**: invalidating `['templates']` (create, update, delete) also invalidates, by prefix, all cached template file trees and contents. `useApplyTemplate` / `useApplyTemplateFiles` do not remove the case content caches (`['projects', id, 'files', 'content', path]`): an overwritten file that is already open may stay stale until the next refetch.

## `apps/web/src/features/terminal/`
Optional shell terminal in the project directory. The feature is disabled by default on the server side: the button only appears if `GET /config` returns `terminalEnabled`. xterm.js and the WebSocket bridge are loaded on demand (`lazy`) when the dialog opens. Deliberately dark surface (`--terminal-*` tokens) in a light app, for ANSI legibility.

### `apps/web/src/features/terminal/ProjectTerminalButton.tsx`
**Role**: project header action that opens a terminal in a large dialog.
**Exports**:
- `ProjectTerminalButton({ projectId, projectTitle })`. Query `['server-config']` on `getServerConfig` (`GET /config`), `staleTime: Infinity`, `retry: false`. Returns `null` as long as `terminalEnabled` is not true. `TerminalView` via `lazy` + `Suspense` (fallback `TerminalLoading`, `role="status"`), mounted only while the dialog is open (closing therefore unmounts the socket).
**Used by**: `pages/ProjectDetailPage.tsx`.
**Notes**: the `['server-config']` key is declared inline (no shared constant).

### `apps/web/src/features/terminal/TerminalView.tsx`
**Role**: xterm.js terminal connected to the project shell over WebSocket.
**Exports**:
- `TerminalView({ projectId })`. Creates `Terminal` (mono font, 13 px, `scrollback` 5000, `convertEol`) + `FitAddon`, theme via `terminalTheme()` which reads the CSS tokens (`--terminal-bg`, `--terminal-fg`, `--terminal-ansi-*`, `--color-accent` for the cursor) with hex fallbacks. URL: `VITE_API_URL` with `http` replaced by `ws`, then `/projects/:id/terminal` (error if the variable is missing). Authentication via subprotocol `['bearer', token]` (`getAccessToken`). JSON protocol: client `{ type: 'input', data }`, `{ type: 'resize', cols, rows }`; server `{ type: 'output', data }`, `{ type: 'ready', pty }` (message if no PTY), `{ type: 'exit' }`. `ResizeObserver` re-runs `fit()` and sends the size. States `connecting`/`open`/`closed`/`error` displayed by `StatusPill`; `Reconnect` button that increments `attempt` to recreate terminal + socket.
**Depends on**: `@xterm/xterm`, `@xterm/addon-fit`, `getAccessToken`. **Used by**: `ProjectTerminalButton` (lazy).
**Notes**: env variable read: `VITE_API_URL`. On reconnect, `status` and `reason` do not go back to `connecting`: the old state stays displayed until `onopen`. The token is only read when the socket opens. Hard-coded colors: `brightWhite: '#FFFFFF'` and an ANSI gray `38;2;154;164;178` in system messages. No test.

## `apps/web/src/features/visualize/`
"Visualize" tab: three.js viewer of OpenFOAM boundary patches, either of the case mesh (`constant/polyMesh`) or of a part imported into the library (source). `VisualizePanel` chooses the target, `MeshViewer` calls both sets of hooks (case via `useMesh`, source via `features/assemble/useAssembly` and `features/projects/useMeshes`) keeping only the target's set active. The manifest triggers the server build (GLB + manifest); the geometry and the edge buffer are only requested afterwards. Editing of names/types (`EditPatchesDialog`), `autoPatch` (`AutoPatchDialog`) and mesh backup/restore (case only). `MeshScene` is exported and reused by `chamber/ChamberViewer` and `meshing/MeshResultViewer`.

### `apps/web/src/features/visualize/AutoPatchDialog.tsx`
**Role**: run `autoPatch <featureAngle> -overwrite` on the current target.
**Exports**:
- `AutoPatchDialog({ projectId, target: MeshTarget, open, onClose, onPatched? })`. Local zod form (`featureAngle` number 0 to 180, default `DEFAULT_FEATURE_ANGLE = 45`, `valueAsNumber`, `mode: 'onSubmit'`), re-seeded on each open. Creates both mutations (`useAutoPatch` for the case, `useAutoPatchMeshSource` for a source) and only runs the target's one. A tool failure (`success === false`) is not an exception: `AutoPatchFailure` shows command, exit code and log (only the title carries `role="alert"`), the dialog stays open. Success: toast with the number of patches, `onPatched`, close. Warning that `constant/polyMesh/boundary` is rewritten in place.
**Depends on**: `useAutoPatch`, `useAutoPatchMeshSource`. **Used by**: `MeshViewer`.

### `apps/web/src/features/visualize/EditPatchesDialog.tsx`
**Role**: batch editing of the names and types of all patches, saved in a single request.
**Exports**:
- `EditPatchesDialog({ projectId, target, open, patches, onClose, onSaved(renames) })`. Rows `{ from, originalType, name, type }` re-seeded when the dialog opens or when `patches` changes. Live validation: name required, `PATCH_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/` (hyphens accepted for Fluent zones), case-sensitive uniqueness. On invalid submit, focus on `patch-name-<index>` (no disabled button). Only modified rows are sent (`MeshPatchEdit[]`); no modification = close. Case: `useEditPatches`; source: `useEditMeshSourcePatches({ meshId, edits })`. `PATCH_EXISTS` as a dedicated toast. `TypeSelect`: types from `MESH_PATCH_TYPES`, flow roles `PATCH_ROLES` (boundary condition preset) only for the case, a value outside `MESH_PATCH_SETTINGS` kept as an option.
**Depends on**: `@dive/shared` (`MESH_PATCH_SETTINGS`, `MESH_PATCH_TYPES`, `PATCH_ROLES`), `useEditPatches`, `useEditMeshSourcePatches`. **Used by**: `MeshViewer`.
**Notes**: a manifest refetch while the dialog is open (new identity of `patches`) resets the inputs. The `patch-name-<index>` ids are not scoped (`useId` not used).

### `apps/web/src/features/visualize/MeshViewer.tsx`
**Role**: viewer body: left panel (patch table, actions, backup) and three.js scene on the right, with all states (building, empty, error with retry, no WebGL).
**Exports**:
- `type MeshTarget = { kind: 'case' } | { kind: 'source'; meshId: string; name: string }`.
- `MeshViewer({ projectId, target = { kind: 'case' } })` (also the default export). Owns `selected`, shared between table and scene. Calls both sets of hooks on every render with `enabled`: case (`useMeshManifestQuery`, `useMeshGeometryQuery`, `useMeshEdgesQuery`, `useMeshBackupQuery`) and source (`useMeshSourceManifestQuery`, `useMeshSourceGeometryQuery`, `useMeshSourceEdgesQuery`). Geometry and edges only if the manifest is OK, patches are present and WebGL is available. `handleRebuild`: case via `useRebuildMesh`; source via `removeQueries` of the three source keys. `BackupBar` (case only): status (`Original saved …` / `Backup saved …`, `en-GB` format), `Save backup`/`Overwrite backup`, `Restore from backup` confirmed via `AlertDialog`. Opens `EditPatchesDialog` (keeps the selection on a renamed patch) and `AutoPatchDialog` (clears the selection).
- `MeshScene({ geometry: ArrayBuffer, edges: ArrayBuffer | null, patches, selected, onSelect, onRebuild, rebuilding })`. Scene built once per `geometry`/`edges` pair: `GLTFLoader.parse`, neutral `MeshLambertMaterial` (`--color-neutral`) with `polygonOffset`, normals computed if missing, real edges from `edges.bin` (`edgeOffset`/`edgeCount` from the manifest) otherwise a fallback `EdgesGeometry`; caps `EDGE_BUILD_CAP = 2_000_000` and `EDGE_SHOW_CAP = 400_000` triangles. On-demand rendering (one frame per `OrbitControls` `change`), damping disabled under `prefers-reduced-motion`. Selection by raycast on click only (drag threshold `CLICK_DRAG_THRESHOLD_SQ = 36`), re-click = deselect. Highlighting via `applyHighlight` (selection in orange `--color-accent`, others at opacity 0.12). Floating buttons `Show/Hide mesh edges` (`aria-pressed`) and `Reset view`. Failed parse = `StageError`. Full cleanup (geometries, materials, renderer, observers).
- Internals: `CanvasArea` (state order: no WebGL, building, manifest error, empty, geometry loading, geometry error, scene), `StageMessage`, `StageError` (collapsible technical details + `Try again`), `PatchTableSkeleton`, `BackupBar`, `manifestErrorMessage` (`NO_MESH`), `buildErrorMessage` (`MESH_BUILD_FAILED`), `errorDetail`, `detectWebgl`, `readToken`, `triangleCount`, `buildEdgeGeometry`.
**Depends on**: `three`, `OrbitControls`, `GLTFLoader`, `./useMesh`, `features/assemble/useAssembly`, `PatchTable`, both dialogs. **Used by**: `VisualizePanel`; `MeshScene` by `chamber/ChamberViewer.tsx` and `meshing/MeshResultViewer.tsx`; the `MeshTarget` type by the dialogs.
**Notes**: the `AlertDialog`'s `Restore` action is not disabled during the restore (only the label changes to `Restoring…`). The GLB's original materials, replaced by the Lambert materials, are not `dispose()`d (to verify). Light colors hard-coded in hex (`0xffffff`, `0xcfd3da`). The header comment says "Lazy-loaded": it is `VisualizePanel` that is loaded via `lazy` by `ProjectDetailPage`; `MeshViewer` is imported statically there. `features/assemble/AssemblyViewer.tsx` copies part of this file instead of importing it.

### `apps/web/src/features/visualize/PatchTable.test.tsx`
**Covers**: one row per patch with a formatted face count (`65,000`); click = `onSelect(name)`, re-click on the selected row = `onSelect(null)`; `aria-selected` true/false; no combobox and no `rename`/`show all` button (read-only table).
**Technique**: direct render, `fireEvent.click`, `vi.fn()`.

### `apps/web/src/features/visualize/PatchTable.tsx`
**Role**: read-only Name / Type / nFaces table, linked to the 3D selection.
**Exports**:
- `PatchTable({ patches: MeshPatch[], selected: string | null, onSelect(name | null) })`. Focusable rows (`tabIndex=0`), activatable with `Enter`/`Space`, selection toggle, selected row in `bg-accent-tint` + bold name + `aria-selected`. `scrollIntoView({ block: 'nearest' })` of the selected row (guarded if the method does not exist, jsdom case). Sticky header. Numbers formatted `en-GB`.
**Used by**: `MeshViewer`.

### `apps/web/src/features/visualize/VisualizePanel.test.tsx`
**Covers**: default target = case (patch `caseInlet`, `getMeshManifest('p1')`, backup bar present); switching the target to source `src1` (`getMeshSourceManifest('p1', 'src1')`); backup bar hidden for a source; `Edit names` on a source calls `editMeshSourcePatches('p1', 'src1', [{ from: 'srcInlet', to: 'srcInletX', type: 'patch' }])` and never `editMeshPatches` (C4); `Auto-patch` on a source calls `autoPatchMeshSource('p1', 'src1', 45)` and never `autoPatchMesh`.
**Technique**: full `vi.mock`s of `@/lib/api/meshes` and `@/lib/api/projects`; real panel, viewer and dialogs. jsdom has no WebGL, so only the left part is rendered. `QueryClient` without retry, `TooltipProvider`, `fireEvent.change` on the select labeled `Mesh`.
**Notable cases**: the header comment explains that the absence of WebGL is what makes these tests possible.

### `apps/web/src/features/visualize/VisualizePanel.tsx`
**Role**: tab body: owns the target and the mesh selector, renders `MeshViewer` remounted per target.
**Exports**:
- `VisualizePanel({ projectId })` (also the default export). `useCaseFilesQuery` (presence of a `constant/polyMesh/` path) and `useMeshesQuery` (sources). A `useEffect` picks the default target (case if polyMesh, otherwise the first source, otherwise `null`) and reconciles if the current source disappears or is renamed. `NativeSelect` selector labeled `Mesh`, shown only if there are at least two options (value `MERGE_BASE_CASE` for the case); "Library part..." mention for a source. `MeshViewer key={targetKey}` to start from a clean scene. `PanelPlaceholder`: loading (`Loading meshes…`) or `EmptyState` `Nothing to visualize`.
**Depends on**: `features/projects/useCaseFiles`, `features/projects/useMeshes`, `MERGE_BASE_CASE` (`@/lib/api/types`), `MeshViewer`. **Used by**: `pages/ProjectDetailPage.tsx` (lazy).

### `apps/web/src/features/visualize/useMesh.ts`
**Role**: TanStack hooks for the case mesh for the viewer (the source hooks live elsewhere).
**Exports**:
- Keys: `meshManifestQueryKey(id) = ['projects', id, 'mesh', 'manifest']`, `meshGeometryQueryKey(id) = [..., 'mesh', 'glb']`, `meshEdgesQueryKey(id) = [..., 'mesh', 'edges']`, `meshBackupQueryKey(id) = [..., 'mesh', 'backup']`. All queries: `retry: false`, `staleTime` and `gcTime` of 5 minutes.
- `useMeshManifestQuery(projectId, enabled = true)`: `GET /projects/:id/mesh/manifest` (first call = server build; 409 `NO_MESH` and 502 treated as final).
- `useMeshGeometryQuery(projectId, enabled)`: `GET /projects/:id/mesh/geometry` as a Blob converted to `ArrayBuffer`.
- `useMeshEdgesQuery(projectId, enabled)`: `GET /projects/:id/mesh/edges`, `ArrayBuffer | null` (404 → `null` in the API wrapper).
- `useMeshBackupQuery(projectId, enabled = true)`: `GET /projects/:id/mesh/backup`, `MeshBackupInfo | null`.
- `useRebuildMesh(projectId)`: `POST .../mesh/rebuild`; writes the manifest, `removeQueries` glb + edges.
- `useRenamePatch(projectId)`: `POST .../mesh/patches/rename`; `removeQueries` manifest + glb + edges, invalidates `['projects', id, 'files']`.
- `useSetPatchType(projectId)`: `POST .../mesh/patches/type`; same effects.
- `useAutoPatch(projectId)`: `POST .../mesh/auto-patch` `{ featureAngle }`; only if `result.success`: `removeQueries` manifest + glb + edges, invalidates files and backup.
- `useEditPatches(projectId)`: `PUT .../mesh/patches` `{ edits }`; `removeQueries` manifest + glb + edges, invalidates files and backup.
- `useSaveBackup(projectId)`: `POST .../mesh/backup`; writes the backup key.
- `useRestoreBackup(projectId)`: `POST .../mesh/backup/restore`; writes the manifest, `removeQueries` glb + edges, invalidates files.
**Depends on**: `@/lib/api/projects`. **Used by**: `MeshViewer`, `AutoPatchDialog`, `EditPatchesDialog`.
**Notes**: `useRenamePatch` and `useSetPatchType` are imported nowhere (replaced by batch editing): dead code. The case-file key is hard-coded as `['projects', projectId, 'files']` instead of importing `caseFilesQueryKey`; by prefix it also invalidates open file contents. `features/assemble/useAssembly.ts` redeclares the same manifest/glb keys (`caseMeshManifestQueryKey`, `caseMeshGeometryQueryKey`): two sources of truth for the same cache. Removing (`removeQueries`) rather than invalidating guarantees that the geometry, gated on the manifest, cannot be refetched before the rebuild.
