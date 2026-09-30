# Codemap: web / features / projects

> Scope: `apps/web/src/features/projects/**`, `apps/web/src/features/freesurface/**` (Free surface tab, WS-I), `apps/web/src/features/optimisation/**` (Optimisation tab, WS-H) · Updated: 2026-09-30

## Overview
Front-end "project" feature: everything related to a project's OpenFOAM case, seen from the detail page (`pages/ProjectDetailPage.tsx`) and the edit page (`pages/ProjectEditPage.tsx`).
- **TanStack Query hooks** (`useProjects`, `useCaseFiles`, `useMeshes`, `useConversion`, `useBoundaryConditions`): access layer over the `@/lib/api/*` wrappers. All keys are prefixed `['projects', projectId, ...]`; mutations write the tree returned by the API directly into the cache (`setQueryData`) then remove (`removeQueries`) or invalidate the derived caches (file contents, mesh render, library, plan, assembly).
- **"Case files" card** (`CaseFilesSection`): UI entry point. Files / Summary tabs, folder or .zip import, verification, reset, download, and opening of the overlays: `ConvertToFoamFlow` (CGNS to polyMesh), `MergeMeshesFlow` (multi-mesh merge), `BoundaryConditionDialog` (DIVE BC presets), plus dialogs from other features (`ApplyTemplateFlow`, `TurbulenceCalculatorDialog`, `TopoSetDialog`).
- **Wizards**: the three flows are Radix `Dialog`s that are always `open`, conditionally mounted by the parent, driven by a local `step` state; each step renders its own `DialogContent` (fixed width `max-w-2xl`). Closing is blocked while the mutation runs.
- **FOAM file editing**: `foamModel.ts` (positional parser, splice-based editing), `foamFieldCatalog.ts` ("easy mode" catalog), `foamForm.ts` (file / catalog matching), `CaseFileForm.tsx` (easy mode form), `CaseFileEditor.tsx` (CodeMirror, advanced mode). Consumed mostly by `features/files/FileTreeEditor.tsx` and `features/solver/*`.
- **Read-only summary**: `foamSummary.ts` (tolerant parser without positions) + `CaseSummary.tsx`.
- **Pipeline reports**: `ImportReport.tsx` (shared with `features/assemble/PartsRail.tsx` and `pages/MeshingSessionPage.tsx`); the Convert and Merge flows each have their own copy of the stepper.

## `apps/web/src/features/projects/BoundaryConditionDialog.test.tsx`
**Covers**: the BC wizard end to end. (1) Turbine (single-mode type) skips the "driving" step, the `inlet` / `outlet` patches are prefilled from their names, the default rotor step (Frozen Rotor, zone `rotor`, axis `(0 0 1)`, origin `(0 0 0)`) becomes enabled with a speed > 0, then Apply posts the expected request with `csv = null` and `omega` converted from rpm to rad/s (600 rpm gives `600 * PI / 30`). (2) Turbine in "free" Moving Rotor posts a `sixDof` block (`patches`, `mass`, `momentOfInertia`). (3) Pipe (second type) shows the "How is the flow driven?" step with "Pressure-driven" and "Flow-rate-driven".
**Technique**: `vi.mock('@/lib/api/boundary')` (`applyBoundaryConditions`) and `vi.mock('@/lib/api/projects')` (`getMeshManifest`, source of `useMeshManifestQuery`); real `QueryClient` (`retry: false`) + `MemoryRouter`. Manifest with three patches (`inlet`, `outlet`, `shroud`).
**Notable cases**: the order of the radios depends on `OBJECT_TYPE_LIBRARY` (`@dive/shared`): turbine at 0, pipe at 1. The mode labels also come from `@dive/shared`.

## `apps/web/src/features/projects/BoundaryConditionDialog.tsx`
**Role**: guided "What is this mesh?" overlay that writes inlet / outlet / wall boundary conditions into the case's `0/` fields from the DIVE turbine presets. Opened by `CaseFilesSection` (automatically after an import containing `polyMesh/`, or via the "Boundary conditions" button when the case has a `constant/polyMesh/`). All domain libraries (`OBJECT_TYPE_LIBRARY`, `OBJECT_TYPE_MODES`, `OBJECT_TYPE_TURBULENCE`, `DRIVING_MODE_LIBRARY`, `ROTOR_MODE_LIBRARY`, `ROTOR_MODES`, `MOVING_ROTOR_KIND_LIBRARY`, `MOVING_ROTOR_KINDS`, `GRAVITY`) come from `@dive/shared`.
**Exports**:
- `BoundaryConditionDialog` (props `projectId: string`, `onClose: () => void`). Step wizard `Step = 'type' | 'mode' | 'patches' | 'rotor' | 'values' | 'run'`:
  1. `TypeStep`: choice of `ObjectType` (turbine / pipe / draftTube / chamber) via `OptionCard` (hidden native radio, arrow-key navigable). `pickType` sets `mode` automatically if the type has only one mode. "Configure later" closes.
  2. `ModeStep` (skipped if `OBJECT_TYPE_MODES[type].length === 1`): `DrivingMode` (`pressure` / `flowRate` / `csvProfile`).
  3. `PatchesStep`: two `PatchSelect` inlet / outlet fed by `useMeshManifestQuery(projectId)` (`features/visualize/useMesh`); all other patches become walls (`wallNames`). Blocks if inlet = outlet; empty state if fewer than two patches (points to the Visualize split); skeleton / error with retry.
  4. `RotorStep` (turbine only): `RotorMode` `frozenRotor` (MRF) or `movingRotor`; for moving, `MovingRotorKind` `forced` or `free`. Solid-body (frozen or forced): cell zone, speed + rpm / rad/s unit toggle (`aria-pressed`), axis and origin (`VectorField`). Free (6-DoF): moving patches (`PatchCheckboxChips` over the walls), axis, center of mass, mass, `rhoInf`, inertia, inner / outer distances, damper. Frozen: non-rotating patches. Accent callout for moving: requires `pimpleFoam` + a `cyclicAMI` interface. `ready`: non-zero axis and, depending on the case, (patches + mass > 0 + inertia > 0) or (non-empty zone + speed > 0).
  5. `ValuesStep`: net head H (pressure, help `p0 = 9.81 x H`), flow rate Q (flowRate) or runner-exit CSV upload (csvProfile, columns `x, y, z, Ux, Uy, Uz`, optional k / omega); turbulent intensity and mixing length (per-type defaults via `OBJECT_TYPE_TURBULENCE`, state `null` = follows the type's default).
  6. `RunStep`: "Applying" spinner, then report: success banner, `SummaryRow` (inlet, outlet, driving, `p0`, rotor, zone, omega), notes (diamond bullet), `CsvReport` of the `csvSteps`, buttons "Adjust" (back to values), "Open files" (link `/projects/:id/edit`), "Close".
  State: ~20 `useState` at the root level (type, mode, inlet, outlet, head, flowRate, intensity, mixingLength, csvFile, rotorMode, movingKind, cellZone, speed, speedUnit, axis, origin, nonRotatingPatches, free, result). `handleApply` assembles `ApplyBoundaryConditionsRequest` (`values.head` only in pressure, `values.flowRate` only in flowRate; `rotor: RotorConfig` for turbine, `sixDof` for free) then calls `useApplyBoundaryConditions(projectId).mutateAsync({ request, csv })`. Transport / validation error: back to `values` + toast.
- Internal helpers: `toOmega(speed, unit)` (rpm to rad/s, 0 if not finite), `fmt(value)` (rounding to 4 decimals without noise), `takeFile(input)` (reads then clears the input), `guessPatch(patches, re, fallbackIndex)`, constant `FREE_DEFAULTS` (rhoInf 1000, inner 0.2, outer 0.5, damper 0.85). Internal components `OptionCard`, `PatchSelect`, `NumberField`, `VectorField`, `PatchCheckboxChips`, `SummaryRow`, `CsvReport`.
**Depends on**: `@dive/shared`, `useApplyBoundaryConditions`, `useMeshManifestQuery`, `@/components/ui/*` primitives, `Diamond`. **Used by**: `CaseFilesSection`.
**Notes**:
- A `useEffect` prefills inlet / outlet (regex `/inlet|in$/i` and `/outlet|out$/i`, fallback to first / last patch) as soon as the manifest arrives and as long as both are empty.
- The "Boundary conditions applied." toast and the report title are shown without reading `result.success`: a CSV to boundaryData failure only appears in `CsvReport` / `notes`.
- `CsvReport` shows "OK" for any non-`failed` status (a `skipped` step therefore appears as OK).
- The `p0Helper` help text hardcodes "9.81" while the computation uses `GRAVITY`.
- Token deviations: `rounded-[6px]` on the unit toggle, `text-white` on the icon of a checked `OptionCard`.
- The header comment describes 5 steps; the rotor step (3b) is not listed.

## `apps/web/src/features/projects/CaseFileEditor.tsx`
`CodeMirror` wrapper (`@uiw/react-codemirror`) to edit a case file in advanced mode. Export `CaseFileEditor` (props `value`, `onChange`, `readOnly?`, `className?`): `cpp()` language (OpenFOAM dictionaries are "C++-like"), light theme, 100 % height (the parent sets the height), line numbers, no fold gutter, active line highlighting disabled in read-only. Isolated so that CodeMirror is only loaded in the edit page's lazy chunk and so it can be mocked in tests (`pages/ProjectEditPage.test.tsx`). **Used by**: `features/files/FileTreeEditor.tsx`, `features/solver/SolverConfigPanel.tsx`.

## `apps/web/src/features/projects/CaseFileForm.test.tsx`
**Covers**: `CaseFileForm` in easy mode. Enum rendered as a `<select>` with the current value and the catalog options; enum change spliced into the raw text without touching the rest; one "Boundary type" `<select>` per patch, editing only that patch; text field validated on blur and not on every keystroke; unknown block (`functions`) shown as "Edit in Advanced mode".
**Technique**: direct render with a spy `onChange` (`vi.fn`), inline `controlDict` and `U` fixtures, `fireEvent.change` / `fireEvent.blur`.
**Notable cases**: the assertions check exact alignment (`writeFormat     ascii;`), proof that only the value range is replaced.

## `apps/web/src/features/projects/CaseFileForm.tsx`
**Role**: "easy mode" editor for an OpenFOAM file. Parses the text (`parseFoamModel`), finds the catalog entry (`matchFoamFileDef`), and renders each entry as a control; each edit rewrites only the value via `setFoamValue`, so banner, comments, macros and unknown content are preserved byte for byte.
**Exports**:
- `CaseFileForm` (props `value: string`, `onChange(next: string)`, `readOnly?`). Header: catalog title (or `object`, or "File"), `class` badge, description. Body: recursive `NodeFields` over the top-level nodes other than `FoamFile`, or empty state "No structured fields were found". `commit(path, value)` only calls `onChange` if the text actually changes; no-op in `readOnly`.
- Internals: `lookupFieldDef(def, path)` (patch `boundaryField/<patch>/type`: enum over `def.boundaryFieldTypes` labeled "Boundary type"; depth 1: `def.fields`; inside a known sub-dictionary: match by leaf key, at any depth, which covers `solvers/<field>/solver`); `isStructuredSection` (at the top level, only `boundaryField` and the catalog's `subDicts` are expanded; without a catalog, everything is expanded); `Section`, `DeferredSection` ("Edit in Advanced mode"), `FieldRow`, `EnumControl` (`NativeSelect`, adds the current value if it is outside the catalog), `TextControl` (uncontrolled input `key={value}`, commit on blur / Enter, `trim`).
- `MAX_DEPTH = 4`: beyond that, the section is deferred to advanced mode.
**Depends on**: `foamModel`, `foamFieldCatalog` (types), `foamForm`, `NativeSelect`. **Used by**: `features/files/FileTreeEditor.tsx`.
**Notes**: only `enum` and `bool` (with `options`) produce a `<select>`; the kinds `scalar`, `integer`, `vector`, `dimensions`, `dimensioned`, `text` all fall back to `TextControl` (no numeric validation). Per-term entries of `fvSchemes` (e.g. `div(phi,U)`) are not in the catalog and remain free text. React `key`s are the FOAM keys: two entries with the same key at the same level (e.g. two `#include`) would collide. Stable DOM id per path (`fieldId`).

## `apps/web/src/features/projects/CaseFilesSection.test.tsx`
**Covers**: empty state ("No case files yet", Import folder / Import .zip buttons); imported tree with sizes (`2.0 KB`, `512 B`) and toolbar (Verify case, Download, Reset, TopoSet); reset after `alertdialog` confirmation; Verify opening the setup flow (`ApplyTemplateFlow`: "Set up the case files", missing files, "Add minimal base files", "Use a saved template"); adding the minimal files (call to `scaffoldCase('p1')`); Files (active by default) / Summary tabs; Summary that reads `system/controlDict` without ever opening `constant/polyMesh/points`.
**Technique**: partial `vi.mock('@/lib/api/projects')` (`getCaseFiles`, `getCaseFileContent`, `importCaseFolder`, `importCaseZip`, `verifyCase`, `scaffoldCase`, `downloadCase`, `resetCase`); real `QueryClient` + `MemoryRouter`; `userEvent` for the tab.
**Notable cases**: the Summary test validates the `constant/polyMesh/` filtering of `CaseSummary`.

## `apps/web/src/features/projects/CaseFilesSection.tsx`
**Role**: "Case files" card of the project detail page: import, inspection, verification, download and reset of the OpenFOAM case, plus hub for opening the overlays. Two Radix tabs: "Files" (management) and "Summary" (`CaseSummary`).
**Exports**:
- `CaseFilesSection` (props `projectId: string`, `className?` so that the page can make the card fill and scroll at `lg`). Hooks: `useCaseFilesQuery`, `useImportCase`, `useVerifyCase`, `useScaffoldCase`. State: `importingKind` (`'folder' | 'zip' | null`, spinner on the relevant button only), `downloading`, `pendingVerification` (`CaseVerification | null`, opens `ApplyTemplateFlow`), `tab`, and one boolean per overlay (`convertOpen`, `mergeOpen`, `bcOpen`, `calcOpen`, `topoOpen`). Derived: `hasFiles`, `hasPolyMesh`.
  - Files tab states: loading (`CaseTreeSkeleton`), error (alert + "Try again"), empty (`ImportPrompt`), data (toolbar + `CaseTree`).
  - Toolbar: Import folder, Import .zip, Convert mesh, Merge meshes, Boundary conditions (if `hasPolyMesh`), Edit files (link `/projects/:id/edit`), Calculator, TopoSet, Download (ghost), then on the right `ResetCaseButton` and "Verify case" (primary button).
  - `handleImport`: toast with the number of files; if a written path contains `polyMesh/`, automatically opens `BoundaryConditionDialog`.
  - `handleDownload`: `downloadCase` then temporary anchor `case-<projectId>.zip` via `URL.createObjectURL`.
  - `handleVerify`: `verify.mutateAsync()` then `setPendingVerification(result)`; `handleScaffold`: creates the minimal base files and closes the flow.
- Internals: `ImportPrompt` (diamond, solid CTA "Import folder", secondary "Import .zip", ghost links "Convert a CGNS mesh" / "Merge meshes"), `CaseTree` (indented list, `paddingInlineStart = depth * 16px`, size via `formatBytes`), `CaseTreeSkeleton`, `ResetCaseButton` (`AlertDialog`, not closable during the mutation, `event.preventDefault()` on the action to keep the dialog open until the result), `formatBytes`, `takeFiles`.
**Depends on**: `useCaseFiles`, `CaseSummary`, `ConvertToFoamFlow`, `MergeMeshesFlow`, `BoundaryConditionDialog`, `features/templates/ApplyTemplateFlow`, `features/solver/TurbulenceCalculator` (`TurbulenceCalculatorDialog`), `features/solver/TopoSetDialog`, `downloadCase`. **Used by**: `pages/ProjectDetailPage.tsx`.
**Notes**:
- The hidden file inputs and the overlays live at the section level so they stay mounted regardless of the tab. The non-standard `webkitdirectory` / `directory` attributes are set by a `useEffect` on mount (the input is not in a portal, unlike `MergeMeshesFlow`).
- `TurbulenceCalculatorDialog` and `TopoSetDialog` are always mounted (controlled by `open`), the other overlays are conditionally mounted.
- The header comment still describes the old "Yes / No" generation overlay; the code opens `ApplyTemplateFlow` (minimal / template / ignore).
- The Download button uses `text-cta` (orange) on a `text-sm` label: to verify against the AA rule in `CLAUDE.md` (orange reserved for large or bold text).

## `apps/web/src/features/projects/CaseSummary.tsx`
**Role**: read-only summary of the settings entered in the case dictionaries (Summary tab of `CaseFilesSection`).
**Exports**:
- `CaseSummary` (props `projectId`). `useCaseFilesQuery` then filters files with `size <= EDITABLE_FILE_MAX_BYTES` (`@dive/shared`) and outside `constant/polyMesh/`; `useQueries` loads each content with the same key as the editor (`caseFileContentQueryKey`), hence a shared cache. States: skeleton, error + retry, empty ("Nothing to summarise yet", two messages depending on whether there are zero files or only mesh / large files), data: scrollable `<section aria-label="Case settings summary" tabIndex={0}>` (max-h-96, full height at `lg`) + mention of the number of skipped files.
- Internals: `FileSummary` (per file: skeleton, error + "Try again", otherwise `parseFoam` + `countFoamEntries`, header with folder / `object` / `class` badge / counter) and `FoamEntries` (recursive key → value `<dl>`, sub-dictionaries indented under a rule).
**Depends on**: `useCaseFiles`, `foamSummary`, `getCaseFileContent`. **Used by**: `CaseFilesSection`.
**Notes**: one HTTP request per summarizable file, fired when the tab is rendered. The parse is redone on every render (no `useMemo`).

## `apps/web/src/features/projects/ConvertToFoamFlow.test.tsx`
**Covers**: "Continue" locked without a CGNS file; listing an existing CGNS unlocks it; full flow sources → template choice → confirmation → report, with a call to `convertCgnsToFoam('p1', { cgnsFile: 'rotor.cgns', templateId: 't1' })` and the checkMesh log expanded by default ("Mesh OK.").
**Technique**: mocks of `@/lib/api/conversion` (`listCgns`, `uploadCgns`, `deleteCgns`, `convertCgnsToFoam`), `@/lib/api/templates` (`listTemplates`) and `useAuth`; `QueryClient` + `TooltipProvider` + `MemoryRouter`.
**Notable cases**: `ConversionResult` fixture with three steps (`cgnsToVtk`, `vtkToFoam`, `checkMesh`) and an applied-template note.

## `apps/web/src/features/projects/ConvertToFoamFlow.tsx`
**Role**: guided "Convert a CGNS mesh" dialog (CGNS to `constant/polyMesh`), opened from `CaseFilesSection` (empty state or toolbar). Owns its own CGNS roster so it can open on an empty case.
**Exports**:
- `ConvertToFoamFlow` (props `projectId`, `onClose`). `Step = 'sources' | 'picker' | 'confirm' | 'run'`; state `template`, `cgnsFile`, `result`. Hooks `useCgnsFilesQuery`, `useConvertToFoam`.
  0. `SourcesStep`: list of CGNS files (`CgnsList` with size and `RemoveCgnsButton` without confirmation, via `useDeleteCgns`), `.cgns` upload (`useUploadCgns`), skeleton / error / empty states (`EmptyHint`). "Continue" disabled without CGNS; `goToPicker` keeps a valid CGNS selection (first file by default).
  1. `PickerStep`: list of shared templates (`useTemplatesQuery`, `useAuth` to show "By You"), loading / error / empty states with a link to `/templates`. Clicking a template moves to confirm.
  2. `ConfirmStep`: CGNS selector if there are several, reminder that `constant/polyMesh` is overwritten, pipeline preview (`STEP_META`).
  3. `RunStep`: non-live "Converting" state, then report (success / failure banner with the faulty step, notes, `StepRow` per step with `StatusChip` and `LogDisclosure`), buttons Back (on failure), "Open files" (on success), Close.
  `handleRun`: `mutateAsync({ cgnsFile, templateId })`; `result.success === false` gives an error toast and the report; an exception (validation / transport) sends back to `confirm`.
- `STEP_META` (internal): `cgnsToVtk` / `python3`, `vtkToFoam` / `vtkUnstructuredToFoam`, `checkMesh` / `checkMesh`.
**Depends on**: `useConversion`, `features/templates/useTemplates`, `features/auth/AuthProvider`. **Used by**: `CaseFilesSection`.
**Notes**: log open by default for a failure or for the successful checkMesh. `formatBytes`, `takeFile`, `formatDuration`, `LogDisclosure` and `StatusChip` are copies of code present in other files of the folder.

## `apps/web/src/features/projects/ImportReport.tsx`
**Role**: per-step report of a mesh file conversion (`.cgns` / `.msh` to polyMesh), shared between the case import, the merge library and the meshing session.
**Exports**:
- `ImportReport` (props `steps: ImportStep[]`). Numbered `<ol>` with a status rail; per step: label, `tool`, status chip (OK / Failed / Skipped, icon + word + color), exit code, duration, and collapsible `ImportLog` (command `$ ...`, stdout, stderr in red, "No output."), open by default if the step failed.
**Depends on**: `ImportStep` (`@/lib/api/types`). **Used by**: `MergeMeshesFlow`, `features/assemble/PartsRail.tsx`, `pages/MeshingSessionPage.tsx`.
**Notes**: same visual vocabulary as the steppers of `ConvertToFoamFlow` and `MergeMeshesFlow`, but duplicated code rather than shared.

## `apps/web/src/features/projects/MergeMeshesFlow.test.tsx`
**Covers**: "Continue" locked without a mesh; a half-filled interface blocks ("Finish or remove the incomplete interface"); full flow sources → interfaces → confirmation → report with plan `{ order: ['m1','m2'], interfaces: [{ ..., coupling: 'nonConformal' }] }` and visible checkMesh log; conversion report shown when a `.cgns` import fails (stderr visible, `importMeshFile('p1', file, undefined)`); entered name passed to the import (`'rotor'`); split (`autoPatchMeshSource('p1','m1',30)`) and inline rename via Enter (`renameMeshSourcePatch('p1','m1','ifaceA','interface')`).
**Technique**: full `vi.mock('@/lib/api/meshes')`; `getMergePlan` returns `null`; file injection via `document.querySelector('input[accept=".cgns,.msh"]')`.
**Notable cases**: the mock declares `getMeshPatches` and `saveMergePlan`, which the component does not use. The success fixture has no `splitMeshRegions` step although the preview includes one (the report shows `result.steps`, not the preview).

## `apps/web/src/features/projects/MergeMeshesFlow.tsx`
**Role**: guided "Merge meshes" dialog: combines several polyMesh sources from the project library into a single `constant/polyMesh`, with coupled patch pairs (non-conformal by default, or conformal stitch). Opened from `CaseFilesSection`.
**Exports**:
- `MergeMeshesFlow` (props `projectId`, `onClose`). `Step = 'sources' | 'connections' | 'confirm' | 'run'`; state `order` (ids), `interfaces` (`InterfaceDraft[]`), `result`. Hooks `useMeshesQuery`, `useMergePlanQuery`, `useRunMerge`.
  - Initialization (single effect guarded by `initRef`, once library and plan are loaded): `order` = ids from the saved plan that are still present + new ids; `interfaces` = `plan.interfaces` or, failing that, the legacy `plan.stitches` interpreted as `coupling: 'stitch'`, filtered on existing meshes and patches. Afterwards the effect prunes deleted ids, adds new ones and removes interfaces pointing to a mesh that has disappeared.
  1. `SourcesStep`: ordered library (`MeshRow`), optional "Name" field for the next import, folder / .zip / `.cgns,.msh` imports via `useImportMesh`; a conversion failure shows `ImportReport` inline. "Continue" as soon as there is one mesh.
  2. `ConnectionsStep`: `InterfaceRow` rows (two `SidePicker` mesh + patch, diamond between them, delete, coupling `SegmentedRadioGroup` with `COUPLING_HELP` help). An empty row is ignored, a partial row blocks "Continue". Changing the mesh clears that side's patch.
  3. `ConfirmStep`: ordered list (first = base), interfaces with `CouplingChip`, pipeline preview.
  4. `RunStep`: "Merging" state listing the preview, then report (banner, notes, chips for the resulting boundary patches, `MergeStepRow` + `MergeStatusChip` + `MergeLogDisclosure`). Failure: "The case mesh was not changed.".
  `handleRun`: `mutateAsync({ order, interfaces: completeInterfaces })`; an exception sends back to confirm.
- `MeshRow`: position, "Base" badge for the first, up / down arrows, immediate deletion (`useDeleteMesh`, without confirmation), "N patches" toggle expanding `PatchEditor`.
- `PatchEditor`: split by feature angle (default `'30'`, `useAutoPatchMeshSource`) with the `autoPatch` failure log; list of `PatchRenameRow` (inline rename via Enter or button, `useRenameMeshSourcePatch`, name restored on error).
- Internals: `buildPipelinePreview(orderedMeshes, interfaces, meshById)` (Prepare per mesh, `mergeMeshes` per added mesh, `splitMeshRegions` if more than one mesh, `stitchMesh` or `nonConformalCouple` per interface, cleanup, `checkMesh`), `KIND_TOOL`, `COUPLING_OPTIONS`, `COUPLING_HELP`, `COUPLING_CHIP`, `DEFAULT_COUPLING = 'nonConformal'`, `isComplete`, `isBlank`, `takeFiles`, `formatDuration`.
**Depends on**: `useMeshes`, `ImportReport`, `SegmentedRadioGroup`, `Field`. **Used by**: `CaseFilesSection`.
**Notes**:
- The `webkitdirectory` / `directory` attributes are set by a callback ref (`setFolderInput`) because the input lives in the Radix portal, where an on-mount effect did not always see the node.
- A patch rename in `PatchEditor` is not propagated to already-entered interfaces (pruning only looks at mesh ids): the interface keeps the old name and the server validation will fail (to verify).
- `InterfaceRow` generates a `helpId` that is never referenced by `aria-describedby`. Interface rows keyed by index.
- The header talks about "folder / .zip" import and a pipeline without `splitMeshRegions`: the code also handles `.cgns / .msh` and includes `splitMeshRegions`.
- The plan is not saved client-side; `getMergePlan` is only used for prefilling (persistence happens server-side, to verify).

## `apps/web/src/features/projects/foamFieldCatalog.ts`
**Role**: curated data for easy mode: for each recognized OpenFOAM file (by `FoamFile.object`, optionally restricted by `class`), the list of editable fields and, for enumerated ones, the exact OpenFOAM tokens. Declared source: `docs/DOCUMENTATION.md` (OpenFOAM v2412), supplemented with common knowledge. Labels and help texts in English.
**Exports**:
- `FoamFieldKind`: `'enum' | 'scalar' | 'integer' | 'bool' | 'vector' | 'dimensions' | 'dimensioned' | 'text'`.
- `FoamFieldDef` (`key`, `label`, `kind`, `options?`, `help?`, `example?`); for `bool`, `options` gives the exact pair to write, "on" token first.
- `FoamSubDictDef` (`key`, `label`, `help?`, `fields`).
- `FoamFileDef` (`object`, `className?`, `title`, `description?`, `fields`, `subDicts?`, `boundaryFieldTypes?`).
- `FOAM_FIELD_CATALOG: FoamFileDef[]`, by group:
  - **`0/` fields** (all with `className`, `dimensions` + `internalField` fields as text, and flattened / deduplicated `boundaryFieldTypes`): `U` (`volVectorField`, 40 types: fixedValue, noSlip, rotatingWallVelocity, inletOutlet, flowRateInletVelocity, pressureInletOutletVelocity, turbulentDFSEMInlet, timeVaryingMappedFixedValue, codedFixedValue, ...), `p` (`volScalarField`, 25 types including totalPressure, prgh*, fixedFluxPressure, freestreamPressure), `k` (21, including kqRWallFunction, turbulentIntensityKineticEnergyInlet), `omega` (19, including omegaWallFunction, turbulentMixingLengthFrequencyInlet), `nut` (23, `nut*WallFunction` family), `epsilon` (19) and `nuTilda` (17). For `epsilon` and `nuTilda`, the comment states that the lists are absent from the docs and were built by analogy.
  - **`constant/`**: `transportProperties` (`transportModel` enum Newtonian / CrossPowerLaw / BirdCarreau / powerLaw / HerschelBulkley / Casson / strainRateFunction; `nu` dimensioned); `turbulenceProperties` (`simulationType` laminar / RAS / LES; sub-dicts `RAS`: `RASModel` 17 models including kOmegaSST, `turbulence` and `printCoeffs` on/off; `LES`: `LESModel` 9 models, `turbulence`, `printCoeffs`, `delta` 6 models).
  - **`system/`**: `controlDict` (19 fields: `application` enum of 8 solvers, `startFrom`, `startTime`, `stopAt`, `endTime`, `deltaT`, `writeControl`, `writeInterval`, `purgeWrite`, `writeFormat`, `writePrecision`, `writeCompression` on/off, `timeFormat`, `timePrecision`, `graphFormat`, `runTimeModifiable` true/false, `adjustTimeStep` yes/no, `maxCo`, `maxDeltaT`); `decomposeParDict` (`numberOfSubdomains`, `method` 9 algorithms, `distributed` yes/no); `fvSchemes` (no top-level field; sub-dicts `ddtSchemes`, `gradSchemes`, `divSchemes`, `laplacianSchemes`, `interpolationSchemes`, `snGradSchemes` each with a `default` enum, and `wallDist.method`); `fvSolution` (sub-dicts `solvers` with `solver` / `preconditioner` / `smoother` / `tolerance` / `relTol` as representative keywords, `SIMPLE`, `PIMPLE`, `PISO`, and `relaxationFactors` without fields).
**Depends on**: nothing. **Used by**: `foamForm.ts`, `CaseFileForm.tsx` (types).
**Notes**: marked "GENERATED/curated data"; the options must remain exact OpenFOAM tokens (some contain spaces, e.g. `Gauss linearUpwind grad(U)`, `bounded Euler`). Boolean tokens vary by key (on/off, true/false, yes/no). Objects without `className` match any class.

## `apps/web/src/features/projects/foamForm.test.ts`
**Covers**: `matchFoamFileDef` (match by `object`, match of a class-restricted `0/` field with `noSlip` in `boundaryFieldTypes`, `undefined` for arbitrary text and for `polyMesh/boundary`) and `foamEasyModeAvailable` (true for recognized files, false for the list format of `boundary`).
**Technique**: minimal single-line inline fixtures (`FoamFile { class ...; object ...; }`).

## `apps/web/src/features/projects/foamForm.ts`
Helpers that connect the parsed FOAM model to the catalog, separated from `CaseFileForm.tsx` for Fast Refresh compatibility and so that the edit panel can know whether to offer easy mode without importing the form. `matchFoamFileDef(content: string): FoamFileDef | undefined`: reads `FoamFile.object` / `class`, first looks for an entry whose class matches (or with no class), then falls back to a match on `object` alone. `foamEasyModeAvailable(content: string): boolean`: true if the file is recognized or if there is at least one top-level leaf other than `FoamFile` (list-format files stay in advanced mode). **Used by**: `CaseFileForm`, `features/files/FileTreeEditor.tsx`.

## `apps/web/src/features/projects/foamModel.test.ts`
**Covers**: reading top-level values, the `FoamFile` header, nested patch types and vectors (`uniform (0 0 0)`); `childrenAt` to list patches; `null` on a missing or non-leaf path; surgical `setFoamValue` (banner and other entries untouched, a single occurrence modified, neighboring patches untouched, vector rewritten); `insertFoamField` into a sub-dictionary and at end of file; `findNode` distinguishes dict and leaf; H8 regression: an `#include "initialConditions"` without `;` no longer swallows the next entry, and a neighboring splice does not corrupt the `#include` line.
**Technique**: `controlDict` fixtures with a real banner and `U` with three patches.

## `apps/web/src/features/projects/foamModel.ts`
**Role**: positional parser for OpenFOAM dictionaries. Unlike `foamSummary.ts`, it keeps the character range of each value and of each sub-dictionary body, which makes it possible to edit a field by splicing without ever re-serializing the file. Tolerant: a file it does not understand simply yields fewer addressable fields.
**Exports**:
- Types `FoamLeaf` (`key`, trimmed `value`, `hasValue`, `valueStart`, `valueEnd` = offset of the `;`), `FoamDict` (`key`, `bodyStart` right after `{`, `bodyEnd` = offset of the `}`, `children`), `FoamNode`, `FoamDocument` (`children`, `FoamFile` header included).
- `parseFoamModel(text: string): FoamDocument`. Internal tokenizer: ignores block / line comments, treats `"..."` strings and `#{ ... #}` verbatim blocks as opaque words, `{ } ;` as structure. A dict's key is the join of its tokens (e.g. `"1 ( inlet"` for a list format). Directives `#include`, `#includeEtc`, `#remove`, etc.: terminated by a newline (no `;`), converted to a leaf by `directiveLeaf`, including at the end of a body or of the file (H8 fix).
- `findNode(doc, path: string[]): FoamNode | null`, `getFoamValue(doc, path): string | null` (leaves only), `childrenAt(doc, path): FoamNode[]` (root if the path is empty).
- `setFoamValue(text, path, value): string | null`: re-parses, replaces only `[valueStart, valueEnd)`; for a bare `key;`, inserts ` value` before the `;`; `null` if missing or non-leaf.
- `insertFoamField(text, parentPath, key, value): string | null`: at the root, appends `key value;` at end of file; otherwise inserts before the parent's `}` with an indentation of 4 spaces per level; `null` if the parent is missing or not a dict.
**Depends on**: nothing. **Used by**: `foamForm`, `CaseFileForm`, `features/solver/SolverConfigPanel.tsx`, `features/solver/TurbulenceCalculator.tsx`.
**Notes**: parentheses and brackets are not structural (`uniform (0 0 0)`, `[0 1 -1 ...]` remain value text). Each call to `setFoamValue` / `insertFoamField` re-parses the whole text.

## `apps/web/src/features/projects/foamSummary.ts`
**Role**: tolerant parser for the read-only summary (`CaseSummary`). Strips banner and comments via regex, splits around `{ } ;`, keeps the remaining tokens of an entry as its value, and surfaces the `FoamFile` header as metadata.
**Exports**:
- `FoamEntry` (`key`, `value?` for a leaf, `children?` for a sub-dict), `FoamSummary` (`className?`, `object?`, `entries` excluding `FoamFile`).
- `parseFoam(content: string): FoamSummary`.
- `countFoamEntries(entries: FoamEntry[]): number` (recursive, leaves and sub-dicts).
**Used by**: `CaseSummary`.
**Notes**: this parser handles neither strings, nor `#{ #}` blocks, nor newline-terminated directives: the H8 bug fixed in `foamModel.ts` remains here (an `#include "x"` without `;` merges with the next entry in the summary). The comment regexes also act inside strings. Multiple spaces in a value are normalized to a single one.

## `apps/web/src/features/projects/schemas.test.ts`
**Covers**: `createProjectSchema` accepts a normal title, rejects a blank title (trim) and a title longer than `PROJECT_TITLE_MAX_LENGTH`.

## `apps/web/src/features/projects/schemas.ts`
Zod schema for the project creation form. `createProjectSchema`: `title` trimmed string, min 1 ("Enter a project title."), max `PROJECT_TITLE_MAX_LENGTH` imported from `@dive/shared` to align API and form. `CreateProjectFormValues` = inferred type. **Used by**: `pages/ProjectsPage.tsx`.

## `apps/web/src/features/projects/useBoundaryConditions.ts`
Hook for the BC overlay. `ApplyBoundaryInput` = `{ request: ApplyBoundaryConditionsRequest; csv?: File | null }`. `useApplyBoundaryConditions(projectId)`: `applyBoundaryConditions` mutation (multipart POST `/projects/:id/boundary-conditions/apply`, JSON `payload` field + optional `csv`). `onSuccess`: `removeQueries` on `meshManifestQueryKey`, `meshGeometryQueryKey`, `meshEdgesQueryKey` (case render, the `boundary` file changes); `invalidateQueries` on `['projects', id, 'files']` (hardcoded key, equivalent to `caseFilesQueryKey`) and `meshBackupQueryKey` (the first apply captures a mesh backup). The mutation resolves even if the CSV to boundaryData step fails: read `result.notes` / `result.csvSteps`. **Used by**: `BoundaryConditionDialog`.

## `apps/web/src/features/projects/useCaseFiles.ts`
**Role**: TanStack Query hooks for the tree and the content of the OpenFOAM case files. Tree mutations write the response directly into the cache.
**Exports**:
- `caseFilesQueryKey(projectId)` = `['projects', id, 'files']`.
- `caseFileContentQueryKey(projectId, path)` = `['projects', id, 'files', 'content', path]` (prefixed by the tree key).
- `useCaseFilesQuery(projectId)`: GET `/projects/:id/files` → `CaseEntry[]`.
- `useCaseFileContentQuery(projectId, path | null)`: GET `/projects/:id/files/content?path=`; `enabled: !!path`.
- `useImportCase(projectId)`: input `{ kind: 'folder', files } | { kind: 'zip', file }`, multipart POST `/projects/:id/files/import`. Success: `setQueryData(tree, result.entries)` + `removeQueries([...tree, 'content'])`.
- `useVerifyCase(projectId)`: cacheless mutation on GET `/projects/:id/files/verify` → `CaseVerification`.
- `useResetCase(projectId)`: DELETE `/projects/:id/files`. Success: tree written, contents removed, `removeQueries` for the case manifest / GLB / edges, `invalidateQueries` `['projects', id, 'meshes' | 'assembly' | 'mergePlan']` (keys hardcoded to avoid an import cycle with `useMeshes`); reference H6.
- `useScaffoldCase(projectId)`: POST `/projects/:id/files/scaffold`; writes `result.entries`.
- `useSyncBoundaries(projectId)`: POST `/projects/:id/files/sync-boundaries` (carries the mesh patch names and types over into every `boundaryField` of `0/`); writes the tree and invalidates `['projects', id, 'runnable']` (key from `features/solver/useRuns.ts`).
- `useCreateCaseFile(projectId)`: `{ path, content? }`, POST `/projects/:id/files/content`; writes the tree.
- `useDeleteCaseFile(projectId)`: DELETE `/projects/:id/files/content?path=`; writes the tree and removes only that file's cache.
- `useDeleteCaseDir(projectId)`: DELETE `/projects/:id/files/dir?path=`; writes the tree, removes all contents.
- `useMoveCaseEntry(projectId)`: `{ from, to }`, POST `/projects/:id/files/move`; writes the tree, removes all contents.
- `useSaveCaseFile(projectId)`: text PUT `/projects/:id/files/content?path=`; `setQueryData` for the content (`size` recomputed via `Blob`) then `invalidateQueries(tree)`.
**Depends on**: `@/lib/api/projects`, keys from `features/visualize/useMesh`. **Used by**: `CaseFilesSection`, `CaseSummary`, `useConversion`, `useMeshes`, `pages/ProjectEditPage.tsx`, `pages/ProjectDetailPage.tsx`, `features/solver/*` (`SolverConfigPanel`, `SolverFilesStep`, `SolverSetupWizard`, `TopoSetDialog`, `TurbulenceCalculator`), `features/templates/*` (`ApplyTemplateFlow`, `useTemplates`), `features/assemble/AssemblyWorkspace.tsx`, `features/visualize/VisualizePanel.tsx`.
**Notes**: `invalidateQueries` is prefix-based by default, so invalidating `caseFilesQueryKey` also invalidates all file contents (including the one `useSaveCaseFile` just wrote). `useImportCase` does not touch the mesh render even though an import can replace `constant/polyMesh` (unlike reset, conversion and merge). Neither `useScaffoldCase` nor `useSaveCaseFile` invalidates `runnable`.

## `apps/web/src/features/projects/useConversion.ts`
**Role**: hooks for a project's CGNS sources and for the CGNS to OpenFOAM conversion.
**Exports**:
- `cgnsFilesQueryKey(projectId)` = `['projects', id, 'cgns']`.
- `useCgnsFilesQuery(projectId)`: GET `/projects/:id/cgns` → `CgnsFile[]`.
- `useUploadCgns(projectId)`: multipart POST `/projects/:id/cgns`; writes `result.files`.
- `useDeleteCgns(projectId)`: `{ name }`, DELETE `/projects/:id/cgns?name=`; writes `result.files`.
- `useConvertToFoam(projectId)`: `ConvertCgnsInput` (`cgnsFile`, `templateId`), POST `/projects/:id/cgns/convert` → `ConversionResult`. Success (transport): writes `result.entries` into the tree, removes contents, `removeQueries` for the case manifest / GLB / edges, invalidates `meshesQueryKey`, `assemblyQueryKey`, `mergePlanQueryKey` (H6).
**Depends on**: `@/lib/api/conversion`, `useCaseFiles`, `useMeshes`, `features/visualize/useMesh`. **Used by**: `ConvertToFoamFlow`.
**Notes**: the mutation resolves even when the pipeline fails (`result.success === false`); the caches are then rewritten anyway (no `success` guard, unlike `useRunMerge`).

## `apps/web/src/features/projects/useMeshes.fromMeshing.test.tsx`
**Covers**: `useImportMeshFromMeshing`: case target removes the case `manifest`/`glb`/`edges`, sets `files` from `result.entries`, invalidates `meshes`, `assembly`, `mergePlan`, `runnable`, `mesh/backup`; library target sets `meshes` and leaves the case render and tree alone; the API receives `(projectId, body)` without `projectId` in the body.
**Technique**: `renderHook` with a seeded `QueryClient`; `@/lib/api/projects` mocked.

## `apps/web/src/features/projects/useMeshes.ts`
**Role**: hooks for the project's mesh library, the merge pipeline and the applied assembly.
**Exports**:
- Keys: `meshesQueryKey` = `['projects', id, 'meshes']`, `mergePlanQueryKey` = `['projects', id, 'mergePlan']`, `assemblyQueryKey` = `['projects', id, 'assembly']`.
- `useMeshesQuery(projectId)`: GET `/projects/:id/meshes` → `MeshSource[]`.
- `useMergePlanQuery(projectId)`: GET `/projects/:id/meshes/plan` → `MergePlan | null`.
- `useAssemblyQuery(projectId)`: GET `/projects/:id/meshes/assembly` → `AppliedAssembly | null` (drives the Disassemble panel, C1).
- `useImportMesh(projectId)`: `{ kind: 'folder', files, name? } | { kind: 'zip', file, name? } | { kind: 'file', file, name? }`, multipart POST `/projects/:id/meshes/import`; writes `result.meshes`.
- `useDeleteMesh(projectId)`: `{ meshId }`, DELETE `/projects/:id/meshes/:meshId`; writes `result.meshes`.
- `useAutoPatchMeshSource(projectId)`: `{ meshId, featureAngle }`, POST `/projects/:id/meshes/:meshId/auto-patch`; writes `result.meshes`.
- `useRenameMeshSourcePatch(projectId)`: `{ meshId, from, to }`, POST `/projects/:id/meshes/:meshId/patches/rename`; writes `result.meshes`.
- `useEditMeshSourcePatches(projectId)`: `{ meshId, edits: MeshPatchEdit[] }`, PUT `/projects/:id/meshes/:meshId/patches` (batch rename + retype, C4); writes `result.meshes` and removes the manifest / GLB / edges of that source (`meshSource*QueryKey` from `features/assemble/useAssembly`).
- `useRunMerge(projectId)`: `MergePlan`, POST `/projects/:id/meshes/merge` → `MergeRunResult`. If `!result.success`, no cache effect; otherwise writes the tree, removes the case manifest, then `invalidateAssemblyOutputs` (H6).
- `useReapplyAssembly(projectId)`: same endpoint with a reduced plan (removing a part; the server first restores the pre-merge case); same cache effects as `useRunMerge`.
- `useUndoAssembly(projectId)`: POST `/projects/:id/mesh/backup/restore` (`restoreMeshBackup`, C3) → `MeshManifest`; `setQueryData(meshManifestQueryKey, manifest)`, invalidates the tree, `invalidateAssemblyOutputs`, invalidates `meshBackupQueryKey`.
- `invalidateAssemblyOutputs` (internal): removes the case GLB / edges and the file contents; invalidates library, plan, assembly.
- `useImportMeshFromMeshing()` + type `ImportMeshFromMeshingVars` (`MeshFromMeshingRequest & { projectId }`, the project travels with the variables because the dialog picks it): POST `/projects/:id/mesh/from-meshing`. Library: `setQueryData(meshesQueryKey, result.meshes)`. Case (H6): removes the case manifest / GLB / edges and file contents, sets the tree, invalidates library, assembly, plan, `runnableQueryKey` (`features/solver/useRuns`) and `meshBackupQueryKey`.
**Depends on**: `@/lib/api/meshes`, `restoreMeshBackup` and `importMeshFromMeshing` (`@/lib/api/projects`), `useCaseFiles`, `runnableQueryKey` (`features/solver/useRuns`), `features/visualize/useMesh`, `features/assemble/useAssembly`. **Used by**: `MergeMeshesFlow`, `useConversion`, `pages/ProjectDetailPage.tsx`, `features/assemble/*` (`AssemblyManagePanel`, `AssemblyMergeDialog`, `AssemblyWorkspace`, `PartsRail`), `features/visualize/*` (`AutoPatchDialog`, `EditPatchesDialog`, `VisualizePanel`), `features/meshing/SendToProjectDialog` (`useImportMeshFromMeshing`).
**Notes**: import cycle avoided in one direction (`useMeshes` imports `caseFilesQueryKey`, `useCaseFiles` hardcodes the meshes keys). `useRunMerge` does not invalidate `meshBackupQueryKey` whereas `useUndoAssembly` does. The header comment says "mirrors useConvertToFoam" but the `success` guard differs.

## `apps/web/src/features/projects/useProjects.ts`
**Role**: CRUD hooks for projects and collaborators. Errors surface as `ApiError` via `mutateAsync`.
**Exports**:
- `projectsQueryKey` = `['projects']`, `projectQueryKey(id)` = `['projects', id]`.
- `useProjectsQuery()`: GET `/projects` → `Project[]`. `useProjectQuery(id)`: GET `/projects/:id`.
- `useCreateProject()`: POST `/projects`; invalidates `projectsQueryKey`.
- `useRenameProject()`: `{ id, title }`, PATCH `/projects/:id`; `setQueryData` for the detail then invalidates the list.
- `useDeleteProject()`: DELETE `/projects/:id`; invalidates the list.
- `useAddCollaborator(id)`: `email`, POST `/projects/:id/collaborators`; writes the detail, invalidates the list.
- `useRemoveCollaborator(id)`: `userId`, DELETE `/projects/:id/collaborators/:userId`; writes the detail, invalidates the list.
**Used by**: `pages/ProjectsPage.tsx`, `pages/ProjectDetailPage.tsx`, `pages/ProjectEditPage.tsx`.
**Notes**: `projectsQueryKey` is the prefix of every key in the feature; `invalidateQueries({ queryKey: ['projects'] })` (non-exact) therefore also invalidates trees, contents, meshes, plans, etc. of all cached projects on every creation, rename, deletion or collaborator change. `useDeleteProject` does not remove the caches of the deleted project.

## `apps/web/src/features/freesurface/FreeSurfaceTab.test.tsx`
**Covers**: readiness list + measured Z_lid + flat-only lid select, Start disabled on a blocking check, iterations control in the start body, progress stepper (`aria-current`, Solver link, Stop), results table + chart table alternative.
**Technique**: `@/lib/api/projects` mocked, QueryClient without retries, no router.

## `apps/web/src/features/freesurface/FreeSurfaceTab.tsx`
**Role**: The project's `Free surface` tab (WS-I): Setup panel (readiness checks with icon + text, lid / inlet / source-session selects re-querying the checks, measured Z_lid, iterations `SegmentedRadioGroup`, tolerance, Advanced `<details>`, one orange Start), Progress panel (stepper Export → Solve, meshing-session link, Open the Solver tab, Stop), Results panel (status, reason, notes, "Results per iteration" table, fitted STL download, residual chart, figures fetched on demand, delete with confirmation), previous runs list, skeleton and `ErrorState`.
**Exports**: `FreeSurfaceTab({ projectId, onOpenSolver? })`.
**Depends on**: `useFreeSurface.ts`, `ResidualPerIterationChart`, `@/lib/api/projects` (`downloadFreeSurfaceFile`). On a job's end it invalidates `['projects', id, 'files' | 'runs' | 'runnable']`.
**Notes**: visual contract `brain/design/design-system.md` sections 2, 4 and 6.

**Scroll + loading (2026-09-30)**: root (`data-tab-root`) scrolls on `lg` like `SolverTab`; `FreeSurfaceSkeleton` shows a `Loader2` spinner "Checking the mesh and the last run…"; `updating = isFetching && isPlaceholderData` shows "Updating the checks…" (role `status`) next to the title after a selection change, never on job polls.

## `apps/web/src/features/freesurface/ResidualPerIterationChart.tsx`
**Role**: Hand-made SVG of the lid residual RMS per iteration (Parent, It. 1..n) with the tolerance as a dashed line, direct value labels, `role="img"` summary and a "Show residual values" `<details>` table. **Exports**: `ResidualPerIterationChart({ surfaces, tolRmsMm })`.

## `apps/web/src/features/freesurface/useFreeSurface.ts`
**Role**: TanStack Query hooks of the Free surface tab. **Exports**: keys `freeSurfaceQueryKey`, `freeSurfaceOverviewQueryKey(projectId, selection)`, `freeSurfaceJobQueryKey(projectId, jobId)`; `useFreeSurfaceQuery` (keepPreviousData, polls 2 s while a job runs), `useFreeSurfaceJobQuery` (polls while running or without data), `useStartFreeSurface` (sets the job, invalidates the overviews), `useStopFreeSurface`, `useDeleteFreeSurface`.

## `apps/web/src/features/optimisation/OptimisationTab.tsx`
**Role**: the project's Optimisation tab (WS-H): studies list (status badge, counted / max), the shown study (`StudyPanel`, running one first) or the inline `StudyCreateForm` (create / edit draft); skeleton, `ErrorState`, empty state with "New study".
**Depends on**: `useStudies`, `useChamberSavesQuery`. **Used by**: `pages/ProjectDetailPage.tsx` (view `optimisation`).

**Layout (2026-09-30 redesign)**: `lg` = fixed-height column (header `shrink-0`, then a `16rem | 1fr` grid, `18rem` at `xl`): the studies list and the detail pane scroll independently (`lg:overflow-auto`), the list header is sticky with the study count; below `lg` everything stacks and the page scrolls.

## `apps/web/src/features/optimisation/StudyCreateForm.tsx`
**Role**: inline create / edit form: study name, base design (chamber save or chamber of this mesh), parameters table with live range preview (`computeParamSpace`, per-key band, table limit note, relation warnings), objective (weighted / Pareto, weights, vortex metric), reference session, cores, budgets, Advanced (sampler, seed, keep best / last). Client validation mirrors the API; first invalid control focused. One orange CTA ("Create study" / "Save changes").

**Fieldsets (2026-09-30)**: `min-w-0` on every fieldset (default `min-inline-size: min-content` let the 560 px parameters table overflow the card); the form is shown full width by `OptimisationTab` (list hidden while it is open).

## `apps/web/src/features/optimisation/StudyCreateForm.test.tsx`
**Covers**: band preview on the grid, table limit, zero weights refused, Pareto hides the weights, create body.

## `apps/web/src/features/optimisation/StudyPanel.tsx`
**Role**: one study: status badge (`StudyStatusBadge`, exported), owner-only controls (Start / Resume orange, Pause, Edit, Delete with confirmation), Export CSV, running evaluation stepper (Build, Mesh, Transfer, Configure, Solve) with session link and Solver tab button, search space, best design with "Open in Chamber" (router state `chamberInput`), evaluations table, charts.

**Redesign (2026-09-30)**: `StudySummary` (`<dl aria-label="Study summary">` on hairlines: evaluations counted / budget, best objective or Pareto front size, lowest head loss and lowest vortex metric with `#k` and the change vs the baseline, or "the baseline"); order = progress, best design, charts (`ChartPanel`, side by side at `xl`), evaluations table, search space. "Open Solver tab" is a secondary button. Table headers are two-line (`HeaderLabel`: quantity then unit), notes `line-clamp-2` with the full text in `title`.

## `apps/web/src/features/optimisation/StudyPanel.test.tsx`
**Covers**: stepper of the running evaluation + Pause, owner Start and read-only member, evaluations table (infeasible reason, budget flag, best), chart table alternatives.

## `apps/web/src/features/optimisation/StudyCharts.tsx`
**Role**: hand-made SVG `ObjectiveChart` (objective per evaluation, best-so-far step line, diamond for the best) and `ParetoChart` (head loss against the picked vortex metric, front joined), each with a "Show … values" table.

**Responsive (2026-09-30)**: width measured with `useMeasuredWidth` (min 320 px, horizontal scroll below), fixed 240 px height; objective x axis = integer `niceTicks` on a regular step (one per evaluation while about 44 px each fit), Pareto x ticks scale with the width.

## `apps/web/src/features/optimisation/studyFormat.ts`
**Role**: `VORTEX_METRIC_LABEL` (name + unit per metric) and `vortexOf(evaluation, metric)`.

## `apps/web/src/features/optimisation/useStudies.ts`
**Role**: React Query hooks: keys `['projects', id, 'studies', 'list' | 'setup' | 'detail', studyId]`, `useStudiesQuery` / `useStudyQuery` (poll 3 s while running or pausing), `useStudySetupQuery`, `useCreateStudy`, `useUpdateStudy`, `useStudyControl` (start / stop / resume), `useDeleteStudy`, `isStudyActive`.
