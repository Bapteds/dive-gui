# Frontend architecture (`apps/web`)

> Audience: AI agents modifying the DIVE Turbinen frontend. Updated: 2026-09-28.
> File-by-file detail: `brain/codemap/web-core.md` (foundation) and the feature codemaps.
> Design rules and mandatory skill sequence: `brain/conventions/frontend.md` and `brain/design/design-system.md`.

## 1. In short

- Stack: React 18.3 + Vite 5 + TypeScript 5 (strict), react-router-dom 6 in data router mode, TanStack Query 5, react-hook-form + zod, Tailwind 3.4 + shadcn-style primitives on Radix, `lucide-react` (stroke `strokeWidth={1.75}`), `sonner` for toasts, three.js (3D), CodeMirror (editor), xterm (terminal).
- Workspace package `@dive/web`, depends on `@dive/shared` (contract shared with the API: types, schemas, catalogs, computation models such as `computeChamberOutputs`).
- All interface text is in English.
- Import alias: `@/` = `apps/web/src/`.

## 2. Bootstrap

```
index.html (#root, /src/main.tsx)
 └─ main.tsx : Inter fonts (@fontsource, 400/500/600/700/700-italic) + styles/index.css
     └─ <StrictMode><App/></StrictMode>
         └─ App.tsx : <Providers><RouterProvider router={router}/></Providers>
             └─ app/providers.tsx
                 QueryClientProvider (staleTime 30 s, retry 1, refetchOnWindowFocus false)
                  └─ AuthProvider (features/auth) : session bootstrap
                      └─ TooltipProvider (delay 200 ms, skip 300 ms)
                          ├─ {router}
                          └─ <Toaster/> (sonner, top-right, 4 s)
```

- `styles/index.css` imports `tokens.css` then the Tailwind layers; it defines the global visible focus, `.skip-link`, `.bg-blueprint`, `.tabular-nums` and reduced motion.
- `VITE_API_URL` (see `apps/web/.env.example`, typical value `http://localhost:4000/api/v1`) is read lazily by `lib/api/client.ts`: the app starts without it but the first request throws an explicit error.
- In dev, `vite.config.ts` points `@dive/shared` at `packages/shared/src/index.ts` (always up to date). However, `tsc` (typecheck) and Vitest resolve the package through its `dist/`: run `npm run build:shared` (or the root `test`/`typecheck` scripts, which do it) after any change to `packages/shared`.

## 3. Routing

Defined in `apps/web/src/app/router.tsx` (`createBrowserRouter`). All pages are `lazy` chunks; the `Suspense` for protected pages lives in `AppShell` (the shell stays visible), the one for `/login` is local (fallback `FullPageLoader`).

| Route | Page (`src/pages/`) | Guard | Lazy chunk | Layout mode (`AppShell`) |
|---|---|---|---|---|
| `/login` | `LoginPage` | `RedirectIfAuthenticated` | yes | outside the shell (full screen, `bg-blueprint`) |
| `/` (index) | `HomePage` | `RequireAuth` | yes | full width, pinned to the viewport from `lg` |
| `/projects` | `ProjectsPage` | `RequireAuth` | yes | centered `max-w-content` |
| `/projects/:id` | `ProjectDetailPage` | `RequireAuth` | yes (+ lazy tabs) | full width, pinned from `lg` |
| `/projects/:id/edit` | `ProjectEditPage` | `RequireAuth` | yes | editor: pinned at all sizes, `overflow-hidden` |
| `/templates` | `TemplatesPage` | `RequireAuth` | yes | centered |
| `/templates/:id/edit` | `TemplateEditPage` | `RequireAuth` | yes | editor (as above) |
| `/meshing` | `MeshingPage` | `RequireAuth` | yes | centered |
| `/meshing/:id` | `MeshingSessionPage` | `RequireAuth` | yes | centered |
| `/chamber` | `ChamberPage` | `RequireAuth` | yes (+ lazy `ChamberViewer`) | full width, normal flow |
| `/account` | `AccountPage` | `RequireAuth` | yes | centered |
| `/admin` | `AdminPage` | `RequireAuth` + `RequireRole role="SUPER_ADMIN"` | yes | centered |
| `*` | redirect `<Navigate to="/" replace/>` | | | |

Guards (`app/guards.tsx`):
- `RequireAuth`: `status === 'loading'` shows `FullPageLoader`; unauthenticated redirects to `/login` with `state.from = pathname + search`.
- `RedirectIfAuthenticated`: on `/login`, an already signed-in user is sent to `state.from` or `/`.
- `RequireRole`: renders a 403 "Access restricted" view inside the shell (no redirect).

The layout mode is chosen in `components/layout/AppShell.tsx` by tests on `pathname` (regex `/(projects|templates)/:id/edit`, `/projects/:id`, `/`, `/chamber`). **Adding a full-screen or pinned page requires extending these regexes.**

Navigation: `components/layout/nav.ts` (`NAV_ITEMS` + `visibleNavItems(role)`) feeds `Sidebar` (desktop, from `lg`) and `MobileNav` (Radix Dialog panel below `lg`). Adding a destination = adding the route in `router.tsx` and the item in `NAV_ITEMS` (with `requiredRole` if needed). `/account` is reachable only through `UserMenu`.

Recipe "add a page":
1. Create `src/pages/XxxPage.tsx` with a named export `XxxPage` (the `lazy` does `.then(m => ({ default: m.XxxPage }))`).
2. Declare the child route in the protected branch of `router.tsx` (wrap it in `RequireRole` if restricted).
3. Add the nav item if it is a main destination; adjust `AppShell` if the layout is not "centered".
4. Business logic and hooks go in `src/features/xxx/`, not in the page.

## 4. Session and authentication

Parts: `lib/api/client.ts` (token + refresh), `lib/api/auth.ts` (endpoints), `features/auth/AuthProvider.tsx` + `auth-context.ts` (React state, `useAuth()`).

- **Access token in memory only**: module variable in `client.ts` (`setAccessToken` / `getAccessToken`), never `localStorage`. Sent as `Authorization: Bearer`.
- **Refresh via httpOnly cookie**: the paths `/auth/login`, `/auth/refresh`, `/auth/logout` (`AUTH_PATHS`) are sent with `credentials: 'include'` and never trigger the refresh cycle. `changePassword` also passes `credentials: 'include'` (server-side cookie rotation) and replaces the token.
- **Bootstrap**: on mount, `AuthProvider` calls `authApi.refresh()` (returns token + user); success: `status = 'authenticated'`, failure: `'unauthenticated'`. `AuthStatus` = `'loading' | 'authenticated' | 'unauthenticated'`.
- **Single-flight refresh on 401**: any non-auth request that receives a 401 calls `refreshAccessToken()`, which shares a single promise between concurrent calls, then replays the request once. Failure: token cleared, `onLogout()` (registered by `AuthProvider` via `setLogoutHandler`) sets the state to `unauthenticated` and calls `queryClient.clear()`, then `ApiError('UNAUTHORIZED', ...)` is thrown. The guards then redirect to `/login`.
- **Explicit logout** (`useAuth().logout`, from `UserMenu`): `POST /auth/logout`, token cleared in a `finally`, state reset and **`queryClient.clear()`** so that another user on the same machine does not see the previous cache. A network error does not prevent the local logout (warning toast).
- `useAuth().setUser(user)` replaces the session user after a profile or password update (`/account`).
- Exposed context: `{ user, status, login, logout, setUser }` (memoized). `useAuth()` throws outside the provider.

Pitfalls:
- `StrictMode` replays the bootstrap effect in dev: two `POST /auth/refresh` are sent (the `cancelled` flag only ignores the first result). If the API rotates the cookie on every refresh, the race can invalidate a session in dev (to verify on the API side).
- The bootstrap `refresh()` does not use the single-flight promise of `client.ts`: a concurrent 401 during bootstrap can trigger a second refresh.
- `/auth/change-password` is not in `AUTH_PATHS`: a 401 on this path triggers the refresh + retry cycle.

## 5. Data layer

### 5.1 API client (`src/lib/api/`)

- `client.ts` exposes `apiClient`: `get`, `post`, `put`, `patch`, `delete`, `postForm` (multipart), `putText` (raw text), `getBlob` (downloads and 3D binaries). Every error becomes an `ApiError { code: ApiErrorCode, status, message }`; transport: `NETWORK_ERROR` (status 0).
- One module per domain, `async` functions that **unwrap the envelope** (`{ project }`, `{ users }`, `{ result }`...) to return bare values: `auth.ts`, `users.ts`, `projects.ts` (projects, case files, 3D viewer, CGNS export, applied templates, solver), `templates.ts`, `meshes.ts` (mesh library + merge), `conversion.ts` (CGNS), `boundary.ts`, `meshing.ts`, `chamber.ts`, `chamberSaves.ts`, `dashboard.ts`, `config.ts`.
- `types.ts` (≈ 880 lines) is the contract: local interfaces for envelopes and bodies, re-exports (types and a few runtime values: solver catalogs, meshing defaults, `isMeshingRunActive`) from `@dive/shared`. Import API types from `@/lib/api/types`, not directly from `@dive/shared` (existing exceptions: `boundary.ts`, `ChamberPage` for `computeChamberOutputs`).
- Conventions:
  - Tool pipelines (conversion, autoPatch, merge, export, boundary conditions) **resolve** with a `success: false` report instead of rejecting: test `result.success`, not only `onError`.
  - 3D edge buffers return `null` on 404 (and on an empty blob for chamber/meshing): the viewer falls back to a client-side computation.
  - File paths go through `?path=` with `encodeURIComponent`. Folder imports name each multipart part by `webkitRelativePath`.

### 5.2 TanStack Query

- The `useQuery`/`useMutation` hooks live in `src/features/<domain>/use*.ts`, with their keys exported as constants or factories (`xxxQueryKey`). Pages consume these hooks; they call the API directly only for one-off actions (`getSessionZip` download, `stopRun` in `HomePage`, silent `buildChamber` re-POST in `ChamberPage`).
- **Hierarchical keys** per resource, so that a subtree can be invalidated or removed:
  - `['users']`; `['dashboard']`; `['templates']`, `['templates', id]`, `['templates', id, 'files']`, `['templates', id, 'files', 'content', path]`.
  - `['projects']`, `['projects', id]`, then under `['projects', id, ...]`: `'files'` (+ `'content'`, path), `'cgns'`, `'meshes'`, `'mergePlan'`, `'assembly'`, `'mesh', 'manifest'|'glb'|'edges'|'backup'`, `'runnable'`, `'runs'`, `'runs', runId, 'log'`, export.
  - `['meshing']`, `['meshing', id]`, `['meshing', id, 'run', 'log']`, `['meshing', id, 'mesh', 'manifest'|'glb'|'edges']`, `['meshing', id, 'stlBuffers', names]`.
  - `['chamber', 'saves']`, `['chamber', hash, 'manifest'|'glb'|'edges']`.
- **staleTime**: 30 s by default (providers); 5 min (`FIVE_MINUTES`, with the same `gcTime`) for heavy 3D artifacts (manifest, GLB, edges); 10 s for `runnable`.
- **Polling**: dashboard every 3 s (`refetchIntervalInBackground: false`); solver and meshing run logs every 1.2 s while the status is active (`refetchInterval` function returning `false` once a terminal status is observed).
- **After a mutation** (dominant pattern): `setQueryData` with the object returned by the server (session, file tree, CGNS list), then `invalidateQueries` on the parent list; `removeQueries` (not `invalidate`) for 3D artifacts and file contents that became stale, to force a clean reload on the next mount.
- **Logout**: `queryClient.clear()` (see section 4).
- Errors: forms use `mutateAsync` in a `try/catch`, map some `ApiError.code` values onto a field (`setError`, e.g. `VALIDATION_ERROR`, `USER_NOT_FOUND`, `COLLABORATOR_EXISTS`, `INVALID_CREDENTIALS`) and show the rest with `toast.error(err instanceof ApiError ? err.message : '...')`. List states: `isPending` skeleton, `isError` `ErrorState` + `refetch`, empty `EmptyState`, otherwise data.

## 6. Code organization

| Folder | Content | Rule |
|---|---|---|
| `src/app/` | `providers.tsx`, `router.tsx`, `guards.tsx` | application wiring only |
| `src/pages/` | one component per route, named export `XxxPage` (some also `default`) | orchestration: composes hooks and feature components, handles page states; may contain small local subcomponents |
| `src/features/<domain>/` | TanStack Query hooks, forms, dialogs, 3D viewers, business logic (`account`, `admin`, `assemble`, `auth`, `chamber`, `dashboard`, `export`, `files`, `meshing`, `projects`, `solver`, `templates`, `terminal`, `visualize`) | all reusable or domain-specific logic |
| `src/components/ui/` | generic primitives (shadcn style, Radix + tokens) | no business knowledge |
| `src/components/common/` | cross-cutting components (`EmptyState`, `ErrorState`, `PageHeader`, `FullPageLoader`, `RenameDialog`, `UnsavedChangesPrompt`, `RoleBadge`, `StatusBadge`) | reuse before recreating |
| `src/components/layout/` | `AppShell`, `Header`, `Sidebar`, `MobileNav`, `UserMenu`, `nav.ts` | shell structure |
| `src/components/brand/` | `BrandLockup` (logo `/logo.svg`), `Diamond` (diamond mark) | identity |
| `src/lib/` | `api/*` (client + contract), `utils.ts` (`cn`) | no UI |
| `src/styles/` | `tokens.css`, `index.css` | single source of design |
| `src/test/` | `setup.ts` | Vitest setup |

Known deviation: `lib/api/templates.ts` imports the `UploadFile` type from `features/files/folderImport` (a `lib` to `features` dependency).

Tests: Vitest + jsdom + Testing Library, `*.test.tsx` files next to the code. Pattern: mock the `@/lib/api/*` modules with `vi.mock`, mock `useAuth`, create a `QueryClient` with `retry: false`, use `createMemoryRouter` as soon as a component uses `useBlocker` (otherwise `MemoryRouter`), provide `TooltipProvider` if tooltips are rendered, mock the three.js and CodeMirror viewers (no WebGL under jsdom).

## 7. Available UI primitives (reuse them)

`src/components/ui/`:
- `Button` (`variant`: `primary` orange CTA, `secondary` blue outline, `ghost`, `destructive`; `size`: `sm`, `md`, `icon`; `loading` without layout shift; `asChild`) and `buttonVariants`.
- Forms: `Field` (label + help + error, ARIA wiring through context; `useFieldControl()` for a custom control), `Input`, `PasswordInput`, `Textarea`, `NativeSelect` (the styled native select, standard for dense forms), `Select*` (Radix, used only by the admin user form), `Label`, `SegmentedRadioGroup` (native radios as a segmented control).
- Overlays: `Dialog*` (480px, built-in X button), `AlertDialog*` (420px, destructive confirmation; no built-in loading state), `DropdownMenu*` (`destructive` item), `Tooltip*`.
- Data and feedback: `Table*` (rules, scrollable container), `Badge` (`neutral`, `primary`, `success`, `danger`), `Skeleton`, `Tabs*` (blue underline), `Avatar*`, `Separator` (unused so far), `Toaster` + `toast` (import `toast` from `@/components/ui/sonner`).

`src/components/common/`: `PageHeader` (title + action on the right), `EmptyState` (`card` or `inline`), `ErrorState` ("could not load" block with retry), `FullPageLoader`, `RenameDialog`, `UnsavedChangesPrompt` (blocks internal navigation + `beforeunload`; pass the form's `isDirty`), `RoleBadge`, `StatusBadge`.

Conventions observed in pages:
- A single `primary` (orange) `Button` per action zone; the rest in `secondary` or `ghost`.
- lucide icons `strokeWidth={1.75}` + `aria-hidden="true"`; icon buttons carry an `aria-label`.
- A disabled control that must explain why is wrapped in a `span tabIndex={0}` carrying the `Tooltip`.
- Opening a dialog from a `DropdownMenu` item: defer with `setTimeout(() => setOpen(true), 0)`.
- Async confirmation in `AlertDialogAction`: `event.preventDefault()` then `mutateAsync`, `Loader2` spinner added by hand.
- Dates: `Intl.DateTimeFormat('en-GB', ...)` declared locally in each page (not factored out).

## 8. Tokens and Tailwind mapping

Single source: `src/styles/tokens.css` (full list of values in the codemap). `tailwind.config.ts` only references the variables under semantic names. Classes to use:

| Need | Classes | Variable |
|---|---|---|
| Brand blue | `bg-primary`, `text-primary`, `border-primary`, `hover:bg-primary-hover`, `text-primary-light`, `bg-primary-tint` | `--color-primary*` |
| Orange accent (non-text, surfaces) | `bg-accent`, `bg-accent-hover`, `bg-accent-tint`, `border-accent/40`; small orange text: `text-accent-strong` | `--color-accent*` |
| Solid CTA | `bg-cta`, `hover:bg-cta-hover` (bold white label) | `--color-cta`, `--color-cta-hover` |
| Logo grey | `text-neutral`, `bg-neutral` | `--color-neutral` |
| Backgrounds | `bg-bg` (page), `bg-surface` (cards) | `--color-bg`, `--color-surface` |
| Text | `text-text`, `text-text-secondary` | `--color-text*` |
| Borders | `border-border` (global default), `border-border-strong` | `--color-border*` |
| Signals | `text-success`, `bg-success-tint`, `text-danger`, `bg-danger`, `hover:bg-danger-hover`, `bg-danger-tint` | `--color-success*`, `--color-danger*` |
| Focus | `ring-focus-ring` (+ `focus-visible:ring-2 ring-offset-2`) | `--color-focus-ring` |
| Scrim | `bg-scrim` | `--color-scrim` |
| Radii | `rounded-xs` (4), `rounded-sm` (8), `rounded-md` (12), `rounded-lg` (16) | `--radius-*` |
| Shadows | `shadow-sm`, `shadow-md`, `shadow-lg` (dialogs) | `--shadow-*` |
| z-index | `z-base`, `z-dropdown`, `z-sticky`, `z-overlay`, `z-modal`, `z-toast`, `z-tooltip` | `--z-*` |
| Font | `font-sans` | `--font-sans` |
| Motion | `duration-fast` (150ms), `duration-base` (200ms), `ease-out` | `--ease-out` (durations hardcoded in Tailwind) |
| Content width | `max-w-content` (1200px, hardcoded) | none |
| Animations | `animate-overlay-in/out`, `animate-content-in/out`, `animate-shimmer` | Tailwind keyframes |

No Tailwind alias for `--terminal-*` (read in JS through `getComputedStyle` for xterm) nor for `--duration-*` (used only by `.skip-link`). Custom CSS utilities: `.bg-blueprint`, `.tabular-nums`, `.skip-link`.

Caution: everything is declared in `theme.extend`, so the default Tailwind palette and scales remain active (`text-white`, `rounded`, `rounded-full`, `font-mono`, `bg-red-500`...). Nothing technically prevents a component from stepping outside the tokens; the discipline is manual. Off-token usages already present: `text-white` (Button, Tooltip, chips), `rounded-full` (Avatar, dashboard bars), `rounded` and `font-mono` and `animate-pulse` (HomePage).

## 9. Code-splitting

- Route level: the 12 pages are `lazy` in `router.tsx`.
- Tab or panel level: `ProjectDetailPage` lazily loads `VisualizePanel`, `AssemblyWorkspace` (three.js), `SolverTab`, `ExportTab`, mounted only when the tab is active; `ChamberPage` lazily loads `ChamberViewer`; `features/terminal/ProjectTerminalButton` lazily loads `TerminalView`.
- `vite.config.ts` `manualChunks` (vendor `node_modules` only): `codemirror` (CodeMirror, `@uiw`, `@lezer`, `style-mod`, `crelt`, `w3c-keyname`), `three`, `router`, `radix`, `query`, `forms` (react-hook-form, `@hookform`, zod), `react` (react, react-dom, scheduler), the rest in `vendor`.
- Likely pitfall: `@xterm/xterm` and `@xterm/addon-fit` have no rule and fall into `vendor`, a chunk loaded at startup, which would cancel the benefit of the terminal `lazy` (to verify on the `vite build` output; fix: a dedicated `xterm` rule).
- `optimizeDeps.include` (dev) explicitly lists the dependencies to pre-bundle; `@radix-ui/react-tabs`, `three` and `@xterm/*` are not in it (risk of re-optimization + reload the first time a route that uses them is opened).

## 10. Divergences between tokens.css / design-system.md / original charter

> "Original charter" column = the former `CLAUDE.md` (design charter from 2026-06), replaced on 2026-09-28 by `brain/conventions/frontend.md`, which already settles the CTA color and the `accent-strong` token.

| Topic | Original charter | `design-system.md` | `tokens.css` / code | Comment |
|---|---|---|---|---|
| CTA color | « Orange / Accent `#EE7F00` : action principale (CTA) », « un seul bouton orange plein » | CTA = `--color-cta` `#A85F00` (darkened orange, bold white 4.88:1), `#EE7F00` never behind white text | `Button variant="primary"` = `bg-cta` `#a85f00`, hover `#8c4e00` | The code follows `brain/design/design-system.md` (AA accessibility). `CLAUDE.md` allows « aucune autre teinte de marque » and lists neither `#A85F00` nor `#8C4E00`. |
| Orange for small text | forbidden for small text | forbidden on white | `--color-accent-strong: #8f4f00` (`text-accent-strong`) intended for AA small orange text | Token absent from `brain/design/design-system.md` and from `CLAUDE.md`. |
| Signal colors | not mentioned | `success`/`danger` allowed as functional signals | present | Consistent with `brain/design/design-system.md`, outside the original charter palette. |
| Dark terminal | « Clair par défaut, et seul thème » | single dark surface allowed (`--terminal-*`) | `--terminal-*` including `#e5484d`, `#30a46c` (lightened red/green) | Off-palette hues; accepted by `brain/design/design-system.md`. |
| Dark mode | via `[data-theme]` if ever requested | no | `darkMode: 'class'` configured (unused) | If a dark mode is added, `CLAUDE.md` requires `[data-theme]`, not the class. |
| Radius | 8 / 12 / 16 | + `--radius-xs: 4px` (micro-controls), "no bubble radii" | `--radius-xs` present; `rounded-full` used (Avatar, dashboard) | `rounded-full` contradicts the rule "no full-round bubble radii". |
| Type scale | 12 to 48 | 12 to 30 (`text-3xl` reserved for branding) | `fontSize` defined up to `3xl`; `4xl`+ = Tailwind defaults | No 36/48 token. |
| Single font | modern sans-serif | "One family across the whole UI" | `font-mono` (Tailwind default) in `HomePage` | Deviation in the dashboard. |
| Spacing tokens | 4px scale as tokens | 4px scale | no `--space-*` variables; default Tailwind scale | No dedicated token. |
| Motion | 150 to 200ms ease-out | same | `--duration-*` exist but Tailwind hardcodes `150ms`/`200ms` | Two sources. |
| Sidebar | no | "Items this phase: Home, Administration" | 6 items (`nav.ts`) | `brain/design/design-system.md` lags behind the code. |
| Lockup | bold italic style reserved for branding | "diamond mark + DIVE Turbinen wordmark in `--primary`" | `BrandLockup` = official `logo.svg` (DIVE orange, Turbinen blue) | `brain/design/design-system.md` description is inaccurate. |
| Dialog usage | no | "create/edit user and delete confirmation only" | many dialogs (collaborators, details, rename, import, send to meshing...) | `brain/design/design-system.md` rule is outdated. |

Practical rule for an agent: follow `tokens.css` + `brain/design/design-system.md` for values (the code and the accessibility review align with them) and flag any new hue; never put `#EE7F00` back behind a white label.

## 11. Cross-cutting debt and pitfalls

- Artifacts tracked by git: `apps/web/tsconfig.tsbuildinfo` and `apps/web/tsconfig.node.tsbuildinfo` (stale; the config writes to `node_modules/.tmp/`). Remove them from tracking and add `*.tsbuildinfo` to `.gitignore`.
- `FullPageLoader` (height `100dvh`) is also used as a loading state inside the shell (`ProjectDetailPage`, `ProjectEditPage`, `TemplateEditPage`, `AccountPage`): it overflows the content area.
- Inconsistent "not found" detection: `error.code === 'NOT_FOUND'` (projects, templates) versus `error.status === 404` (meshing). `ProjectEditPage` and `TemplateEditPage` hand-code their error card instead of using `EmptyState`/`ErrorState`.
- Duplicated helpers: `formatCreated`/`formatDate`/`dateFormatter` (Projects, Meshing, Templates), `formatBytes` (two different versions in `HomePage` and `MeshingSessionPage`), `BackLink` redefined in four pages, nav item rendering duplicated between `Sidebar` and `MobileNav`.
- Local type mirrors "ahead" of `@dive/shared` in `types.ts` (`MergeStepKind`, `MeshInterface`, `PartTransform`, `MergePlan`, `AppliedAssembly`, `MERGE_BASE_CASE`): risk of silent divergence.
- `ProjectsPage`: the skeleton has one column fewer than the loaded table.
- `ProjectDetailPage.test.tsx` does not mock `@/lib/api/meshes` (a real request that fails under jsdom without affecting the assertions).
- A comment in `meshes.ts` references `projects.ts` by line numbers (stale).
