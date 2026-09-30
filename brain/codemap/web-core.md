# Codemap: web-core

> Scope: `apps/web/` excluding `apps/web/src/features/` (configs, `public/`, `src/app`, `src/components`, `src/lib`, `src/pages`, `src/styles`, `src/test`, `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`) · Updated: 2026-09-28

## Overview
Foundation of the React 18 + Vite 5 + TypeScript front end of the `@dive/web` package. `index.html` loads `src/main.tsx`, which imports the self-hosted Inter fonts and `styles/index.css`, then mounts `App`. `App` wraps the `RouterProvider` in `Providers` (TanStack Query, `AuthProvider`, `TooltipProvider`, `Toaster`). `app/router.tsx` declares all routes: each page in `pages/` is a `lazy` chunk, protected by the guards in `app/guards.tsx` and rendered inside `components/layout/AppShell`.
The data layer is `lib/api/`: `client.ts` (fetch + in-memory bearer + single-flight refresh on 401) and one module of typed wrappers per domain, all typed by `types.ts` (mirror of the `/api/v1` contract, largely re-exported from `@dive/shared`). TanStack Query hooks live in `features/*` (out of scope); pages compose them.
The design system lives in `styles/tokens.css` (single source of CSS variables), mirrored under semantic names by `tailwind.config.ts`, consumed by the `components/ui/*` primitives (shadcn style on Radix) and the shared components `components/common/*`, `components/brand/*`.
Tests: Vitest + jsdom + Testing Library, setup in `src/test/setup.ts`, co-located `*.test.tsx` files.

## `apps/web/public/favicon.svg`
32x32 SVG favicon: rounded white square carrying the DIVE diamond (square rotated 45°) in `#004A99`. Referenced by `index.html`.

## `apps/web/public/logo.svg`
Binary-like asset (Adobe Illustrator export, 793.51 x 211.364): official DIVE Turbinen logo, diamond emblem + wordmark, fills `#004A99` (dominant), `#EE7F00` and `#BCBDBF`. Served at `/logo.svg` and rendered by `BrandLockup`.

## `apps/web/src/app/guards.tsx`
**Role**: router route guards. They read the session status via `useAuth()` (`features/auth/AuthProvider`) and decide whether to show the loader, redirect, or render the children.
**Exports**:
- `RequireAuth({ children })`. `status === 'loading'`: `FullPageLoader`. `'unauthenticated'`: `<Navigate to="/login" replace state={{ from: pathname + search }}>`. Otherwise renders the children.
- `RedirectIfAuthenticated({ children })`. Guard for `/login`: loader during bootstrap; if authenticated, redirects to `location.state.from` or `/`.
- `RequireRole({ role, children })`. Compares `user?.role` with the required role; on failure renders an internal 403 view `Forbidden` (`ShieldAlert` icon, text "Access restricted", secondary button to `/`), without redirecting.
**Depends on**: `FullPageLoader`, `Button`, `useAuth`, type `Role`. **Used by**: `app/router.tsx`.
**Notes**: `RequireRole` does not handle the `loading` state (it is always nested under `RequireAuth`).

## `apps/web/src/app/providers.tsx`
**Role**: composes the global providers around the routed tree. The `QueryClient` is created once via the lazy initializer of `useState`.
**Exports**:
- `Providers({ children })`. Order: `QueryClientProvider` > `AuthProvider` > `TooltipProvider delayDuration={200} skipDelayDuration={300}` > children + `<Toaster />`.
**Depends on**: `@tanstack/react-query`, `TooltipProvider`, `Toaster`, `AuthProvider`. **Used by**: `App.tsx`.
**Notes**: default query options: `staleTime: 30_000`, `retry: 1`, `refetchOnWindowFocus: false`. No default options for mutations. `AuthProvider` sits under the `QueryClientProvider` because it calls `queryClient.clear()` on logout.

## `apps/web/src/app/router.tsx`
**Role**: route tree (`createBrowserRouter`, data router, required by `useBlocker`). All pages are imported as `lazy(() => import(...).then(m => ({ default: m.X })))` because they export named components.
**Exports**:
- `router`. `/login`: `RedirectIfAuthenticated` > `Suspense(FullPageLoader)` > `LoginPage`. Protected branch without path: `RequireAuth` > `AppShell`, children: index `HomePage`, `projects` `ProjectsPage`, `projects/:id` `ProjectDetailPage`, `projects/:id/edit` `ProjectEditPage`, `templates` `TemplatesPage`, `templates/:id/edit` `TemplateEditPage`, `meshing` `MeshingPage`, `meshing/:id` `MeshingSessionPage`, `chamber` `ChamberPage`, `account` `AccountPage`, `admin` `RequireRole role="SUPER_ADMIN"` > `AdminPage`. Catch-all `*`: `<Navigate to="/" replace />`.
**Depends on**: `AppShell`, `FullPageLoader`, `guards`, `pages/*`. **Used by**: `App.tsx`.
**Notes**: the `Suspense` for protected pages lives in `AppShell` (the shell stays visible while the chunk loads). The header comment only describes Home and Admin (predates the other routes).

## `apps/web/src/components/brand/BrandLockup.tsx`
**Role**: renders the official logo `/logo.svg` as an `<img>` with explicit width/height (no layout shift).
**Exports**:
- `BrandLockup({ size?: 'sm'|'md'|'lg', alt?: string, className? })`. `SIZES`: sm 90x24, md 105x28, lg 150x40 (ratio ≈ 3.754). Default `alt` is `'DIVE Turbinen'`, `""` when a parent already names the control. `draggable={false}`.
- `BrandLockupProps`.
**Depends on**: `cn`. **Used by**: `Header`, `MobileNav`, `FullPageLoader`, `LoginPage`.

## `apps/web/src/components/brand/Diamond.tsx`
**Role**: the DIVE diamond in SVG (`rect` rotated 45°), a recurring motif (bullets, active nav marker, empty states, super-admin badge). Decorative (`aria-hidden`, `role="presentation"`).
**Exports**:
- `Diamond({ size = 12, color = 'currentColor', outline = false, className })`. Filled or outlined (stroke 1.2). Color inherited from text by default.
- `DiamondProps`.
**Depends on**: `cn`. **Used by**: `EmptyState`, `RoleBadge`, `Sidebar`, `MobileNav`, `MeshingSessionPage`, features.
**Notes**: the comment (`brain/design/design-system.md` section 1) forbids filling it in orange or rendering it large.

## `apps/web/src/components/common/EmptyState.tsx`
**Role**: centered "teach the next step" empty state: `bg-primary-tint` pill with `Diamond`, title, one help line, optional action.
**Exports**:
- `EmptyState({ title, description, action?, variant?: 'card'|'inline', className? })`. `card` (default) draws its own bordered surface; `inline` drops the chrome to fit inside an existing panel (avoids card in card).
- `EmptyStateProps`.
**Depends on**: `Diamond`, `cn`. **Used by**: `AdminPage`, `ProjectsPage`, `TemplatesPage`, `MeshingPage`, `MeshingSessionPage`, `ProjectDetailPage`, `HomePage`, features.

## `apps/web/src/components/common/ErrorState.tsx`
**Role**: shared load-error block (`role="alert"`, `bg-danger-tint` background, `AlertTriangle` icon) with a secondary "Try again" button. Replaces copies formerly duplicated across lists.
**Exports**:
- `ErrorState({ title, description = 'Check your connection and try again.', onRetry?, retrying = false, className? })`. The button only appears if `onRetry` is provided; `retrying` puts it in `loading`.
- `ErrorStateProps`.
**Depends on**: `Button`, `cn`. **Used by**: `AdminPage`, `ProjectsPage`, `TemplatesPage`, `MeshingPage` (no feature imports it yet).

## `apps/web/src/components/common/FullPageLoader.tsx`
**Role**: full-screen loader (`min-h-[100dvh]`, `bg-bg`): `BrandLockup size="lg"` + `Loader2` spinner + "Loading your workspace", `role="status"` `aria-live="polite"`.
**Exports**: `FullPageLoader()`.
**Depends on**: `BrandLockup`. **Used by**: `guards.tsx`, `router.tsx` (fallback for `/login`), `AccountPage`, `ProjectDetailPage`, `ProjectEditPage`, `TemplateEditPage`.
**Notes**: these four pages also use it as a loading state inside the shell, where its `100dvh` height overflows the content area.

## `apps/web/src/components/common/PageHeader.tsx`
**Role**: page title row: `h1` `text-2xl font-semibold`, optional subtitle, right-aligned action slot (stacked below `sm`).
**Exports**: `PageHeader({ title, subtitle?, action?, className? })`, `PageHeaderProps`.
**Depends on**: `cn`. **Used by**: most pages (except `HomePage`, `LoginPage`, `ProjectEditPage`, `TemplateEditPage`).

## `apps/web/src/components/common/RenameDialog.tsx`
**Role**: small controlled modal to rename an entity through a single field.
**Exports**:
- `RenameDialog({ open, onOpenChange, title, label, currentName, maxLength = 120, pending = false, onSubmit(name) })`. Resets the value on each open (`useEffect` on `open`, `currentName`). "Save" is disabled while the trimmed value is empty, unchanged or `pending`. `onSubmit` receives the trimmed value; closing after success is up to the caller.
**Depends on**: `Dialog*`, `Field`, `Input`, `Button`. **Used by**: `ProjectsPage`, `MeshingPage`.

## `apps/web/src/components/common/RoleBadge.tsx`
**Role**: user role badge.
**Exports**: `RoleBadge({ role })`, `RoleBadgeProps`. `SUPER_ADMIN`: `Badge variant="primary"` + `Diamond size={9}` + "Super admin"; otherwise `Badge variant="neutral"` "User".
**Used by**: `UserMenu`, `features/account/ProfileSection`, `features/admin/UsersTable`.

## `apps/web/src/components/common/StatusBadge.tsx`
**Role**: active/disabled account badge, icon + text (never color alone).
**Exports**: `StatusBadge({ active })`, `StatusBadgeProps`. Active: `variant="success"` + `CircleCheck` "Active"; otherwise `variant="neutral"` + `CircleSlash` "Disabled".
**Used by**: `features/admin/UsersTable`.

## `apps/web/src/components/common/UnsavedChangesPrompt.tsx`
**Role**: guard against losing unsaved input. Active when `when` is true.
**Exports**:
- `UnsavedChangesPrompt({ when })`. Arms `beforeunload` (reload, tab close) and `useBlocker` for internal navigation to another `pathname` (query/hash changes do not block). Renders an `AlertDialog` "Discard unsaved changes?": "Stay on page" (`blocker.reset()`), "Discard changes" (`blocker.proceed()`, danger style overridden via classes). Closing via Esc/scrim cancels the navigation.
**Depends on**: `react-router-dom` `useBlocker` (requires a data router), `AlertDialog*`. **Used by**: `AccountPage`, `features/admin/UserFormDialog`, `features/files/FileTreeEditor`, `features/templates/TemplateFormDialog`.

## `apps/web/src/components/common/UnsavedChangesPrompt.test.tsx`
**Covers**: navigation is blocked and the prompt shown when `when=true`; no interception when `when=false`; "Stay on page" stays on the page; "Discard changes" closes the prompt.
**Technique**: real `createMemoryRouter` (so that `useBlocker` is active) + `userEvent`. Local override of `globalThis.Request` that prefixes `http://localhost` to relative paths and drops the `signal` (jsdom / undici incompatibility of the data router).
**Notable cases**: the last test only checks that the prompt disappears, not that `/next` is reached.

## `apps/web/src/components/layout/AppShell.tsx`
**Role**: authenticated layout: `.skip-link` skip link to `#main`, `Header`, then `Sidebar` + `<main id="main" tabIndex={-1}>` containing a `Suspense` (`Loader2` spinner, "Loading") around the `<Outlet/>`.
**Exports**: `AppShell()`.
**Depends on**: `Header`, `Sidebar`, `useLocation`. **Used by**: `router.tsx`.
**Notes**: the container class depends on the path (regex): editor (`/(projects|templates)/:id/edit`) pinned to `h-[calc(100dvh_-_4rem)]` and `overflow-hidden` at all sizes; project detail and dashboard `/` full width and pinned from `lg` up; `/chamber` full width in normal flow; everything else centered `max-w-content` (1200px). Adding a full-screen page requires editing these regexes.

## `apps/web/src/components/layout/Header.tsx`
**Role**: top bar `sticky top-0 z-sticky h-16`: on the left `MobileNav` (below `lg`) + `BrandLockup` link to `/` (`aria-label="DIVE Turbinen home"`, `alt=""`), on the right `UserMenu`.
**Exports**: `Header()`. **Used by**: `AppShell`.

## `apps/web/src/components/layout/MobileNav.tsx`
**Role**: the side navigation as a sliding panel (Radix Dialog) below 1024px; `Menu` button, closes on every `pathname` change.
**Exports**: `MobileNav()`. Items via `visibleNavItems(user?.role)`, `NavLink` with `end` for `/`, active state `bg-primary-tint text-primary` + `Diamond size={6}`.
**Depends on**: `@radix-ui/react-dialog`, `BrandLockup`, `Diamond`, `useAuth`, `nav.ts`. **Used by**: `Header`.
**Notes**: duplicates the item rendering of `Sidebar` (same classes, different vertical padding); only the `nav.ts` model is shared.

## `apps/web/src/components/layout/Sidebar.tsx`
**Role**: desktop side navigation (`w-60`, visible from `lg` up), icon + label items, diamond marker on the active item (`aria-current` provided by `NavLink`).
**Exports**: `Sidebar()`. **Depends on**: `Diamond`, `useAuth`, `nav.ts`. **Used by**: `AppShell`.

## `apps/web/src/components/layout/UserMenu.tsx`
**Role**: avatar button (initials) opening a `DropdownMenu`: name, email, `RoleBadge`, "Account settings" link (`/account`, via `asChild` + `Link`), destructive "Log out".
**Exports**: `UserMenu()` (renders `null` without a user). Internal helper `initialsOf(fullName)` (2 initials max, `?` if empty).
**Depends on**: `Avatar`, `DropdownMenu*`, `RoleBadge`, `useAuth`, `toast`. **Used by**: `Header`.
**Notes**: logout calls `event.preventDefault()` in `onSelect` then `logout()`; a network error shows a toast but the local session is cleared anyway (`AuthProvider.logout`).

## `apps/web/src/components/layout/nav.ts`
**Role**: single model of the main navigation, shared by `Sidebar` and `MobileNav`.
**Exports**:
- `NavItem` (`label`, `to`, `icon: LucideIcon`, `requiredRole?`).
- `visibleNavItems(role: Role | undefined): NavItem[]`. Filters items with a required role.
- Internal constant `NAV_ITEMS`: Home `/` (`Home`), Projects `/projects` (`FolderKanban`), Templates `/templates` (`LayoutTemplate`), Meshing `/meshing` (`Boxes`), Chamber Creation `/chamber` (`Box`), Administration `/admin` (`Users`, `SUPER_ADMIN`).
**Notes**: `/account` is not in the nav (reachable via `UserMenu`).

## `apps/web/src/components/ui/alert-dialog.tsx`
**Role**: confirmation dialog on Radix AlertDialog, `max-w-[420px]`, `rounded-md`, `shadow-lg`, `content-in/out` animations.
**Exports**: `AlertDialog`, `AlertDialogPortal`, `AlertDialogOverlay` (`bg-scrim z-overlay`), `AlertDialogTrigger`, `AlertDialogContent` (portal + overlay included, `z-modal`), `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction` (styled `buttonVariants({ variant: 'destructive' })`), `AlertDialogCancel` (styled `secondary`).
**Used by**: `UnsavedChangesPrompt`, `ProjectDetailPage`, `TemplatesPage`, `MeshingSessionPage`, features.
**Notes**: `AlertDialogAction` has no `loading` state: callers add a `Loader2` by hand and `event.preventDefault()` to keep the modal open during the mutation.

## `apps/web/src/components/ui/avatar.tsx`
**Role**: round Radix avatar (`size-9 rounded-full`), initials fallback on `bg-primary-tint text-primary`.
**Exports**: `Avatar`, `AvatarImage`, `AvatarFallback`. **Used by**: `UserMenu`.

## `apps/web/src/components/ui/badge.tsx`
**Role**: compact label `text-xs font-medium rounded-sm px-2 py-1`.
**Exports**: `Badge` (forwardRef `span`), `badgeVariants` (cva), `BadgeProps`. Variants: `neutral` (default, border + `bg-bg`), `primary`, `success`, `danger`.
**Used by**: `RoleBadge`, `StatusBadge`, `MeshingSessionPage`, features.

## `apps/web/src/components/ui/button.tsx`
**Role**: the single button primitive of the application.
**Exports**:
- `Button` (forwardRef; props `variant`, `size`, `asChild`, `loading`). Variants: `primary` (default: `bg-cta text-white font-bold`, hover `bg-cta-hover`), `secondary` (blue outline, hover `bg-primary-tint`), `ghost` (transparent, `text-text-secondary`, hover `bg-bg`), `destructive` (`bg-danger`). Sizes: `sm` (h-8), `md` (h-10, default), `icon` (size-10). Shared disabled style: `bg-border text-text-secondary`. `:active` pushes down 1px.
- `buttonVariants` (cva), `ButtonProps`.
**Notes**: `loading` overlays a `Loader2` and makes the label `invisible` (stable width), sets `disabled` and `aria-busy`. `asChild` uses Radix `Slot` except when `loading` (then falls back to a native `<button>`). Design rule: a single `primary` per action zone.

## `apps/web/src/components/ui/dialog.tsx`
**Role**: Radix Dialog modal, `max-w-[480px]`, built-in `X` close button at top right.
**Exports**: `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogTrigger`, `DialogClose`, `DialogContent` (portal + overlay included), `DialogHeader` (`pr-8` to leave room for the X), `DialogFooter`, `DialogTitle`, `DialogDescription`.
**Used by**: `RenameDialog`, `ProjectDetailPage`, features.

## `apps/web/src/components/ui/dropdown-menu.tsx`
**Role**: tokenized Radix dropdown menu (`z-dropdown`, `shadow-md`, `rounded-sm`, items `rounded-xs`).
**Exports**: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent` (`sideOffset` 6, portal included), `DropdownMenuItem` (`destructive` prop: danger text + `bg-danger-tint` highlight), `DropdownMenuCheckboxItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuGroup`, `DropdownMenuPortal`.
**Used by**: `UserMenu`, `ProjectDetailPage`, features.

## `apps/web/src/components/ui/field.tsx`
**Role**: label + control + help/error wrapper with ARIA wiring through React context.
**Exports**:
- `Field` (forwardRef `div`; props `label`, `helperText?`, `error?`, `required?`). Generates an `id` via `useId`, shows the help text (hidden on error) and the error `role="alert"` with `AlertCircle`; `aria-hidden` asterisk if `required`.
- `useFieldControl()`. Returns `{ id, 'aria-invalid', 'aria-describedby' }` to spread on the control; `{}` outside a `Field`.
**Used by**: `Input`, `Textarea`, `NativeSelect`, `SelectTrigger`, page and feature forms.
**Notes**: explicit caller props override the wiring (e.g. `aria-invalid` in `LoginPage`). Handles only one control per `Field`.

## `apps/web/src/components/ui/input.tsx`
**Role**: 40px text field, thin border darkened on hover, blue focus ring, danger border if `aria-invalid`.
**Exports**: `Input` (forwardRef, `type` defaults to `'text'`), `InputProps`. Consumes `useFieldControl()`.
**Used by**: `PasswordInput`, `RenameDialog`, pages, features.

## `apps/web/src/components/ui/label.tsx`
Radix label (`text-sm font-medium text-text`, `peer-disabled` styles). Exports `Label`. Used by `Field` and features.

## `apps/web/src/components/ui/native-select.tsx`
**Role**: native `<select>` styled like `Input` (40px, overlaid lucide `ChevronDown` chevron), for dense forms or ones registered via react-hook-form.
**Exports**: `NativeSelect` (forwardRef; `className` applies to the wrapping `span`, not the `select`), `NativeSelectProps`. Consumes `useFieldControl()`.
**Used by**: features `assemble` (`AssemblyMergeDialog`, `PlacementPanel`), `chamber` (`ChamberInputsForm`, `ChamberSavesMenu`, `SendToMeshingDialog`), `meshing/CfMeshConfigForm`, `projects` (`BoundaryConditionDialog`, `CaseFileForm`, `ConvertToFoamFlow`, `MergeMeshesFlow`), `solver/SolverConfigPanel`, `templates/TemplateFilePicker`, `visualize` (`EditPatchesDialog`, `VisualizePanel`).

## `apps/web/src/components/ui/password-input.tsx`
**Role**: `Input` with a show/hide button (`Eye`/`EyeOff`, `aria-pressed`, dynamic `aria-label`).
**Exports**: `PasswordInput` (forwardRef; `type` enforced), `PasswordInputProps`. **Used by**: `LoginPage`, account/admin features.

## `apps/web/src/components/ui/segmented.tsx`
**Role**: segmented control built on real `input type="radio"` (native radiogroup semantics, arrow keys), each option is a wrapping `<label>`.
**Exports**: `SegmentedRadioGroup<T extends string>({ name, value, onChange, options, ariaLabel, disabled?, stretch?, className? })` (named and `default` export), `SegmentedOption<T>` (`value`, `label`, `icon?`), `SegmentedRadioGroupProps<T>`.
**Used by**: `MeshingPage`, `features/assemble/*` (`AssemblyMergeDialog`, `PartsRail`, `PlacementPanel`), `chamber/SendToMeshingDialog`, `meshing/SnappyConfigForm`, `projects/MergeMeshesFlow`.
**Notes**: the focus ring is carried by a `span` driven by `peer-focus-visible`. `name` must be unique per instance.

## `apps/web/src/components/ui/select.tsx`
**Role**: Radix select whose trigger is shaped like `Input` and consumes `useFieldControl()`.
**Exports**: `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent` (`position` defaults to `'popper'`, trigger width, `max-h-[18rem]`), `SelectItem` (blue `Check` tick).
**Used by**: `features/admin/UserFormDialog` only (other screens use `NativeSelect`).

## `apps/web/src/components/ui/separator.tsx`
1px Radix separator `bg-border`, horizontal by default, `decorative` by default. Exports `Separator`. No importer to date (primitive available but unused).

## `apps/web/src/components/ui/skeleton.tsx`
Loading block `bg-border/70 rounded-sm` with an `animate-shimmer` sweep hidden under `motion-reduce`, `aria-hidden`. Exports `Skeleton`, `SkeletonProps`. Used by the table skeletons of pages and features.

## `apps/web/src/components/ui/sonner.tsx`
**Role**: tokenized `sonner` toast host and single import point for `toast`.
**Exports**:
- `toast` (re-export from `sonner`).
- `Toaster(props: ToasterProps)`. `theme="light"`, `position="top-right"`, `duration={4000}`, `gap={12}`, per-type classes (success `text-success`, error `text-danger`, action button `bg-cta`), internal sonner variables driven by tokens (`--normal-bg`, `--normal-border`, `--border-radius: var(--radius-md)`), `zIndex: var(--z-toast)`.
**Used by**: `providers.tsx` (`Toaster`), pages and features (`toast`).
**Notes**: `toast.warning` is used by `ChamberPage` without a dedicated class (default sonner style, to verify).

## `apps/web/src/components/ui/table.tsx`
**Role**: ruled table primitives (`divide-y`), `bg-bg` `text-xs` header, `h-14 tabular-nums` cells, `overflow-x-auto` container.
**Exports**: `Table` (wrapped in a scrollable `div`; `ref` points to the `table`), `TableHeader`, `TableBody`, `TableRow` (hover `bg-bg`), `TableHead`, `TableCell`.
**Used by**: `ProjectsPage`, `TemplatesPage`, `MeshingPage`, features.

## `apps/web/src/components/ui/tabs.tsx`
**Role**: underline-style Radix tabs: active tab `border-primary font-semibold text-primary` (never orange).
**Exports**: `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`. **Used by**: `ProjectDetailPage`, features.

## `apps/web/src/components/ui/textarea.tsx`
Text area mirroring `Input` (`min-h-20`, same states), consumes `useFieldControl()`. Exports `Textarea`, `TextareaProps`. Used by `features/templates/TemplateFormDialog`.

## `apps/web/src/components/ui/tooltip.tsx`
**Role**: Radix tooltip on a dark background `bg-text text-white`, `z-tooltip`.
**Exports**: `Tooltip`, `TooltipTrigger`, `TooltipContent` (`sideOffset` 6, portal included), `TooltipProvider` (mounted once in `providers.tsx`).
**Notes**: a tooltip on a disabled control requires a wrapping `span tabIndex={0}` (see `ProjectDetailPage`). Tests that render tooltips must provide a `TooltipProvider`.

## `apps/web/src/lib/api/auth.ts`
**Role**: authentication endpoints. All go through `apiClient`; the `/auth/login|refresh|logout` paths are sent with `credentials: 'include'` and `skipRefresh`.
**Exports**:
- `login(email, password): Promise<AuthResponse>`. `POST /auth/login`, stores the token in memory.
- `refresh(): Promise<AuthResponse>`. `POST /auth/refresh` (httpOnly cookie), stores the token. Used by the `AuthProvider` bootstrap.
- `logout(): Promise<void>`. `POST /auth/logout`, clears the token in a `finally` (even if the network fails).
- `me(): Promise<MeResponse>`. `GET /auth/me`.
- `updateMe(fullName): Promise<MeResponse>`. `PATCH /auth/me`.
- `changePassword(currentPassword, newPassword): Promise<AuthResponse>`. `POST /auth/change-password` with `credentials: 'include'` (the server rotates the refresh cookie), replaces the token.
**Depends on**: `client.ts`, `types.ts`. **Used by**: `features/auth/AuthProvider`, `features/account/*`.
**Notes**: `/auth/change-password` is not in `AUTH_PATHS` of `client.ts`: a 401 there triggers the refresh + retry cycle (to verify on the API side whether a wrong password returns 401). `refresh()` does not use the client's internal single-flight promise.

## `apps/web/src/lib/api/boundary.ts`
**Role**: applies a boundary conditions preset to a project's `0/` fields.
**Exports**: `applyBoundaryConditions(projectId, request: ApplyBoundaryConditionsRequest, csv?: File | null): Promise<ApplyBoundaryConditionsResult>`. Multipart: `payload` field (JSON) + optional `csv` file, `POST /projects/:id/boundary-conditions/apply`, unwraps `result`. Resolves even if the CSV step fails; only validation/transport reject.
**Depends on**: `client.ts`, types imported directly from `@dive/shared` (not via `types.ts`). **Used by**: `features/projects/useBoundaryConditions`.

## `apps/web/src/lib/api/chamber.ts`
**Role**: Chamber Creation endpoints (`/chamber/*`), builds shared by the team and indexed by parameter hash.
**Exports**:
- `ChamberExportKind` = `'stl' | 'step' | 'stepMirrored' | 'trisurface'` (`stepMirrored` generated on demand at first download, ~10-30 s).
- `buildChamber(input: ChamberInput): Promise<ChamberBuildResponse>`. `POST /chamber/build`.
- `getChamberManifest(hash): Promise<MeshManifest>`. `GET /chamber/:hash/manifest`.
- `getChamberGeometry(hash): Promise<ArrayBuffer>`. GLB.
- `getChamberEdges(hash): Promise<ArrayBuffer | null>`. `null` if the blob is empty (204) or 404.
- `getChamberExport(hash, kind): Promise<Blob>`. `GET /chamber/:hash/export/:kind`.
**Used by**: `ChamberPage` (direct call to `buildChamber`), `features/chamber/*`.

## `apps/web/src/lib/api/chamberSaves.ts`
**Role**: named, shared saves of the exact `POST /chamber/build` body.
**Exports**: `listChamberSaves()` (`GET /chamber/saves`, `saves`), `createChamberSave({ name, snapshot })` (409 if the name is taken), `updateChamberSave(id, { name?, snapshot? })` (`PUT`, author or super-admin), `deleteChamberSave(id)`.
**Used by**: `features/chamber/useChamberSaves`.

## `apps/web/src/lib/api/client.ts`
**Role**: central `fetch` wrapper. Every front-end API request goes through here.
**Exports**:
- `setAccessToken(token | null)`, `getAccessToken()`. Holder of the access token in module memory (never `localStorage`).
- `setLogoutHandler(handler | null)`. Registers the single callback called when the refresh fails (wired by `AuthProvider`).
- `ApiError extends Error` (`code: ApiErrorCode`, `status: number`, `name = 'ApiError'`).
- `apiClient`: `get<T>`, `post<T>(path, body?)`, `put<T>`, `patch<T>`, `delete<T>`, `postForm<T>(path, FormData)`, `putText<T>(path, text)` (`text/plain;charset=utf-8`, `rawText`), `getBlob(path): Promise<Blob>`. `RequestOptions` = `RequestInit` without `body` + `body?: unknown`, `rawText?`, `skipRefresh?`.
**Depends on**: `types.ts`. **Used by**: all `lib/api/*` modules, `AuthProvider`.
**Notes**:
- `getBaseUrl()` reads `import.meta.env.VITE_API_URL` lazily (on the first request) and throws an explicit `Error` if it is missing; importing the client in a test therefore does not throw.
- Headers: `Accept: application/json` always, `Content-Type: application/json` only for a JSON body (never for `FormData` or raw text), `Authorization: Bearer` if there is a token.
- `credentials: 'include'` forced for paths starting with `AUTH_PATHS` (`/auth/login`, `/auth/refresh`, `/auth/logout`), otherwise whatever the caller passes.
- Transport failure: `ApiError('NETWORK_ERROR', ..., 0)`. Non-OK response: `toApiError` reads `{ error: { code, message } }`; non-JSON body: code derived from the status (401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, otherwise `UNKNOWN`).
- Single-flight refresh: on a 401 outside auth paths and without `skipRefresh`, `refreshAccessToken()` shares a single `refreshPromise` across concurrent calls (`POST /auth/refresh` via raw `fetch`), then replays the request once. Failure: token cleared, `onLogout()` called, `ApiError('UNAUTHORIZED', 'Your session has expired. Please sign in again.', 401)`.
- `decodeBody` tolerates 204 and empty bodies (returns `undefined as T`).

## `apps/web/src/lib/api/config.ts`
Public server flags. Exports `ServerConfig` (`terminalEnabled: boolean`) and `getServerConfig()` (`GET /config`, no auth). Used by `features/terminal/ProjectTerminalButton`.

## `apps/web/src/lib/api/conversion.ts`
**Role**: a project's CGNS sources and CGNS to OpenFOAM conversion (`/projects/:id/cgns`).
**Exports**: `listCgns(projectId): Promise<CgnsFile[]>`, `uploadCgns(projectId, file)` (multipart field `file`), `deleteCgns(projectId, name)` (`?name=`), `convertCgnsToFoam(projectId, { cgnsFile, templateId }): Promise<ConversionResult>` (resolves with `success: false` if a step fails).
**Used by**: `features/projects/useConversion`.

## `apps/web/src/lib/api/dashboard.ts`
Exports `getDashboard(): Promise<DashboardData>` (`GET /dashboard`, server metrics + the user's runs). Used by `features/dashboard/useDashboard`; mocked in `HomePage.test.tsx`.

## `apps/web/src/lib/api/meshes.ts`
**Role**: a project's multi-mesh library and merge pipeline (`/projects/:id/meshes`).
**Exports**:
- `listMeshes(projectId): Promise<MeshSource[]>`, `getMeshPatches(projectId, meshId): Promise<MeshPatch[]>`.
- `autoPatchMeshSource(projectId, meshId, featureAngle)`, `renameMeshSourcePatch(projectId, meshId, from, to)`, `editMeshSourcePatches(projectId, meshId, edits)` (`PUT .../patches`, boundary only).
- `importMeshFolder(projectId, files, name?)` (each file named by `webkitRelativePath`, `name` otherwise the root folder unless `polyMesh`), `importMeshZip(projectId, file, name?)` (field `archive`), `importMeshFile(projectId, file, name?)` (field `meshFile`, `.cgns`/`.msh`). All three post to `/meshes/import`.
- `deleteMesh(projectId, meshId)`.
- `runMerge(projectId, plan): Promise<MergeRunResult>` (resolves even when a step fails), `getMergePlan(projectId)`, `saveMergePlan(projectId, plan)` (falls back to the sent plan if `plan` is null), `getAssembly(projectId): Promise<AppliedAssembly | null>`.
- `getMeshSourceManifest`, `getMeshSourceGeometry` (Blob), `getMeshSourceEdges` (`null` on 404).
**Used by**: `features/projects/useMeshes`, `features/assemble/*`.
**Notes**: `getMeshSourceEdges` does not treat an empty blob as `null` (unlike `chamber.ts`/`meshing.ts`). A comment cites `projects.ts:189-207`: a line-number reference, stale.

## `apps/web/src/lib/api/meshing.ts`
**Role**: standalone Meshing sessions STL to snappyHexMesh/cfMesh to polyMesh (`/meshing/*`), shared by the team.
**Exports**: `listMeshingSessions()`, `createMeshingSession(name, engine)`, `copyMeshingSession(body: CopySessionBody)`, `transferChamberToMeshing(body: FromChamberBody)` (`POST /meshing/from-chamber`), `getMeshingSession(id)`, `renameMeshingSession(id, name)` (`PATCH`), `deleteMeshingSession(id)`, `uploadStl(id, files)` (field `files`, STL or FMS), `deleteStl(id, name)`, `getStlBuffer(id, name): Promise<ArrayBuffer>`, `runSnappy(id, config)` (starts a background job, 409 `MESH_IN_PROGRESS` if one is already active), `getMeshingLog(id)` (poll), `stopMeshing(id)`, `saveMeshingConfig(id, config)` (`PUT /config`, autosave), `getMeshingManifest(id)`, `getMeshingGeometry(id)`, `getMeshingEdges(id)` (`null` if empty or 404), `getSessionZip(id): Promise<Blob>`.
**Used by**: `features/meshing/*`, `MeshingSessionPage` (`getSessionZip` directly).

## `apps/web/src/lib/api/projects.ts`
**Role**: the largest module: projects, OpenFOAM case files, 3D viewer, CGNS export, template application, solver.
**Exports** (grouped):
- Projects: `listProjects()`, `getProject(id)`, `createProject(input)`, `renameProject(id, title)`, `deleteProject(id)`, `addCollaborator(id, email)`, `removeCollaborator(id, userId)`.
- Case files: `getCaseFiles(id)`, `importCaseFolder(id, files)` (part name = `webkitRelativePath`), `importCaseZip(id, file)`, `verifyCase(id)`, `scaffoldCase(id)`, `downloadCase(id): Promise<Blob>`, `resetCase(id)` (`DELETE /files`), `getCaseFileContent(id, path)`, `saveCaseFileContent(id, path, content)` (`putText`), `createCaseFile(id, path, content?)`, `deleteCaseFile(id, path)`, `deleteCaseDir(id, path)`, `moveCasePath(id, from, to)`, `syncBoundaries(id)`.
- Viewer (`/mesh`): `getMeshManifest(id)` (builds the render if missing), `getMeshGeometry(id): Promise<Blob>`, `getMeshEdges(id)` (`null` on 404), `rebuildMesh(id)`, `renameMeshPatch(id, from, to)`, `setMeshPatchType(id, patch, type)`, `autoPatchMesh(id, featureAngle)`, `editMeshPatches(id, edits)`, `getMeshBackup(id)`, `saveMeshBackup(id)`, `restoreMeshBackup(id)`, `importMeshFromMeshing(id, body: MeshFromMeshingRequest): Promise<MeshFromMeshingResult>` (`POST /mesh/from-meshing`, unwraps `{ result }`).
- CGNS export: `runExport(id)`, `getExportStatus(id)`, `downloadExportArtifact(id, artifact)`.
- Templates: `previewApplyTemplate(projectId, templateId)`, `applyTemplate(projectId, templateId, decisions = {})`, `applyTemplateFiles(projectId, templateId, paths)`.
- Solver: `getRunnable(id)`, `scaffoldSolver(id, solver?, turbulence?)`, `startRun(id, { solver?, cores? })` (`cores` sent only if > 1), `listRuns(id)`, `getRunLog(id, runId)`, `stopRun(id, runId)`; convergence criteria (WS-G) `getCriteria(id)`, `saveCriteria(id, criteria)` (PUT), `computeVortexMetrics(id)` (POST `/criteria/vortex`, returns the sample).
**Used by**: `features/projects/*`, `features/visualize/*`, `features/solver/*`, `features/export/*`, `HomePage` (`stopRun` directly).
**Notes**: file paths are passed as a `?path=` query encoded with `encodeURIComponent`. Tool-driven pipelines (autoPatch, export, conversion) resolve with a `success: false` report instead of rejecting: the UI must test `success`, not only `onError`.

## `apps/web/src/lib/api/templates.ts`
**Role**: shared file templates (`/templates`); file responses reuse the case file types.
**Exports**: `listTemplates()`, `getTemplate(id)`, `createTemplate(input)`, `updateTemplate(id, input)`, `deleteTemplate(id)`, `getTemplateFiles(id)`, `importTemplateFolder(id, files: UploadFile[])` (explicit path per file), `importTemplateZip(id, file)`, `getTemplateFileContent(id, path)`, `saveTemplateFileContent(id, path, content)`, `createTemplateFile(id, path)`, `deleteTemplateFile(id, path)`, `deleteTemplateDir(id, path)`, `moveTemplatePath(id, from, to)`.
**Used by**: `features/templates/useTemplates`.
**Notes**: imports the `UploadFile` type from `@/features/files/folderImport`: an inverted `lib` to `features` dependency.

## `apps/web/src/lib/api/types.ts`
**Semi-spiral (2026-09-29)**: `ChamberBuildResponse.spiral?: ChamberSpiralSummary | null` (re-exported from `@dive/shared`).
**Role**: typed contract of the `/api/v1` API consumed by the whole front end. A mix of local interfaces (response envelopes, request bodies) and re-exports from `@dive/shared` (types and a few runtime values).
**Exports** (by group):
- Users and errors: `Role` (re-export), `User` (`id`, `email`, `fullName`, `role`, `isProtected`, `isActive`, `lastLoginAt`, `createdAt`, `updatedAt`), `ApiErrorBody`, `ApiErrorCode` = `ServerErrorCode | 'UNAUTHORIZED' | 'NETWORK_ERROR' | 'UNKNOWN'`.
- Auth: `AuthResponse` (`accessToken`, `user`), `MeResponse`.
- User admin: `ListUsersResponse`, `UserResponse`, `CreateUserInput`, `UpdateUserInput` (all fields optional, including `isActive`).
- Projects: `UserSummary`, `Project` (`owner`, `collaborators`), `CreateProjectInput`, `ListProjectsResponse`, `ProjectResponse`.
- Case files: `CaseEntry` (`path`, `type: 'file'|'directory'`, `size`), `CaseVerification` (`hasMesh`, `missingMesh`, `presentBase`, `missingBase`, `complete`, `canScaffold`), `CaseFilesResponse`, `VerifyCaseResponse`, `ImportCaseResponse` (`conversion?` for a `.cgns`/`.msh` import), `ScaffoldCaseResponse`, `CaseFileContent`, `CaseFileContentResponse`, `CreateCaseFileResponse`, `DeleteCaseFileResponse`, `DeleteCaseDirResponse`, `MoveCaseEntryResponse`.
- Templates: `Template` (`tags`, `owner`), `CreateTemplateInput` (`file?` for a single-file template), `UpdateTemplateInput`, `ListTemplatesResponse`, `TemplateResponse`, `ApplyDecision` (`'overwrite'|'keep'`), `ApplyPreview`, `ApplyPreviewResponse`, `ApplyTemplateResponse`.
- CGNS and conversion: `CgnsFile`, `CgnsListResponse`, `UploadCgnsResponse`, `DeleteCgnsResponse`, `ConversionStepId` (re-export), `ConversionStepStatus`, `ConversionStep`, `ConversionResult`, `ConvertCgnsResponse`, `ConvertCgnsInput`.
- Meshing hand-off (WS-F): re-exports `MeshFromMeshingRequest`, `MeshFromMeshingResult`, `MeshToProjectTarget`; envelope `MeshFromMeshingResponse`.
- Mesh library and merge: re-exports `MeshSource`, `StitchPair`, `MergeStep`, `MergeResult`, `ImportStep`, `MeshImportConversion`; local mirrors "ahead" of `@dive/shared`: `MergeStepKind` (widened to `nonConformalCouple`), `InterfaceCoupling` (`'nonConformal'|'stitch'`), `MeshInterface`, runtime constant `MERGE_BASE_CASE = '__case__'`, `PartTransform` (translation + three.js quaternion), `MergePlan` (`order`, `interfaces`, `transforms?`, deprecated `stitches?`), `AppliedAssembly`; envelopes `MeshesResponse`, `AssemblyResponse`, `ImportMeshResponse`, `DeleteMeshResponse`, `MeshPatchesResponse`, `MeshSourceAutoPatchRun`, `AutoPatchMeshSourceResponse`, `RenameMeshSourcePatchResponse`, `EditMeshSourcePatchesResponse`, `MergeRunResult` (`MergeResult & { entries }`), `MergeResponse`, `MergePlanResponse`.
- Viewer: re-exports `MeshPatch`, `MeshManifest`, `MeshPatchType`, `MeshPatchSetting`, `MeshPatchEdit`, `MeshBackupInfo`; `MeshManifestResponse`, `AutoPatchResult`, `AutoPatchResponse`, `MeshBackupResponse`.
- Chamber: re-exports `ChamberInput`, `ChamberOutput`, `ChamberOutputKey`, `ChamberConstraint`, `ChamberStatus`, `ChamberConfidence`, `ChamberSaveOwner`, `ChamberSaveSummary`; `ChamberBuildResponse` (`hash`, `outputs`, `warnings`, `stepHasVanes: boolean | null`).
- CGNS export: re-exports `CaseProfile`, `ExportStep`, `ExportStepId`, `ExportResult`, `ExportValidation`, `ValidationCheck`, `ExportArtifacts`; `ExportArtifact` (`'cgns'|'session'|'memo'|'report'`), `ExportStatus`, `ExportRunResponse`, `ExportStatusResponse`.
- Solver: `RunnableCheck` (`runnable`, `solver`, `scaffoldable`, `maxCores`, ...), `RunnableResponse`, `ScaffoldSolverResponse`, `RunSummary` (`cores`, `status: RunStatus`, `reason`), `RunResponse`, `ListRunsResponse`, `RunLogPayload` (`series: ResidualSample[]`, `logTail`, `logBytes`, `monitors: RunMonitors`); runtime re-exports `SOLVER_SPECS`, `SOLVER_CATALOG`, `SOLVER_LIBRARY`, `SOLVER_CATEGORIES`, `CONFIGURABLE_SOLVER_IDS`, `isConfigurableSolver`, `TURBULENCE_MODELS`, `TURBULENCE_APPROACHES` and related types (`SolverSpec`, `SolverParamDef`, `SolverInfo`, `SolverCategory`, `ConfigurableSolverId`, `TurbulenceModelSpec`, `TurbulenceApproach`, `RunStatus`, `SolverId`, `ResidualSample`).
- Dashboard: `ServerMetrics`, `DashboardRun`, `DashboardProject`, `DashboardData` (`runCounts: Record<RunStatus, number>`).
- Meshing: runtime re-exports `DOMAIN_TYPES`, `DEFAULT_SNAPPY_CONFIG`, `DEFAULT_CFMESH_CONFIG`, `defaultMeshingConfig`, `MESHING_ENGINES`, `CFMESH_PATCH_TYPES`, `STL_EXTENSION`, `FMS_EXTENSION`, `isMeshingRunActive` and many types (`MeshingEngine`, `MeshingConfig`, `SnappyConfig`, `CfMeshConfig`, `MeshingSession`, `MeshingSessionSummary`, `MeshingRunState`, `MeshingRunStatus`, `MeshingLogPayload`, `StlFile`, ...); local envelopes `MeshingSessionsResponse`, `MeshingSessionResponse`, `CopySessionBody`, `FromChamberBody` (discriminated union `mode: 'new'|'existing'|'copyFrom'`), `RunSnappyResponse`, `MeshingLogResponse`.
**Depends on**: `@dive/shared`. **Used by**: all of `lib/api/*`, pages, features.
**Notes**: the local mirrors (`MergeStepKind`, `MeshInterface`, `PartTransform`, `MergePlan`, `AppliedAssembly`, `MERGE_BASE_CASE`) can drift from the shared package; reconcile them if `@dive/shared` now defines them. The last envelopes use inline `import('@dive/shared').X` instead of top-level imports.

## `apps/web/src/lib/api/users.ts`
Account management (super-admin). Exports `listUsers()`, `getUser(id)`, `createUser(input)`, `updateUser(id, input)` (`PATCH`), `deleteUser(id)`; each function unwraps `{ user }` / `{ users }`. Used by `features/admin/useUsers`.

## `apps/web/src/lib/utils.ts`
Exports `cn(...inputs: ClassValue[]): string` = `twMerge(clsx(inputs))`: class merging with Tailwind conflict resolution. Used by all primitives and most components.

## `apps/web/src/pages/AccountPage.tsx`
**Role**: settings of the current account (route `/account`).
**Exports**: `AccountPage()`. Renders `UnsavedChangesPrompt when={profileDirty || passwordDirty}`, `PageHeader` "Account", `ProfileSection` and `ChangePasswordSection` (`max-w-3xl` column), each reporting its dirty state via `onDirtyChange`.
**Depends on**: `useAuth`, `features/account/*`. **Notes**: fallback `FullPageLoader` if `user` is null.

## `apps/web/src/pages/AdminPage.tsx`
**Role**: account back office (`/admin`, `SUPER_ADMIN`). Orchestrates the query and three dialogs.
**Exports**: `AdminPage()`. States: `isPending` `UsersTableSkeleton`, `isError` `ErrorState` with `refetch`, empty list `EmptyState`, otherwise `UsersTable`. Dialogs `UserFormDialog` (create if `editingUser` is null), `DeleteUserDialog`, `DisableUserDialog`. `toggleActive`: disabling goes through a confirmation dialog, re-enabling is direct (`useUpdateUser().mutateAsync`) + toast.
**Depends on**: `features/admin/*`, `useAuth`. **Notes**: single orange CTA "Add user" in the header (reused in the empty state).

## `apps/web/src/pages/ChamberPage.tsx`
**Semi-spiral (2026-09-29)**: keeps the last build's `spiral` (`lastSpiral`); the live outputs use `chamberSpiralModelInput` and, with the spiral ticked, `applyChamberSpiralToOutputs` filled from the last spiral only while the inputs still match that build (`lastBuildMatches`, also behind `isStale`); `onSemiSpiralChange` unticks Feet and Chamfer; `FIELD_LABELS` gain `feetEnabled` and `spiralFlowVelocity`; the table gets `spiral={{ on, summary }}`.
**Role**: Chamber Creation tool (`/chamber`): input form, live computation of the 12 outputs, CadQuery generation, 3D preview, exports, send to Meshing, saves.
**Exports**: `ChamberPage()` (named + `default`).
**Depends on**: `react-hook-form` + `zodResolver(chamberFormSchema)` (`mode: 'onChange'`), `computeChamberOutputs` from `@dive/shared` (client-side computation), `features/chamber/*` (`ChamberInputsForm`, `chamberForm` helpers, `ChamberSavesMenu`, `ChamberOutputsTable`, `ChamberBuildWarnings`, `ChamberExportButtons`, `SendToMeshingDialog`, `useBuildChamber`), `buildChamber` directly, `ChamberViewer` as `lazy` (three.js).
**Notes**: local state `constraints`, `hash`, `offerMirror`, `lastBuildInput`, `buildWarnings`, `buildErrors`, `sendOpen`. Errors (inverted Min > Max detected client-side, server refusal, invalid form) go both to the notes panel and to a toast. `isStale` compares the `chamberBodyKey` of the current form and of the last build (key order differs between `watch()` and the zod output). `onExportDownloaded` silently re-POSTs the last body after a STEP download to pick up new warnings. Loading a save resets all build-related state. `FIELD_LABELS` is recreated on every render.

## `apps/web/src/pages/HomePage.tsx`
**Role**: `/` dashboard pinned to the viewport from `lg` up: KPI strip (CPU, memory, active solvers, total runs), panel of running solvers (can be stopped), outcomes donut, grid of recent projects.
**Exports**: `HomePage()`. Internal components: `KpiCard`, `MetricNumber`, `KpiFoot`, `KpiSkeleton`, `DeltaPill`, `RunningSolversPanel`, `RunRow`, `RunOutcomesPanel`, `LegendRow`, `RecentProjectsPanel`, `ProjectCard`; helpers `lastDelta`, `formatBytes` (GB/MB), `elapsed`, `relativeTime`.
**Depends on**: `useDashboardQuery`, `dashboardQueryKey`, `Sparkline`, `DistributionBar`, `Donut`, `RUN_STATUS_COLOR`, `RUN_STATUS_PILL`, `TONE`, `usageColor` (`features/dashboard/*`), `stopRun` directly in a local `useMutation` that invalidates `dashboardQueryKey`.
**Notes**: local CPU/memory history (40 samples) fed on each `dataUpdatedAt`. Outcome grouping: converged = `converged + completed`, diverged = `diverged + failed`, other = `stopped + queued + running`. Colors applied as inline `style` via `TONE` (CSS variables). Deviations from the design system: `font-mono`, `rounded` and `animate-pulse` (home-made skeletons instead of `Skeleton`). `elapsed()` only refreshes at the polling rate.

## `apps/web/src/pages/HomePage.test.tsx`
**Covers**: rendering with data (greeting "Welcome back, Ada", CPU 42, solver `simpleFoam`, recent project, donut `role="img"` "4 total runs") and empty states ("no solver running", "no projects yet").
**Technique**: `vi.mock` of `@/lib/api/dashboard`, `@/lib/api/projects` (`stopRun`) and `@/features/auth/AuthProvider` (fake `useAuth`); `QueryClient` with `retry: false`; `MemoryRouter`.

## `apps/web/src/pages/LoginPage.tsx`
**Role**: `/login` sign-in screen: `bg-blueprint` background, `rounded-lg shadow-md` `max-w-[400px]` card, `BrandLockup`, email and password fields, full-width CTA.
**Exports**: `LoginPage()`.
**Depends on**: `react-hook-form` + zod (local `loginSchema`, `mode: 'onSubmit'`), `useAuth().login`, `ApiError`.
**Notes**: error mapping: `INVALID_CREDENTIALS` (banner + danger borders on both fields via `credentialsInvalid`, cleared as soon as the user types), `ACCOUNT_DISABLED`, `NETWORK_ERROR`, otherwise a generic message. The `role="alert"` region is always present. Success: `navigate(location.state.from ?? '/', { replace: true })`.

## `apps/web/src/pages/MeshingPage.tsx`
**Role**: list and creation of meshing sessions (`/meshing`).
**Exports**: `MeshingPage()` (named + `default`). Internals: `CreateSessionForm` (zod `createSessionSchema`, name 1-120, engine via `SegmentedRadioGroup` snappy/cfmesh, server `VALIDATION_ERROR` surfaced on the field), `SessionsTable` (link to `/meshing/:id`, engine badge, number of surfaces, meshed yes/no, date, Rename action via `RenameDialog` and Duplicate via `useCopyMeshingSession`), `SessionsSkeleton`.
**Depends on**: `features/meshing/useMeshing`. **Notes**: `formatCreated` and `dateFormatter` (`en-GB`) duplicated with `ProjectsPage`.

## `apps/web/src/pages/MeshingSessionPage.tsx`
**Role**: session detail (`/meshing/:id`): surface management, engine configuration, background execution with live log, report, resulting mesh, download, deletion.
**Exports**: `MeshingSessionPage()` (named + `default`). Header: `Download case` and `Send to project` (both secondary, meshed sessions only; `Send to project` is `aria-disabled` with a `Tooltip` "Wait for the mesh run to finish." while a run is active) open `SendToProjectDialog`. Internals: `BackLink`, `StatusPill`, `runStatusMeta`, `MeshRunPanel` (status badge, timer, Stop, `RunLog`), `RunElapsed` (1 s tick), `StlManager` (hidden file input, `.stl`/`.fms` filter, per-row deletion), `formatBytes`.
**Depends on**: `SendToProjectDialog`, `Tooltip`; hooks `useMeshingSession`, `useStartMeshing`, `useStopMeshing`, `useOnMeshingRunSettled`, `useSaveMeshingConfig`, `useDeleteMeshingSession`, `useMeshingRunLog`, `useUploadStl`, `useDeleteStl`; `StlViewer`, `SnappyConfigForm`, `CfMeshConfigForm`, `MeshResultViewer`, `ImportReport` (features/projects), `RunLog` (features/solver); `getSessionZip` directly.
**Notes**: the live status comes from the polled log (`runLog.data.status`), otherwise from `session.runStatus`; a `useRef` detects the active to terminal transition to call `onRunSettled()` only once and toast the outcome. Silent config autosave (failure swallowed). Download via a `blob:` anchor + immediate `URL.revokeObjectURL`. Not-found detected by `status === 404` (elsewhere by `code === 'NOT_FOUND'`). Loading skeleton that mirrors the layout.

## `apps/web/src/pages/ProjectDetailPage.tsx`
**Role**: project detail (`/projects/:id`): header with terminal button and gear menu, then Detail / Visualize / Assemble / Solver / Export tabs.
**Exports**: `ProjectDetailPage()`. Internals: `ProjectTabs`, `VisualizeTab`, `AssembleTab`, `SolverTabTrigger`, `ExportTabTrigger` (disabled triggers wrapped in a `span tabIndex={0}` + `Tooltip`), `ViewerLoading`, `BackLink`, `ProjectSettingsMenu`, `ProjectDetailsDialog`, `ManageCollaboratorsDialog`, `DeleteProjectDialog`, `AddCollaboratorForm` (codes `USER_NOT_FOUND`, `COLLABORATOR_EXISTS` surfaced on the field), `RemoveCollaboratorButton`, `formatDateTime`.
**Depends on**: `useProjectQuery`, `useAddCollaborator`, `useDeleteProject`, `useRemoveCollaborator`, `useCaseFilesQuery`, `useMeshesQuery`, `CaseFilesSection`, `ProjectTerminalButton`; `lazy` for `VisualizePanel`, `SolverTab`, `ExportTab`, `AssemblyWorkspace`.
**Notes**: initial tab read once from `?view=` (`PROJECT_VIEWS`, `isProjectView`; unknown value → Detail), then the param is dropped with `setSearchParams({}, { replace: true })` (meshing hand-off lands on `?view=visualize`). Gating: Visualize if there is a polyMesh (`constant/polyMesh/`) or a non-empty library; Assemble if the library is non-empty; Solver and Export if there is a polyMesh. Each lazy panel is only mounted when its tab is active (`view === ...`) so as not to trigger builds/polls. Dialogs opened from the menu are deferred with `setTimeout(..., 0)` (Radix focus/`aria-hidden` race). `canManage` = owner or super-admin.

## `apps/web/src/pages/ProjectDetailPage.test.tsx`
**Covers**: disabling/enabling of the Visualize and Solver tabs depending on whether a polyMesh exists; opening a tab replaces the Detail body; `?view=visualize` opens Visualize at mount, an unknown `?view=` falls back to Detail.
**Technique**: mocks of `@/features/visualize/MeshViewer`, `@/features/projects/CaseFilesSection`, `@/features/solver/SolverTab`, `@/lib/api/projects` (`getProject`, `getCaseFiles`), `useAuth`; `createMemoryRouter` + `TooltipProvider`; `userEvent.click` for Radix Tabs activation.
**Notable cases**: `useMeshesQuery` is not mocked (real call that fails without `VITE_API_URL`, with no impact on the assertions; to verify). The Visualize test depends on `VisualizePanel` rendering `MeshViewer`.

## `apps/web/src/pages/ProjectEditPage.tsx`
**Role**: case file editor (`/projects/:id/edit`): thin wrapper that binds the project's file hooks to the shared `FileTreeEditor`.
**Exports**: `ProjectEditPage()`. Builds a `FileTreeResource` (`useFiles`, `useContent`, `useSave`, `useCreate`, `useDelete`, `useDeleteDir`, `useMove`) and passes `enableEasyMode`, `emptyFilesHint`.
**Notes**: hand-coded error/not-found state (not `EmptyState`). The `resource` is recreated on every render.

## `apps/web/src/pages/ProjectEditPage.test.tsx`
**Covers**: file list and initially empty editor; content loaded on selection; debounced autosave (no Save button) calling `saveCaseFileContent('p1', 'system/controlDict', ...)`.
**Technique**: `CaseFileEditor` mocked as a `textarea`, `@/lib/api/projects` mocked, in-memory data router (the guard uses `useBlocker`), `waitFor` with `timeout: 2000` for the debounce.

## `apps/web/src/pages/ProjectsPage.tsx`
**Role**: creation and list of projects (`/projects`).
**Exports**: `ProjectsPage()`. Internals: `CreateProjectForm` (`createProjectSchema` from `features/projects/schemas`, `VALIDATION_ERROR` on the field), `ProjectsTable` (link to `/projects/:id`, owner "You" or email, date, Rename if owner or super-admin), `ProjectsSkeleton`.
**Notes**: the skeleton has 3 columns versus 4 in the loaded table (Actions column missing).

## `apps/web/src/pages/TemplateEditPage.tsx`
**Role**: editing of a template's files (`/templates/:id/edit`), read-only if the user is neither the author nor a super-admin.
**Exports**: `TemplateEditPage()`. Internals: `ImportControls` (hidden file inputs, `webkitdirectory`/`directory` attributes set in a `useEffect`, folder grouped by `groupPickedFolder` then selection in `FolderImportDialog`, `.zip` imported directly, via `useImportTemplate`), `BackLink`.
**Depends on**: `features/templates/useTemplates`, `FileTreeEditor`, `features/files/*`.

## `apps/web/src/pages/TemplatesPage.tsx`
**Role**: list of shared templates (`/templates`) with search and tag filters.
**Exports**: `TemplatesPage()`. Internals: `TemplatesToolbar`, `TagChip` (`aria-pressed`), `DeleteTemplateDialog`, `TemplatesTableSkeleton`, `formatDate`. `useMemo` filtering on name, description, tags + all active tags. `TemplateFormDialog` in create mode redirects to the editor (`onCreated`).
**Notes**: orange CTA "New template" in the header. Edit/delete actions visible to the author or a super-admin.

## `apps/web/src/styles/index.css`
**Role**: global stylesheet: imports `tokens.css` then the three Tailwind layers.
**Exports** (CSS): base: `border-color: var(--color-border)` on `*`, `body` (background, text, `font-sans`, 16px, line-height 1.5, `font-feature-settings 'cv05','ss01'`), headings `letter-spacing: -0.01em`, `:focus-visible` (2px outline `--color-focus-ring`, 2px offset), `.skip-link`, `touch-action: manipulation` on interactive elements, global animation reduction under `prefers-reduced-motion`. Utilities: `.bg-blueprint` (32px grid in `--color-border`), `.tabular-nums`.
**Used by**: `main.tsx`.

## `apps/web/src/styles/tokens.css`
**Role**: single source of design tokens (CSS variables on `:root`, light theme only).
**Exports** (all variables):
- Blue: `--color-primary: #004a99`, `--color-primary-hover: #003a78`, `--color-primary-light: #1e63b5`, `--color-primary-tint: #e8f0f9`.
- Orange: `--color-accent: #ee7f00`, `--color-accent-hover: #cc6e00`, `--color-accent-tint: #fff3e6`, `--color-accent-strong: #8f4f00` (AA small orange text).
- CTA: `--color-cta: #a85f00`, `--color-cta-hover: #8c4e00`.
- Grey: `--color-neutral: #bcbdbf`.
- Surfaces and text: `--color-bg: #f5f7fa`, `--color-surface: #ffffff`, `--color-text: #1a2230`, `--color-text-secondary: #5b6676`.
- Borders: `--color-border: #e4e8ee`, `--color-border-strong: #bcbdbf`.
- Signals: `--color-success: #1e7b4f`, `--color-success-tint: #e7f4ee`, `--color-danger: #b42318`, `--color-danger-hover: #911a12`, `--color-danger-tint: #fdecea`.
- Focus and scrim: `--color-focus-ring: #1e63b5`, `--color-scrim: rgba(16, 24, 40, 0.45)`.
- Terminal (the only dark surface, read via `getComputedStyle` because xterm draws on a canvas): `--terminal-bg: #1a2230`, `--terminal-fg: #e4e8ee`, `--terminal-selection: rgba(30, 99, 181, 0.45)`, `--terminal-muted: #5b6676`, `--terminal-ansi-red: #e5484d`, `--terminal-ansi-green: #30a46c`, `--terminal-ansi-yellow: #ee7f00`, `--terminal-ansi-blue: #1e63b5`, `--terminal-ansi-magenta: #bcbdbf`, `--terminal-ansi-cyan: #e8f0f9`.
- Radii: `--radius-xs: 4px`, `--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 16px`.
- Shadows: `--shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.05)`, `--shadow-md: 0 4px 12px rgba(16, 24, 40, 0.08)`, `--shadow-lg: 0 12px 32px rgba(16, 24, 40, 0.1)`.
- z-index: `--z-base: 0`, `--z-dropdown: 1000`, `--z-sticky: 1100`, `--z-overlay: 1200`, `--z-modal: 1300`, `--z-toast: 1400`, `--z-tooltip: 1500`.
- Type: `--font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
- Motion: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--duration-fast: 150ms`, `--duration-base: 200ms`.
**Notes**: no spacing token (Tailwind's 4px scale serves as spacing). `--color-accent-strong` and `--terminal-*` have no Tailwind alias. Divergences from `CLAUDE.md`: see `brain/architecture/frontend.md`.

## `apps/web/src/test/setup.ts`
**Role**: global Vitest setup.
**Covers**: registers the `@testing-library/jest-dom/vitest` matchers, `cleanup()` after each test, minimal stub of `window.matchMedia` (missing from jsdom, probed by Radix and sonner).

## `apps/web/src/App.tsx`
Application root: `export default function App()` renders `<Providers><RouterProvider router={router} /></Providers>`. The whole visual structure lives under the router.

## `apps/web/src/main.tsx`
Entry point: imports the Inter weights `@fontsource/inter` 400, 500, 600, 700 and 700-italic (self-hosted), then `./styles/index.css`, and mounts `<StrictMode><App/></StrictMode>` in `#root` (throws `Error('Root element #root was not found in index.html')` if missing). Under `StrictMode`, the `AuthProvider` bootstrap effects run twice in dev.

## `apps/web/src/vite-env.d.ts`
References `vite/client` and types `ImportMetaEnv` with a single variable: `readonly VITE_API_URL: string`.

## `apps/web/.env.example`
Environment template: `VITE_API_URL=http://localhost:4000/api/v1` (API base URL, `/api/v1` prefix included). Required: the client fails on the first request if it is missing. Copy to `apps/web/.env`.

## `apps/web/index.html`
Host document: `lang="en"`, favicon `/favicon.svg`, `color-scheme: light`, `theme-color #F5F7FA`, meta description, title "DIVE Turbinen", `div#root`, module script `/src/main.tsx`. No external font request.

## `apps/web/package.json`
**Role**: manifest of the `@dive/web` workspace (`type: module`, private).
**Exports** (scripts): `dev` (`vite`), `build` (`tsc -b && vite build`), `preview`, `typecheck` (`tsc --noEmit -p tsconfig.json`), `test` (`vitest run`), `lint` (`eslint .`).
**Notes**: key dependencies: React 18.3, react-router-dom 6.25 (data router), TanStack Query 5, react-hook-form 7 + zod 3 + `@hookform/resolvers`, Radix (alert-dialog, avatar, checkbox, dialog, dropdown-menu, label, select, separator, slot, tabs, tooltip), cva + clsx + tailwind-merge, lucide-react 0.400, sonner, three 0.166, CodeMirror (`@uiw/react-codemirror`, `@codemirror/lang-cpp`), xterm (`@xterm/xterm` 6, `@xterm/addon-fit`), `@fontsource/inter`, `@dive/shared`. Dev: Vite 5, Vitest 2, jsdom 24, Testing Library, Tailwind 3.4, TypeScript 5.5. The root `npm test` script builds `@dive/shared` first; `npm test -w @dive/web` alone does not.

## `apps/web/postcss.config.js`
ESM PostCSS config: plugins `tailwindcss` then `autoprefixer`.

## `apps/web/tailwind.config.ts`
**Role**: semantic mirror of `tokens.css` for Tailwind 3 (`content`: `index.html`, `src/**/*.{ts,tsx}`), `tailwindcss-animate` plugin.
**Exports** (`theme.extend` keys):
- Colors: `primary` (`DEFAULT`, `hover`, `light`, `tint`), `accent` (`DEFAULT`, `hover`, `tint`, `strong`), `cta`, `cta-hover`, `neutral`, `bg`, `surface`, `text` (`DEFAULT`, `secondary`), `border` (`DEFAULT`, `strong`), `success` (`DEFAULT`, `tint`), `danger` (`DEFAULT`, `hover`, `tint`), `focus-ring`, `scrim`. All as `var(--color-*)`.
- `borderRadius` `xs|sm|md|lg`, `boxShadow` `sm|md|lg`, `fontFamily.sans`, `zIndex` `base|dropdown|sticky|overlay|modal|toast|tooltip`: all as variables.
- Fixed `fontSize` from `xs` 12/16 to `3xl` 30/36; `maxWidth.content: '1200px'`; `transitionTimingFunction.out: var(--ease-out)`; `transitionDuration` `fast: 150ms`, `base: 200ms`.
- Keyframes/animations: `overlay-in/out` (150ms), `content-in` (200ms, scale 0.98 to 1), `content-out` (150ms), `shimmer` (1.6s infinite).
**Notes**: `darkMode: 'class'` configured but unused. Since everything is in `extend`, the default Tailwind palette and scales remain available (`white`, `rounded`, `rounded-full`, `font-mono`, `text-4xl`...), which makes it possible to bypass the tokens without any error. `maxWidth.content` and the durations are hard-coded (not linked to `--duration-*`).

## `apps/web/tsconfig.json`
App TS config: extends `../../tsconfig.base.json` (strict, `noUnusedLocals`, `noUnusedParameters`, ES2022), `moduleResolution: Bundler`, `jsx: react-jsx`, `noEmit`, `allowImportingTsExtensions`, alias `@/*` to `./src/*`, `include: ["src"]`, references `tsconfig.node.json`, `tsBuildInfoFile: ./node_modules/.tmp/tsconfig.app.tsbuildinfo`. No `@dive/shared` alias: typing goes through the shared package's `dist/`.

## `apps/web/tsconfig.node.json`
Composite TS config for `vite.config.ts` only (ES2022, lib ES2023, strict), outputs under `./node_modules/.tmp/`.

## `apps/web/tsconfig.node.tsbuildinfo`
TypeScript build artifact (~45 KB) tracked by git although it should be ignored; stale (the config now writes to `node_modules/.tmp/`).

## `apps/web/tsconfig.tsbuildinfo`
TypeScript build artifact tracked by git (one line: roots `./src/app.tsx`, `./src/main.tsx`, `./src/vite-env.d.ts`, `"errors": true`, TS 5.9.3); stale and should be untracked.

## `apps/web/vite.config.ts`
**Role**: Vite config (React plugin, port 5173).
**Exports**: default `defineConfig`.
**Notes**:
- Alias `@` to `./src` and `@dive/shared` to `../../packages/shared/src/index.ts` (TS source, so that a pre-bundled and cached `dist/` does not mask changes in dev).
- `optimizeDeps.include`: explicit list of dependencies to pre-bundle (avoids re-optimize + reload when opening a lazy route). `@radix-ui/react-tabs`, `three`, `@xterm/*` are not listed.
- `build.rollupOptions.output.manualChunks`: `codemirror` (`@codemirror`, `@uiw`, `@lezer`, `codemirror`, `style-mod`, `crelt`, `w3c-keyname`), `three`, `router` (`react-router`, `@remix-run`), `radix`, `query` (`@tanstack`), `forms` (`react-hook-form`, `@hookform`, `zod`), `react` (`react-dom`, `react/`, `scheduler`), everything else from `node_modules` into `vendor`. `@xterm/*` has no rule and therefore lands in `vendor`, a chunk loaded at startup (likely cancels the terminal's lazy loading; to verify on a build).

## `apps/web/vitest.config.ts`
Separate Vitest config: React plugin, `@` alias only, `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']`, `css: false`. Without a `@dive/shared` alias, tests resolve the shared package through its `dist/` (must be built beforehand).
