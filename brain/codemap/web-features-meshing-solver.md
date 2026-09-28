# Codemap: Web: meshing + solver features

> Scope: `apps/web/src/features/meshing/**`, `apps/web/src/features/solver/**` · Updated: 2026-09-28

## Overview
Two independent front-end features that share the same "background job + polling" model.
**Meshing**: standalone mesh sessions (engine `snappy` or `cfmesh`, fixed at creation). `useMeshing.ts` holds all the TanStack Query hooks (keys under `['meshing', ...]`, endpoints `/meshing/*`). The pages `apps/web/src/pages/MeshingPage.tsx` and `MeshingSessionPage.tsx` (out of scope) orchestrate: STL/FMS upload, config form (`SnappyConfigForm` or `CfMeshConfigForm`, autosave debounced 800 ms), run launch, live log (via `RunLog` from the solver feature), then 3D preview (`StlViewer` before meshing, `MeshResultViewer` after).
**Solver**: the "Solver" tab of a project (`SolverTab`, lazy-loaded by `ProjectDetailPage`). Flow: `useRunnableQuery` decides between the setup wizard (`SolverSetupWizard`: solver, turbulence, then the `SolverFilesStep` file editor), the "not runnable" gate, or the runnable panel (`SolverConfigPanel` + live run with `ResidualChart`/`RunLog` + `RunHistory`). Runs are polled every 1,200 ms while active (`useRuns.ts`, keys under `['projects', id, ...]`).
Two project tools also live in `solver/` but are mounted by `features/projects/CaseFilesSection.tsx`: `TopoSetDialog` (writes `system/topoSetDict`) and `TurbulenceCalculatorDialog` (k/epsilon/omega seeds).
Case file edits go through `features/projects/useCaseFiles` + `features/projects/foamModel` (splicing a value into the OpenFOAM dictionary while preserving the rest).

## `apps/web/src/features/meshing/CfMeshConfigForm.perPatch.test.tsx`
**Covers**: the tri-state semantics of per-patch layers in `CfMeshConfigForm` (unchecked: `noLayerPatches`; checked without Customize: nothing, mirror of the global block; Customize: a `perPatch` entry), the read-only display of "live" global values on a mirror row, seeding Customize from the current globals, `Reset to global`, re-seeding from a saved config (identical round trip), and per-patch local refinement (`localRefinement` only for checked patches with a positive size, map omitted otherwise, re-seed of a saved value).
**Technique**: Vitest + Testing Library, direct component render (no QueryClient), `onGenerate` as `vi.fn()`; the assertion targets the last `CfMeshConfig` object passed to `onGenerate` (same payload as the autosave). Fixture: patches `inlet` (`patch`) and `walls` (`wall`), unit cube bounds, `maxCores=8`.
**Notable cases**: the patch checkboxes exist twice (refinement fieldset and layers fieldset), hence scoping via `within(getByRole('group', { name: 'Per-patch layers' }))`. A customized row no longer follows a later global edit.

## `apps/web/src/features/meshing/CfMeshConfigForm.tsx`
**Role**: form for the cfMesh (`cartesianMesh`) parameters of a session. Sizes in absolute meters, no domain type or keep-point, extraction of STL sharp edges to FMS, cfMesh layers (`thicknessRatio` / `maxFirstLayerThickness`), `cores` = OpenMP threads. Same UX contract as `SnappyConfigForm`: seeded from `initialConfig` on mount only, debounced autosave. Mounted by `MeshingSessionPage` for a `cfmesh` session.
**Exports**:
- `CfMeshConfigForm` (props: `stls: StlFile[]`, `bounds: MeshBounds | null`, `patches: MeshingPatch[]` (patches discovered in the surface), `disabled`, `running`, `initialConfig: CfMeshConfig | null`, `maxCores`, `onGenerate(config)`, `onConfigChange?(config)`). State: sizes `maxCellSize` / `minCellSize` / `boundaryCellSize` (strings), `extractFeatures`, `featureAngle`, global layers (`layersOn`, `nLayers`, `thicknessRatio`, `maxFirstLayer`), `cores`, per-patch maps (`patchTypes`, `patchRefineOn`, `patchRefine`, `patchLayers`, `patchLayerEnabled`, `patchLayerCustom`), `advancedOpen`. Renders: base size ("Auto: diag/40" helper), "Extract feature edges" checkbox + angle (hidden if a `.fms` is present), "Boundary types" editor (one `PatchTypeSelect` per patch), Advanced disclosure (min/boundary cell size, per-patch local refinement, cores, global layers + "Per-patch layers" with `Customize` / `Reset to global` buttons), orange CTA `Generate mesh` (`loading={running}`).
- `default`: same component.
- Internal helpers: `seedPatchType` (saved choice, otherwise the FMS type if it is in `CFMESH_PATCH_TYPES`, otherwise `wall`), `seedPatchLayers`, `fmt`, `diagonalOf`, `clampCores`, `defaultCores` (half the budget, at least 1), `parseSize` (positive otherwise `null`), `PatchTypeSelect` (`NativeSelect` over `CFMESH_PATCH_TYPES`).
**Depends on**: `@/components/ui/{native-select,button,field,input}`, `CFMESH_PATCH_TYPES` / `DEFAULT_CFMESH_CONFIG` from `@/lib/api/types`. **Used by**: `pages/MeshingSessionPage.tsx`, test `CfMeshConfigForm.perPatch.test.tsx`.
**Notes**:
- `needsCellSize`: without `bounds` (FMS input) a base size is mandatory, otherwise an inline error and a disabled CTA (`canSubmit = !disabled && !running && !needsCellSize`).
- `config` assembled in `useMemo`: every discovered patch is sent with its resolved type (no accidental `empty`, `empty` is never a default). `perPatch`, `noLayerPatches`, `patchTypes`, `localRefinement` are `undefined` when empty. `featureAngle` clamped to [0, 180].
- Autosave: effect keyed on `JSON.stringify(config)` (value, not reference) so it does not loop on the cache update; skips the first run (`didMount`); 800 ms delay.
- Per-patch maps are synchronized on `patchKey` (names joined by `|`): adds a default for a new patch, removes a vanished patch, keeps existing choices. New patches added after mount take the `DEFAULT_CFMESH_CONFIG` defaults, not the edited globals.
- `cores` is reduced if `maxCores` drops.
- Clicking `Customize` calls `setPatchLayers` inside the `setPatchLayerCustom` updater (side effect in an updater, works but may run twice in StrictMode).

## `apps/web/src/features/meshing/MeshResultViewer.tsx`
**Role**: 3D preview of a session's result mesh. Reuses `MeshScene` and `PatchTable` from the visualize feature (shared three.js scene). The manifest query triggers the server-side render build; geometry and edges depend on it.
**Exports**:
- `MeshResultViewer` (props: `sessionId`). State: `selected` (selected patch). Hooks: `useMeshingManifestQuery(sessionId)`, then `useMeshingGeometryQuery` / `useMeshingEdgesQuery` enabled only if the manifest is OK, patches are non-empty and WebGL is available. Renders a grid: left column "Boundary patches (n)" (`PatchTable` or building / error / empty messages), right area `CanvasArea`.
- `default`: same component.
- Internal: `detectWebgl`, `CanvasArea` (state cascade: no WebGL, manifest loading, manifest error, no patch, geometry loading, geometry error, then `MeshScene` with `rebuilding={false}`), `StageMessage` (`role="status"`), `StageError` (`role="alert"`, technical details if `ApiError`, `Try again` button).
**Depends on**: `useMeshing` (hooks + keys), `@/features/visualize/MeshViewer` (`MeshScene`), `@/features/visualize/PatchTable`, `Diamond`, `ApiError`. **Used by**: `pages/MeshingSessionPage.tsx`.
**Notes**: `rebuild` resets `selected` to null and runs `removeQueries` on the manifest / glb / edges keys, which restarts the whole chain (including the server rebuild). The doc comment wording mentions snappyHexMesh but the viewer also serves cfMesh sessions.

## `apps/web/src/features/meshing/SnappyConfigForm.tsx`
**Role**: form for the snappyHexMesh parameters of a session. Per-STL surface refinement, Advanced disclosure (background padding, per-surface sharp edges, MPI cores, keep-point, per-surface prism layers). Seeded from `initialConfig` (autosaved config, otherwise last run) on mount only; debounced autosave.
**Exports**:
- `SnappyConfigForm` (props: `stls`, `bounds`, `disabled`, `running`, `initialConfig: SnappyConfig | null`, `maxCores`, `onGenerate(config)`, `onConfigChange?(config)`). State: `domainType` (`internal` / `external` via `SegmentedRadioGroup`), `cellSize`, `refinements` (min/max per STL), `marginFactor`, `features` (angle/level per STL), `featureSurfaceOn`, `layersOn`, `layerSurfaceOn`, `layerSpecs` (n/exp/final per STL), `nLayers`, `relativeSizes`, `finalThickness`, `expansionRatio`, `manualPoint` + `px/py/pz`, `cores`, `advancedOpen`. Orange CTA `Generate mesh`.
- `default`: same component.
- Internal helpers: `fmt`, `diagonalOf`, `autoLocation` (bbox center for `internal`, corner of the padded box × 0.99 for `external`, mirroring the server derivation), `clampCores`, `defaultCores`, `seedFeatures`, `seedFeatureSurfaces` (missing or empty = all active), `seedRefinements`, `seedLayerSurfaces` (legacy config without `surfaces` = all active), `seedLayerSpecs`.
**Depends on**: `@/components/ui/{button,field,input,segmented}`, `DEFAULT_SNAPPY_CONFIG`. **Used by**: `pages/MeshingSessionPage.tsx`.
**Notes**:
- Validation: a surface with `max < min` blocks the CTA and the autosave (`refinementError`, `role="alert"` message).
- Payload: an empty or non-positive `baseCellSize` sends `null` (server-derived); manual keep-point off sends `locationInMesh: null`. The global scalars (`surfaceRefinement`, `featureLevel`, `featureAngle`) take the first surface's values. `featureSurfaces` and `addLayers.surfaces` list the checked STLs; `addLayers.perSurface` covers all STLs.
- `enableManualPoint` prefills the keep-point with the auto value only if all three fields are empty.
- Same autosave mechanism as cfMesh (serialized key, 800 ms, skip of the first render) and same map resynchronization on `stlKey`.
- `role="status"` warning if layers are enabled with no surface checked.
- `clampCores`, `defaultCores`, `fmt`, `diagonalOf` are duplicated identically in `CfMeshConfigForm` (and `clampCores` exists as a variant in `SolverConfigPanel`).

## `apps/web/src/features/meshing/StlViewer.tsx`
**Role**: client-side three.js preview of a session's uploaded STLs, without server rendering (works without OpenFOAM). Same light "studio" and token-driven materials as the Visualize viewer.
**Exports**:
- `StlViewer` (props: `sessionId`, `stls`). Inline `useQuery` with key `['meshing', sessionId, 'stlBuffers', names.join('|')]` (sorted names), `queryFn` = `Promise.all(getStlBuffer)` (GET `/meshing/:id/stl?name=`), `enabled` if at least one STL and WebGL, `staleTime` 5 min, no polling. Rendered states: no WebGL, no surface, loading, error, otherwise `StlScene`.
- `default`: same component.
- Internal: `readToken` (reads a CSS variable on `:root`), `detectWebgl`, `StlScene` (scene, `OrbitControls`, on-demand rendering via `requestAnimationFrame`, `STLLoader` parsing, `--color-neutral` fill + `EdgesGeometry(30°)` edge overlay in `--color-text` at 22% opacity, `fitView`, `ResizeObserver`, `Reset view` button with tooltip, full dispose on unmount), `StageMessage`.
**Depends on**: `three`, `three/examples/jsm/{OrbitControls,STLLoader}`, `getStlBuffer` from `@/lib/api/meshing`, `Tooltip`, `Button`. **Used by**: `pages/MeshingSessionPage.tsx`.
**Notes**: control damping is turned off under `prefers-reduced-motion`. An unparsable STL is silently ignored. The background is an inline `radial-gradient` over `--color-surface` / `--color-bg`. The key starts with `['meshing', id]`: any invalidation of the session or the list also hits it (see `useMeshing.ts`).

## `apps/web/src/features/meshing/useMeshing.ts`
**Role**: all TanStack Query hooks of the Meshing feature. List and detail have their own keys; mutations write the detail into the cache (`setQueryData`) and invalidate the list; the run is a background job whose log is polled; the result viewer follows the manifest then glb/edges pattern.
**Exports**:
- Keys: `meshingSessionsKey = ['meshing']`, `meshingSessionKey(id) = ['meshing', id]`, `meshingRunLogKey(id) = ['meshing', id, 'run', 'log']`, `meshingManifestKey(id) = [..., 'mesh', 'manifest']`, `meshingGeometryKey(id) = [..., 'mesh', 'glb']`, `meshingEdgesKey(id) = [..., 'mesh', 'edges']`.
- `useMeshingSessions()`. Query `meshingSessionsKey`, GET `/meshing`.
- `useMeshingSession(id)`. Query `meshingSessionKey(id)`, GET `/meshing/:id`.
- `useCreateMeshingSession()`. Mutation `{ name, engine }`, POST `/meshing`; invalidates the list.
- `useCopyMeshingSession()`. Mutation `CopySessionBody`, POST `/meshing/copy`; `setQueryData` detail + invalidates the list.
- `useTransferChamberToMeshing()`. Mutation `FromChamberBody`, POST `/meshing/from-chamber`; `setQueryData` detail + invalidates the list.
- `useRenameMeshingSession()`. Mutation `{ id, name }`, PATCH `/meshing/:id`; `setQueryData` + invalidates the list.
- `useDeleteMeshingSession()`. Mutation `id`, DELETE `/meshing/:id`; invalidates the list.
- `useUploadStl(id)`. Mutation `File[]`, multipart POST `/meshing/:id/stl` (field `files`); `setQueryData` + invalidates the list.
- `useDeleteStl(id)`. Mutation `name`, DELETE `/meshing/:id/stl?name=`; `setQueryData` + invalidates the list.
- `useStartMeshing(id)`. Mutation `MeshingConfig`, POST `/meshing/:id/run`, resolves `{ session, status }` as soon as it is queued; rejects with 409 `MESH_IN_PROGRESS`. `setQueryData` detail, invalidates list and log.
- `useMeshingRunLog(id, enabled)`. Query `meshingRunLogKey(id)`, GET `/meshing/:id/run/log`. `refetchInterval` 1,200 ms (`RUN_POLL_MS`) while the status is unknown or active (`isMeshingRunActive`), `false` as soon as a terminal status has been seen.
- `useStopMeshing(id)`. Mutation, POST `/meshing/:id/run/stop`; `setQueryData` + invalidates the list.
- `useOnMeshingRunSettled(id)`. Not a query hook: returns a callback to call once per terminal transition; invalidates detail + list and runs `removeQueries` on manifest / glb / edges.
- `useSaveMeshingConfig(id)`. Mutation `MeshingConfig`, PUT `/meshing/:id/config`; `setQueryData` on the detail only (no invalidation). Failures are swallowed by the caller.
- `useMeshingManifestQuery(id, enabled = true)`. GET `/meshing/:id/mesh/manifest` (builds the render on the first call). `retry: false`, `staleTime` and `gcTime` 5 min.
- `useMeshingGeometryQuery(id, enabled)`. GET `/meshing/:id/mesh/geometry` (GLB as `ArrayBuffer`). Same options.
- `useMeshingEdgesQuery(id, enabled)`. GET `/meshing/:id/mesh/edges`, `null` on 204/404 or an empty blob. Same options.
**Depends on**: `@/lib/api/meshing`, `isMeshingRunActive` and types from `@/lib/api/types`. **Used by**: `pages/MeshingPage.tsx` (list, create, copy, rename), `pages/MeshingSessionPage.tsx` (detail, run, log, stop, save, upload, delete), `features/chamber/SendToMeshingDialog.tsx` (list + transfer), `MeshResultViewer`.
**Notes**:
- Prefix pitfall: `invalidateQueries({ queryKey: ['meshing'] })` (list) matches by prefix every active meshing query (details, log, manifest, glb, edges, STL buffers) and refetches them. Same for `meshingSessionKey(id)`, which covers the session's log and STL buffers. No invalidation uses `exact: true`.
- The `useStartMeshing` comment says the log is "reset", but it is an invalidation (refetch), not a reset of the data.

## `apps/web/src/features/solver/RadioCardGroup.tsx`
**Role**: accessible group of "radio cards" (real radios hidden as `sr-only` inside a `fieldset`/`legend`, native keyboard navigation). Selection in brand blue (tint + border + filled dot), never in orange.
**Exports**:
- `RadioCardItem` (interface: `id`, `label`, `mono` (OpenFOAM token shown in mono), `summary`).
- `RadioCardGroup` (props: `items`, `value`, `onChange(id)`, `disabled?`, `name` (unique per page), `legend`). Stateless. 1- or 2-column grid, internal `RadioDot`.
**Depends on**: `cn`. **Used by**: `TurbulencePicker`.

## `apps/web/src/features/solver/ResidualChart.tsx`
**Role**: hand-made SVG chart of solver residuals, logarithmic Y axis, one line per field, no chart library (bundle discipline). Width measured by `ResizeObserver`, fixed height 260 px (1 viewBox unit = 1 px).
**Exports**:
- `ResidualChart` (props: `samples: ResidualSample[]`). State: `width` (680 by default). Model in `useMemo` via `buildModel`: `1eN` decade gridlines, 2 to 5 iteration X ticks, polylines, marker and label at the last point. Legend (swatch + name), `details` "Show residual values" with a table of the last 100 iterations (screen reader source of truth, sr-only `caption`). `ChartEmpty` (diamond + "No residuals yet") if there is no model.
- Internal: `HEIGHT`, `PAD`, `SERIES_COLORS` (8 CSS variables from the brand palette only), `orderFields` (order of `RESIDUAL_FIELDS` from `@dive/shared`, then sorted extras), `buildModel`.
**Depends on**: `RESIDUAL_FIELDS` (`@dive/shared`), type `ResidualSample`. **Used by**: `SolverTab` (`LiveRun`).
**Notes**: only strictly positive numeric values are plotted (log). If `xMax === xMin`, the axis is widened by 1. Table rows are keyed by `sample.time` (possible duplicates not handled, to verify on the server parser side).

## `apps/web/src/features/solver/RunHistory.tsx`
**Role**: list of a project's runs (most recent first, order provided by the API): status badge, solver, creation date, duration and exit code once finished.
**Exports**:
- `RunHistory` (props: `runs: RunSummary[]`). Stateless. "No runs yet." if empty.
- Internal: `whenFormatter` (`Intl.DateTimeFormat('en-GB')`), `formatWhen`, `formatDuration` (`1m 42s`, `null` if incomplete or negative).
**Depends on**: `RunStatusBadge`. **Used by**: `SolverTab` (`RunnablePanel`).

## `apps/web/src/features/solver/RunLog.tsx`
**Role**: focusable streaming log area (`role="log"`, `tabIndex=0`) that automatically follows the end as long as the user has not scrolled up (24 px threshold).
**Exports**:
- `RunLog` (props: `text`, `live` (shows "streaming"), `ariaLabel = 'Solver output log'`). Refs: container `ref`, `pinned`. "No output yet." if the text is empty.
**Used by**: `SolverTab` (`LiveRun`) and `pages/MeshingSessionPage.tsx` (mesh run log, hence the `ariaLabel` prop).

## `apps/web/src/features/solver/RunStatusBadge.tsx`
Component `RunStatusBadge({ status, className = '' })`: pill (border + tinted background + icon + label) read from `runStatusMeta[status]`, icon spinning if `spin`. Color is never the only signal. Used by `RunHistory` and `SolverTab` (`LiveRun`).

## `apps/web/src/features/solver/SolverBrowserDialog.tsx`
**Role**: "Choose a solver" overlay: the whole solver library (`SOLVER_LIBRARY`) grouped by physics family (`SOLVER_CATEGORIES`), full-text search, setup level badge. Picking a solver selects it and closes.
**Exports**:
- `SolverBrowserDialog` (props: `open`, `onOpenChange`, `value: SolverId`, `onSelect(id)`). State: `query`. Filters on `id`, `label`, `summary` (case-insensitive); empty groups hidden; "No solver matches" message if nothing matches.
- Internal: `SolverRow` (button with `aria-current` if selected, badge `Guided` (tier `full`) or `Base setup` (tier `base`, default if missing from `SOLVER_CATALOG`)).
**Depends on**: `@/components/ui/{dialog,input,badge}`, `SOLVER_CATALOG`, `SOLVER_CATEGORIES`, `SOLVER_LIBRARY`. **Used by**: `SolverSetupWizard` (step 1), `SolverConfigPanel` (`ChangeSolver`).
**Notes**: `query` is not reset on close (component always mounted by its parents).

## `apps/web/src/features/solver/SolverConfigPanel.tsx`
**Role**: configuration and launch panel for a runnable case. Header with `Reconfigure` (reopens the wizard) and the only orange CTA `Run solver` / `Run again`, persistent cores selector, solver summary and a `Configure` button that opens a large Easy / Advanced dialog. All editing is locked during an active run.
**Exports**:
- `SolverConfigPanel` (props: `projectId`, `solver: string | null` (read from `controlDict`), `scaffoldable` (Easy by default if true, otherwise Advanced), `active`, `maxCores`, `runLabel`, `runPending`, `onRun(cores)`, `onReconfigure()`). State: `mode` (`easy` / `advanced`), `cores` (read from `localStorage` key `dive.solver.cores.<projectId>`, default 1), `configOpen`.
- Internal (not exported):
  - `ChangeSolver` (current, disabled): opens `SolverBrowserDialog`, keeps a pending `choice` then `Apply <solver>`, which calls `useScaffoldSolver().mutateAsync({ solver })` (success/error toast), or `Cancel`. Explicit two-step change, never silent.
  - `SolverEasyForm` (solver `ConfigurableSolverId`): loads in parallel, via `useQueries`, each distinct file referenced by `SOLVER_CATALOG[solver].easyParams` (key `caseFileContentQueryKey(projectId, file)`, GET `/projects/:id/files/content?path=`, `staleTime` 5 s, `retry: false`). Params whose file did not load are skipped; error state only if all files fail; skeleton while loading; message if there are no params. `commit`: `setFoamValue` otherwise `insertFoamField`, then `useSaveCaseFile().mutate` (toast on error).
  - `TurbulenceField`: the `rasModel` param is not spliced but applied via the scaffold (`mutateAsync({ solver, turbulence })`) because it rewrites the whole `simulationType` block and adds the `0/` fields. `NativeSelect` grouped by `TURBULENCE_APPROACHES`, warning if LES/DES on a `steady` solver.
  - `ParamRow` (enum or text), `BoolRow` (checkbox: `options[0]` = on token, `options[1] ?? 'no'` = off), `EnumControl` (adds the current value if outside the options), `TextControl` (uncontrolled input `defaultValue` + `key={value}`, commit on blur or Enter).
  - `AdvancedConfig`: `ApplicationField` (free `application` field written to `system/controlDict`) + selection of a real config file (`useCaseFilesQuery`, filtered by `isConfigFile`, order: the catalog's `requiredFiles` or `DEFAULT_SOLVER_FILES`, then the rest sorted) and `RawFileEditor`.
  - `RawFileEditor`: `CaseFileEditor` (CodeMirror) with a local draft and 600 ms debounced autosave; `RawSaveStatus` (Save failed / Saving… / Editing… / All changes saved).
  - `ModeToggle` / `ModeButton` (`aria-pressed`), `BaseSetupHint`, `ManualEasyNote`, `clampCores`, `readStoredCores`, `writeStoredCores`, `DEFAULT_SOLVER_FILES`, `isConfigFile`.
**Depends on**: `useScaffoldSolver` (`./useRuns`), `useCaseFileContentQuery` / `useCaseFilesQuery` / `useSaveCaseFile` / `caseFileContentQueryKey` (`features/projects/useCaseFiles`), `foamModel`, `CaseFileEditor`, `SolverBrowserDialog`, `getCaseFileContent`, catalogs from `@/lib/api/types`, `toast`. **Used by**: `SolverTab` (`RunnablePanel`).
**Notes**:
- The dialog ignores "outside" clicks coming from portaled content (popper, menu, dialog, alertdialog) so it does not close when the solver browser is open.
- `RawFileEditor` only reloads the draft when `path` changes (fix H4: the save echo no longer overwrites typing). Consequence to verify: if the open file is rewritten elsewhere while the editor is mounted (for example `Apply` in `ChangeSolver`, which invalidates `['projects', id, 'files']` and therefore the content), `query.data` changes, the draft stays the old one and the autosave effect sends it back to the server, which could undo the scaffold rewrite.
- `clampCores` here does `Math.min(n, max)` with no floor on `max` (unlike the meshing versions), so it returns 0 if `maxCores` is 0.
- `ManualEasyNote` shows literal backticks around `application` (JSX text, not Markdown). The `AdvancedConfig` doc comment still talks about the "curated two" solvers whereas the catalog covers more.

## `apps/web/src/features/solver/SolverFilesStep.tsx`
**Role**: step 3 of the wizard, in a 90% overlay: the app's file editor (`FileTreeEditor`, Easy + Advanced, autosave) restricted to `system/`, `0/`, `constant/` (without `constant/polyMesh`), plus `Add from template file` (`TemplateFilePicker`).
**Exports**:
- `SolverFilesStep` (props: `projectId`, `open`, `onBack`, `onDone`). State: `pickerOpen`. Builds a `FileTreeResource` that binds the `useCaseFiles` hooks to the project (`useFiles` filters `data` by `isConfigFile`). Closing the dialog calls `onDone`.
**Depends on**: `FileTreeEditor` (`features/files`), `TemplateFilePicker` (`features/templates`), hooks `useCaseFilesQuery`, `useCaseFileContentQuery`, `useSaveCaseFile`, `useCreateCaseFile`, `useDeleteCaseFile`, `useDeleteCaseDir`, `useMoveCaseEntry`. **Used by**: `SolverSetupWizard`.
**Notes**: same `onInteractOutside` guard as `SolverConfigPanel`. The `resource` object is recreated on every render. `isConfigFile` is duplicated in `SolverConfigPanel`. `FileTreeEditor` uses `useBlocker`, hence the need for a data router in tests.

## `apps/web/src/features/solver/SolverSetupWizard.tsx`
**Role**: three-step solver setup: 1 solver choice (card for the current solver + `Browse all solvers`), 2 turbulence model choice (`TurbulencePicker`, summary, option to align boundaryFields), 3 generation then file editing (`SolverFilesStep`). Going from 2 to 3 scaffolds the case.
**Exports**:
- `SolverSetupWizard` (props: `projectId`, `initialSolver?` (opens on the `controlDict` solver if it is in the library, otherwise `simpleFoam`), `onDone()`, `missingFiles?` (declared but unused)). State: `step` (1 | 2 | 3), `solver`, `browserOpen`, `turbulence` (default `kOmegaSST`), `applyBoundaries` (default true). Hooks: `useScaffoldSolver`, `useSyncBoundaries`.
- Internal: `StepIndicator` (`ol` with `aria-label`), `StepDot` (`aria-current="step"`, sr-only "(completed)").
**Depends on**: `SolverBrowserDialog`, `SolverFilesStep`, `TurbulencePicker`, `useScaffoldSolver`, `useSyncBoundaries` (`features/projects/useCaseFiles`), `SOLVER_CATALOG`, `SOLVER_LIBRARY`, `TURBULENCE_MODELS`, `toast`. **Used by**: `SolverTab`.
**Notes**:
- `handleGoToFiles`: `scaffold.mutateAsync({ solver, turbulence })`, then if checked `syncBoundaries.mutateAsync()`, then `setStep(3)`; any error produces a toast (`ApiError` message if available).
- Focus moves to the step content on each change (not on first mount).
- At step 3 the wizard card is unmounted and only the overlay remains: `StepIndicator` therefore never shows in the current "Files" state.
- Single orange CTA: `Generate and continue` at step 2; `Next` is secondary.
- Warning if an LES model is chosen with a `steady` regime solver.

## `apps/web/src/features/solver/SolverTab.test.tsx`
**Covers**: the full wizard journey (`simpleFoam` + `kOmegaSST` defaults, scaffold then `syncBoundaries`, opening "Edit case files"), choosing `pimpleFoam` via the browser and `realizableKE` at step 2, the runnable panel (config, `Configure` button, cores, empty history, `startRun('p1', { cores: 1 })`), a parallel run on 4 cores, persistence of cores after unmount/remount (localStorage), applying a turbulence model via the scaffold from the config overlay (without `saveCaseFileContent`), and the display of a converged run (badge, banner, "Show residual values" button).
**Technique**: `vi.mock('@/lib/api/projects')` (runnable, scaffold, syncBoundaries, runs, log, case files) and `vi.mock` of the toast; real `QueryClient` (`retry: false`); `createMemoryRouter` + `RouterProvider` for the `useBlocker` of `FileTreeEditor`; `localStorage.clear()` before each test; default `controlDict` content for all files.
**Notable cases**: no real polling or network. `pimpleFoam` is targeted via the unique text "URANS" in the browser.

## `apps/web/src/features/solver/SolverTab.tsx`
**Role**: content of a project's Solver tab: launch an OpenFOAM run and follow its convergence live. States: loading, load error, wizard, "not runnable" gate, runnable panel.
**Exports**:
- `SolverTab` (props: `projectId`). Hook: `useRunnableQuery(projectId)`. State: `wizardOpen`, ref `inited`. On the first response, opens the wizard if the case is not runnable (derived during render, not in an effect, so that the wizard is present in the same commit). After that, opening is user-driven (Done closes, Reconfigure reopens).
- Internal:
  - `NotRunnableGate` (list of missing files + CTA `Configure the solver`).
  - `SolverSkeleton`.
  - `RunnablePanel`: `useRunsQuery`, current run = `runs.data[0]`, `useRunLogQuery(projectId, currentRun.id)`. The freshest status comes from the log payload, with fallback to the list. `useStartRun` (`mutateAsync({ cores })`), `useStopRun` (`mutateAsync(currentRun.id)`), error toasts. Renders `SolverConfigPanel`, `LiveRun`, History section.
  - `LiveRun`: `role="status"` badge, `Elapsed`, last iteration, `Stop run` button (danger-tinted secondary) if active, `RunBanner` if terminal, `ResidualChart`, `RunLog`.
  - `RunBanner`: message per status (or `run.reason`), `role="alert"` for `failed`.
  - `Elapsed`: re-renders every second while active; `formatClock` (`mm:ss` or `h:mm:ss`).
**Depends on**: `useRuns`, `SolverSetupWizard`, `SolverConfigPanel`, `ResidualChart`, `RunHistory`, `RunLog`, `RunStatusBadge`, `runStatusMeta`, `toast`. **Used by**: `pages/ProjectDetailPage.tsx` (lazy import), test `SolverTab.test.tsx`.
**Notes**: `runnable` is not re-invalidated by `useStartRun`; after the wizard, it is `useScaffoldSolver` (`setQueryData`) and `useSyncBoundaries` (invalidation of `['projects', id, 'runnable']`) that bring `runnable` up to date.

## `apps/web/src/features/solver/TopoSetDialog.tsx`
**Role**: project tool (button in the "Case files" bar) that writes `system/topoSetDict`, read by `topoSet` to create cellSets / cellZones (e.g. the rotor cellZone of a Frozen Rotor). Never runs `topoSet`: that step stays manual on the OpenFOAM server.
**Exports**:
- `TopoSetDialog` (props: `projectId`, `open`, `onOpenChange`). State: `step` (`mode` / `cylinder` / `done`), `mode` (`basic` / `manual`), `cellZone` (default `rotor`), `p1`, `p2`, `radius`, `busy`, `resultMode`. Hooks: `useCaseFilesQuery` (file existence), `useCreateCaseFile`, `useSaveCaseFile`.
- Internal: `foamBanner`, `FOAM_FOOTER`, `buildTopoSetDict` (pair of actions `cylinderToCell` on `<zone>Cells` then `setToCellZone`), `buildManualTopoSetTemplate` (commented skeleton, empty `actions ( );`), `OptionCard`, `ModeStep`, `NumberField`, `VectorField`, `CylinderStep` (warns if the file exists: `Overwrite file` button), `DoneStep` (reminder to run `topoSet`, `Open files` link to `/projects/:id/edit`, `Adjust`, `Close`).
**Depends on**: `useCaseFiles`, `Diamond`, `Link` (react-router), `toast`. **Used by**: `features/projects/CaseFilesSection.tsx`.
**Notes**:
- `writeDict` chooses `save` if the file exists, otherwise `create`. Manual mode writes nothing if the file already exists.
- The dialog does not close while `busy`.
- The component stays mounted in `CaseFilesSection` and its state is never reset: on reopening it resumes at the last step (often `done`).
- Minimal validation: non-empty zone name and radius > 0; the components of `p1` / `p2` are not validated (an empty string produces an invalid vector in the dictionary).

## `apps/web/src/features/solver/TurbulenceCalculator.tsx`
**Role**: project tool that estimates RANS initialization values (k, epsilon, omega) from U, Dh, nu and intensity I, with per-value copy and "Write to case", which splices `internalField uniform <value>` into `0/k` and into `0/omega` or `0/epsilon` depending on which file is present. The turbulence model is read from `constant/turbulenceProperties` (no manual choice) and is used to highlight the fields in use.
**Exports**:
- `TurbulenceCalculatorDialog` (props: `projectId`, `open`, `onOpenChange`). Dialog with an sr-only `DialogTitle` and `TurbulenceCalculator bare`.
- `TurbulenceCalculator` (props: `projectId`, `bare?` (removes the card chrome)). State: `u` (default `2`), `dh` (`0.1`), `nu` (`1e-6`, water), `intensity` (`5`), `writing`. Inputs are reloaded from and persisted to `localStorage` key `dive.turbulence-calculator.<projectId>`. Hooks: `useCaseFilesQuery`, `useCaseFileContentQuery(projectId, 'constant/turbulenceProperties' | null)`, `useSaveCaseFile`. `writeToCase` re-reads each file via `getCaseFileContent` (direct call, outside the cache) before saving.
- Internal: `CMU_075`, `positive`, `computeSeeds`, `trimZeros`, `formatNumber` (4 significant digits for display, 6 for copy, scientific outside [1e-3, 1e5)), `readProjectModel`, `loadInputs`, `NumberField`, `ModelReadout` ("project" badge if a model was read), `Derived`, `SeedRow` (copy button, `aria-live`), `FormulaReference`.
**Depends on**: `foamModel`, `useCaseFiles`, `getCaseFileContent`, `TURBULENCE_MODELS`, `toast`. **Used by**: `features/projects/CaseFilesSection.tsx` (dialog).
**Notes**:
- Formulas: `Re = U·Dh/nu`, `k = 1.5·(U·I)²`, `L = 0.07·Dh`, `epsilon = k^1.5/(Cmu^0.75·L)`, `omega = k^0.5/(Cmu^0.75·L) = epsilon/k`, with `Cmu = 0.09` (cited reference: `documents/calculator/turbulence_cfd_notes.md`). To verify: the usual form is `omega = k^0.5/(Cmu^0.25·L) = epsilon/(Cmu·k)`; the implementation differs by a factor of `Cmu^-0.5` (about 3.3).
- With no configured model, highlighting uses `kOmegaSST` as an indication.
- If the case contains both `0/omega` and `0/epsilon`, only `omega` is written, whatever the model.
- Clipboard blocked: silent failure.

## `apps/web/src/features/solver/TurbulencePicker.tsx`
Component `TurbulencePicker({ value, onChange, disabled = false, name = 'turbulence' })`: one `RadioCardGroup` per approach in `TURBULENCE_APPROACHES` (Laminar/DNS, RANS, LES/DES), fed by `TURBULENCE_MODELS` filtered by `simulationType`. All groups share the same `name`: only one model selected overall. An empty group is not rendered. Used by `SolverSetupWizard` (step 2).

## `apps/web/src/features/solver/runStatusMeta.ts`
**Role**: shared presentation of a `RunStatus` (label, lucide icon, spin, badge classes), used by the badge and the banner. Palette: primary blue for `running`, success for `converged`, orange family (`text-cta` for AA) for `completed` and `diverged`, danger for `failed`, neutral for `queued` / `stopped`.
**Exports**:
- `RunStatusMeta` (interface: `label`, `icon: LucideIcon`, `spin?`, `badgeClass`).
- `runStatusMeta: Record<RunStatus, RunStatusMeta>` (queued, running, converged, completed, diverged, failed, stopped).
**Used by**: `RunStatusBadge`, `SolverTab` (`RunBanner`).
**Notes**: `pages/MeshingSessionPage.tsx` defines its own local `runStatusMeta` table instead of reusing this one.

## `apps/web/src/features/solver/useRuns.ts`
**Role**: TanStack Query hooks for the Solver tab. The server pushes nothing: the client polls while a run is active, then stops (idle tab stays quiet). Each poll is a full authenticated GET (survives reloads).
**Exports**:
- `isRunActive(status: RunStatus | undefined): boolean`. True for `queued` and `running`.
- Keys: `runnableQueryKey(projectId) = ['projects', id, 'runnable']`, `runsQueryKey(projectId) = ['projects', id, 'runs']`, `runLogQueryKey(projectId, runId) = ['projects', id, 'runs', runId, 'log']`.
- `useRunnableQuery(projectId, enabled = true)`. GET `/projects/:id/runnable`, `staleTime` 10 s, no polling.
- `ScaffoldSolverVars` (interface: `solver?`, `turbulence?`).
- `useScaffoldSolver(projectId)`. Mutation `ScaffoldSolverVars | undefined`, POST `/projects/:id/runnable/scaffold` (body limited to the provided fields). `onSuccess`: `setQueryData(runnableQueryKey, result.runnable)` and invalidation of `['projects', id, 'files']` (prefix: covers the tree and all file contents).
- `useRunsQuery(projectId, enabled = true)`. GET `/projects/:id/runs`. `refetchInterval` 1,200 ms if there is no data yet (including after a failure, fix H5) or if a run is active, otherwise `false`.
- `useStartRun(projectId)`. Mutation `{ solver?, cores? } | undefined`, POST `/projects/:id/runs` (`cores` is only sent if > 1). Invalidates `runsQueryKey`.
- `useStopRun(projectId)`. Mutation `runId`, POST `/projects/:id/runs/:runId/stop`. Invalidates `runsQueryKey`.
- `useRunLogQuery(projectId, runId | null)`. GET `/projects/:id/runs/:runId/log` (run + residual series + log tail), key with `'none'` if there is no run, `enabled: !!runId`. `refetchInterval` 1,200 ms while the status is unknown or active (H5), `false` after a terminal status has been seen.
**Depends on**: `@/lib/api/projects`. **Used by**: `SolverTab`, `SolverConfigPanel` and `SolverSetupWizard` (`useScaffoldSolver`).
**Notes**: `runsQueryKey` is a prefix of `runLogQueryKey`, so `useStartRun` / `useStopRun` also invalidate run logs. Log polling stops for good once a terminal status is seen; a new run has a new `runId`, hence a new query.
