# Chamber optimisation loop (WS-H) · implementation plan

> **Spec:** `brain/specs/2026-09-29-optimisation-loop-design.md`, **§0 amendment (2026-09-30) wins** over the older sections.
> **Branch:** `feat/optimisation-loop` (from `main` `5721c0f`, WS-G + WS-I merged). Not merged, not pushed.
> **Models to copy:** WS-I free-surface job (`modules/projects/freeSurface.service.ts`: in-memory registry, project lock middleware, state persisted before each stage, boot reconciliation, Windows-safe JSON rewrite) and `lib/pipelineStages.ts`.

## Goal

A project tab **Optimisation** that runs an optimisation study on the project itself: each evaluation builds a chamber design (Exact values on the ticked Parameters-table outputs, 50 mm grid, band ±10 % ∩ table Min/Max), meshes it with a copy of the reference meshing session, sends the mesh into the project case (WS-F), solves until the WS-G criteria, reads the head loss and the vortex metrics, and asks Optuna (ask/tell rebuilt from the Evaluation rows) for the next design.

## Decisions fixed by §0 (recap)

- Study.projectId = the project it was created in (no project creation). Routes `/api/v1/projects/:id/studies[...]`; visibility = the project's; control (edit, start, stop, resume, delete) = study owner + super-admin (403 otherwise).
- Base design: a `ChamberSave.snapshot`, or the chamber of the project's mesh origin (`mesh-origin.json.chamberHash` → `STORAGE_DIR/chamber/<hash>/input.json`).
- Reference meshing session: the mesh origin's session by default, else picked among meshed sessions.
- Metrics: `dp0` (Pa) = mean Δp₀ over the last `window` iterations of the run (`simplePDrop.window`, or `robust.W` for the robust criterion), `headLoss` (m) = dp0 / (ρ g); vortex = `maskedQVolume` and `omegaRms` from the WS-G on-demand post-process at the latest time; `Study.vortexMetric` picks the one in the objective (default `maskedQVolume`).
- `Study.criteria` = snapshot of the project's `cfd-criteria.json` (saved or resolved defaults) at study start, re-installed (written back to `cfd-criteria.json`) before each solve.
- Locks: running study ⇒ 409 `STUDY_IN_PROGRESS` on manual runs, case / mesh mutations (same routes as `freeSurfaceLock`) and free-surface start; running free-surface job ⇒ study start 409 `FREE_SURFACE_IN_PROGRESS`; one study running globally.
- Out of scope: "Optimise this design" on the Chamber page, MCP tools.

## Simplifications where §0 leaves the old sections moot (to report)

- No `bcPlan` / scaffold in the loop: the project's case keeps its own solver setup and BCs (WS-F keeps BCs of same-name patches, like WS-I). `solverSetup` holds `{ cores }` only. A start requires the case solver to be steady incompressible (criteria applicable), else 422.
- An interrupted evaluation is re-run **in place** (same row, same index) on resume: its design is re-proposed first and indexes stay dense.
- Infeasible designs replay into Optuna as COMPLETE trials with a violated constraint (`constraints_func`), failed ones as FAIL; interrupted ones are not replayed.
- `maxDurationHours` counts the evaluation wall-clock time (sum of `finishedAt − startedAt`), so a paused period does not consume it.

## Tasks

1. **Shared contract** (`packages/shared/src/index.ts`): `STUDY_STATUSES`, `EVALUATION_STATUSES`, `EVALUATION_STAGES`, `STUDY_MODES`, `STUDY_SAMPLERS`, `STUDY_VORTEX_METRICS`, `STUDY_DEFAULTS`, types `ParamRange`, `StudyWeights`, `PublicStudy`, `StudyEvaluation`, `StudyDetail`, `StudySetup`, `CreateStudyRequest`; pure `computeParamSpace`, `chamberInputWithExact`, `studyRelationWarnings`, `weightedObjective`, `paretoFront`; error codes `STUDY_IN_PROGRESS`, `STUDY_NOT_DRAFT`, `STUDY_NOT_PAUSED`, `CHAMBER_REFUSED`. Unit tests in `apps/api/tests/studyModel.test.ts`. `npm run build:shared`.
2. **Prisma migration** `optimisation_studies`: `Study`, `Evaluation` (+ relations on `User`, `Project`); `resetDatabase` deletes `evaluation`, `study` first.
3. **`CHAMBER_REFUSED`**: `buildChamber` (and the semi-spiral designer step) answers 422 `CHAMBER_REFUSED` when the tool printed a `KO:` refusal; a crash without `KO:` stays 502 `CHAMBER_BUILD_FAILED`. `chamber.test.ts` updated; web `ChamberPage` shows the message (test).
4. **`optimiseSuggest.py`** (stdin JSON → `OK: {"params": …}` / `KO: …`), pytest `test_optimise_suggest.py` (skipped without optuna), `requirements.txt` gets `optuna`; env `OPTIM_PYTHON_BIN` (empty ⇒ `MESH_PYTHON_BIN`), `OPTIMISE_SUGGEST_SCRIPT`, `OPTIM_SUGGEST_TIMEOUT_MS` (60 s) in `env.ts` + `.env.example`.
5. **Tests first** (red): `apps/api/tests/studies.test.ts` (CRUD, permissions, setup endpoint, search-space validation, locks, CSV, reconciliation) and `apps/api/tests/studyRunner.test.ts` (fakes: command runner for the builder + `optimiseSuggest.py` + `postProcess`; stream runner for cartesianMesh / checkMesh / simpleFoam writing the artefacts). Commit `test(optimisation): …`.
6. **`studies` module**: `studies.schemas.ts`, `studies.service.ts` (CRUD, permissions, base resolution, space validation, start / stop / resume / delete, evaluation read, CSV), `studyRunner.ts` (stage machine, abort, metrics, archive, duplicate reuse, disk hygiene, boot reconciliation), `studyRegistry.ts` (in-memory active study, lock middleware), `studies.controller.ts`, routes wired in `projects.routes.ts`; `lib/studyStorage.ts` (archives under `STORAGE_DIR/studies/<studyId>/`); `pipelineStages.clearCaseSolution` (moved from the free-surface service, shared); `criteria.service.writeProjectCriteria` / `resolveProjectCriteria`; `server.ts` reconciliation; deletion paths (`deleteProject`, `deleteUser`) stop the study and remove its sessions + archive.
7. **Project lock**: `studyLock()` next to every `freeSurfaceLock()`; free-surface start 409 `STUDY_IN_PROGRESS`.
8. **Web** (after the UI skill sequence): `lib/api/studies.ts`, `features/optimisation/` (`OptimisationTab`, `StudyCreateForm`, `StudyPanel`, `EvaluationsTable`, `ObjectiveChart`, `ParetoChart`, `useStudies`), `ProjectDetailPage` view `optimisation`; charts hand-made SVG with a table alternative; "Open in Chamber" for the best design (router state read by `ChamberPage`). Tests `StudyCreateForm.test.tsx`, `StudyPanel.test.tsx`.
9. **Brain**: changelog, `features/optimisation.md` (+ README line), `features/projects.md` tab table, architecture (`api-routes`, `data-model`, `storage-layout`, `configuration`), codemaps, `decisions.md` (only new choices), `python brain/codemap/build-index.py`.
10. **Verify**: studies, studyRunner, studyModel, chamber, runs, criteria, freeSurface, pipelineStages suites; pytest; web vitest; typecheck; lint.

## To validate on the Debian server

One real 3-evaluation study end to end (CadQuery build, snappy / cfMesh, simpleFoam with the WS-G function objects, `postProcess -func diveVortexMetrics`), Optuna installed in the chosen interpreter, timing per stage.
