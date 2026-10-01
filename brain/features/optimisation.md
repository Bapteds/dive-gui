# Feature · Optimisation (chamber optimisation loop)

> **Status**: in progress (branch `feat/optimisation-loop`, not merged; OpenFOAM, CadQuery and Optuna side to validate on the Debian server) · **Updated**: 2026-10-01 (Length pickable, spec `2026-10-01-chamber-length-row-design.md`); 2026-09-30
> **Specs**: `brain/specs/2026-09-29-optimisation-loop-design.md` (§0 amendment of 2026-09-30 wins), plan `brain/plans/2026-09-30-optimisation-loop.md` · **Codemaps**: `brain/codemap/api-projects.md` (`modules/studies/*`), `brain/codemap/api-lib.md` (`studyStorage`, `pipelineStages`), `brain/codemap/api-scripts.md` (`optimiseSuggest.py`), `brain/codemap/web-features-projects.md` (`features/optimisation`), `brain/codemap/root-shared-mcp.md` (study contract)

## 1. Purpose

Search chamber geometries that lower the **head loss** and the **vortex metric** of the flow through the chamber, automatically, inside a project: each evaluation builds a design (Chamber Creation builder), meshes it with a reference meshing session, sends the mesh into **this project's case** (WS-F), solves until the WS-G convergence criteria, reads the metrics, and Optuna proposes the next design. Any member who can see the project reads its studies; only the study owner or a super-admin edits, starts, pauses, resumes or deletes one.

## 2. User journey

Project page, tab **Optimisation** (`?view=optimisation`, always enabled).

1. **Empty**: "No optimisation study yet" + `New study`.
2. **New study** (inline form, one orange `Create study`): study name; base design (`Chamber save` or `Chamber of this mesh` when the mesh origin has a chamber build with `input.json`); parameters table (every output except BF1 / BF2 while their BF = LF relation is on and, with the semi-spiral, its derived rows and Length; Length is listed for a non-spiral base since 2026-10-01): tick, base FINAL, optional per-key band, live range "4050 to 4850 mm" (with "(table limit)" when the table Min / Max is tighter; an empty range shows the refusal); global band (±10 % default); relation warnings (e.g. H Kammer with LEOW); objective (Weighted sum with weights, or Pareto front; Vortex metric: Masked Q volume or RMS vorticity); reference meshing session (the mesh origin's by default), solver cores (latest run's), max evaluations (30), max duration (h, optional); Advanced (sampler TPE / NSGA-II / random, seed, keep best / last sessions). Notes when the case solver is not steady incompressible or another study runs. A draft can be edited (`Edit`), not its base.
3. **Study panel**: status badge (Draft, Running, Pausing, Paused, Completed, Failed), base + mode + "k of N evaluations counted", controls (`Start` / `Resume` orange, `Pause`, `Edit` for drafts, `Export CSV`, delete with confirmation); reason line; while running, the current evaluation ("Evaluation #k (baseline)") with the stepper Build → Mesh → Transfer → Configure → Solve, the live meshing session link and "Open the Solver tab"; search space chips; best design (weighted mode) with `Open in Chamber` (loads the design into `/chamber` through the router state); evaluations table (status, parameter values, head loss, picked vortex metric, objective, notes: baseline, best, time budget, refusal reason, duplicate); charts: objective per evaluation (best-so-far line, diamond on the best) and head loss vs vortex with the Pareto front, each with a "Show … values" table. Other members see the same panel without controls.
4. **Studies list** on the left (status + counted / max); the running study is shown by default.
- Layout (2026-09-30 redesign): on large screens the studies list stays in place while the study detail scrolls; the detail opens with a summary strip (evaluations, best objective, lowest head loss and vortex metric vs the baseline), then the evaluation in progress, the best design, the two charts side by side, the evaluations table and the search space. The project tab bar drops its icons below 1280 px so the seven tabs fit on one line.

## 3. Business rules and invariants

- **Work project = this project** (§0 A1): each evaluation replaces the case mesh through WS-F (original case backed up once, chamber patch types forced, BCs of same-name patches kept), then clears the old solution (time dirs > 0, `processor*`, `postProcessing/`) and solves with the study's cores. The project's own solver setup and BCs are used as they are (no BC plan, no scaffold in the loop).
- **Search space** (§4): base = FINAL of the base design; range = [base·(1 − band), base·(1 + band)] ∩ table Min / Max, snapped inward to the 50 mm grid; sent as Exact on the picked keys, other constraints unchanged; X1..X3 fixed. Empty range, no key, BF1 / BF2, weights not > 0 in sum, unknown save, no mesh origin chamber, reference session without a finished mesh and settings ⇒ 422 `VALIDATION_ERROR` at creation.
- **Length** (since 2026-10-01, spec `2026-10-01-chamber-length-row-design.md`): Length is an ordinary output row (`= 2 × B Kammer`, always on), so it is **pickable for a non-spiral base design** like any row: band around its FINAL, table Min / Max, 50 mm grid, sent as a Length Exact. **Not pickable with the semi-spiral** yet (its default is still the spiral's own length; "Length comes from the semi-spiral casing and cannot be optimised."); item 1 of the brief `2026-09-30-chamber-spiral-and-optimisation-fixes.md` lifts that. Picking Length with B Kammer shows the relation warning ("Length = 2 × B Kammer: optimising Length together with B Kammer pins Length by its own value, …"), even with the base's master switch off (the relation is fixed). A study that varies B Kammer without picking Length still moves the default Length (2 × B Kammer). Old base designs carrying `lengthOverride` are normalised (`normaliseChamberLength` in `computeParamSpace` / `chamberInputWithExact`): the old value becomes a Length Exact, its base value in the table, and a picked Length overrides it.
- **Baseline** = evaluation #0 = the unmodified base design, always first. A baseline that is not `done` (or with a non-positive metric) fails the study. Weighted objective J = w_h · headLoss / headLoss₀ + w_v · vortex / vortex₀.
- **Metrics** (§0 A4): dp0 = mean Δp₀ (Pa) over the last `window` iterations of the run (`simplePDrop.window`, `robust.W` for the robust method), from the WS-G monitor lines; headLoss = dp0 / (ρ g) with ρ from the criteria; `maskedQVolume` and `omegaRms` from the WS-G on-demand post-process at the latest time. No Δp₀ samples or a post-process failure ⇒ evaluation `failed`.
- **Criteria** (§0 A5): snapshot of the project's criteria (saved or defaults) at the first start, written back as `cfd-criteria.json` before every solve.
- **Outcomes**: builder refusal (422 `CHAMBER_REFUSED`) or pre-builder refusal (422 `VALIDATION_ERROR`) ⇒ `infeasible`; failed `checkMesh` checks ⇒ `infeasible`, no retry; builder crash, mesher failure, diverged / failed run ⇒ `failed`; `completed` run (time budget) ⇒ `done` + `budgetHit` (counted). A design whose chamber hash was already evaluated (done / infeasible) reuses that result (`duplicate of #k`).
- **Budgets**: before each evaluation, stop when done + infeasible + failed ≥ `maxEvaluations`, or when the evaluations' wall-clock sum ≥ `maxDurationHours` (paused time excluded); the current evaluation always finishes.
- **Pause / resume**: Stop = pause (`running → pausing → paused`), the current meshing run or solver run is stopped (a chamber build or a suggestion finishes first), the evaluation is `interrupted` and re-run in place first on resume. Boot: `running` / `pausing` ⇒ `paused` "Interrupted by a server restart".
- **Locks** (§0 A7): one study running globally (409 `STUDY_IN_PROGRESS`); while it runs its project answers 409 `STUDY_IN_PROGRESS` on manual runs and case / mesh mutations (same routes as `freeSurfaceLock`) and on the free-surface start; a running free-surface job or solver run blocks the start (409 `FREE_SURFACE_IN_PROGRESS` / `RUN_IN_PROGRESS`); the case solver must be steady incompressible (422).
- **Disk hygiene**: after each evaluation, only the meshing sessions of the best `keepBest` (by objective, equal weights in Pareto mode) and the last `keepLast` evaluations are kept; the reference session is never touched. Deleting a study (or its project / owner) removes its sessions and archive.
- **Optimiser**: ask / tell with an in-memory Optuna study rebuilt from the Evaluation rows at every step (Prisma stays the single source of truth); infeasible = COMPLETE with a violated constraint, failed = FAIL, interrupted not replayed; seed offset by the history length. A suggestion failure (e.g. optuna missing) fails the study with its message.

## 4. Technical flow

`OptimisationTab` → `useStudiesQuery` (`['projects', id, 'studies', 'list']`, poll 3 s while one runs), `useStudyQuery` (`…, 'detail', studyId`), `useStudySetupQuery` (`…, 'setup'`), `useChamberSavesQuery` → `lib/api/studies.ts` → `/api/v1/projects/:id/studies[...]` (`studies.controller` → `studies.service`).

Start: `startStudy` checks, claims the global slot (`studyRegistry`), snapshots the criteria, sets `running`, then `studyRunner` loops: budgets → next design (interrupted row, else baseline, else `optimiseSuggest.py` with `STORAGE_DIR/studies/<id>/suggest-request.json`) → `evaluate`: `buildChamber(chamberInputWithExact(base, params))` → `importChamberIntoMeshing({ mode: 'copyFrom', … name: study-<slug>-<index> })` + `startMeshingRun` + `awaitMeshingTerminal` + `failedMeshChecks(mesh.log)` → `sendSessionToCase` + `clearCaseSolution` → `writeProjectCriteria` → `solveCase` (startRun installs the criteria) → `readRunLog` + `parseMonitors` → `computeVortexOnDemand` → `writeEvaluationMetrics` + `archivePostProcessing` → row `done` → normalisation (baseline) → objectives → session cleanup.

Stop: `stopStudy` → `requestStudyAbort` (`stopMeshingRun` / `stopRun`) → the runner marks the evaluation `interrupted` and the study `paused`.

## 5. Data and storage

- Prisma `Study` and `Evaluation` (migration `20260930085427_optimisation_studies`, `brain/architecture/data-model.md`).
- `STORAGE_DIR/studies/<studyId>/`: `suggest-request.json`, `evaluations/<index>/metrics.json` (Δp₀ series downsampled to 500, window, vortex sample), `evaluations/<index>/postProcessing/` (WS-G monitor folders).
- Meshing sessions `study-<slug>-<index>` under `STORAGE_DIR/meshing/`; the project's `cfd-criteria.json` (rewritten with the snapshot) and `mesh-origin.json` (last evaluation).
- In-memory registry of the running study (single API instance, K31).

## 6. Configuration and external dependencies

- `OPTIM_PYTHON_BIN` (empty ⇒ `MESH_PYTHON_BIN`; needs `optuna` ≥ 3.0, in `scripts/requirements.txt`), `OPTIMISE_SUGGEST_SCRIPT` (empty ⇒ bundled), `OPTIM_SUGGEST_TIMEOUT_MS` (60 s).
- The stages use the builder (`CHAMBER_PYTHON_BIN`), the mesher of the reference session, the solver (`OPENFOAM_BASHRC`) and `postProcess` (`POSTPROCESS_TIMEOUT_MS`) with their own settings.
- **To validate on the Debian server**: one real 3-evaluation study end to end (CadQuery build, cfMesh / snappy, simpleFoam with the WS-G function objects, `postProcess -func diveVortexMetrics`), optuna installed for the chosen interpreter, timing per stage; whether ESI v2406 `checkMesh` prints "Failed N mesh checks." with exit 0 or 1 (both handled).

## 7. Tests

- `apps/api/tests/studyModel.test.ts` (9): search space, Exact pinning, relation warnings, objective, Pareto front.
- `apps/api/tests/studies.test.ts` (14): access and permissions, creation and space validation, mesh-origin base and setup, lifecycle guards, CSV and archived metrics, boot reconciliation.
- `apps/api/tests/studyRunner.test.ts` (10): the stage machine with fakes (happy path, refusals, mesh checks, failures, budgets, cleanup, duplicates, pause / resume, locks, suggestion failure).
- `apps/api/tests/chamber.test.ts`: `CHAMBER_REFUSED` (builder and spiral `KO:`), crash still 502.
- `apps/api/scripts/tests/test_optimise_suggest.py` (6, skipped without optuna).
- `apps/web/src/features/optimisation/StudyCreateForm.test.tsx` (5), `StudyPanel.test.tsx` (4); `chamberForm.test.ts` (`chamberBuildErrorMessage`).

## 8. History

- 2026-09-30: created (WS-H), `brain/changelog/2026-09.md`.

## 9. Known limits and bugs

- Evaluations run one at a time in the project's case: the case holds the last evaluation's mesh and solution; the original case is in the mesh backup (WS-F).
- Not implemented yet (out of scope now, §0 A9): "Optimise this design" on the Chamber page, MCP tools; "Load evaluation #k into the case" (spec §6) is not implemented either.
- Meshing cores stay outside the global core budget (L21).
- A chamber build or a suggestion cannot be interrupted: a pause waits for it.

## 10. Changing this feature

- New stage or status: `EVALUATION_STAGES` / `STUDY_STATUSES` in `@dive/shared`, `studyRunner`, the panel's `STAGES` / labels, this sheet.
- A new case-mutating route must get `studyLock()` next to `freeSurfaceLock()`.
- Keep `optimiseSuggest.py` stateless (history in, one design out) and the request contract in sync with `studyRunner.suggestDesign`.
