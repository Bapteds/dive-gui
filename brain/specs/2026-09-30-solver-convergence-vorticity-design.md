# Solver convergence criteria + vortex metrics (WS-G) — design

**Date:** 2026-09-30
**Status:** approved (user decisions 2026-09-30, see §9)
**Replaces:** the uncommitted WS-G draft of 2026-09-29 (`2026-09-29-solver-convergence-criteria-design.md` cited by the WS-H spec never landed in the repository; this file is its replacement).
**Feature:** `brain/features/solver-and-runs.md` (Solver tab of a project).
**Sources (user tools, stored in `documents/Tools/`):** `ConvergenceFunctions/` (`SimplePDropConvergence`, `convergenceControl`, `pressureLossMonitors`, `plotConvergence.py`), `VorticityFunction/` (`postVorticity.sh`, Q-core RMS method: `vorticityRMSFields`, `topoSetDict.vorticityRMS`, `vorticityRMSMetric`, `calculateVorticityRMS.py`).
**Scope:** shared contract + API (pure renderers, a `criteria` sub-module of `projects`, parsers, run classification) + web (Solver tab panel + charts) + tests. No change to meshing, chamber, BC presets.

---

## 1. Goal

1. The user picks a **convergence criterion** for the project's solver runs, with adjustable settings, from the Solver tab. The run stops by itself when the criterion is met and is reported `converged`.
2. The **pressure drop Δp₀** (flux-weighted total pressure inlet − outlet, the quantity both criteria judge) and the criterion's progress are **plotted live** in the Solver tab next to the residuals.
3. **Vortex metrics** are computed during the run (every N iterations) and on demand at the latest time, and plotted in the Solver tab:
   - **masked Q volume** (m³): volume of the cells with Q > Q_threshold farther than d from any wall (`postVorticity.sh`);
   - **RMS vorticity in the Q-core** (1/s): √(∫|ω|² dV / ∫dV) over the cells with Q ≥ Q_crit and V > V_min (VorticityFunction README).
4. These numbers (head loss, both vortex metrics) are what the optimisation loop (WS-H) consumes.

## 2. Criteria (from the user's tools, unchanged maths)

| Method (`method`) | Stop rule | Settings (default) |
|---|---|---|
| `simplePDrop` **(default)** | Δp₀ within ±`devTol` (relative) of the trailing `window` mean for `nPass` consecutive iterations | `window` 100, `devTol` 0.03, `nPass` 100 |
| `robust` | every `W` iterations: \|mean(last W) − mean(prev W)\| ≤ `tolMean` AND \|LS slope(last W)\|·(W−1) ≤ `tolMean` AND max initial residual in the window ≤ `resTol`, for `K` consecutive checks | `W` 100, `tolMean` 50 Pa, `K` 2, `resTol` 1e-3 |
| `residuals` | OpenFOAM `residualControl` only (today's behaviour) | none (edited in `fvSolution` as today) |

Common settings: `inletPatch`, `outletPatch` (defaults: patches named `inlet` / `outlet` when present, else the first two `patch`-type patches; validated against `constant/polyMesh/boundary`), `rho` 1000 kg/m³ (the monitors' `rhoInf`, used for Pa and head).

Rules taken from the tool README:
- `robust` needs the `residualControl` block **disabled** in `system/fvSolution` (otherwise the solver stops on residuals alone). DIVE comments it out with a marker (`/* DIVE convergence: residualControl disabled (robust criterion) … */`) and restores it verbatim when another method is picked. `simplePDrop` keeps `residualControl` (it has no residual gate; whichever fires first stops the run).
- The `resTol` caveat of the README is shown as help text under the field ("Set it just above your case's residual floor, read on the residual chart; below it the run rides to endTime").
- The coded function objects compile on the first iteration (about 1 to 2 min, `gcc`/`wmake` present on the server).

## 3. Vortex metrics (from the user's tools)

One DIVE coded function object `diveVortexMetrics` (file `system/diveVortexMetrics`) reproduces both tools in one pass, on any OpenFOAM version that has `coded` function objects (the tools target v2606, the API runs v2406: the `volFieldValue` `cellZone` shortcut of `vorticityRMSMetric` is v2606-only, so the maths is done in the coded FO instead of topoSet + volFieldValue):
- `gradU = fvc::grad(U)`, `Ω = skew(gradU)`, `S = symm(gradU)`, `Q = 0.5(|Ω|² − |S|²)` (the `Q` function object's definition), `ω = curl(U)` (`fvc::curl`), `y = wallDist::New(mesh).y()` (meshWave, as in `postVorticity.sh`), `V = mesh.V()`.
- `qVolume = Σ V [Q > qThreshold]`, `maskedQVolume = Σ V [Q > qThreshold ∧ y > wallDistance]` (the `postVorticity.sh` print), `coreVolume = Σ V [Q ≥ qCrit ∧ V > vMin]`, `coreCells`, `omegaRms = √(Σ |ω|² V / coreVolume)` over the same cells (0 when the core is empty). All sums `gSum`/`reduce` (parallel-safe).
- Executed every `interval` iterations (default 50) and at write times; prints one log line
  `diveVortexMetrics: time=<t> qVolume=<m3> maskedQVolume=<m3> omegaRms=<1/s> coreVolume=<m3> coreCells=<n>` and appends the same row to `postProcessing/diveVortexMetrics/<startTime>/vortexMetrics.dat`.
- At write times, when `writeFields` is on (default on), writes `Q`, `vorticity`, `wallDistance` and `Qfiltered` (= Q where y > wallDistance, else 0) into the time directory, like `postVorticity.sh`, for the Visualize tab / ParaView.

Settings (defaults): `enabled` true, `velocityField` `U` (`Urel` allowed: "use the same field for Q and ω", README), `qThreshold` 5 1/s², `wallDistance` 0.03 m, `qCrit` 5 1/s² (README: pick it per operating point and keep it for every variant), `vMin` 0 m³ (0 = no volume filter), `interval` 50, `writeFields` true.

**On demand** ("Compute at latest time" button, and used by WS-H at the end of each evaluation): `postProcess -case <dir> -latestTime` with the same FO included (it runs its write step once), parsed from the command output. Refused with 409 `RUN_IN_PROGRESS` while a run is active.

## 4. How it is wired into the case

- Settings are stored per project in `STORAGE_DIR/projects/<id>/cfd-criteria.json` (outside `case/`, so a case reset does not lose them; absent = defaults). Shape `CfdCriteriaSettings` in `@dive/shared`:
  `{ convergence: { method, inletPatch, outletPatch, rho, simplePDrop: {...}, robust: {...} }, vortex: {...} }`.
- **Install** = write `system/pressureLossMonitors` (always, when the method is not `residuals`, or when vortex metrics are on: Δp₀ is also plotted then), `system/SimplePDropConvergence` or `system/convergenceControl`, `system/diveVortexMetrics`, and set the managed `#include` lines inside `functions { }` of `system/controlDict` (created if missing; unrelated entries untouched; includes of the unused files removed). Rendering is pure (`lib/cfdCriteria.ts`), from templates identical to the user's files with the USER INPUTS substituted.
- Install happens on **save** (`PUT`) and again **at every run start** (`startRun`, before the solver spawns), because a scaffold / solver change rewrites `controlDict` and would drop the includes. A failing install at run start fails the start with 422 `CRITERIA_INVALID` (e.g. a patch that no longer exists) rather than running without criteria.
- Only for solvers whose `SOLVER_CATALOG` regime is `steady` and family `incompressible` (the tools are simpleFoam tools: kinematic p × rho). For other solvers the panel shows "Convergence criteria apply to steady incompressible solvers (simpleFoam)." and nothing is installed.

## 5. Run classification and live data

- `residualParser` gains two convergence banners: `SimplePDropConvergence: CONVERGED` and `convergenceControl: CONVERGED`. `classifyExit`: exit 0 + banner ⇒ `converged` with reason "Pressure drop converged (<method>)." (the residual banner keeps its current text).
- New pure parser `lib/monitorParser.ts` reads the solver log (same bounded read as the residuals):
  - the `surfaceFieldValue <name> write:` blocks of `inlet_p0_flux` / `outlet_p0_flux` (`weightedAverage(...) of pTotal = v`) ⇒ `pressureDrop: { time, dp0 }[]` (Pa), one per iteration;
  - `SimplePDropConvergence: dp0 = …, mean = …, dev = … %, consecutive = a/b` ⇒ latest progress `{ method: 'simplePDrop', consecutive, required, devPct }`;
  - `convergenceControl @ t: drift=… trend=… maxRes=… [mean:y slope:n res:y] pass p/K` ⇒ latest check `{ method: 'robust', drift, trend, maxRes, passes, required, gates }`;
  - `diveVortexMetrics: …` ⇒ `vortex: { time, qVolume, maskedQVolume, omegaRms, coreVolume, coreCells }[]`.
  Parsed with tolerant regexes (v2406 vs v2606 wording of the `surfaceFieldValue` lines is **to validate on the server**); downsampled like the residuals (4 000 points).
- `GET /runs/:runId/log` payload gains `monitors: { pressureDrop, criterion, vortex }` (empty arrays / null when absent). No new polling: the Solver tab already polls this endpoint every 1.2 s while a run is active.
- Head loss shown as Δp₀ (Pa) and **H = Δp₀ / (ρ g)** in m (g = `GRAVITY`, 9.81).

## 6. API

```
GET  /api/v1/projects/:id/criteria            Visible   200 { criteria: CfdCriteriaSettings, patches: string[], applicable: boolean, installed: boolean }
PUT  /api/v1/projects/:id/criteria            Visible   body cfdCriteriaSchema   200 { criteria, installed }
       409 RUN_IN_PROGRESS (a run is active: the case must not change under the solver), 422 CRITERIA_INVALID (unknown patch, inlet = outlet)
POST /api/v1/projects/:id/criteria/vortex     Visible   200 { vortex: VortexMetricsSample }   (postProcess at the latest time)
       409 RUN_IN_PROGRESS, 409 NO_RESULTS (no time directory > 0), 502 POSTPROCESS_FAILED (tool failed: last log lines)
```
New error codes in `SERVER_ERROR_CODES`: `CRITERIA_INVALID`, `NO_RESULTS`, `POSTPROCESS_FAILED`. Timeout of the on-demand post-process: new env `POSTPROCESS_TIMEOUT_MS` (default 30 min).

## 7. Web (Solver tab)

- `SolverConfigPanel` gets a **Convergence** section (collapsible, below the run controls): method radio (`Pressure drop, simple (default)`, `Pressure drop, robust`, `Residuals only`), the method's fields with units and help text, inlet / outlet patch selects, then **Vortex metrics** (toggle + fields). One `Save criteria` button (secondary; the zone's single CTA stays `Run solver`). Locked while a run is active, like every edit.
- `LiveRun` gains two charts under the residual chart, same SVG style as `ResidualChart`, each with a "Show values" table alternative:
  - **Pressure drop**: Δp₀ per iteration + trailing mean (window of the criterion) + for `simplePDrop` the ±devTol band around the mean; header line with the latest Δp₀ (Pa and m) and the criterion progress ("34 / 100 consecutive iterations within ±3 %", or "Check 1 / 2: drift 12 Pa, trend 40 Pa, max residual 8e-4"); a "Last 500 iterations" zoom toggle.
  - **Vortex metrics**: masked Q volume (m³) and RMS vorticity (1/s) on two Y axes, latest values in the header; `Compute at latest time` button on a terminal run.
- UI skill sequence and `brain/design/design-system.md` before any JSX.

## 8. Out of scope

- A vortex-based stop rule (the vortex metrics are tracked, plotted and reported, never stop the run).
- Transient solvers, compressible solvers.
- Cp / pressure recovery footer of `plotConvergence.py`.
- MCP tools.

## 9. Decisions (user, 2026-09-30)

| # | Topic | Decision |
|---|---|---|
| G1 | Default criterion | `SimplePDropConvergence` (robust selectable). |
| G2 | Vortex metric for optimisation | Both are computed; the **study picks** which one enters its objective (WS-H). |
| G3 | Where | Solver tab of the project. |

## 10. Tests

- API `cfdCriteria.test.ts` (pure): renderers match the user's templates with substituted inputs; `setManagedIncludes` adds / removes only the managed includes, creates `functions {}`, is idempotent; `disableResidualControl` / `restoreResidualControl` round-trip.
- API `monitorParser.test.ts`: sample v2406-style log with monitors, both FO progress lines, vortex lines, garbage lines.
- API `residualParser.test.ts`: new banners ⇒ `converged`.
- API `criteria.test.ts` (supertest): GET defaults + patches, PUT validation (unknown patch 422, run active 409), files written and includes set, run start re-installs after a scaffold, non-applicable solver, vortex on demand with a fake `setCommandRunner` (NO_RESULTS, success, tool failure 502).
- API `runs.test.ts`: `classifyExit` with the FO banner ⇒ `converged` + reason; log payload carries `monitors`.
- Web: `ConvergenceSettings.test.tsx`, `PressureDropChart.test.tsx`, `VortexChart.test.tsx`, `SolverTab.test.tsx` (sections present, locked while running).
- ⚠️ To validate on the Debian server: the coded FOs compile and run on v2406 (serial and MPI), the log wording of `surfaceFieldValue`, `postProcess -latestTime` with the vortex FO.
