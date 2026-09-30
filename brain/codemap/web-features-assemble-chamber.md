# Codemap: web features: assemble + chamber

> Scope: `apps/web/src/features/assemble/**`, `apps/web/src/features/chamber/**` · Updated: 2026-09-28

## Overview
Two independent frontend features.
**Assemble** ("Assemble" tab of `ProjectDetailPage`, loaded with `lazy`): `AssemblyWorkspace` orchestrates three panes (`PartsRail` on the left, the three.js `AssemblyViewer` in the center, `PlacementPanel` on the right), then `AssemblyMergeDialog` (interfaces, confirmation, report via `MergeRunReport`) posts a `MergePlan` to `POST /projects/:id/meshes/merge`. `AssemblyManagePanel` ("Disassemble") replays a reduced plan or undoes the applied assembly. Key principle: **placement is optional**. A coupling (part patch ↔ base patch) never moves the part; only an explicitly repositioned part produces a `transforms` entry. All the placement math lives in `placement.ts`, in raw polyMesh coordinates, to guarantee preview == server parity (fixture shared with `apps/api/tests/meshTransform.test.ts`). The base can be the case mesh (`MERGE_BASE_CASE` = `'__case__'`) or the first part of the library.
**Chamber** (page `pages/ChamberPage.tsx`, out of scope, which owns the react-hook-form instance): `chamberForm.ts` defines the form contract (zod, defaults, save → form mapping, canonical anti-"stale" key, Gen Dim v3 auto hints); `ChamberInputsForm` (presentational) and `ChamberOutputsTable` (12 parameters + Min/Max/Exact constraints) edit; `useBuildChamber` posts `POST /chamber/build`, which returns a `hash`; `ChamberViewer`, `ChamberExportButtons` and `SendToMeshingDialog` consume this hash; `ChamberBuildWarnings` displays errors/warnings; `ChamberSavesMenu` manages team-shared saved builds.

## `apps/web/src/features/assemble/AssemblyManagePanel.test.tsx`
**Covers**: empty render without an applied assembly; "Remove" posts a reduced `MergePlan` (order, interfaces and transform of the removed part dropped) to `runMerge` and displays the report (`Mesh OK.`); "Undo assembly" opens an `alertdialog` then calls `restoreMeshBackup('p1')`; no Undo button when `baseIsCase: false`.
**Technique**: `vi.mock` of `@/lib/api/meshes` and `@/lib/api/projects` (the real logic of the `useMeshes` hooks runs), `QueryClient` with `retry: false`, `AppliedAssembly` fixture with base `'__case__'` and two parts (`p2` transformed, `p3` not).
**Notable cases**: the "renders nothing" test waits for a simple `await Promise.resolve()` before `toBeEmptyDOMElement`.

## `apps/web/src/features/assemble/AssemblyManagePanel.tsx`
**Role**: "Disassemble" surface inserted into the `AssemblyWorkspace` toolbar. Only appears if an assembly is applied with at least one added part. Lets the user remove a part (rebuild from a reduced plan) or undo the whole assembly (restore of the pre-merge backup, offered only if `assembly.baseIsCase`).
**Exports**:
- `AssemblyManagePanel({ projectId })`. Reads `useAssemblyQuery` and `useMeshesQuery`; local state `result`, `pendingSteps`, `removingId`, `confirmUndo`. `addedIds` = `plan.order.slice(1)` without the sentinel. `reducedPlan(removeId)` filters `order`, `interfaces` (side A or B) and `transforms`. `handleRemove` computes the preview via `buildPipelinePreview` then `useReapplyAssembly().mutateAsync(plan)`; toasts `Part removed from the assembly.` / `Rebuild failed. See the report.`. `handleUndo` via `useUndoAssembly`; the `AlertDialogAction` calls `preventDefault` to stay open during the restore. Inline report via `MergeRunReport`.
- identical default export.
**Depends on**: `@/features/projects/useMeshes` (`useAssemblyQuery` key `['projects', id, 'assembly']` on `GET /projects/:id/meshes/assembly`; `useReapplyAssembly` = `runMerge`; `useUndoAssembly` = `restoreMeshBackup`), `MergeRunReport`, `MERGE_BASE_CASE`. **Used by**: `AssemblyWorkspace`.
**Notes**: invalidations (defined in `useMeshes`, out of scope): on reapply success, `setQueryData` of `caseFilesQueryKey`, `removeQueries` of the case manifest/geometry/edges and of file contents, `invalidateQueries` of `meshes`, `mergePlan`, `assembly`; undo adds the invalidation of the backup and puts the restored manifest in the cache. A `success: false` result triggers no invalidation (the mutation still resolves). `sourceFor` fabricates a dummy `MeshSource` for an unknown id or the sentinel (name `Project case mesh`).

## `apps/web/src/features/assemble/AssemblyMergeDialog.tsx`
**Role**: three-step merge dialog (`'connections' | 'confirm' | 'run'`) opened by the workspace's orange "Merge" CTA. Interface editor pre-filled with the workspace couplings, confirmation with a pipeline preview, then execution and report.
**Exports**:
- `AssemblyMergeDialog({ projectId, orderedMeshes, transforms, seedInterfaces?, onClose })`. Keeps `interfaces` (seed filtered by `isComplete`), `step`, `result`. `handleRun` posts `{ order: orderedMeshes.map(id), interfaces: completeInterfaces, transforms }` via `useRunMerge`; on exception returns to `confirm`. The `Dialog` does not close during execution.
- `InterfaceDraft` (type): `{ aMeshId, aPatch, bMeshId, bPatch, coupling }`.
- internal subcomponents: `ConnectionsStep` (add/remove rows, "Continue" blocked if a row is partial), `InterfaceRow` (two `SidePicker` + coupling `SegmentedRadioGroup`), `SidePicker` (part select + patch select, ids `aiface-<row>-<side>-mesh|patch`), `ConfirmStep` (list of parts, number of positioned parts, interfaces with `CouplingChip`, planned pipeline), `CouplingChip`.
- internal constants: `DEFAULT_COUPLING = 'nonConformal'`, `COUPLING_OPTIONS` (`Non-conformal` / `Conformal stitch`), `COUPLING_HELP`, `COUPLING_CHIP`.
**Depends on**: `useRunMerge` (`useMeshes`), `RunStep` + `buildPipelinePreview` (`MergeRunReport`), `MERGE_BASE_CASE`. **Used by**: `AssemblyWorkspace`.
**Notes**: `useRunMerge` on success: `setQueryData(caseFiles)`, `removeQueries` of the case manifest, then the same invalidations as reapply (the Disassemble panel then appears). The confirmation text differs by base: case base, backup + `0/` preserved; library base, "overwrites… cannot be undone". The header comment says the dialog opens "once at least one part has been positioned" whereas the CTA is active as soon as `orderedMeshes.length >= 2` (positioning not required). `helpId` is set on the help paragraph but is referenced by no `aria-describedby`.

## `apps/web/src/features/assemble/AssemblyViewer.tsx`
**Role**: three.js canvas of the Assemble tab. A single scene: the base (opaque, color `--color-neutral`, the only clickable body), the other parts as blue ghosts (`--color-primary-light`, opacity `0.28`), the active part as a `--color-primary` ghost (opacity `0.4`, excluded from framing). The chosen base patch is highlighted in `--color-accent`. A `TransformControls` (gizmo) moves the active part when repositioning is enabled.
**Exports**:
- `AssemblyViewer(props: AssemblyViewerProps)`. Props: `base`, `placed`, `active`, `activeTransform`, `matingPatch`, `target`, `reposition`, `gizmoMode`, `onPickBaseFace`, `onTransformChange`, `onAlignTransform`, `onError?`. Detects WebGL (`detectWebgl`, message "3D rendering isn't available" otherwise). A `useEffect` builds the scene on each change of `sceneKey` (set of bodies + transforms of the placed parts + buffer lengths); three lightweight effects call through refs `applyActiveTransform` (value key `activeTransformKey`), `applyGizmo` (`reposition`, `gizmoMode`, active id) and `applyHighlightAlign` (`matingPatch`, `target`, active id). On-demand rendering (`requestAnimationFrame` only on change), `OrbitControls` with damping disabled under `prefers-reduced-motion`, suspended during a gizmo drag. Click (pointer movement ≤ 6 px) on the base: raycast then `onPickBaseFace(targetFromHit(...))`. Help bubble at the top left, "Reset view" button at the top right.
- `AssemblyViewerError({ onRetry })`. Error block "Could not load the 3D geometry.".
- types `ViewerPart`, `PlacedViewerPart`, `GizmoMode` (`'translate' | 'rotate'`), `AssemblyViewerProps`.
**Depends on**: `placement.ts` (`anchorFromPatch`, `bakedRootTransform`, `computePlacement`, `targetFromHit`), `three` + `OrbitControls`/`TransformControls`/`GLTFLoader`. **Used by**: `AssemblyWorkspace` (mocked in its test).
**Notes**: parity. Each part is wrapped in a group whose matrix is the inverse of the Z-up→Y-up flip baked into the GLB, so the local position/quaternion of the placement group **is** the raw `(t, q)` sent to the server; the base flip is reapplied only once on `contentRoot` for display. `applyHighlightAlign` computes the "align to face" suggestion (`computePlacement` with roll 0 and offset 0) and emits it via `onAlignTransform` (or `null`). During a drag, `applyActiveTransform` is ignored so as not to fight the React echo. Full cleanup (dispose of geometries/materials, gizmo, renderer). JSDoc inconsistencies: `placed` is described as "rendered opaque" and `active` as "orange ghost", whereas the code renders them as blue ghosts. `failedRef` is declared but unused. Colors read via `getComputedStyle` on the tokens with a hex fallback.

## `apps/web/src/features/assemble/AssemblyWorkspace.test.tsx`
**Covers**: Merge CTA disabled with a single part; non-destructive note ("backed up… Visualize tab", "cyclicAMI"); coupling then merge **without** a transform (`transforms: []`, `coupling: 'nonConformal'`); a `transforms` entry added only after repositioning; switch to `'stitch'` in the payload; case base by default when `getCaseFiles` contains `constant/polyMesh/…`, with `order` = `['__case__', 'base', 'p2']`.
**Technique**: `AssemblyViewer` mocked by a button stub (`mock pick face` → `onPickBaseFace` on `baseTop`, `mock move part` → `onTransformChange` translation `[1,2,3]`) because jsdom has no WebGL; mocks of `@/lib/api/meshes` and `@/lib/api/projects`; `TooltipProvider` required; `selectAndCoupleRotor` helper.
**Notable cases**: selecting a part goes through the button carrying `aria-pressed`; the `switch` ("Reposition this part") and `radio` ("Conformal stitch") roles are locked.

## `apps/web/src/features/assemble/AssemblyWorkspace.tsx`
**Role**: full-height container of the Assemble tab (named export loaded with `lazy` by `ProjectDetailPage`). Determines the base, the order, the per-part drafts, loads all geometries and derives `seedInterfaces` and `transforms` for the merge dialog.
**Exports**:
- `AssemblyWorkspace({ projectId })` (+ default export). Queries: `useMeshesQuery`, `useMergePlanQuery`, `useCaseFilesQuery`, `useCaseMeshManifestQuery` (enabled only if base = case), and a `useQueries` that loads the geometry of each body (key `caseMeshGeometryQueryKey` for the case, `meshSourceGeometryQueryKey` otherwise; the case query waits for `caseManifest.isSuccess` because the manifest triggers the server build; `retry: false`, `staleTime`/`gcTime` 5 min).
- State: `baseSource` (`'case' | 'library'`), `order` (library ids), `activePartId`, `drafts: Record<id, Draft>`, `gizmoMode`, `alignSuggestion`, `mergeOpen`, `viewerError`.
- internal `Draft`: `{ matingPatch, target, reposition, transform }`; `defaultDraft` = identity transform.
- internal `CanvasArea`: state machine no base → viewer error → build in progress ("Building 3D preview") → geometry error → `AssemblyViewer`. Internal `StageMessage`.
**Depends on**: `useAssembly`, `PartsRail`, `PlacementPanel`, `AssemblyViewer`, `AssemblyMergeDialog`, `AssemblyManagePanel`, `placement` (`eulerDegFromQuat`, `quatFromEulerDeg`), `@/features/projects/useMeshes`, `@/features/projects/useCaseFiles`. **Used by**: `pages/ProjectDetailPage.tsx`.
**Notes**:
- Initial base choice (only once, via `baseInitRef`): if `plan.order[0] === '__case__'` and a case exists, case base; if a plan exists, library; otherwise case if `hasCaseMesh` (a path starts with `constant/polyMesh/`). Forced back to library if the case disappears.
- Order: initialized from `plan.order` (the sentinel is filtered out), then maintained by keeping the existing order and appending new ids. `orderedMeshes` = `[caseBase?, ...library]`, `base = orderedMeshes[0]`, `basePinned` if case base. `moveMesh` shifts the display index by 1 when the case base is pinned. With a library base, the first part can be moved: the base then changes and the cleanup effect deletes the draft of the new base.
- Interactions: picking a face (`handlePickBaseFace`) or a patch (`handleMatingPatch`) never touches `transform`. The gizmo, the numeric fields and "Align to base face" enable `reposition: true`. Turning the switch off resets the transform to identity. `handleResetPosition` resets to identity but leaves the editor open. `alignSuggestion` is cleared on each change of active part.
- `seedInterfaces`: one `nonConformal` interface per part having `matingPatch` and `target.patchName` (side B = base). `transforms`: only if `reposition` and a non-identity transform. `placedIds` ("Placed" badge) = ids with a transform, not the coupled parts.
- `canMerge = orderedMeshes.length >= 2`. The local order is not persisted by this screen outside the merge (no call to `saveMergePlan` here).

## `apps/web/src/features/assemble/MergeRunReport.tsx`
**Role**: shared report of "what the merge pipeline did", used as a step of the merge dialog and inline in the Disassemble panel.
**Exports**:
- `buildPipelinePreview(orderedMeshes, interfaces, meshById): PlannedStep[]`. Planned order: `Prepare <name>` per part, `Combine <name>` (`mergeMeshes`) for each part after the base, `Split combined regions into cellZones` (`splitMeshRegions`) if more than one part, then per interface `Stitch a ↔ b` (`stitchMesh`) or `Couple a ↔ b` (`nonConformalCouple`), `Clean up empty patches`, `Check combined mesh` (`checkMesh`). Comment: "matches the server's steps".
- `PlannedStep`: `{ label, tool? }`.
- `MergeRunReport({ running, result, plannedSteps })`. During execution (or without a result): spinner + planned steps. Afterwards: success banner ("Combined mesh written to constant/polyMesh with N patches") or failure banner ("Failed at “label”. The case mesh was not changed."), notes, chips of the resulting patches, `MergeStepRow` stepper.
- `RunStep({ running, result, plannedSteps, onRetry, onClose })`. Dialog wrapper (titles `Merging` / `Assembly merged` / `Merge failed`), Back button only on failure, Close as `primary` on success.
- default export `MergeRunReport`.
**Depends on**: types `MergeRunResult`, `MergeStep`, `MergeStepKind`. **Used by**: `AssemblyMergeDialog`, `AssemblyManagePanel`.
**Notes**: `MergeLogDisclosure` is open by default for a failed step or for a successful `checkMesh`; displays `$ command`, stdout, stderr (in red). `MergeStatusChip`: icon + word + color (never color alone). Duration formatted as `ms` or `s`.

## `apps/web/src/features/assemble/PartsRail.tsx`
**Role**: left pane. The project mesh library presented as an assembly roster: base selector (if a case mesh exists), ordered list, imports, patch splitting and renaming.
**Exports**:
- `PartsRail(props: PartsRailProps)`. Props: `projectId`, `query` (`useMeshesQuery` result), `orderedMeshes`, `activePartId`, `placedIds`, `basePinned`, `baseSource`, `onBaseSourceChange`, `caseBaseAvailable`, `onSelectPart`, `onMove`. State: `importingKind` (`'folder' | 'zip' | 'file' | null`), `convReport` (failed conversion steps, rendered by `ImportReport`), `name` (optional name of the next part). Three hidden `<input type="file">`: folder (`webkitdirectory`/`directory` set in an effect), `.zip`, `.cgns,.msh`. States: skeleton, error with "Try again", list, empty (`EmptyHint` with a diamond).
- `BaseSource` (type): `'case' | 'library'`; internal `BASE_SOURCE_OPTIONS` (`Project mesh` / `First part`).
- internal subcomponents: `PartRow` (number, `Base` badge, `aria-pressed` selection button for added parts, `Placed` or `Part N` badge, up/down arrows, delete except for the case base; patch editor opened by default if the part has only one patch or none), `PatchEditor` (split by feature angle, default `30`, display of the `autoPatch failed` log), `PatchRenameRow` (inline rename, Enter or button), `EmptyHint`, `RailSkeleton`.
**Depends on**: `useImportMesh`, `useDeleteMesh`, `useAutoPatchMeshSource`, `useRenameMeshSourcePatch` (`@/features/projects/useMeshes`), `ImportReport`, `SegmentedRadioGroup`, `Diamond`. **Used by**: `AssemblyWorkspace`.
**Notes**: the four mutations write the list returned by the server into `['projects', id, 'meshes']` via `setQueryData`. Unlike `useEditMeshSourcePatches`, `useAutoPatchMeshSource` and `useRenameMeshSourcePatch` do not remove the `meshSource…` caches (manifest/glb/edges, 5 min): the GLB shown in the viewer may keep the old patch names after a split or a rename, and `anchorFromPatch` would then not find the new name (align unavailable). To verify. An orphan JSDoc comment ("Top-level folder name of a folder upload") precedes `PartsRail`. The case base shows a simple patch count "from constant/polyMesh" (re-patch in Visualize).

## `apps/web/src/features/assemble/PlacementPanel.tsx`
**Role**: right pane. Coupling of the active part to the base (base patch picked on the canvas + mating patch of the part), then a collapsed "Reposition this part" section (6 DOF) reserved for misaligned parts.
**Exports**:
- `PlacementPanel(props: PlacementPanelProps)`. Props: `activePart`, `baseName`, `matingPatch`, `onMatingPatchChange`, `target`, `onClearCouple`, `reposition`, `onRepositionChange`, `gizmoMode`, `onGizmoModeChange`, `position`, `rotationDeg`, `onPositionChange`, `onRotationChange`, `alignAvailable`, `onAlignToFace`, `onResetPosition`, `isRepositioned`. Without an active part: explanatory empty state. Otherwise: `Coupled` / `Moved` chips, display of the base patch (`aria-live`), `NativeSelect` "Mating patch on <name>" (disabled without patches), "Clear" button, `role="switch"` switch, then gizmo mode selector (`Move` / `Rotate`), two `AxisTriplet` (position in m, step `0.001`, rotation in degrees, step `1`), "Align to base face" (disabled without a suggestion), "Reset to imported position" (disabled if not moved).
- `PlacementPanelProps` (interface). Internal `AxisTriplet` and `roundForInput` (3 decimals in m, 1 in degrees; ARIA labels `Position X in m`, etc.).
**Depends on**: `GizmoMode` (`AssemblyViewer`), `HitTarget` (`placement`), UI primitives. **Used by**: `AssemblyWorkspace`.
**Notes**: no orange CTA here (hierarchy: only the workspace "Merge" is orange). The rotation fields are an XYZ Euler display; the source of truth remains the quaternion.

## `apps/web/src/features/assemble/placement.test.ts`
**Covers**: the client/server **parity proof**. Canonical fixture `q = [0,0,sin45°,cos45°]`, `t = [1,2,3]`, `p = [1,0,0]` → `[1,3,3]` (must stay identical to `apps/api/tests/meshTransform.test.ts`); invariants of `computePlacement` (added normal → `-nT`, anchor placed on `pT + offset·nT`, stable under any roll, near identity if already in place); `anchorFromGeometry` on a unit square (centroid `[0.5,0.5,0]`, normal `+Z` by CCW winding) and chaining into `computePlacement`.
**Technique**: real `three` in Vitest, `applyQt` helper, `toBeCloseTo` tolerances of 8 to 12 decimals.
**Notable cases**: changing the quaternion convention or the application order breaks this test and its API twin together.

## `apps/web/src/features/assemble/placement.ts`
**Role**: placement math critical for parity (spec `ASSEMBLY_SPEC.md` sections 2d/2e cited in a comment). All vectors are in raw polyMesh coordinates (meters); the viewer neutralizes the flip baked into the GLB before calling this module, so that the computed `(q, t)` is exactly the one posted and applied to `constant/polyMesh/points` on the server side (`Matrix4.compose`).
**Exports**:
- `Vec3`, `Quat` (three.js order x,y,z,w), `Anchor { point, normal }`, `HitTarget { patchName, point, normal }`, `Placement { rotation, translation }`.
- `computePlacement(pA, nA, pT, nT, rollRad, offset): Placement`. `q1` brings `nA` onto `-nT`, then roll around `nT` (`q = qRoll * q1`), then `t = pT + offset·nT - q·pA`.
- `anchorFromGeometry(geometry): Anchor`. Area-weighted centroid and normal = normalized sum of the area vectors; falls back to the simple centroid if the total area is ≤ `1e-20`; `{[0,0,0],[0,0,1]}` if fewer than 3 vertices.
- `anchorFromPatch(source, patchName): Anchor | null`. Looks for the mesh whose name (or its parent's) equals the patch, in raw local space.
- `targetFromHit(intersection, baseObject): HitTarget`. Brings the point and face normal from the viewer world back to the base's local frame (rigid transformations assumed, no scale).
- `eulerDegFromQuat(q): Vec3` and `quatFromEulerDeg(deg): Quat`. XYZ Euler display conversion in degrees.
- `bakedRootTransform(loaded): THREE.Matrix4`. `matrixWorld` of the first mesh of the GLB (trimesh Z-up→Y-up flip shared by all patches).
**Depends on**: `three`. **Used by**: `AssemblyViewer`, `AssemblyWorkspace`, `PlacementPanel` (type), `placement.test.ts`.
**Notes**: roll and offset are supported by the formula but the viewer always calls `computePlacement(..., 0, 0)` for the alignment suggestion.

## `apps/web/src/features/assemble/useAssembly.ts`
**Role**: TanStack Query hooks for per-source preview for the Assemble tab and the Visualize viewer. The library/merge hooks (list, import, auto-patch, rename, merge, plan) are in `@/features/projects/useMeshes.ts`, not here.
**Exports**:
- `caseMeshManifestQueryKey(projectId)` = `['projects', id, 'mesh', 'manifest']` and `caseMeshGeometryQueryKey(projectId)` = `['projects', id, 'mesh', 'glb']`. Deliberately identical to the Visualize keys (a single shared server build).
- `useCaseMeshManifestQuery(projectId, enabled)`. `GET /projects/:id/mesh/manifest` via `getMeshManifest`; the first call builds the render on the server side (`isPending` = "building").
- `meshSourceManifestQueryKey`, `meshSourceGeometryQueryKey`, `meshSourceEdgesQueryKey` = `['projects', id, 'meshSource', meshId, 'manifest' | 'glb' | 'edges']`.
- `useMeshSourceManifestQuery(projectId, meshId, enabled = true)` → `GET /projects/:id/meshes/:meshId/manifest`.
- `useMeshSourceGeometryQuery(projectId, meshId, enabled)` → `GET /projects/:id/meshes/:meshId/geometry`, converted to `ArrayBuffer`.
- `useMeshSourceEdgesQuery(projectId, meshId, enabled)` → `GET /projects/:id/meshes/:meshId/edges` (`ArrayBuffer | null`).
**Depends on**: `@/lib/api/meshes`, `@/lib/api/projects`. **Used by**: `AssemblyWorkspace` (keys + `useCaseMeshManifestQuery`), `features/visualize/MeshViewer.tsx` (the three source hooks), `features/projects/useMeshes.ts` (keys, for `removeQueries`).
**Notes**: all with `retry: false` (a build failure is final), `staleTime` = `gcTime` = 5 min. No mutation or invalidation in this file. The source hooks are not used by `AssemblyWorkspace`, which runs its own `useQueries` on the same keys (cache shared with Visualize).

## `apps/web/src/features/chamber/assets/chamber-dimensions.png`
PNG 1319 × 511 (≈ 390 KB): annotated CAD drawings (plan view B Kammer, B1, BF1/BF2, LF1/LF2, LT; section H Kammer, LEB, LEOW, HLE, LE Ø), imported by `ChamberOutputsTable` for the "Dimension reference" legend.

## `apps/web/src/features/chamber/ChamberBuildWarnings.test.tsx`
**Since 2026-09-29** the warning list also carries the semi-spiral width-limit note.
**Covers**: nothing is rendered for a clean build; errors appear in a "Build errors" block; errors and warnings coexist in two blocks; each warning becomes a `listitem` under "Build warnings".
**Technique**: direct render, queries by `alert` role and by text.
**Notable cases**: realistic builder messages (2 × HLE shoulder too high, clamped outlet radius, vane-less STEP fallback).

## `apps/web/src/features/chamber/ChamberBuildWarnings.tsx`
**Role**: notices panel between the preview and the parameter table. Red "Build errors" block (refused build or invalid inputs, persistent copy of the toast) and orange "Build warnings" block (clamps/fallbacks emitted by the builder for a successful build, persisted per build on the API side).
**Exports**: `ChamberBuildWarnings({ warnings, errors = [] })` (+ default). Returns `null` if both lists are empty; `role="alert"` container. Orange header text in `text-accent-strong` to meet AA.
**Depends on**: `lucide-react`. **Used by**: `ChamberPage`.
**Notes**: the list `key`s are the messages themselves (two identical messages would produce a duplicate key).

## `apps/web/src/features/chamber/ChamberExportButtons.test.tsx`
**Covers**: the three exports disabled without a hash then enabled; download via object URL (`getChamberExport(HASH, 'step')`, `revokeObjectURL('blob:mock')`); recovery after failure; `onDownloaded` called only on success; plain STEP without `offerMirror`; STEP menu with "Change rotational direction" (`stepMirrored`) and "Download STEP"; waiting toast shown only once per build.
**Technique**: mocks of `@/lib/api/chamber` and `@/components/ui/sonner`; `URL.createObjectURL`/`revokeObjectURL` stubbed (absent from jsdom); `userEvent` for the Radix menus.

## `apps/web/src/features/chamber/ChamberExportButtons.tsx`
**Role**: downloads of the current build as STL, STEP or OpenFOAM triSurface zip. The endpoints require the bearer, so each export is fetched as a Blob then triggered by a transient `download` anchor.
**Exports**: `ChamberExportButtons({ hash, offerMirror = false, onDownloaded? })` (+ default). `busy` state (kind in progress); `downloadedRef` remembers the kinds already downloaded for the current hash (reset when the hash changes). Internal `EXPORTS`: `stl` → `chamber.stl`, `step` → `chamber.step`, `trisurface` → `chamber-trisurface.zip`; `stepMirrored` variant → `chamber-mirrored.step`.
**Depends on**: `getChamberExport(hash, kind)` = `GET /chamber/:hash/export/:kind` (`@/lib/api/chamber`, type `ChamberExportKind`). **Used by**: `ChamberPage`.
**Notes**: with `offerMirror` (vaned build whose STEP actually carries the vanes), the STEP button becomes a menu; vaned builds defer the STEP export on the server side, hence the `info` toast "Preparing the STEP export…" on the first download of each kind. `onDownloaded` lets `ChamberPage` silently re-POST the body (cache hit) to fetch new warnings, and collapse the menu if the STEP is a vane-less fallback (`stepHasVanes === false`). The object URL is revoked immediately after `click()`.

## `apps/web/src/features/chamber/ChamberInputsForm.test.tsx`
**Corner chamfers at 45° (2026-09-30)**: relations button reads "(7/7 on)" (BF1 / BF2 permanent, out of the menu).
**Semi-spiral (2026-09-29)**: the harness wires `semiSpiral` (watch) and `onSemiSpiralChange` (unticks Feet and Chamfer, as `ChamberPage`); checkbox in both designs, Feet / Chamfer unticked and disabled with the reason, Length hidden, velocity shown, submitted body.
**Covers**: "hollow" fields visible only for `variant: 'hollow'`; rounded hints (`Blank = auto ≈ 2778 mm`, `Blank = 2 × width ≈ 8889 mm`); submission of the defaults with `undefined` overrides; typed override → number, cleared → `undefined`; hollow blocked without a cone length; out-of-range X1 blocked (`role="alert"`); relations counter and "Configure" disabled when the master is off; `Power (kW)` field and its formula in hollow only; "Simplify generator" hides height and dome; submission of `simplifyGenerator` and `x4`; "Cone chamfer" checkbox in both designs, "Cone chamfer size (mm)" (hint "Blank = 50 mm") only when ticked, submission `coneChamferEnabled: true, coneChamferSize: 50` in both designs; "Guide vane count" integer number field (min 8, max 32, step 1, default 16, hint "Guide-vane builds only") in both designs, typing 24 submits the number 24, 7 / 33 / 12.5 / blank block the submit with "Enter a whole number from 8 to 32".
**Technique**: `Harness` that wires `useForm` + `zodResolver(chamberFormSchema)` like `ChamberPage`; fixed `AUTO_DIMS`; `rerender` to change variant (the `defaultValues` are only read on mount, hence fresh mounts when the submitted value matters).

## `apps/web/src/features/chamber/ChamberInputsForm.tsx`
**Semi-spiral (2026-09-29)**: props `semiSpiral?`, `onSemiSpiralChange?`; "Semi-spiral casing" checkbox card after Guide vanes (both designs, `register('semiSpiral', { onChange })`); while ticked, Chamfer and Feet are `disabled` with their reason shown in place of the description, and "Casing flow velocity (m/s)" replaces Length: since 2026-09-30 a **read-only** field (prop `casingVelocity: CasingVelocity`, value to 3 decimals, helper "From B Kammer (N mm), H Kammer and Q_max. Read-only.", the out-of-range refusal as its error).
**Role**: presentational form for the chamber inputs. The parent owns the react-hook-form instance (so that the parameter table recomputes live on the same values) and passes `register`, `errors`, the current variant and the auto values.
**Exports**:
- `ChamberInputsForm({ register, errors, onSubmit, isBuilding, variant, simplifyGenerator, autoLengthMm, autoDims, relationsMaster, relations, onRelationChange })` (+ default). Submit button "Generate chamber" (`loading={isBuilding}`).
- re-export of the `ChamberAutoDims` type.
**Depends on**: `CHAMBER_INPUT_RANGES`, `CHAMBER_RELATIONS`, `CHAMBER_VANE_COUNT_MIN`/`_MAX` (`@dive/shared`, bounds of the Guide vane count number field), `chamberForm` (types), primitives `Field`, `Input`, `NativeSelect`, `DropdownMenu`. **Used by**: `ChamberPage`.
**Notes**:
- **Displayed vocabulary ↔ internal keys**: `variant`: `stepped` = "Closed generator", `hollow` = "With cone" (label "Design"); `x1` = "Runner Ø (mm)", `x2` = "Head (m)", `x3` = "Q_max (m³/s)", `x4` = "Power (kW)"; `lengthOverride` = "Length (mm)"; `dFirst` = "Runner case Ø (mm)"; `dMiddle` = "Guide vanes Ø (mm)"; `hollowLength` = "Cone length (mm)"; `wallThickness` = "Wall thickness (mm)"; `coneChamferEnabled` / `coneChamferSize` = "Cone chamfer" / "Cone chamfer size (mm)"; `centralDiameter` / `centralHeight` = "Generator Ø / height (mm)"; `domeHeight` = "Dome height (mm)"; `relationsMaster` = "Structural relations"; `guideVanes`, `chamferEnabled`, `feetEnabled` = "Guide vanes", "Chamfer", "Feet"; `footAngleDeg` = "Foot angle (°)"; `partScale` = "Part scale (×)"; `vaneCount` = "Guide vane count" (integer number field 8..32, step 1, `valueAsNumber`, just before Vane angle, always visible, hint "Guide-vane builds only"); `vaneAngleDeg` = "Vane angle (°)"; `outletRatio` = "Outlet ratio"; `simplifyGenerator` = "Simplify generator".
- **Auto vs override**: the override fields are registered with `setValueAs: numOrUndef` (empty → `undefined` = auto) and `placeholder="auto"`; their help shows `Blank = auto ≈ N mm` from `autoDims` (or `Blank = auto` if unknown). `lengthOverride`: `Blank = 2 × width ≈ N mm` from `autoLengthMm`. The required fields use `valueAsNumber`.
- Cone chamfer (both designs, since 2026-09-29 WS-C v2): checkbox card right after the main grid, description per design; its size field in its own grid right under it, only when ticked, via the `coneChamferEnabled` prop watched by `ChamberPage`.
- Hollow-only section: Simplify generator, Cone length, Wall thickness, Power (hint `0.9 · 9.81 · Head · Q_max`), Generator Ø; Generator height and Dome height hidden if `simplifyGenerator`. Hidden fields are not unregistered: their values stay in the body sent (the server ignores them outside the variant, to verify).
- Relations: one `DropdownMenuCheckboxItem` per relation (`onSelect` with `preventDefault` to keep the menu open), counter `(n/total on)` forced to 0 if the master is off, trigger disabled.

## `apps/web/src/features/chamber/ChamberOutputsTable.test.tsx`
**Corner chamfers at 45° (2026-09-30)**: BF1 / BF2 rows have no spinbutton, show "= LF1" / "= LF2" and the sr-only read-only text, LF1 / LF2 stay editable; also with the relations master off.
**Semi-spiral (2026-09-29)**: 7 `from spiral` cells and no B1 / LT inputs before Generate, values + Length + quality note after, nothing while off.
**Covers**: prompt when `outputs === null`; collapsed "Dimension reference" legend (`aria-expanded`, image shown/hidden); one row per output with status and relation labels (`= LEB + LEOW`, `= LF1 + LF2`); Min edit → `onConstraintChange('width', 'min', 4000)`; Exact editable on an identity output (`height`); "no effect" tag on LEOW when H Kammer is fixed as Exact, and absent otherwise; confidence pill `Low · 38.9%` visible; 50 mm grid hint; final ≤ 0 flagged "not buildable"; negative input or > 100,000 turned into `undefined`; cleared cell → `undefined`.
**Technique**: real outputs via `computeChamberOutputs` from `@dive/shared` (no mock).

## `apps/web/src/features/chamber/ChamberOutputsTable.tsx`
**Corner chamfers at 45° (2026-09-30, spec corner-chamfer-45)**: rows in `CHAMBER_PERMANENT_RELATION_KEYS` (BF1, BF2) render Min / Max / Exact as `ReadOnlyCell` (sr-only "BF1 exact: read-only, always equals LF1"), Model, Final, Status ("= LF1" / "= LF2") and Confidence as usual; the spiral branch still wins while the spiral is on.
**Semi-spiral (2026-09-29)**: optional prop `spiral { on, summary }`; rows with status `from spiral` render read-only (`ReadOnlyCell`, sr-only "read-only, from the spiral"; Model and Confidence "-", Final "-" while NaN); a read-only Length row after B Kammer and a `SpiralNote` (`role="status"`: "fill in after Generate" or width, B Kammer limit, worst cross-section error and angle).
**Role**: table of the twelve computed parameters (mm) with Min / Max / Exact constraints editable inline. Columns: Parameter, Model (raw regression), Min, Max, Exact, Final (after clamp), Status, Confidence (leave-one-out cross-validation error). Live recomputation by the parent.
**Exports**: `ChamberOutputsTable({ outputs, constraints, onConstraintChange })` (+ default). Local state `legendOpen`. Internal `NumCell`: `type="number"`, accepts only `0 < v ≤ CHAMBER_DIMENSION_MAX_MM`, otherwise reports `undefined`.
**Depends on**: `CHAMBER_DIMENSION_MAX_MM`, `CHAMBER_PERMANENT_RELATION_KEYS` (`@dive/shared`), types `ChamberOutput`, `ChamberConstraint`, `ChamberOutputKey`, `ChamberStatus`, `ChamberConfidence`, PNG asset. **Used by**: `ChamberPage`.
**Notes**: `STATUS_STYLES` covers `within range`, `set exact`, `capped at max`, `raised to min`, `! min>max`, `from relation` (the latter displays `relationLabel`). Tags `refined` (refined from the partner's Exact) and `no effect` (LEOW ignored), each doubled by `sr-only` text. Final ≤ 0 (outside `noEffect`) in red (`! ≤ 0 mm — not buildable`). Small orange text in `accent-strong` (AA). The Final header explains in `title` the 50 mm rounding of the estimates.
**BF confidence (2026-09-30)**: the permanent BF1 / BF2 rows show "-" instead of a confidence pill (their value copies LF1 / LF2).

## `apps/web/src/features/chamber/ChamberSavesMenu.test.tsx`
**Covers**: dropdown disabled without saves; loading → `onLoad(save)`; creation; overwrite when keeping the name of the loaded save (`updateChamberSave('save-mine', { snapshot })`); inline refusal to overwrite a colleague's name ("belongs to Colleague"); Save disabled if `snapshot === null`; rename via the "Saved build actions" menu; Rename/Delete `aria-disabled` on someone else's save but Duplicate allowed (name prefilled with `(copy)`, source snapshot); deletion after confirmation; super-admin allowed everywhere.
**Technique**: mocks of `@/lib/api/chamberSaves` and `useAuth` (mutable `authState` object), `userEvent`, `QueryClient` without retry.

## `apps/web/src/features/chamber/ChamberSavesMenu.tsx`
**Role**: saved-build controls in the Chamber page header: load, Save (create or overwrite by name), Rename / Duplicate / Delete menu. Saves are shared across the team; rename, overwrite and delete are reserved to the author or to `SUPER_ADMIN`; Duplicate creates a copy owned by oneself.
**Exports**: `ChamberSavesMenu({ snapshot, onLoad })`. State `selectedId`, `dialog` (`'save' | 'rename' | 'duplicate' | null`), `deleteOpen`. `submitSave` overwrites the save carrying exactly that name if `canManage`, otherwise returns an inline error message, otherwise creates. Internal `NameDialog`: single field (`maxLength={CHAMBER_SAVE_NAME_MAX}`), name required, inline error, closes if `onSubmit` returns `null`.
**Depends on**: `useChamberSaves`, `useAuth`, `CHAMBER_SAVE_NAME_MAX`. **Used by**: `ChamberPage` (which, on load, calls `reset(chamberInputToFormValues(snapshot))`, restores `constraints` through `chamberInputToConstraints` (BF constraints dropped) and invalidates the displayed build).
**Notes**: the `snapshot` is the current build body (`{ ...values, constraints }`) or `null` if the form is invalid. Name matching is exact (case-sensitive). If deletion fails, the `AlertDialogAction` closes anyway (error toast only).

## `apps/web/src/features/chamber/ChamberViewer.tsx`
**Role**: 3D preview of a build (colored per OpenFOAM patch), reusing `MeshScene` and `PatchTable` from Visualize. Driven by `hash`; loaded with `lazy` by `ChamberPage`.
**Exports**: `ChamberViewer({ hash })` (+ default). `selected` state (patch). Geometry and edges enabled only if the manifest is OK, patches are present and WebGL is available. Internal `CanvasArea`: no hash → no WebGL → manifest in progress → manifest error → no patch → geometry loading → geometry error → `MeshScene` (with `rebuilding={false}` and an `onRebuild` that deselects). `StageMessage`, `StageError` (collapsible `ApiError` details).
**Depends on**: `useChamberManifestQuery`, `useChamberGeometryQuery`, `useChamberEdgesQuery`, `MeshScene`, `PatchTable`. **Used by**: `ChamberPage`.
**Notes**: `detectWebgl` duplicated with `AssemblyViewer`. The welcome message "…plus a length, then Generate…" implies that the length is required whereas it is optional (auto 2 × width).

## `apps/web/src/features/chamber/SendToMeshingDialog.test.tsx`
**Covers**: default "new" mode (name `chamber-<first 8 characters of the hash>`, engine `snappy`), closing and navigation to `/meshing/sess-new`; `cfmesh` engine; existing mode without a selection sends nothing; existing body; copyFrom body with `name: undefined` if empty; dialog left open on failure.
**Technique**: mocks of `@/lib/api/meshing` and of `useNavigate` (`importOriginal`); waits for the `option`s before `fireEvent.change` (an unknown value falls back to `''`).

## `apps/web/src/features/chamber/SendToMeshingDialog.tsx`
**Role**: transfers the build (by `hash`) to a meshing session, in three modes: new session (name + engine), existing session, copy of a session's setup with the geometry injected. Navigates to the target session on success.
**Exports**: `SendToMeshingDialog({ hash, open, onOpenChange })` (+ default). State `mode` (`'new' | 'existing' | 'copyFrom'`), `name`, `engine` (`'snappy' | 'cfmesh'`), `sessionId`, `sourceId`, `copyName`. `buildBody()` produces a `FromChamberBody` (or `null` if no session is chosen → toast "Choose a session first.").
**Depends on**: `useMeshingSessions`, `useTransferChamberToMeshing` (`@/features/meshing/useMeshing`, out of scope), `react-router-dom`. **Used by**: `ChamberPage`.
**Notes**: in `new` mode, a cleared name is sent as is (`''`) without client validation. Engine labels: `snappyHexMesh` / `cfMesh`. Displayed note: patches with the same name replace the existing surfaces, the others are kept.

## `apps/web/src/features/chamber/chamberForm.test.ts`
**Corner chamfers at 45° (2026-09-30)**: an old save's BF relation toggles are dropped by `chamberInputToFormValues` (LF2 toggle kept) and its BF constraints by `chamberInputToConstraints`.
**Semi-spiral (2026-09-29)**: defaults, velocity bounds, Feet refused with the spiral, old-save fallbacks and round trip.
**Covers**: valid defaults; cone length required in hollow only; range guards (`footAngleDeg` 0..180, `partScale` ]0,5], `vaneAngleDeg` 45..55, `outletRatio` 0.35..0.50, `vaneCount` whole number 8..32 with "Enter a whole number from 8 to 32" for 7, 33, 12.5 and NaN); overrides optional but positive; `chamberInputToFormValues` round-trip (complete incl. `vaneCount: 18`, sparse, partial relations, old save without `vaneCount` → 16, saves with 16 / 18 / 24 load as is); `x4` (> 0, ≤ ceiling, `100_001` rejected); `simplifyGenerator`; cone chamfer (foot, both designs: defaults off / 50, old saves off / 50, round trip, `superRefine` "Must be at most Cone length minus Wall thickness (30 mm)", size above the wall accepted, no form bound in Closed generator, ignored when off, 0 refused in both); `chamberBodyKey` insensitive to key order, `undefined` ≡ omitted key, real drift detected (value, nested relation, constraint); `computeChamberAutoDims` (ratios `1.14703` and `0.8` × dLast, `x4 ≈ 618.03` for X2=7, X3=10, generator Ø `1242`, cascade from a typed Ø to height/dome, `x4 = 2000` → Ø `2225`, generator hints `null` if X1..X3 are not finite).
**Technique**: pure Vitest tests on the zod schema and the shared functions of `@dive/shared`.
**Notable cases**: the `chamberBodyKey` block guards against the regression of the "Inputs changed since this build" banner stuck after Generate.

## `apps/web/src/features/chamber/chamberForm.ts`
**Semi-spiral (2026-09-29)**: `semiSpiralToggle(on, current, savedChamfer)` (pure): ticked → `{ feetEnabled: false, chamferEnabled: false }` and remembers Chamfer; unticked → restores the remembered Chamfer (nothing when none, e.g. after loading a save); used by `ChamberPage` with a `useRef` reset on save load; tested in `chamberForm.test.ts`. `semiSpiral` in values, schema (`superRefine` refuses Feet on with the spiral), default false and `chamberInputToFormValues` fallback (old saves load off). **Since 2026-09-30** `spiralFlowVelocity` is no longer a form value (a saved one is dropped on load): `casingVelocity(values, constraints, outputs)` → `CasingVelocity { value, widthMm, error }` derives it live from B Kammer with the shared helpers (`ChamberPage` memo → read-only field of `ChamberInputsForm`, prop `casingVelocity`).
**Role**: form contract of the chamber inputs, separated from the component for fast-refresh. Consumed by `ChamberPage` (useForm + zodResolver, stale build detection, loading of saves, hints) and `ChamberInputsForm`.
**Exports**:
- `ChamberFormValues` (interface): `x1`, `x2`, `x3`, `variant`, `relationsMaster`, `relations`, `footAngleDeg`, `partScale`, `guideVanes`, `chamferEnabled`, `feetEnabled`, `vaneAngleDeg`, `vaneCount` (number, 8..32), `outletRatio`, `simplifyGenerator`, `coneChamferEnabled`, and optional overrides `lengthOverride`, `hollowLength`, `wallThickness`, `dFirst`, `dMiddle`, `x4`, `centralDiameter`, `centralHeight`, `domeHeight`, `coneChamferSize`.
- `chamberFormSchema`. zod: X1..X3 bounded by `CHAMBER_INPUT_RANGES` through `modelRange` ("Must be between 700 and 2,420 mm (the range the model was fitted on)"); `optionalPositive` overrides (> 0, ≤ `CHAMBER_DIMENSION_MAX_MM`, message `Max 100,000 mm` formatted en-US); `x4` ≤ `CHAMBER_X4_MAX`; `superRefine`: `hollowLength` required if `variant === 'hollow'` ("Enter a cone length: the With cone design needs one."); With cone + `coneChamferEnabled` + a size + a Cone length: `coneChamferSize` at most Cone length − Wall thickness (blank wall = 50; "Must be at most Cone length minus Wall thickness (N mm)", mirrors the builder; the Closed generator bound is builder-only).
- `CHAMBER_FORM_DEFAULTS`. `x1: 1450`, `x2: 7.85`, `x3: 8`, `variant: 'stepped'`, relations according to `defaultOn`, `footAngleDeg: 40`, `partScale: 1`, `guideVanes: true`, `chamferEnabled: true`, `feetEnabled: true`, `vaneAngleDeg: 50`, `vaneCount: 16`, `outletRatio: 0.45`, `hollowLength: 200`, `wallThickness: CHAMBER_WALL_THICKNESS_MM`, all other overrides `undefined` (auto), `simplifyGenerator: false`, `coneChamferEnabled: false`, `coneChamferSize: CHAMBER_CONE_CHAMFER_SIZE_MM` (50).
- `chamberBodyKey(body): string`. `JSON.stringify` after recursive key sorting (`sortKeysDeep`). Used by `ChamberPage`: `isStale = hash !== null && lastBuildInput !== null && chamberBodyKey({ ...values, constraints }) !== chamberBodyKey(lastBuildInput)`; needed because `watch()` and the zod output of `handleSubmit` order keys differently, and `undefined` disappears on serialization like an omitted key.
- `chamberInputToFormValues(input: ChamberInput): ChamberFormValues`. Maps a saved snapshot (body of `POST /chamber/build`) to the form; fields with a server default fall back to `CHAMBER_FORM_DEFAULTS`; empty overrides stay empty; `hollowLength` and `wallThickness` are not defaulted (they stay `undefined` on an old save). `relations` only keeps the 7 `CHAMBER_RELATIONS` keys, so an old save's BF1 / BF2 toggles are dropped.
- `chamberInputToConstraints(input: ChamberInput)`. The snapshot's constraints without the permanent BF1 / BF2 keys (`CHAMBER_PERMANENT_RELATION_KEYS`; spec 2026-09-29-corner-chamfer-45), `{}` when none. Used by `ChamberPage` when loading a save.
- `ChamberAutoDims` (interface): `dFirst`, `dMiddle`, `x4`, `centralDiameter`, `centralHeight`, `domeHeight` (numbers or `null`).
- `computeChamberAutoDims(values, dLastFinal): ChamberAutoDims`. `dFirst = CHAMBER_D_FIRST_OVER_LAST × dLast`, `dMiddle = CHAMBER_D_MIDDLE_OVER_LAST × dLast` (if `dLastFinal` is known, provided by `ChamberPage` from the `dLast` output); the generator hints (Gen Dim v3) come from `computeChamberGeneratorDims` of `@dive/shared` called **with** the current overrides (`x4`, `centralDiameter`, `centralHeight`, `domeHeight`): a typed X4 re-picks the frame, a typed Ø re-bases height and dome; the Ø hint remains the value an empty Ø would have (`gen.auto.centralDiameter`), `x4` = `gen.x4Auto`. All `null` if X1..X3 are not finite.
**Depends on**: `zod`, `@dive/shared` (chamber constants, `computeChamberGeneratorDims`, types `ChamberInput`, `ChamberVariant`). **Used by**: `ChamberPage`, `ChamberInputsForm` (types), tests.
**Notes**: the same shared function feeds the hints and the API build (single source). The header comment of `ChamberFormValues` labels several fields "Hollow only" / "Guide-vane builds only": this is a builder-side usage, the schema does not make them conditional.

## `apps/web/src/features/chamber/useChamber.ts`
**Role**: TanStack Query hooks of Chamber Creation. A build is identified by the hash returned by `POST /chamber/build`; manifest, geometry and edges are then loaded by hash.
**Exports**:
- `chamberManifestKey(hash)` = `['chamber', hash, 'manifest']`, `chamberGeometryKey(hash)` = `['chamber', hash, 'glb']`, `chamberEdgesKey(hash)` = `['chamber', hash, 'edges']`.
- `useBuildChamber()`. Mutation `buildChamber(input)` → `POST /chamber/build` (`ChamberBuildResponse`: hash, outputs, `warnings`, `stepHasVanes`…). No invalidation (resources are indexed by hash, hence immutable).
- `useChamberManifestQuery(hash, enabled = true)` → `GET /chamber/:hash/manifest`.
- `useChamberGeometryQuery(hash, enabled)` → `GET /chamber/:hash/geometry` (`ArrayBuffer`).
- `useChamberEdgesQuery(hash, enabled)` → `GET /chamber/:hash/edges` (`ArrayBuffer | null`).
**Depends on**: `@/lib/api/chamber`. **Used by**: `ChamberViewer`, `ChamberPage` (`useBuildChamber`; the silent re-POST after export uses `buildChamberRequest` directly).
**Notes**: queries disabled if `hash === null`, `retry: false`, `staleTime` = `gcTime` = 5 min. The build is synchronous, so the manifest exists as soon as the hash is known.

## `apps/web/src/features/chamber/useChamberSaves.ts`
**Role**: saved-build hooks. A single shared list (small: names + snapshots); each mutation invalidates it.
**Exports**:
- `chamberSavesKey` = `['chamber', 'saves']`.
- `useChamberSavesQuery()` → `GET /chamber/saves` (sorted "newest-updated first" according to the comment).
- `useCreateChamberSave()` → `POST /chamber/saves` `{ name, snapshot }` (also used for Duplicate).
- `useUpdateChamberSave()` → `PUT /chamber/saves/:id` `{ name?, snapshot? }`.
- `useDeleteChamberSave()` → `DELETE /chamber/saves/:id`.
**Depends on**: `@/lib/api/chamberSaves`. **Used by**: `ChamberSavesMenu`.
**Notes**: the three mutations call `invalidateQueries({ queryKey: chamberSavesKey })` in `onSuccess`. TanStack Query passes a context object as the second argument of `mutationFn` (hence the `mock.calls[0][0]` assertions in the tests).
