# Chamber optimisation loop (WS-H) — design

**Date:** 2026-09-29
**Status:** approved (2026-09-29), amended 2026-09-30 (§0); implemented 2026-09-30 on branch `feat/optimisation-loop` (not merged; plan `brain/plans/2026-09-30-optimisation-loop.md`)
**Sequencing:** implementation starts **only after WS-F and WS-G are implemented on branch `feat/chamber-v2-cfd-loop`** (WS-G also validated on the Debian server).
**Feature:** new "Optimisation" feature chaining Chamber Creation → Meshing → Project case → Boundary conditions → Solver → metrics
**Scope:** Prisma (2 tables) + API (new `studies` module, an in-process orchestrator, a Python suggestion script) + web (study page) + tests. **No change** to `buildChamber.py`, to the meshing pipelines, to the BC presets or to the solver internals: the loop only calls existing services.
**Related:** `brain/specs/2026-08-11-chamber-to-meshing-transfer-design.md` (the `copyFrom` path was built for this loop, `brain/features/chamber-creation.md` §4.9), WS-F `2026-09-29-meshing-to-project-design.md`, WS-G `2026-09-30-solver-convergence-vorticity-design.md` (replaces the never-committed `2026-09-29-solver-convergence-criteria-design.md`), WS-I `2026-09-30-free-surface-tool-design.md` (shared pipeline helpers, mesh origin).

---

## 0. Amendment 2026-09-30 (user decisions; wins over the sections below where they differ)

| # | Topic | Amended decision |
|---|---|---|
| A1 | Where it lives | **In the project**: a new project tab **Optimisation** (no `/studies` pages, no navigation entry). A study is created from a project and uses **that project as its work project** (Q3 amended: no project is created; `Study.projectId` = the project it was created in). Each evaluation replaces the project's case mesh (the original case is backed up once by the WS-F route) and solves there. |
| A2 | Base design | Picked in the creation form: a **Chamber save** (`ChamberSave.snapshot`), or **the chamber this mesh came from** when the project's mesh origin (WS-I §4) has a `chamberHash` whose build dir holds `input.json`. |
| A3 | Reference meshing session | Default = the mesh origin's session; else picked among meshed sessions. |
| A4 | Metrics (WS-G) | `headLoss` (m) = mean Δp₀ over the last `window` iterations of the run (the criterion's window; `simplePDrop.window` or `robust.W`) / (ρ g), from the WS-G monitors. Vortex: WS-G computes **both** the masked Q volume (m³) and the RMS vorticity in the Q-core (1/s) at the latest time (on-demand post-process after the solve). **The study picks which one enters the objective**: new field `Study.vortexMetric` `'maskedQVolume'` (default) \| `'omegaRms'`. `Evaluation` stores both (`maskedQVolume`, `omegaRms`) plus `dp0` (Pa); `vortexVolume` in §3 is replaced by these columns and the objective uses the picked one (`vortex₀` = the baseline's value of the picked metric). Objectives ids: `headLoss`, `vortex`. |
| A5 | Criteria | `Study.criteria` = snapshot of the project's WS-G `cfd-criteria.json` at study start (method, patches, vortex settings); the runner re-installs it before each solve. |
| A6 | Routes | Nested under the project: `/api/v1/projects/:id/studies[...]` (same verbs as §7). Visibility = the project's; control = study owner + super-admin. |
| A7 | Locks | A running study locks its project (manual runs, mesh/case mutations, free-surface job: 409 `STUDY_IN_PROGRESS`); a running free-surface job blocks a study start (409 `FREE_SURFACE_IN_PROGRESS`). One study running at a time globally stays. |
| A8 | Pipeline | The stages reuse the WS-I helpers (`lib/pipelineStages.ts`: `awaitRunTerminal`, `awaitMeshingTerminal`, `sendSessionToCase`, `solveCase`). |
| A9 | Out of scope now | "Optimise this design" on the Chamber page; MCP tools. |

---

## 1. Goal

Search chamber geometries that **minimise the head loss and the vortex volume** of the flow through the chamber, automatically:

design → build the chamber → mesh it with a reference meshing setup → put the mesh into a project case → apply the chamber BCs → solve until the WS-G criteria → read the metrics → propose the next design.

Constraints from the user:
- the search space is only a **band around the calculated/set value** of each chosen parameter, reusing the Min/Max of the Parameters table; default band **±10 %**, adjustable;
- objectives: head loss and vortex volume, **weighted sum by default**, Pareto (multi-objective) optional;
- a geometry refusal (the builder refuses the design) is an **infeasible trial**, not a crash;
- one study running at a time;
- X1..X3 (Runner Ø, Head, Q_max) stay fixed: the machine does not change, only the chamber around it.

## 2. Current mechanism (verified in code)

| Step | Existing API / service | Notes |
|---|---|---|
| Build | `POST /chamber/build` → `chamber.service.ts:260` `buildChamber(input)` → `{ hash, outputs, warnings, stepHasVanes }`; cache per hash, `withChamberLock` | Refusals: pre-builder **422 `VALIDATION_ERROR`** (`:278` non-positive dims, `:295` Min>Max, `:306` generator height) and builder **`KO:` line ⇒ 502 `CHAMBER_BUILD_FAILED`** "Cannot build the chamber. …" (`summarizeFailure`, `:145`). A real crash is also 502 (no `KO:`). Distinguishable only by message today: this spec adds `CHAMBER_REFUSED` (§10 Q7). |
| Mesh setup | `POST /meshing/from-chamber` `{ mode: 'copyFrom', chamberHash, sourceId, name? }` → `meshing.service.ts:246` `importChamberIntoMeshing` | Copies engine + `config.json` + surfaces, overwrite by name (caveat: stale surfaces with other names stay). |
| Mesh | `startMeshingRun` (202, background), `getMeshingLog` status, `stopMeshingRun` | In-memory `activeMeshRuns`; `reconcileOrphanMeshingRuns` at boot. |
| Into a case | WS-F `POST /projects/:id/mesh/from-meshing { target: 'case' }` (to build) | Forces chamber patch types, merge sync, backup. |
| BCs | `boundary.service.applyBoundaryConditions` — **a chamber preset exists**: `objectType: 'chamber'`, modes `flowRate` / `pressure` (`packages/shared/src/index.ts:260`); flow-rate inlet `flowRateInletVelocity` + `extrapolateProfile false`; outlet `p fixedValue 0`; turbulence seeds k 0.06 / ω 10, I 5 %, L 0.07 | Needs inlet/outlet names: the chamber contract gives `inlet` / `outlet`. |
| Solver setup | `scaffoldSolver(viewer, projectId, 'simpleFoam', 'kOmegaSST')` + `syncBoundaryFields merge` + Easy values | Idempotent. |
| Solve | `runs.service.ts:394` `startRun` (`SOLVER_MAX_CONCURRENT_RUNS` per project, global core budget, FIFO lock), `finalizeRun`/`classifyExit` | WS-G adds `converged` via runTimeControl + metrics. |
| Metrics | WS-G `readDiveMetrics` (head loss m, vortex volume m³) | |
| Parameters table | `ChamberConstraint { min?, max?, exact? }` per output (12 outputs, `CHAMBER_OUTPUT_SPECS`), relations (`refine`, `combination`), 50 mm grid for estimates only | An `exact` wins and is not rounded (`chamber-creation.md` §3.3-3.4). |
| DB | SQLite via Prisma 5, `DATABASE_URL=file:./dev.db`; 6 models; no enums, JSON in `String` | `decisions.md` 2026-06-19: SQLite now, Postgres "trivial later". |
| Concurrency | all locks in memory ⇒ **single API instance** (K31) | The loop inherits this; Postgres only matters for multi-instance, not proposed here. |

## 3. Data model (Prisma, migration `<ts>_optimisation_studies`)

```prisma
/// One optimisation study: the base design, the search space, objectives, and the pipeline settings.
model Study {
  id                String   @id @default(cuid())
  name              String                         // 1..120, not unique
  ownerId           String
  owner             User     @relation("StudyOwner", fields: [ownerId], references: [id], onDelete: Cascade)
  projectId         String                         // work project that receives each evaluation's case (one per study, created with it)
  project           Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  baseInput         String                         // JSON ChamberInput (validated by chamberBuildSchema), incl. constraints
  paramSpace        String                         // JSON ParamRange[]: { key, base, min, max, step?, source: 'band'|'table' }
  bandPct           Float    @default(10)          // default ±10 %
  objectives        String                         // JSON: [{ id: 'headLoss', sense: 'min' }, { id: 'vortexVolume', sense: 'min' }]
  weights           String                         // JSON { headLoss: 0.5, vortexVolume: 0.5 } (weighted sum)
  mode              String   @default("weighted")  // 'weighted' | 'pareto'
  sampler           String   @default("tpe")       // 'tpe' | 'nsga2' | 'random'
  seed              Int?
  maxEvaluations    Int      @default(30)
  maxDurationHours  Float?                         // optional wall-clock budget for the whole study
  keepBest          Int      @default(3)           // meshing sessions kept: best K ...
  keepLast          Int      @default(2)           // ... and last N (others deleted after metrics are archived)
  meshingSourceId   String                         // reference meshing session copied for each design (copyFrom)
  bcPlan            String                         // JSON ApplyBoundaryConditionsRequest (objectType 'chamber')
  solverSetup       String                         // JSON { solver, turbulence, cores, easyValues }
  criteria          String                         // JSON ConvergenceCriteria (WS-G) snapshot
  normalisation     String?                        // JSON { headLoss0, vortexVolume0 } from the baseline evaluation
  status            String   @default("draft")     // draft | running | pausing | paused | completed | failed
  reason            String?
  startedAt         DateTime?
  finishedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  evaluations       Evaluation[]
  @@index([ownerId])
  @@index([status])
}

/// One design evaluated by a study (one trial).
model Evaluation {
  id                String   @id @default(cuid())
  studyId           String
  study             Study    @relation(fields: [studyId], references: [id], onDelete: Cascade)
  index             Int                            // 0 = baseline, then 1..n (trial number)
  designParams      String                         // JSON { width: 4150, hMiddle: 820, ... } (mm, the Exact values sent)
  chamberHash       String?
  meshingSessionId  String?
  projectId         String?                        // = study.projectId in v1 (kept for per-evaluation projects later)
  runId             String?                        // Run row of the solve (no FK: runs can be purged with the project)
  headLoss          Float?                         // m
  vortexVolume      Float?                         // m³
  objective         Float?                         // weighted sum (normalised), null in pareto mode
  status            String   @default("pending")   // pending | building | meshing | transferring | configuring | solving | done | infeasible | failed | interrupted
  stage             String?                        // last stage reached (for failed/interrupted)
  refusalReason     String?                        // builder / validation message for infeasible
  runStatus         String?                        // converged | completed | diverged | failed (from Run)
  budgetHit         Boolean  @default(false)       // solve ended on the WS-G time budget (completed): metrics counted, flagged
  warnings          String?                        // JSON: chamber warnings, mesh checkMesh summary
  startedAt         DateTime?
  finishedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([studyId, index])
  @@index([studyId, status])
}
```
Relations to add on `User` (`studies Study[] @relation("StudyOwner")`) and `Project` (`studies Study[]`). Deletion: cascades remove rows; on-disk artefacts (meshing sessions created by the study, archived metrics) need an explicit best-effort cleanup in `deleteUser` / `deleteProject` (playbook `add-prisma-migration.md` step 5). A study still `running` when its project is deleted is stopped first (same as `stopProjectRuns`).

## 4. Search space

- The user **ticks** the parameters to optimise among the **12 outputs** of the Parameters table. X1..X3 and the geometric options (`vaneAngleDeg`, `outletRatio`, `footAngleDeg`, ...) stay as in `baseInput`.
- For each picked key: `base` = the Final of the base design (calculated or set: `computeChamberOutputs(baseInput)` from `@dive/shared`), range = `[base·(1 − band), base·(1 + band)]` **intersected** with the table's Min/Max when present (`source: 'table'` if the table bound is tighter). `band` default 10 %, per-parameter override allowed. An empty intersection is refused at study creation (422).
- A design is sent as **Exact** constraints on the picked keys (other constraints of `baseInput` unchanged). Exact values are not rounded by the model, so the space is discretised in **50 mm steps** (`CHAMBER_GRID_MM`): manufacturable values, and neighbouring trials hit the build cache. Bounds are snapped inward to the grid.
- Relations: picking a key that is the target of an active `combination` relation (e.g. `height = LEB + LEOW`) conflicts with its partners; the creation form warns and proposes to pick independent keys only (or switches the relation off in `baseInput`, explicit).
- Duplicate designs (same `chamberHash` + same meshing source + same BC + same criteria) reuse the previous evaluation's metrics instead of re-solving (`status: done`, `warnings: ["duplicate of #k"]`).

## 5. Objectives and optimiser

- Metrics per evaluation: `headLoss` (m, WS-G, averaged over the last window) and `vortexVolume` (m³, WS-G).
- **Weighted sum (default)**: `J = w_h · headLoss / headLoss₀ + w_v · vortexVolume / vortexVolume₀`, normalised by the **baseline evaluation #0** (the unmodified base design, always evaluated first), weights default 0.5 / 0.5, adjustable at creation. A baseline that is infeasible or failed stops the study (no normalisation possible), with a clear reason.
- **Pareto (optional, `mode: 'pareto'`)**: two objectives, NSGA-II; the UI shows the non-dominated front. Weighted sum stays the default.
- Budget-hit evaluations (`budgetHit`) are counted in the optimiser like converged ones and flagged in the table and charts.
- **Optimiser**: Optuna, **ask/tell** with an **in-memory study rebuilt from the `Evaluation` rows at each step**:
  - `apps/api/scripts/optimiseSuggest.py` (`MESH_PYTHON_BIN` or a dedicated `OPTIM_PYTHON_BIN`; `optuna` added to `requirements.txt`), stdin JSON `{ space, sampler, seed, mode, history: [{ params, values | null, state: 'COMPLETE'|'FAIL'|'PRUNED' }] }` → stdout `OK: {"params": {...}}` / `KO: …` (house contract), run with `execFile` (argv, no shell), timeout 60 s.
  - history replayed via `optuna.trial.create_trial` + `study.add_trial`; sampler `TPESampler(seed, multivariate=True, constant_liar=False)` or `NSGAIISampler`; infeasible designs added as `FAIL` (TPE ignores them) or, better, via a `constraints_func` returning > 0 (supported by TPE and NSGA-II since Optuna 3.x) so the sampler learns the infeasible region.
  - Why not Optuna's RDB storage in the same SQLite: (1) Prisma `migrate dev` detects the foreign tables (`studies`, `trials`, `trial_params`, …) as **drift** and asks to reset the dev database; (2) SQLite has a single writer: Optuna (SQLAlchemy) and Prisma writing the same file concurrently leads to `database is locked` errors unless WAL + busy timeouts are tuned on both sides; (3) two sources of truth for trial state. A **separate** `optuna.db` file would avoid (1) and (2) but not (3). The ask/tell rebuild keeps **Prisma as the single source of truth**, is resumable after a restart for free, and costs milliseconds for ≤ a few hundred trials. Recommended.
- Postgres is only relevant if the API ever runs as several instances (K31: in-memory locks); not proposed here.

## 6. Where the loop runs

| Option | Pros | Cons |
|---|---|---|
| **A. In-process orchestrator in the API** (`modules/studies/studyRunner.ts`), async state machine calling the services directly (not HTTP), Python only for `suggest` (recommended) | Reuses every guard, lock and registry (`withChamberLock`, `activeMeshRuns`, run admission/core budget, `finalizeRun`); one place for cancellation; boot reconciliation like runs/meshing; no new auth | Lives and dies with the API process (mitigated by persisted state + reconciliation); long-running work in the API process, but it only awaits child processes that already run there today |
| B. Standalone Python driver calling the REST API (service account, like `apps/mcp`) | Optuna-native, API untouched | Duplicates polling/orchestration, needs credentials, token refresh, cancellation through the API anyway, two processes to supervise under systemd |
| C. Separate Node worker process | Isolation | Locks and registries are in-memory in the API process (K31): a second process would bypass them. Rejected. |

**Stage machine per evaluation** (each stage persisted in `Evaluation.status` before it starts):
1. `building`: `buildChamber({ ...baseInput, constraints: withExact(designParams) })`; 422 `VALIDATION_ERROR` or the new 422 **`CHAMBER_REFUSED`** (builder `KO:` refusal, see §7) ⇒ `infeasible` + `refusalReason`; 502 `CHAMBER_BUILD_FAILED` (a real crash) ⇒ `failed`.
2. `meshing`: `importChamberIntoMeshing({ mode: 'copyFrom', chamberHash, sourceId: study.meshingSourceId, name: 'study-<slug>-<index>' })`, then `startMeshingRun(sessionId, readConfig(sessionId))`, await terminal `status.json` (internal promise, no HTTP polling); a mesher step failure ⇒ evaluation `failed` (stage `meshing`), no retry. Quality gate: parse the `checkMesh` step of `run.json` ("Mesh OK." vs "Failed N mesh checks."); failed checks ⇒ **`infeasible`** with the failed checks as `refusalReason`, **no retry** (the sampler learns the region as infeasible).
3. `transferring`: WS-F `importMeshFromMeshing(viewer = study owner, projectId, { sessionId, target: 'case' })` (chamber patch types forced).
4. `configuring`: `scaffoldSolver(solverSetup)`, `applyBoundaryConditions(study.bcPlan)` (chamber preset, `inlet`/`outlet`), Easy values, write WS-G `convergence.json` from `study.criteria`.
5. `solving`: `startRun({ cores })`, await `finalizeRun` (hook a completion promise into `runs.service`, e.g. `onRunTerminal(runId)`), `runStatus` stored. `converged` ⇒ read metrics; `completed` (WS-G time budget) ⇒ metrics read and counted, `budgetHit = true`; `diverged`/`failed` ⇒ `failed`.
6. `done`: metrics → `headLoss`, `vortexVolume`, `objective`; archive `postProcessing/dive_*` + key numbers under `STORAGE_DIR/studies/<studyId>/evaluations/<index>/`; then ask Optuna for the next design.

**Concurrency and guards**
- **One study running at a time, globally**: in-memory `activeStudy` + DB check `Study.status in (running, pausing)` under a lock (409 `STUDY_IN_PROGRESS`). One evaluation at a time inside the study.
- The study's project is **locked for manual runs and case mutations** while the study runs: `startRun` from the UI returns 409 `RUN_IN_PROGRESS` naturally during `solving`; for the other stages, add a `studyOwnsProject(projectId)` check to the WS-F route and to BC/merge/reset (small M1-style guard). **One work project per study**: created at study creation (title `Study: <name>`, owner = study owner, collaborators copied from the source project if any), visible in the normal UI.
- Cores: the solve goes through the normal global budget; meshing cores are still outside it (L21), documented.

**Cancellation**
- **Stop = pause.** `POST /studies/:id/stop` ⇒ `pausing`: the runner sets an abort flag, stops the current stage with the existing primitives (`stopMeshingRun`, `stopRun`; a chamber build is not interruptible and simply finishes), marks the in-flight evaluation `interrupted` (not counted by the optimiser, its design is re-proposed first on resume), then the study `paused`. `POST /studies/:id/resume` continues from the Evaluation rows. Ending a study for good = leaving it paused, or deleting it.
- **Boot reconciliation** (`server.ts`, after `reconcileOrphanRuns` / `reconcileOrphanMeshingRuns`): a study left `running`/`pausing` ⇒ `paused` with reason "Interrupted by a server restart"; its in-flight evaluation ⇒ `interrupted` (stage kept). `POST /resume` continues from the Evaluation rows (the optimiser state is rebuilt from them anyway).

**Study budget**: stop after `maxEvaluations` (default 30) evaluations counted (done + infeasible + failed, not interrupted) or when `maxDurationHours` (optional) has elapsed; the current evaluation finishes first, then the study is `completed` with the reason.

**Disk hygiene**: each evaluation creates a meshing session (`study-<slug>-<index>`); keep the **best 3** and the **last 2** (`keepBest`, `keepLast`), delete the others after their metrics are archived. The project case holds only the current evaluation; a "Load evaluation #k into the case" action re-runs WS-F from its session if still present.

## 7. API contract (new module `studies`, all `requireAuth`)

```
GET    /api/v1/studies                          Auth: studies whose project is visible to the viewer   200 { studies }
POST   /api/v1/studies                          Auth + project Visible  body createStudySchema          201 { study }
       422 VALIDATION_ERROR (no parameter ticked, empty range after the band/table/grid intersection, weights not > 0, meshing source not meshed/absent)
GET    /api/v1/studies/:id                      Visible(project)  200 { study, evaluations, best, paretoFront? }
       (Visible = any member of the study's work project; control = owner + super-admin, 403 FORBIDDEN otherwise)
PATCH  /api/v1/studies/:id                      Owner/super-admin, draft only (403 FORBIDDEN, 409 STUDY_NOT_DRAFT)
POST   /api/v1/studies/:id/start                Owner/super-admin  202 { study }   409 STUDY_IN_PROGRESS (another study running)
POST   /api/v1/studies/:id/stop                 Owner/super-admin  200 { study }   idempotent, pauses (running -> pausing -> paused)
POST   /api/v1/studies/:id/resume               Owner/super-admin  202 { study }   409 if not paused
DELETE /api/v1/studies/:id                      Owner/super-admin  204   (stops first; cleans study sessions + archives)
GET    /api/v1/studies/:id/evaluations/:index   Visible(project)   200 { evaluation, metrics }   (metrics series from the archive)
GET    /api/v1/studies/:id/export.csv           Visible(project)   200 text/csv (one row per evaluation)
```
Web: `/studies` list + `/studies/:id` detail (progress, current stage with a link to the live meshing session / run, evaluations table with a "Show values" pattern, objective-vs-evaluation chart, 2-D scatter head loss vs vortex volume with the Pareto front, best design → "Open in Chamber" loads its `ChamberInput`). Creation from the Chamber page ("Optimise this design") prefilling `baseInput`. Navigation entry `Optimisation`. Controls (start, stop, resume, delete, edit draft) shown only to the owner and super-admin; other project members see a read-only page. Skill sequence + design system before any JSX.

## 8. Out of scope

- Multi-instance / Postgres / distributed evaluations (K31).
- Parallel evaluations (several designs solved at once).
- Changing the empirical model, `buildChamber.py`, the meshing pipelines, the BC presets.
- Mesh-independence studies, adaptive meshing per design.
- The semi-spiral tool.
- Surrogate models beyond what Optuna's samplers provide.

## 9. Tests

- API `studies.test.ts`: CRUD + permissions (401, 404 invisible project, read allowed for a project member, 403 for a member on start/stop/resume/delete, super-admin allowed), work project created with the study, search-space computation (band ∩ table Min/Max, 50 mm snapping inward, empty intersection 422),
- API `chamber.test.ts`: builder `KO:` ⇒ 422 `CHAMBER_REFUSED`; crash without `KO:` still 502 `CHAMBER_BUILD_FAILED`; duplicate-hash reuse, `STUDY_IN_PROGRESS`, stop/resume, boot reconciliation.
- API `studyRunner.test.ts` with injected fakes (`setCommandRunner` for the builder and `optimiseSuggest.py`, `setStreamRunner` for meshers and solver writing the artefacts the services check: `chamber.glb` + `trisurface.zip`, `constant/polyMesh/*`, `solver.log` with the runTimeControl message, `postProcessing/dive_*/0/*.dat`): full happy path of 3 evaluations; builder `KO:` (`CHAMBER_REFUSED`) ⇒ `infeasible` then the loop continues; `checkMesh` failed checks ⇒ `infeasible` (no retry); mesher failure ⇒ `failed`; budget-hit run ⇒ `done` + `budgetHit`; baseline infeasible ⇒ study `failed`; `maxEvaluations` and `maxDurationHours` stop; cleanup keeps best 3 + last 2 sessions; divergence ⇒ `failed`; stop during `solving` ⇒ run `stopped`, evaluation `interrupted`, study `paused`; resume re-proposes the interrupted design first.
- Python `apps/api/scripts/tests/test_optimise_suggest.py`: deterministic suggestion with a seed, history replay, constraint handling, NSGA-II mode, `OK:`/`KO:` contract (skipped without `optuna`).
- Web: `StudyCreateForm.test.tsx` (band, table bounds, weights), `StudyPage.test.tsx` (stages, tables, charts' table alternatives).
- ⚠️ To validate on the Debian server: one real 3-evaluation study end to end (CadQuery, snappy/cfMesh, simpleFoam, WS-G function objects), timing per stage.

## 10. Decisions (user, 2026-09-29) and remaining WS-G-dependent items

| # | Topic | Decision |
|---|---|---|
| Q1 | Parameters | The user ticks which of the **12 chamber outputs** to optimise, sent as **Exact**; X1..X3 fixed. |
| Q2 | Discretisation | **50 mm** steps. |
| Q3 | Where evaluations are solved | **One work project per study**, case replaced at each evaluation, metrics archived. |
| Q4 | Objective | **Weighted sum normalised by the baseline design**, 0.5 / 0.5 adjustable; Pareto (NSGA-II) optional. |
| Q5 | Budget-hit runs | Counted, with a `budgetHit` flag. |
| Q6 | Mesh quality | `checkMesh` failed checks = **infeasible**, no retry. |
| Q7 | Refusal detection | New **`CHAMBER_REFUSED`** (422) for builder `KO:` refusals (small change in `chamber.service.ts`, no geometry change, so no cache purge). |
| Q8 | Stop | **Pause / resume**. |
| Q9 | Disk | Keep the meshing sessions of the **best 3 + last 2** evaluations. |
| Q10 | Permissions | Visible to the work project's members; controlled by **owner + super-admin**. |
| Q11 | Budget | **30 evaluations** by default + optional wall-clock budget (`maxDurationHours`). |

**Still placeholders (depend on WS-G, `2026-09-29-solver-convergence-criteria-design.md` OPEN Q1-Q4 and Q6):** the exact definition of `headLoss` (total or static pressure, averaging) and of `vortexVolume` (indicator |ω| or Q, threshold, reference quantities), and the convergence criteria snapshotted into `Study.criteria`. The loop only consumes WS-G's `headLoss` / `vortexVolume` numbers and its `converged` / `completed` status, so these choices do not change this design.

---

# Plan outline (to expand into `brain/plans/2026-09-29-optimisation-loop.md` once the spec is approved)

Prerequisites: **WS-F and WS-G implemented on branch `feat/chamber-v2-cfd-loop`** (WS-F route + patch-type forcing; WS-G criteria, metrics parser, `converged` via runTimeControl), WS-G validated on the Debian server. WS-H work continues on the same branch (or a `feat/` branch cut from it), never on `main`.

1. **Shared contract**: `StudyStatus`, `EvaluationStatus`, `ParamRange`, `StudyObjective`, `CreateStudyRequest`, error codes `STUDY_IN_PROGRESS`, `STUDY_NOT_DRAFT`, `STUDY_NOT_PAUSED`, `CHAMBER_REFUSED`; pure `computeParamSpace(baseInput, keys, bandPct, overrides)` with unit tests. `npm run build:shared`.
2. **Prisma migration** `optimisation_studies` (Study, Evaluation, relations on User/Project); `resetDatabase` in tests deletes `evaluation`, `study` first; deletion paths (`deleteUser`, `deleteProject`) clean study artefacts.
3. **Refusal code** `CHAMBER_REFUSED` in `chamber.service.ts` (`summarizeFailure` `KO:` branch) + `chamber.test.ts` update + web mapping in `ChamberPage` (same message as today).
4. **Run completion hook** in `runs.service.ts` (`awaitRunTerminal(runId)` promise resolved by `finalizeRun`) and meshing equivalent (`awaitMeshingTerminal(sessionId)`), with tests.
5. **`optimiseSuggest.py`** + pytest + `requirements.txt` (`optuna`), env `OPTIM_PYTHON_BIN` / `OPTIMISE_SUGGEST_SCRIPT` / `OPTIM_SUGGEST_TIMEOUT_MS` (playbook `add-env-var.md`, `integrate-external-tool.md`).
6. **`studies` module**: schemas, service (CRUD, permissions, space validation), `studyRunner.ts` (stage machine, abort, archive, duplicate reuse), boot reconciliation in `server.ts`; tests with fakes (red first).
7. **Project lock** while a study runs (WS-F route, BC, merge, reset) + tests.
8. **Web**: API client, hooks (`['studies']`, `['studies', id]`, polling while running), `/studies` and `/studies/:id` pages, creation from Chamber, charts with table alternatives; UI skill sequence first.
9. **MCP tools** (only if asked): `list_studies`, `get_study`, `start_study`, `stop_study`.
10. **Brain**: feature sheet `features/optimisation.md`, `architecture/data-model.md`, `api-routes.md`, `storage-layout.md` (`studies/<id>/…`), `configuration.md`, codemaps, `decisions.md` (ask/tell over RDB storage, in-process orchestrator), changelog.
11. **Server validation** ⚠️: 3-evaluation study end to end on Debian; record timings in the changelog.
