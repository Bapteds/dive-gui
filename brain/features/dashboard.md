# Feature · Dashboard (Home "command center")

> **Status**: in production · **Updated**: 2026-09-28
> **Specs**: no dedicated spec; imported design "Light Command center" (see changelog 2026-07-02) · **Codemaps**: `brain/codemap/api-core.md` (module `dashboard`), `brain/codemap/web-core.md` (`pages/HomePage.tsx`, `lib/api/dashboard.ts`, `AppShell`), `brain/codemap/web-features-platform.md` (`features/dashboard`)
> **See also**: `brain/features/projects.md` (visibility rule), `brain/features/solver-and-runs.md` (runs, stopping)

## 1. Purpose
Home page `/` for every signed-in user: a "live" view of the state of the machine hosting the API (CPU, memory), of running solvers and of run outcomes, plus quick access to recent projects. Machine metrics are the same for everyone; the runs and projects shown are limited to the projects visible to the user (all projects for a super-admin). Only solver runs are counted, not meshing runs (Meshing page).

## 2. User journey
- **Access**: nav `Home` (`/`, `end`), header logo, and default redirect after login. Page pinned to the viewport from `lg` up (no page scroll, panels with internal scroll); normal flow on mobile.
- **Header**: title `Dashboard`, `Live` pill (animated dot), line `Welcome back, <first name>.` (first word of `fullName`), orange CTA `New project` leading to `/projects` (where the creation form is).
- **KPI strip** (4 cards):
  - `CPU load`: percentage, sparkline of the last 40 samples, delta pill since the previous poll, footer `<cores> cores · load <loadAvg1>`;
  - `Memory`: percentage used, sparkline, used / total bytes;
  - `Active solvers`: number of `queued` + `running` runs, footer `<n> of <cores> cores in use`;
  - `Total runs`: total, outcome distribution bar, success rate.
  Gauge color follows `usageColor`: blue, orange from 75%, red from 90%.
- **Running solvers**: one row per active run (project, solver, status, elapsed time) with two actions: `View <project>` (link to `/projects/:id`) and `Stop <project>` (immediate stop, without confirmation; error toast if stopping fails). Reminder of the number of `queued` runs "waiting for cores". Empty: `No solver running`.
- **Run outcomes**: donut (`<total> total runs`) + legend `Converged` (converged + completed), `Diverged / failed`, `Stopped / other` (stopped + queued + running). Empty: `No runs yet`.
- **Recent projects**: grid of the 6 most recent visible projects with their outcome bar; link to `/projects`. Empty: `No projects yet`.
- **Loading**: custom skeletons per card. **Error**: not handled (see M22); skeletons and the `Live` pill stay displayed if the API fails.

## 3. Business rules and invariants
- **Single endpoint**: `GET /api/v1/dashboard`, authenticated (`requireAuth`), no role restriction.
- **Visibility**: runs and projects filtered by the same rule as `listProjects` (owner, collaborator or super-admin), applied through the `run.project` relation. An outsider sees no run of a project that is not visible to them.
- **Machine metrics** (`node:os`, stateless on the server): `cpuPercent` sampled over ~150 ms on each call (clamped 0..100), `cores`, `memUsedBytes` = total − free, `memTotalBytes`, `loadAvg1` (0 on Windows), `uptimeSec`. They describe the whole machine, not only the DIVE processes.
- **Bounds**: `activeRuns` = at most 12 active runs (`startedAt desc`), `recentRuns` = last 8 runs (`createdAt desc`), `runCounts` = count per status with a 0 entry for each value of `RUN_STATUSES`, `recentProjects` = 6 projects (`createdAt desc`) with `runCount`, `converged` (converged + completed), `diverged` (diverged + failed), `other`.
- **Polling**: every 3 s (`refetchInterval: 3000`), suspended when the browser tab is in the background (`refetchIntervalInBackground: false`). The sparkline history (40 points) is local to the component and restarts from zero on each mount.
- **Stopping a run**: same API as the Solver tab (`POST /projects/:id/runs/:runId/stop`), hence open to any project member; graceful stop (`stopAt writeNow`) then SIGTERM after the grace period (see codemap `api-projects.md`, `runs.service.stopRun`).

## 4. Technical flow
- **Read**: `HomePage` → `useDashboardQuery()` (`features/dashboard/useDashboard.ts`, key `['dashboard']`, 3 s poll) → `lib/api/dashboard.getDashboard` → `GET /api/v1/dashboard` → `requireAuth` → `getDashboardController` (builds the `Viewer`) → `dashboard.service.getDashboard(viewer)`: in parallel `sampleCpuPercent()`, `prisma.run.findMany` (active), `prisma.run.findMany` (recent), `prisma.run.groupBy({ by: ['status'] })`, then `getRecentProjects` (`prisma.project.findMany` + `prisma.run.groupBy({ by: ['projectId', 'status'] })`) → `200 DashboardData`.
- **Client history**: a `useEffect` keyed on `dataUpdatedAt` appends CPU and memory to the local arrays (`slice(-40)`).
- **Stop**: `useMutation` local to `HomePage` → `lib/api/projects.stopRun(projectId, runId)` → `POST /api/v1/projects/:id/runs/:runId/stop` → on success, invalidation of `['dashboard']` only.
- **Rendering**: hand-made SVG primitives (`features/dashboard/DashboardCharts.tsx`: `Sparkline`, `DistributionBar`, `Donut`), colors exclusively via tokens through `features/dashboard/dashboardColors.ts` (`TONE`, `usageColor`, `RUN_STATUS_COLOR`, `RUN_STATUS_PILL`). No chart library.
- **Layout**: `AppShell` classifies `/` among the full-width routes pinned from `lg` up.

## 5. Data and storage
- Read-only: Prisma `Run` (status, solver, dates, `projectId`) and `Project` (title, date). Nothing is written, no file under `STORAGE_DIR`.
- Client cache: `['dashboard']` (refreshed by the poll, cleared on logout along with the whole cache). `recentRuns` and `uptimeSec` are returned by the API but not displayed by `HomePage`.

## 6. Configuration and external dependencies
- No feature-specific variable. The displayed `cores` value comes from `os.cpus()`; it may differ from the solver core budget (`SOLVER_TOTAL_CORES`, defined in `apps/api/src/config/env.ts`).
- `loadAvg1` is 0 on a Windows dev workstation.

## 7. Tests
- `apps/api/tests/dashboard.test.ts`: shape of the metrics (bounds only, machine-dependent), `activeRuns` with `projectTitle`, `recentRuns`, `runCounts`, `recentProjects` and their counters, isolation (an outsider sees no run), 401 without auth. Runs are inserted directly into the database.
- `apps/web/src/pages/HomePage.test.tsx`: rendering with data ("Welcome back, Ada", CPU 42, solver `simpleFoam`, recent project, donut "4 total runs") and empty states; API, `stopRun` and `useAuth` mocked.
- Not covered: `DashboardCharts` (K30), stop mutation, error state (nonexistent).

## 8. History
- 2026-07-02: Dashboard v1, live non-scrolling Home (module `dashboard`, `GET /api/v1/dashboard`, SVG charts, 3 s poll) (`b0478ee`); Dashboard v2, "Command center" redesign based on the imported design, palette mapped onto the brand tokens, addition of `recentProjects` on the API and of the `Stop` action (`1492adf`). `brain/changelog/2026-07.md`.
- 2026-07-10: alignment with the shapes and typography contract during the visual polish pass (`3ab2701`, 2026-07-10 entry on the global visual polish pass in `brain/changelog/2026-07.md`).
- Before 2026-07-02, Home was an empty welcome page (lot 3 of 2026-06-19).

## 9. Known limits and bugs
- `brain/known-issues.md`: **M22** (Home never checks `isError`: skeletons and `Live` badge forever if the API fails), **K25** (`DistributionBar` in `rounded-full`, outside the radius rule), **K30** (no test for `DashboardCharts`), **K31** (metrics of the API machine only).
- Reading findings (not reproduced):
  - `Active solvers … of <cores> cores in use` compares a number of runs with the number of machine cores: an MPI run on 8 cores counts as 1 (`DashboardRun` does not expose `cores`);
  - `activeRuns` is capped at 12: beyond that, the KPI and the list underestimate active runs;
  - `Stop` acts without confirmation and only invalidates `['dashboard']` (the Solver tab of a project open elsewhere only refreshes on its own poll);
  - elapsed time only advances at the poll rate; deviations from the design system noted in the codemap (`font-mono`, custom skeletons instead of `Skeleton`).
- Doc drift: `brain/design/design-system.md` §7.2 still describes an "intentionally blank" Home ("Your workspace is ready.", "No fake widgets, no placeholder charts"); the real Home is the command center described here.

## 10. Changing this feature
- Any new payload field: add it to `DashboardData` in `dashboard.service.ts` AND to the mirror type in `apps/web/src/lib/api/types.ts`, then to the `HomePage.test.tsx` mocks.
- The visibility rule is duplicated in `projectVisibilityWhere`: keep it identical to `projects.service.listProjects` (see `projects.md` §10).
- Each call costs ~150 ms (CPU sampling) and is repeated every 3 s per open tab: do not add heavy queries (log reads, disk) in `getDashboard`.
- Colors: only via `dashboardColors.ts` (tokens), never hex in `HomePage`; new run statuses: complete `RUN_STATUS_COLOR` and `RUN_STATUS_PILL` (typed `Record<RunStatus, …>`, the compiler flags the omission after `npm run build:shared`).
- Add the error state (M22) with `ErrorState` + retry, and stop the `Live` pill when the request fails.
- UI: skill sequence `brain/conventions/frontend.md` §1 (and `dataviz` skill for charts); update `brain/design/design-system.md` §7.2 and the changelog in the same change.
