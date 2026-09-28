# Feature · Boundary conditions (DIVE presets per object type)

> **Status**: in production · **Updated**: 2026-09-28
> **Specs**: none in `brain/specs/`; original CFD contract in `documents/old/{1_turbine_fullMachine,2_pipe,3_draftTube_csvInlet}_BCs_1.txt` and `documents/old/4_turbineChamber_BCs.txt` · **Codemaps**: `brain/codemap/api-projects.md` (`boundary.*`, `mesh.service` for roles), `brain/codemap/api-lib.md` (`openfoamCase` § boundary conditions and rotating machinery, `boundaryData`, `meshBackupStorage`), `brain/codemap/api-scripts.md` (`csv_to_boundaryData.py`), `brain/codemap/web-features-projects.md` (`BoundaryConditionDialog`, `useBoundaryConditions`), `brain/codemap/root-shared-mcp.md` (§ presets and rotor)

## 1. Purpose
Writes in a single pass the inlet / outlet / wall boundary conditions of all `0/` fields of a case, from a DIVE preset chosen by object type (Turbine, Pipe, DraftTube, Chamber) and driving mode (pressure, flow rate, CSV profile). For a turbine, it also writes the rotor dictionary: Frozen Rotor (`constant/MRFProperties`) or Moving Rotor (`constant/dynamicMeshDict`, forced rotation or free 6-DoF rotor driven by the fluid). For a draft tube (DraftTube), it converts a runner-outlet CSV profile into `constant/boundaryData`. The case is backed up before any write.
Access: any visible member of the project; the case must have a mesh.

## 2. User journey
Entry point: Case files → `Boundary conditions` (button visible if the case contains `constant/polyMesh/`), or automatic opening after a case import that wrote a `polyMesh/`. Guided dialog `BoundaryConditionDialog` ("What is this mesh?"), closable at any time except while applying (`Configure later`, Esc).
1. **Type**: `Turbine (full machine)` / `Pipe` / `Draft tube` / `Turbine chamber` (radio cards, navigable with the arrow keys). A single-mode type fixes the mode and skips the next step.
2. **Mode** (Pipe, Chamber): `Pressure-driven` or `Flow-rate-driven`.
3. **Patches**: `Inlet` and `Outlet` (lists from the Visualize manifest); all other patches become walls. Automatic prefill by name (`/inlet|in$/i`, `/outlet|out$/i`, otherwise first and last patch). Blocked if inlet = outlet; empty state if fewer than two patches (pointer to the Visualize split); skeleton and error with retry.
4. **Rotor** (Turbine only): `Frozen Rotor` (MRF) or `Moving Rotor`, then for Moving `Forced` or `Free` (6-DoF).
   - Frozen or Forced: cellZone (default `rotor`), speed with an `rpm` / `rad/s` toggle, axis (default `(0 0 1)`), origin (default `(0 0 0)`); Frozen only: non-rotating patches.
   - Free: moving patches (chips among the walls), axis, center of mass, mass, `rhoInf` (default 1000), moments of inertia, inner / outer distances (0.2 / 0.5), damper (0.85).
   - Callout for Moving: requires `pimpleFoam` and a `cyclicAMI` interface. `Continue` enabled if the axis is non-zero and (Free: patches + mass > 0 + inertias > 0; otherwise: non-empty zone + speed > 0).
5. **Values**: net head H in m (pressure mode, help `p0 = 9.81 x H`), flow rate Q in m³/s (flow-rate mode) or `.csv` file (`Mapped inlet profile (CSV)` mode, Draft tube: columns `x, y, z, Ux, Uy, Uz`, optional `k` / `omega`); turbulence intensity and mixing length prefilled per type.
6. **Run**: "Applying", then report: banner, summary (inlet, outlet, driving, `p0`, rotor, zone, omega), notes (diamond bullets), CSV step report, buttons `Adjust` (back to values), `Open files` (`/projects/:id/edit`), `Close`. Toast `Boundary conditions applied.`; a validation or transport error sends the user back to the Values step with a toast.

Per-patch alternative: in Visualize, `Edit names & types` lets the user give a case patch the `inlet` or `outlet` role (generic preset) or the `wall` type (see `mesh-library-and-conversion.md`).

## 3. Business rules and invariants
- **Allowed modes** (`OBJECT_TYPE_MODES`): turbine `pressure`; pipe `pressure`, `flowRate`; draftTube `csvProfile`; chamber `flowRate`, `pressure`. Any other combination → 422 `INVALID_BC_PLAN`.
- **Validation before writing**: case without `constant/polyMesh/boundary` → 409 `NO_MESH`; inlet, outlet and walls must exist (422 `INVALID_BC_PLAN`); inlet ≠ outlet; `values.head` required in `pressure`, `values.flowRate` in `flowRate`; CSV required in `csvProfile` (422 `BC_CSV_REQUIRED`). Zod schema: positive values, intensity in ]0, 1], non-zero axis, mass and inertias > 0, `movingRotor` + `free` requires `sixDof`.
- **Turbulence defaults** (`OBJECT_TYPE_TURBULENCE`): intensity 5 %, mixing length 0.07, seeds k 0.06 / ω 10 for turbine, pipe and chamber; 8 %, 0.02, 0.1 / 50 for draftTube.
- **Inlet** (`componentInletBc`):
  - `U`: `pressureInletOutletVelocity` in pressure mode; `flowRateInletVelocity` + `volumetricFlowRate constant Q` in flow-rate mode (plus `extrapolateProfile false` for chamber); `timeVaryingMappedFixedValue` in CSV mode.
  - `p`: `totalPressure` with `p0 = GRAVITY × H` (9.81, kinematic pressure) in pressure mode, plus `gamma 1` for turbine and chamber (never for pipe); otherwise `zeroGradient`.
  - `k`: `turbulentIntensityKineticEnergyInlet` (or mapped if the CSV has a k column); `omega`: `turbulentMixingLengthFrequencyInlet` (or mapped); `epsilon`: `turbulentMixingLengthDissipationRateInlet`; other fields: generic inlet preset.
- **Outlet** (`componentOutletBc`): `p` always `fixedValue 0` (single static pressure anchor, never `fixedMeanValue`); `U` `inletOutlet`, except pipe in pressure mode (`pressureInletOutletVelocity`); `k` / `omega` as `inletOutlet` with the type's seed.
- **Walls and wall functions**: each unconstrained wall is set to the geometric type `wall` in `boundary`; in the fields, `U` `noSlip`, `p` `zeroGradient`, and the wall function of the case's turbulence model (`turbulenceWallBc`: `kqRWallFunction`, `omegaWallFunction`, `epsilonWallFunction`, `nutkWallFunction` or `nutUSpaldingWallFunction` without k, compressible `alphat`). A patch with a constraint type (`empty`, `symmetry`, `symmetryPlane`, `wedge`, `cyclic`, `cyclicAMI`, `processor`) keeps its type and its BC reflects that type.
- **Rotor**: `omega` in rad/s (the UI converts rpm with `× π / 30`). Frozen writes `MRFProperties` (block `MRF1`, `nonRotatingPatches`). Forced writes `dynamicMeshDict` `solidBodyMotionFvMesh` + `rotatingMotion`. Free writes `dynamicMotionSolverFvMesh` + `sixDoFRigidBodyMotion` (Newmark, axis and point constraints, `sphericalAngularDamper`, starting at rest, reported `omega` 0). Without `constant/polyMesh/cellZones`, a note reminds the user to create the zone (TopoSet, see `solver-and-runs.md`, or cellZones from an assembly, see `merge-and-assembly.md`).
- **CSV**: a conversion failure does not prevent the application (200 response, `success: true`, `failed` step + "did not complete" note); missing k / omega columns → fallback to the intensity, with a note.
- **Backup**: `ensureOriginalBackup` before the first write (single slot, taken only once).
- **Solver preserved**: missing `0/` fields are created for the `controlDict` solver if it is configurable, otherwise `simpleFoam`; the turbulence model is read from the case (default `kOmegaSST`).

## 4. Technical flow

### Front
`BoundaryConditionDialog` (≈ 20 local states, `@dive/shared` for all label libraries) → `useMeshManifestQuery` (patches) → `handleApply` builds `ApplyBoundaryConditionsRequest` (`values.head` only in pressure mode, `values.flowRate` only in flow-rate mode, `rotor` always present for a turbine) → `useApplyBoundaryConditions(projectId).mutateAsync({ request, csv })` → `lib/api/boundary.ts` → `POST /api/v1/projects/:id/boundary-conditions/apply` as multipart (JSON `payload` field + optional `csv` file).
On success, the hook removes the case manifest, GLB and edges (the `boundary` changes) and invalidates `['projects', id, 'files']` and `['projects', id, 'mesh', 'backup']`.

### Server
`parseBoundaryUpload` (in-memory multer, 1 file ≤ `MAX_UPLOAD_MB`) → `applyBoundaryConditionsController` (`JSON.parse` + `applyBoundaryConditionsSchema`, 422 otherwise) → `boundary.service.applyBoundaryConditions`:
1. `assertProjectVisible`, reading of `boundary` (409 `NO_MESH`).
2. Plan validations (section 3).
3. `ensureOriginalBackup`.
4. `scaffoldSolver(viewer, projectId, caseSolver())` (non-destructive creation of the `0/` fields of the solver and model), then `caseTurbulenceModel`.
5. CSV mode: CSV written to a `dive-bc-*` tmpdir → `lib/boundaryData.convertCsvToBoundaryData(caseDir, csv, inlet)` → `MESH_PYTHON_BIN csv_to_boundaryData.py <csv> <caseDir> <inlet>` (cwd = case) → `constant/boundaryData/<inlet>/{points, 0/U, 0/k?, 0/omega?}`; `mappedFields` detected on disk; tmpdir always deleted.
6. Unconstrained walls retyped to `wall` in `constant/polyMesh/boundary` (`setBoundaryPatchType`).
7. For each case file outside `constant/polyMesh/`, ≤ 2 MB, containing `boundaryField`: `setFieldPatchBc` for inlet (`componentInletBc`), outlet (`componentOutletBc`), walls (`fieldBcBody`).
8. Turbine + rotor: check of `nonRotatingPatches` / `sixDof.patches` (422), cellZones note, writing of `MRFProperties` (`renderMrfProperties`) or `dynamicMeshDict` (`renderDynamicMeshDict` / `renderDynamicMeshDictFree`) + pimpleFoam / cyclicAMI note.
9. Response `{ success: true, applied: { objectType, mode, inlet, outlet, walls, fields, p0?, rotor? }, csvSteps, notes }`.

### Inlet / outlet roles in Visualize
`EditPatchesDialog` → `PUT /projects/:id/mesh/patches` → `mesh.service.editMeshPatches`: a role keeps the geometric type `patch` and sets `fieldBcBody(field, role)` (generic preset: `U` `fixedValue` 0 and `p` `zeroGradient` at the inlet, `p` `fixedValue` 0 and `inletOutlet` at the outlet), without component preset or rotor.

### Links with the rest
- `POST /files/sync-boundaries` (`merge` mode) preserves these BCs when the solver or a template realigns the fields (fix of 2026-07-06).
- `scaffoldSolver` refreshes the wall functions and carries the mixing-length inlet over between `omega` and `epsilon` when the model changes (see `solver-and-runs.md`).

## 5. Data and storage
No Prisma model. Files written under `<STORAGE_DIR>/projects/<id>/case/`: `constant/polyMesh/boundary` (`wall` types), all fields carrying a `boundaryField` (including `0/*`, and also `0.orig/*` and any existing time directories), `constant/MRFProperties` or `constant/dynamicMeshDict`, `constant/boundaryData/<inlet>/`. `backups/` slot filled on the first application. The CSV passes through `os.tmpdir()` and is not kept.

## 6. Configuration and external dependencies
- `MESH_PYTHON_BIN` (standard library only for this script), `CSV_TO_BOUNDARY_DATA_SCRIPT` (otherwise `apps/api/scripts/csv_to_boundaryData.py`), `CSV_TO_BOUNDARY_TIMEOUT_MS` (10 min), `MAX_UPLOAD_MB`. Missing interpreter: CSV step `failed`, BCs applied anyway.
- No OpenFOAM tool is launched by this feature. The Moving Rotor only has an effect with `pimpleFoam` and a `cyclicAMI` interface (not checked by the server, just a note).
- Shared constant `GRAVITY = 9.81`.

## 7. Tests
- API `boundary.test.ts`: pure renderers (`totalPressure` and `p0 = 490.5` for H = 50, `gamma` depending on type, `flowRateInletVelocity` and `extrapolateProfile`, `timeVaryingMappedFixedValue`, k mapped only if there is a column, intensity 0.08 versus 0.05, outlet `fixedValue` anchor, k-epsilon model, wall `fieldBcBody`, `renderMrfProperties`, `renderDynamicMeshDict`, `renderDynamicMeshDictFree`); endpoint (401, 409, turbine preset with a single anchor and retyped walls, Frozen / Moving / Free, 422 `INVALID_BC_PLAN` and `BC_CSV_REQUIRED`, `symmetryPlane` preserved, successful CSV and failed CSV).
- API `mesh.test.ts`: `inlet` / `outlet` roles and switch to `wall` via Visualize; `openfoamCase.test.ts`: wall functions per model.
- Web `BoundaryConditionDialog.test.tsx`: turbine (mode step skipped, patches prefilled, default rotor, `omega = 600 × π / 30`), free Moving Rotor (`sixDof`), mode step for Pipe.

## 8. History
- 2026-07-03: automatic wall functions and model-driven `0/` fields; inlet / outlet roles in Visualize (`brain/changelog/2026-07.md`).
- 2026-07-06: Slices A to F (shared contract, per-component renderers, service + endpoint, bundling of `csv_to_boundaryData.py`, overlay, tests); boundary synchronization switched to `merge` mode so as to stop overwriting inlet / outlet (`2026-07.md`).
- 2026-07-07: Frozen Rotor / Moving Rotor; Forced / Free Moving variant (sixDoF); fixes (outlet `p` `fixedValue`, constraint patches preserved, `dynamicMeshDict` aligned with the template); mixing-length inlet carried over on k-ω / k-ε change (`2026-07.md`).
- 2026-07-09: dialog scrolling with many patches (`2026-07.md`).

## 9. Known limits and bugs
- M1: no "active run" guard.
- M7: the rotor patches (`nonRotatingPatches`, `sixDof.patches`) are validated AFTER `boundary` and the fields have been written; a 422 leaves the case partially modified (the backup allows a restore, unless it has been overwritten).
- M8: `csv_to_boundaryData.py` can write corrupted output and exit with 0 (short rows, empty CSV, Excel BOM).
- K15: success toast and report title without reading `result.success`; `CsvReport` shows "OK" for a `skipped` step.
- K25: hard-coded `rounded-[6px]` and `text-white` in the dialog; the help shows a hard-coded "9.81" instead of `GRAVITY`.
- K10: `csv_to_boundaryData.py` outside the `OK:` / `KO:` contract.
- L8: `fmtFoamNumber` flattens |x| < 5e-7 to 0 (rotor axes and origins).
- Findings of this sheet (code reading, not reproduced): switching from Frozen to Moving Rotor (or the reverse) does not delete the previous dictionary, so `MRFProperties` and `dynamicMeshDict` can coexist; the BC rewrite touches every file with a `boundaryField` outside `polyMesh`, including `0.orig/` and already solved time directories; in Free mode, the entered cellZone is not used by `renderDynamicMeshDictFree` but still appears in the report.

## 10. Changing this feature
- The presets live in `openfoamCase.ts` (`componentInletBc`, `componentOutletBc`, `fieldBcBody`) and their defaults in `packages/shared` (`OBJECT_TYPE_MODES`, `OBJECT_TYPE_TURBULENCE`, `GRAVITY`): `npm run build:shared` after modification, and update the exact strings in `boundary.test.ts`.
- A new object type or mode requires touching together `packages/shared` (lists + label libraries), `boundary.schemas.ts`, `boundary.service.ts`, `openfoamCase.ts`, the dialog (radio order read from `OBJECT_TYPE_LIBRARY`, locked by the web test) and the tests.
- To fix M7, move the rotor patch validation together with the other validations, before `ensureOriginalBackup`.
- Any new write of `boundary` must purge the case's 3D render on the front (manifest, GLB, edges).
