# Feature · Mesh library, conversion and 3D viewer

> **Status**: in production · **Updated**: 2026-09-29
> **Specs**: no dedicated spec · **Codemaps**: `brain/codemap/api-projects.md` (`conversion.*`, `mesh.*`, `meshes.*`), `brain/codemap/api-lib.md` (`meshImport`, `meshStorage`, `cgnsStorage`, `vizStorage`, `meshSourceVizStorage`, `meshBackupStorage`, `openfoamCase` § rewrites), `brain/codemap/api-scripts.md` (`CgnsToVtk.py`, `extractPatches.py`), `brain/codemap/web-features-projects.md` (`ConvertToFoamFlow`, `ImportReport`, `useConversion`, `useMeshes`), `brain/codemap/web-features-platform.md` (`features/visualize/`)

## 1. Purpose
Brings a mesh into a project and makes it inspectable and editable:
- **CGNS → Foam conversion of the case**: a `.cgns` file of the project becomes the case's `constant/polyMesh`, the rest of the configuration coming from a template.
- **Mesh library**: reusable polyMesh parts (folder, `.zip`, `.cgns`, Fluent `.msh`) stored outside the case under a readable slug, sources for merges and assemblies (`merge-and-assembly.md`).
- **Visualize 3D viewer**: boundary surfaces of the case mesh or of a library part, patch table, bulk renaming and retyping, `autoPatch`, case backup / restore.
Access: any member who can see the project; no action reserved to the owner.

## 2. User journey
**Conversion** (`Convert mesh` in Case files, or `Convert a CGNS mesh` on an empty case): `ConvertToFoamFlow` dialog in 4 steps.
1. `Sources`: list of the project's CGNS files (size, immediate deletion without confirmation), `.cgns` upload; `Continue` locked as long as no CGNS exists.
2. `Picker`: choice of a template (mandatory; empty state with a `/templates` link).
3. `Confirm`: CGNS selector if there are several, reminder that `constant/polyMesh` will be overwritten, preview of the 3 steps (`python3`, `vtkUnstructuredToFoam`, `checkMesh`).
4. `Run`: "Converting" (not live), then a per-step report (status, exit code, duration, expandable log, open by default on failure and for `checkMesh`), notes, buttons `Back` (failure), `Open files` (success), `Close`.

**Library**: two import points, same API.
- `Sources` step of `MergeMeshesFlow` (Case files → `Merge meshes`) and left rail `PartsRail` of the `Assemble` tab.
- Optional `Name` field for the next part, buttons `Import folder`, `Import .zip`, `.cgns,.msh` file. A conversion failure shows `ImportReport` inline (steps, logs).
- Per part: immediate deletion, `N patches` toggle opening an editor (split by feature angle, default 30°, inline rename with Enter); in `PartsRail` the editor opens automatically if the part has only one patch.

**Visualize** (tab of `/projects/:id`, active if the case has a `constant/polyMesh/` or if the library has at least one part; otherwise tooltip "Import a polyMesh or a mesh part to enable 3D"):
- `Mesh` selector (shown from two targets on): the case mesh (default) or a part (note "Library part, edited independently of the case mesh.").
- Left panel: `Name` / `Type` / `nFaces` table linked to the 3D selection (click or Enter / Space, clicking again deselects), buttons `Edit names & types` and `Auto-patch` (rebuilding the render is only offered through `Try again` on error states). For the case only: `BackupBar` ("Original saved …" / "Backup saved …", `Save backup` or `Overwrite backup`, confirmed `Restore from backup`).
- three.js scene: neutral patches, selection in orange, others at 12 % opacity, real cell edges (`Show/Hide mesh edges`), `Reset view`, on-demand rendering.
- States: no WebGL, "Building" (first call = server build), manifest error (`NO_MESH`, `MESH_BUILD_FAILED`) with details and `Try again`, empty, geometry loading / error.
- `EditPatchesDialog`: one row per patch (name + type); types `patch`, `wall`, `symmetry`, `symmetryPlane`, `empty`, `wedge`, plus the `inlet` / `outlet` roles for the case only; only modified rows are sent, in one request.
- `AutoPatchDialog`: angle 0 to 180 (default 45), warns that `boundary` is rewritten in place; a tool failure leaves the dialog open with command, code and log.

## 3. Business rules and invariants
- **CGNS upload**: `.cgns` extension and non-empty content, otherwise 400 `INVALID_CGNS`; name flattened to a sanitized basename; stored in `cgns/`, outside the case (survives the reset).
- **Conversion**: template and CGNS must exist (404). The template is applied without overwriting existing files; if `system/controlDict` is missing, the minimal base files are generated. Short-circuit at the first failure (following steps `skipped`); an exit 0 with no VTK produced is requalified as `failed`. A tool failure never throws: 200 response with `success: false`. No rollback of the mesh.
- **Library import**: priority `meshFile` (`.cgns` / `.msh`), then `archive` (zip), then `files` (folder); nothing → 400 `NO_FILES_UPLOADED`. Name = `name` field, otherwise the file name without extension, the zip's name or the root folder's name (excluding `polyMesh`), default "Imported mesh".
- **Slug**: `slugifyMeshName` (NFKD, without diacritics, lowercase, non-alphanumerics to `-`, fallback `mesh`), uniqueness via suffix `-2`, `-3`. The id is the folder name and never changes (part renaming does not exist).
- **Validity**: folder or zip without `constant/polyMesh/boundary` → source deleted and 400 `NO_MESH`. Converted file: the source is kept only if all steps succeed AND `boundary` exists; otherwise it is deleted and the report is returned (200). Unsupported format → 400 `NO_MESH`.
- **From a meshing session** (WS-F, `POST /projects/:id/mesh/from-meshing`, Visible access): `target: 'library'` adds a part of kind `meshing` (`meta.json` `origin.sessionId`), name = `name` or the session name, same slug rules; the mesher's patch types are kept, only a zero-face `domainBoundary` is dropped. `target: 'case'` (default) replaces the case mesh: `original` backup if the case is not empty, chamber patch types forced (`CHAMBER_PATCH_TYPES`), zero-face `domainBoundary` dropped, applied assembly cleared, minimal `system/` + `0/U`, `0/p` scaffolded when there is no `system/controlDict`, `0/` fields realigned in `merge` mode (BCs of surviving patches kept). 409 `RUN_IN_PROGRESS` on `case` while a solver run is queued/running; 409 `MESH_IN_PROGRESS` / `MESHING_NOT_MESHED` for a busy or unmeshed session. Details: `brain/features/meshing.md` §3.
- **Source normalization**: every path is brought back under `constant/polyMesh/` (after the last `polyMesh` segment). A part's `0/` is not kept.
- **Patch names**: regex `^[A-Za-z_][A-Za-z0-9_-]*$` (dash accepted for Fluent zones; 80 characters max on the case's single-patch route `patches/rename`); collision → 409 `PATCH_EXISTS`; unknown name → 404.
- **Case editing**: renaming carried over into `boundary` and into the `boundaryField` of every file ≤ 2 MB. Retyping: an `inlet` / `outlet` role keeps the geometric type `patch` and sets a generic preset in the `0/` fields; `wall` sets `noSlip` and the turbulence model's wall functions; a constraint type is copied as is; going back to `patch` restores `zeroGradient`. Bulk editing is all-or-nothing, renames without intermediate collision (swapping two names is possible).
- **Source editing**: rewrites only its `boundary` (no fields), types limited to `MESH_PATCH_TYPES`, without backup.
- **autoPatch**: `boundary` first collapsed to a single patch (numbering from `auto0`), empty patches removed after success, original `boundary` restored on failure. On the case: `0/` fields realigned (`syncBoundaryFields` in `rebuild` mode, existing BCs discarded).
- **Backup**: single slot `backups/`; `original` taken automatically before the first bulk edit, autoPatch, BC application or merge; `manual` on request (overwrites the slot, keeps `createdAt`). Restoring replaces the whole `case/`, clears the applied assembly record and rebuilds the render.
- **Render**: cache invalidated by mtime (`boundary` or `points` newer than the GLB, or GLB / `edges.bin` missing). The type in the case manifest is corrected from `boundary` (the extractor writes `?` on long names).

## 4. Technical flow

### CGNS conversion of the case
`ConvertToFoamFlow` → `useCgnsFilesQuery` / `useUploadCgns` / `useDeleteCgns` (`GET|POST|DELETE /projects/:id/cgns`) → `conversion.service` → `cgnsStorage`.
`useConvertToFoam` → `POST /projects/:id/cgns/convert` (`{ cgnsFile, templateId }`) → `convertCgnsToFoam`:
1. `applyTemplate` (note "Applied template …"), `scaffoldCase` if there is no `controlDict`.
2. `cgnsToVtk`: `CGNS_PYTHON_BIN CgnsToVtk.py <cgns> <vtk>` (legacy VTK 4.2, topology only, never under `pvpython`), cwd = `cgns/`.
3. `vtkToFoam`: `VTK_TO_FOAM_BIN -case <caseDir> <vtk>` via `planOpenfoamCommand`.
4. `checkMesh`: `CHECK_MESH_BIN -case <caseDir>`.
5. `finalize`: `verifyCase` + tree. The hook writes the tree, purges the case's contents and 3D render, invalidates `meshes` / `assembly` / `mergePlan` (H6), even with `success: false`.

### Library import
`useImportMesh` (`{ kind: 'folder' | 'zip' | 'file', …, name? }`) → `POST /projects/:id/meshes/import` → `importMeshController` → `meshes.service.importMesh`:
- folder / zip: `meshStorage.importMeshFolder` / `importMeshArchive` (normalized tree + `meta.json`), then check of the `boundary`.
- file: `importMeshFromFile` → `uniqueMeshId`, upload to `.src/source.<ext>`, `meshImport.convertMeshFileToCase`: minimal `system/` trio, then `.cgns` = `CgnsToVtk.py` + `vtkUnstructuredToFoam` + `checkMesh`, `.msh` = `FLUENT_TO_FOAM_BIN <msh> -case <dir> [-scale s]` + `checkMesh`. Success: `.src/` deleted, `meta.json` written.
- Response `{ mesh?, meshes, conversion? }`; the hook writes `['projects', id, 'meshes']`.
- Meshing session: see `brain/features/meshing.md` §4 (Send to project); staging under `meshes/.work/from-meshing-<ts>-<rand>/`, removed in a `finally`; the case is replaced through `caseStorage.replaceCasePolyMesh` (shared with the merge promote).
- `MeshSource.kind` (`folder` | `zip` | `cgns` | `msh` | `meshing`) is now on the wire (`GET /meshes`); the web does not display it yet.
- Others: `GET /meshes`, `DELETE /meshes/:meshId`, `GET /meshes/:meshId/patches`, `POST /meshes/:meshId/auto-patch` (temporary `system/` trio written then deleted), `POST /meshes/:meshId/patches/rename`, `PUT /meshes/:meshId/patches` (bulk edit).

### Case viewer
`VisualizePanel` → `MeshViewer` (`target = { kind: 'case' }`) → `useMeshManifestQuery` → `GET /projects/:id/mesh/manifest` → `mesh.service.getMeshManifest`: 409 `NO_MESH` without the 5 polyMesh files; if `vizIsStale`, `buildViz` synchronously runs `MESH_PYTHON_BIN extractPatches.py <caseDir> <glb> <manifest>` (timeout `MESH_BUILD_TIMEOUT_MS`), which writes `viz/patches.glb`, `viz/manifest.json` and `viz/edges.bin` (missing script → 500 `SCRIPT_MISSING`, failure → 502 `MESH_BUILD_FAILED`). Only then `GET /mesh/geometry` (GLB, 409 `MESH_NOT_BUILT` before build) and `GET /mesh/edges` (404 if absent). `POST /mesh/rebuild` forces the rebuild.
Edits: `useEditPatches` → `PUT /mesh/patches` (`editMeshPatches`, with backup); `useAutoPatch` → `POST /mesh/auto-patch` (`autoPatchMesh`, with backup, `scaffoldCase` if there is no `controlDict`). The single-patch routes `POST /mesh/patches/rename` and `POST /mesh/patches/type` still exist (without backup) but their hooks are no longer used.
Backup: `GET|POST /mesh/backup`, `POST /mesh/backup/restore` (`restoreBackup`, `clearAppliedAssembly`, `buildViz`).

### Part viewer
`MeshViewer` (`target = { kind: 'source', meshId }`) → `useMeshSourceManifestQuery` / `useMeshSourceGeometryQuery` / `useMeshSourceEdgesQuery` (`features/assemble/useAssembly.ts`) → `GET /projects/:id/meshes/:meshId/{manifest,geometry,edges}` → `ensureMeshSourceViz`: same script, cache under `meshes/<meshId>/.viz/`. The geometry triggers the build by itself (used alone by Assemble); missing edges → 204.

### 3D scene
`MeshScene` (exported, reused by `chamber/ChamberViewer` and `meshing/MeshResultViewer`): `GLTFLoader.parse`, Lambert material, edges from `edges.bin` (`edgeOffset` / `edgeCount` from the manifest) otherwise fallback `EdgesGeometry`, caps `EDGE_BUILD_CAP` / `EDGE_SHOW_CAP`, raycast on click only.

## 5. Data and storage
Under `<STORAGE_DIR>/projects/<id>/` (details: `brain/architecture/storage-layout.md`):
- `cgns/<name>.cgns` (+ hidden intermediate `.vtk`); `case/constant/polyMesh/` (case mesh);
- `meshes/<slug>/{meta.json, constant/polyMesh/, system/?, .src/?, .viz/}`; `meshes/.work/from-meshing-*` (transient staging of the meshing hand-off);
- `viz/{patches.glb, manifest.json, edges.bin}` (case render, survives the reset);
- `backups/{case/, mesh-backup.json}` (single slot, not atomic).
No Prisma model. TanStack caches (`retry: false`, `staleTime` / `gcTime` 5 min): `['projects', id, 'mesh', 'manifest' | 'glb' | 'edges' | 'backup']`, `['projects', id, 'meshSource', meshId, 'manifest' | 'glb' | 'edges']`, `['projects', id, 'meshes']`, `['projects', id, 'cgns']`. The pattern is to remove (`removeQueries`) manifest, GLB and edges after any change to the mesh.

## 6. Configuration and external dependencies
- `CGNS_PYTHON_BIN` (python3 + `vtk` wheel, never `pvpython`), `CGNS_TO_VTK_SCRIPT`; `VTK_TO_FOAM_BIN` (`vtkUnstructuredToFoam`), `CHECK_MESH_BIN`; `FLUENT_TO_FOAM_BIN` (`fluent3DMeshToFoam`), `FLUENT_TO_FOAM_SCALE`; `AUTO_PATCH_BIN`; `CONVERSION_STEP_TIMEOUT_MS` (10 min per step, also for autoPatch).
- `MESH_PYTHON_BIN` (pyvista, trimesh, numpy; `python` on Windows), `EXTRACT_PATCHES_SCRIPT`, `MESH_BUILD_TIMEOUT_MS` (10 min).
- `OPENFOAM_BASHRC`: if defined, every OpenFOAM binary runs inside `bash -c 'source … && exec "$@"'`; Python scripts are launched directly.
- Missing tool: step `failed` with `[runner]` / "not found" in the report; for the viewer, 502 `MESH_BUILD_FAILED` shown with details.

## 7. Tests
- API `conversion.test.ts`: CGNS upload / list / deletion, 3-step pipeline, template note, scaffold if there is no `controlDict`, short-circuit, missing binary, 404, super-admin.
- API `mesh.test.ts`: manifest (409, on-demand build, corrected type, cache, 502, 404), geometry / edges, rebuild, rename, type (constraint, `wall` + wall functions, roles), auto-patch (argv, collapse, restore, `0/` realignment, out-of-range angle 422), bulk edit (name swap, 409, 422), backup and restore.
- API `meshes.test.ts`: folder import (slug, 400 `NO_MESH`), `.cgns` / `.msh` import (`rotor`, `rotor-2`, failure without source), auto-patch and rename of a source, retyping of a source, per-source render (geometry before manifest, 204 on edges).
- API `openfoamCase.test.ts` (`collapseBoundaryToSinglePatch`, `removeEmptyBoundaryPatches` incl. the `only` filter, `forceChamberPatchTypes`, `fieldBcBody`).
- API `meshFromMeshing.test.ts`: the meshing -> project hand-off (both targets).
- Web `ConvertToFoamFlow.test.tsx`, `MergeMeshesFlow.test.tsx` (import with name, conversion report, split and rename), `VisualizePanel.test.tsx` (case / source target, edit and auto-patch routed to the right API, C4), `PatchTable.test.tsx`.
- `conversion.test.ts` and `meshes.test.ts` fail locally if `.env` defines `OPENFOAM_BASHRC` (see `known-issues.md` § 8); green in CI.

## 8. History
- 2026-06-23: CGNS + "Convert to Foam" added (`brain/changelog/2026-06.md`).
- 2026-06-24: Visualize tab (port of `patch_viewer.py`), patch renaming, `autoPatch`, viewer fixes; `CgnsToVtk.py` without `paraview.simple` (`2026-06.md`).
- 2026-06-25: CGNS chain operational (python3 + vtk, legacy VTK 4.2); bulk patch editing + backup / restore (`2026-06.md`).
- 2026-06-30: multi-mesh library, `.cgns` / `.msh` import, readable slug, import unified on the library (removal of direct mesh import into the case), `Name` field, re-splitting of a part (`2026-06.md`).
- 2026-07-01: source geometry built on demand; library parts visible and retypable in Visualize (`2026-07.md`).
- 2026-07-03: dashed names accepted, `?` types corrected from `boundary`, inlet / outlet roles (`2026-07.md`).
- 2026-07-10: H6 (3D caches after merge / convert / reset) (`2026-07.md`).
- 2026-09-29: meshing session -> project (case or library part, kind `meshing`) (`2026-09.md`).

## 9. Known limits and bugs
- M1: no "active run" guard on conversion, autoPatch, patch editing, restore.
- M4: backup slot destroyed before replacement; `restoreBackup` can empty the case on a partial slot.
- M19: `extractPatches.py` loads the whole volume (possible OOM / timeout); M24: dashed patch names wrongly indexed in the manifest.
- K2: `renameMeshPatch` and `setPatchType` do not write a backup; K3: missing edges = 404 (case) but 204 (source); K7: stale JSDoc (`editPatchesSchema`, name message without the dash).
- K17: `useConvertToFoam` rewrites the caches even on failure; `useImportCase` does not purge the render.
- K18: split and rename of a source do not purge its render (old names visible for 5 min).
- K26: `useRenamePatch` / `useSetPatchType` dead; manifest / GLB keys duplicated between `useMesh.ts` and `useAssembly.ts`.
- K28: `MeshViewer`'s `Restore` not disabled during the restore.
- L10: `uniqueMeshId` not atomic; L13: rebuild loop if `edges.bin` cannot be written; L15: empty angle field accepted as 0°; L19: no handling of WebGL context loss; L21: GLB materials never released, silent `useRebuildMesh` failure, `EditPatchesDialog` reset by a refetch.
- Findings of this sheet (code reading, not reproduced): a source's manifest is not corrected from its `boundary` (possible `?` type, unlike the case); a source's `autoPatch` deletes its `system/` folder, including the one written by the conversion of a `.cgns` / `.msh`.

## 10. Changing this feature
- Any write into `constant/polyMesh` (case or source) must purge the three corresponding render caches on the front end; on the server, invalidation relies only on the mtime of `boundary` / `points`.
- `extractPatches.py` is called by three services (`mesh`, `meshes`, `meshing`) and its transport (GLB + manifest + `edges.bin` alongside) is reproduced by `buildChamber.py`: do not change the format without all four.
- The patch name regex lives in four places (`isValidPatchName`, `renamePatchSchema`, `EditPatchesDialog`, source validation): keep them aligned.
- A new destructive action on the case must call `ensureOriginalBackup` before writing and invalidate `['projects', id, 'mesh', 'backup']`.
- API tests replace the tools with fake runners: use `logicalCommand` to see through the `OPENFOAM_BASHRC` wrapper.
