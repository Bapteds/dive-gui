# Playbook: Add a web page, a navigation entry or a project-detail tab

> When to use: a new route under the authenticated shell, a sidebar destination, or a new tab on `/projects/:id` · Related: `brain/conventions/frontend.md`, `brain/design/design-system.md`, `brain/architecture/frontend.md` (§3 routing, §5 data, §7 primitives), `brain/codemap/web-core.md`, `brain/codemap/web-features-*.md`, `brain/features/projects.md` §2 (tab table), `add-api-endpoint.md` · Updated: 2026-09-28

## Before you start
- Read `brain/STATUS.md`, then `brain/conventions/frontend.md` and `brain/design/design-system.md` (visual rules), `brain/architecture/frontend.md` §3 and §5.
- **UI skill sequence before any JSX/CSS**: `ui-ux-pro-max` → `frontend-design` (or `impeccable`) → `design-taste-frontend`, then `web-design-guidelines` as the exit review. Point the design skills at `brain/design/design-system.md` and `brain/design/product.md` explicitly (they look for `DESIGN.md` / `PRODUCT.md` at the root). A change that only reuses existing primitives may skip to the review step; note any deviation in the changelog.
- Settle with the user (one question at a time): path and name, who sees it (any user, or `SUPER_ADMIN`), layout (centered `max-w-content`, full width in normal flow, or pinned to the viewport from `lg`), sidebar item or not, and for a tab: its enable condition and the tooltip that explains a disabled state.
- The endpoint must exist. If not, do `add-api-endpoint.md` first (shared types, route, `lib/api` function).

## Steps
1. **API client function** in `apps/web/src/lib/api/<domain>.ts`: typed `async` functions that unwrap the envelope and return bare values. Model: `lib/api/chamberSaves.ts` (`listChamberSaves`, `createChamberSave`). Response types go in `lib/api/types.ts`, re-exported from `@dive/shared` when the API already shares them (do not redeclare a shared type locally).
   ```ts
   /** List the widgets of a project. */
   export async function listWidgets(projectId: string): Promise<Widget[]> {
     const data = await apiClient.get<{ widgets: Widget[] }>(`/projects/${projectId}/widgets`);
     return data.widgets;
   }
   ```
2. **Query hooks** in `apps/web/src/features/<domain>/use<Domain>.ts`, keys exported as constants or factories, hierarchical so a subtree can be invalidated or removed:
   - project-scoped: `['projects', id, '<sub>', ...]` (model: `runnableQueryKey` / `runsQueryKey` in `features/solver/useRuns.ts`); global: `['<domain>', ...]` (model: `meshingSessionKey` in `features/meshing/useMeshing.ts`).
   - After a mutation: `setQueryData` with the server response, then `invalidateQueries` on the parent list (model: `useRenameMeshingSession`); `removeQueries` for 3D artifacts or file contents that became wrong (model: `useOnMeshingRunSettled`, `useImportCase` in `features/projects/useCaseFiles.ts`). Do not swallow errors in the hook: the component calls `mutateAsync` and maps `ApiError.code`.
   - Heavy immutable artifacts: `retry: false`, `staleTime` and `gcTime` 5 min (model: `useChamberManifestQuery` in `features/chamber/useChamber.ts`).
   - Polling: `refetchInterval` as a function that keeps polling while there is no data (fix H5) and stops on a terminal status (model: `useRunLogQuery`):
   ```ts
   refetchInterval: (query) => {
     const status = query.state.data?.status;
     if (status && !isActive(status)) return false;
     return POLL_MS; // no data yet or still active: keep polling
   },
   ```
3. **Page** `apps/web/src/pages/XxxPage.tsx`, named export `XxxPage`, orchestration only (logic lives in `features/<domain>/`). States in this order (model: `MeshingPage`): `isPending` → a `Skeleton`-based placeholder (local `SessionsSkeleton`-style component), `isError` → `ErrorState` with `onRetry={() => void refetch()}` and `retrying={isRefetching}`, empty → `EmptyState` whose description teaches the next step, else data. Header via `PageHeader` (title, subtitle, `action`). A detail route reads `useParams()` and maps `error instanceof ApiError && error.code === 'NOT_FOUND'` to a not-found `EmptyState` (model: `ProjectDetailPage`).
4. **Route** in `apps/web/src/app/router.tsx`: a lazy constant mapping the named export, then a child of the protected branch (the shell's `Suspense` covers it):
   ```ts
   const WidgetsPage = lazy(() =>
     import('@/pages/WidgetsPage').then((m) => ({ default: m.WidgetsPage })),
   );
   // children: { path: 'widgets', element: <WidgetsPage /> },
   ```
   Admin only: wrap as `<RequireRole role="SUPER_ADMIN"><WidgetsPage /></RequireRole>` (renders a 403 view inside the shell, no redirect; `app/guards.tsx`).
5. **Layout** in `apps/web/src/components/layout/AppShell.tsx`: pages are centered at `max-w-content` unless a `pathname` test opts out. Full width in normal flow: add a boolean like `isChamber` and its branch in `contentClass`. Pinned from `lg` (page never scrolls, a region scrolls inside): OR your regex into `isProjectDetail || isDashboard`, then give the page root `lg:min-h-0 lg:flex-1` and let one child scroll. Anchor regexes (`/^\/widgets\/[^/]+\/?$/`).
6. **Navigation** (main destinations only): one entry in `NAV_ITEMS` of `apps/web/src/components/layout/nav.ts` (`label`, `to`, a `lucide-react` icon, optional `requiredRole`). `Sidebar` and `MobileNav` both read `visibleNavItems(role)`: nothing else to wire.
7. **Project-detail tab** in `apps/web/src/pages/ProjectDetailPage.tsx`:
   - extend the `ProjectView` union;
   - declare the panel lazily next to `SolverTab` / `ExportTab` (`lazy(() => import('@/features/<x>/<X>Tab').then(...))`);
   - add a trigger component copied from `SolverTabTrigger`: `TabsTrigger` with `disabled`, and when disabled a `Tooltip` around a `span tabIndex={0}` so the reason stays keyboard-reachable;
   - compute the enable flag in `ProjectTabs` from existing queries (`hasPolyMesh` from `useCaseFilesQuery`, `hasSources` from `useMeshesQuery`);
   - add a `TabsContent` whose body is `{view === '<x>' && (<Suspense fallback={<ViewerLoading />}>...</Suspense>)}`: the panel mounts only while active, so no polling or server build runs from another tab. The active tab is local state, not in the URL.
8. **UI rules** while writing JSX: reuse `components/ui/*` (`Button` variants `primary`/`secondary`/`ghost`/`destructive`, `Field`, `Input`, `NativeSelect`, `Dialog`, `AlertDialog`, `Tabs`, `Table`, `Badge`, `Skeleton`, `toast` from `@/components/ui/sonner`) and `components/common/*`. Tokens only (`bg-surface`, `text-text-secondary`, `border-border`, `rounded-md`...), never Tailwind defaults (`text-white`, `rounded-full`, `bg-gray-*`) or hex. One `primary` (orange CTA) per action zone. Icons `strokeWidth={1.75}` + `aria-hidden="true"`, `aria-label` on icon-only buttons. A forbidden action uses `aria-disabled="true"` plus a tooltip, not a silent `disabled`. English strings, no em dashes. Contrast AA (orange text only via `text-accent-strong`).
9. **Tests**, colocated `*.test.tsx`, queries by role and accessible name:
   - page with params: `createMemoryRouter([{ path: '/projects/:id', element: <Page /> }], { initialEntries: [...] })` + `RouterProvider`, inside `QueryClientProvider` (`retry: false`) and `TooltipProvider` (model: `pages/ProjectDetailPage.test.tsx`);
   - a component that only renders links: `MemoryRouter` is enough (model: `features/projects/CaseFilesSection.test.tsx`);
   - any test that NAVIGATES through a data router (`useBlocker`, clicking a `Link` to another route) must install the `globalThis.Request` override from `components/common/UnsavedChangesPrompt.test.tsx` (jsdom vs undici: relative URL and foreign `AbortSignal`);
   - mock every `@/lib/api/<module>` the page touches, `useAuth` (`@/features/auth/AuthProvider`), lazy panels and three.js viewers (stub with `data-testid`); Radix `Tabs` need `userEvent.click`, and a disabled trigger wrapped in a tooltip is a different node after load, so re-query it.

## Verify
- `cd apps/web && npx vitest run src/pages/XxxPage.test.tsx src/features/<domain>`: all green, no act() warnings left unexplained.
- `npm run typecheck` and `npm run lint` at the root (typecheck rebuilds `@dive/shared`; a bare `npx vitest` does not, so run `npm run build:shared` first if shared changed).
- Optional bundle check: `VITE_API_URL=http://localhost:4000/api/v1 npm run build -w @dive/web`, the page appears as its own chunk.
- Manual (`npm run dev`): 375 px width without horizontal scroll, sidebar as slide-over below `lg`, keyboard tab order and focus rings, every state (loading, empty, error, disabled). On Baptiste's Windows workstation run `npm install` first (`brain/STATUS.md` §3).

## Update the brain
- [ ] Changelog entry on top of `brain/changelog/2026-MM.md` (format in `brain/changelog/README.md`), with the Tests line and the skill sequence followed (or the justified deviation).
- [ ] `brain/codemap/web-core.md` (router, nav, AppShell, page) and the `web-features-*.md` sheet of the feature folder, then `python brain/codemap/build-index.py`.
- [ ] `brain/architecture/frontend.md`: route table (§3), query keys (§5.2), lazy chunk count (§9).
- [ ] Feature sheet: new `brain/features/<feature>.md` + row in `brain/features/README.md`, or the tab table in `brain/features/projects.md` §2.

## Pitfalls
- Forgetting the `AppShell` regex: the page renders centered, or a pinned page overflows because its root lacks `lg:min-h-0 lg:flex-1`.
- `lazy()` on a named export without the `.then((m) => ({ default: m.X }))` mapping fails at runtime.
- Mounting a tab panel unconditionally starts its polling and 3D builds on every visit to the project.
- Prefix invalidation refreshes the whole subtree: `['projects']` reloads trees, contents and meshes of every project (K16); `meshingSessionsKey` is `['meshing']`, the prefix of every meshing key. Invalidate the narrowest key.
- Stopping a poll on `undefined` data freezes the UI after one network blip (H5).
- Tooling pipelines (conversion, merge, export, boundary conditions) resolve with `success: false` instead of rejecting: check `result.success`, not only `onError`.
- `FullPageLoader` (`100dvh`) used inside the shell overflows the content area (existing debt in `ProjectDetailPage`, `ProjectEditPage`): use skeletons in new pages.
- Not-found detection is heterogeneous (`code === 'NOT_FOUND'` vs `status === 404` in meshing): prefer the code.
- Tailwind default classes still compile (`theme.extend`); reviewers catch them, the build does not (see K25).
- `fireEvent.click` on a Radix tab does not activate it; unmocked API modules issue real requests under jsdom (`ProjectDetailPage.test.tsx` does not mock `@/lib/api/meshes`); `window.matchMedia` is stubbed in `src/test/setup.ts`, do not re-stub it.
- `useForm` reads `defaultValues` once: to test other defaults, mount fresh instead of `rerender`.
