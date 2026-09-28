# Feature · Merge and multi-part assembly

> **Status**: in production (non-conformal coupling to validate on the ESI v2406 server) · **Updated**: 2026-09-28
> **Specs**: none in `brain/specs/`; `ASSEMBLY_SPEC.md` (§ 1, 2d, 2e) is cited by `placement.ts` and `meshTransform.ts` but is not tracked in the repository · **Codemaps**: `brain/codemap/api-projects.md` (`meshes.*`), `brain/codemap/api-lib.md` (`meshStorage`, `meshTransform`, `meshBackupStorage`, `openfoamCase` § rewrites), `brain/codemap/web-features-assemble-chamber.md` (`features/assemble/`), `brain/codemap/web-features-projects.md` (`MergeMeshesFlow`, `useMeshes`), `brain/codemap/root-shared-mcp.md` (§ library and merge)

## 1. Purpose
Combines several parts from the mesh library (`mesh-library-and-conversion.md`) into a single `constant/polyMesh` for the case:
- **Merge** (Case files → `Merge meshes`): part order + interfaces, the first library part serves as the base, the case mesh is replaced.
- **Assemble** (`Assemble` tab): same pipeline with a 3D view, optional rigid placement of the parts (6-DOF gizmo), default base = the case mesh with its `0/` physics preserved, and **Disassemble** (remove a part or undo the whole assembly).
Each part becomes a named `cellZone` (usable as an MRF rotor zone); each interface is either a non-conformal `cyclicAMI` pair (default, separate parts) or a conformal `stitchMesh` seam.
Access: any visible member of the project.

## 2. User journey
**Merge meshes** (`MergeMeshesFlow`, 4 steps):
1. `Sources`: ordered library (first = `Base` badge, up / down arrows, removal), imports and per-part patch editor; `Continue` as soon as there is one part.
2. `Connections`: interface rows (part + patch on each side, coupling `Non-conformal` or `Conformal stitch`); an empty row is ignored, a partial row blocks ("Finish or remove the incomplete interface").
3. `Confirm`: ordered list, interfaces, pipeline preview, warning "overwrites any existing constant/polyMesh. It cannot be undone.".
4. `Run`: planned steps then report (banner, notes, resulting patches, per-step log); on failure "The case mesh was not changed.".
The draft is prefilled from `meshes/merge.json` (plan of the last run, including old `stitches` read as `stitch`).

**Assemble** (`AssemblyWorkspace`, tab active as soon as a part exists in the library):
- Left rail (`PartsRail`): base selector `Project mesh` / `First part` (if the case has a mesh), ordered list with `Base` / `Placed` badges, imports, patch editor.
- Central canvas (`AssemblyViewer`): base opaque and the only clickable body, parts as blue ghosts, active part more highlighted, chosen base patch in orange. Clicking a face of the base picks the target patch.
- Right panel (`PlacementPanel`): `Mating patch on <part>`, `Clear`, then collapsed section `Reposition this part` (switch) with `Move` / `Rotate` mode, position (m, step 0.001) and rotation (degrees, Euler XYZ), `Align to base face`, `Reset to imported position`.
- Orange `Merge` CTA (active from 2 bodies, placement not required) + note "Merging replaces the case mesh; the previous mesh is backed up and restorable from the Visualize tab. Parts stay separate (cyclicAMI).".
- `AssemblyMergeDialog`: prefilled interfaces (one `nonConformal` per coupled part, side B = base), confirmation (case base: "backed up first… 0/ physics is preserved"; library base: "cannot be undone"), shared `MergeRunReport` report.
- **Disassemble** (`AssemblyManagePanel`, visible if an applied assembly has at least one added part): `Remove` per part (re-merge of a reduced plan, inline report); `Undo assembly` (case base only, confirmation, restores the backup slot).

## 3. Business rules and invariants
- **Plan**: `order` deduplicated, non-empty (otherwise 409 `NO_MESHES`); the `MERGE_BASE_CASE` sentinel (`'__case__'`) is only allowed in position 0 and requires `constant/polyMesh/boundary` in the case; each id must exist in the library and have a `boundary`; each interface must target parts of the plan (422 `INVALID_MERGE_PLAN`) and existing patches (422 `STITCH_PATCH_NOT_FOUND`). `coupling`: `nonConformal` (default; the old `nonConformalCyclic` is normalized) or `stitch`. `transforms`: `translation` [3] and `rotation` quaternion [4] (x, y, z, w as in three.js), finite numbers, no scale.
- **Patch names**: the base keeps all its names; an added part keeps its own unless they collide with an earlier part, in which case only the colliding patch becomes `<slug>_<patch>` (then `_2`, `_3`), with a "Renamed …" note. Never a systematic `m1_` / `m2_` prefix.
- **Placement**: optional. Coupling a part never moves it; only an explicitly repositioned part (switch on, non-identity transform) produces a `transforms` entry. The base is never moved. The transform is baked into a working copy of the `points`; the library source stays intact.
- **Front / back parity**: `placement.ts` (three.js) and `meshTransform.ts` (server) apply the same `Matrix4.compose` formula (quaternion not renormalized) in raw polyMesh coordinates; the viewer neutralizes the Z-up → Y-up flip baked into the GLB. Shared fixture: quaternion 90° around +Z, translation (1, 2, 3), `(1 0 0)` → `(1 3 3)`.
- **cellZones**: with ≥ 2 parts, `splitMeshRegions -makeCellZones` creates one zone per region BEFORE any coupling; if the number of zones equals the number of parts, they are renamed `base` (case base) or after the part slug, otherwise the generated names are kept with a note.
- **Non-conformal coupling**: in-place textual retyping of both patches into cross-referenced `cyclicAMI` (`neighbourPatch`, `transform noOrdering`), verified afterwards; no external tool. Empty-patch cleanup is then skipped. A note flags a minimal AMI `sum(weights)` < 0.5.
- **Conformal stitch**: `stitchMesh -partial`; if no face has merged, the step is requalified as `failed`; a partial merge adds a note.
- **checkMesh**: a non-zero exit is a failure; "Failed N mesh checks" with exit 0 yields a note, not a failure.
- **Promotion**: only if all steps succeed. Before: `ensureOriginalBackup` if the case is not empty (true for both bases). After: `syncBoundaryFields` in `merge` mode for a case base (existing BCs kept, generic defaults for new patches) or `rebuild` for a library base (all BCs regenerated); then `meshes/assembly.json` is written. Any step failure short-circuits without touching the case (except for a prior restore, see below).
- **Re-merge**: if the base is the case AND an applied assembly is recorded AND a backup slot exists, the case is first restored from the backup (avoids stacking an assembly on top of an already merged case). The first merge restores nothing and respects edits made in Visualize.
- **Undo**: `POST /mesh/backup/restore` restores `case/` from the slot and deletes `assembly.json`. Offered only when `baseIsCase`.

## 4. Technical flow

### Plan construction (front)
- Merge meshes: `MergeMeshesFlow` (states `order`, `interfaces`) → `useRunMerge(projectId).mutateAsync({ order, interfaces })`.
- Assemble: `AssemblyWorkspace` loads `useMeshesQuery`, `useMergePlanQuery`, `useCaseFilesQuery`, `useCaseMeshManifestQuery` (case base) and a `useQueries` of the geometries (keys shared with Visualize). Per-part draft `{ matingPatch, target, reposition, transform }`. Derives `seedInterfaces` (pairs) and `transforms` (repositioned parts) → `AssemblyMergeDialog` → `useRunMerge` with `{ order: ['__case__'?, …ids], interfaces, transforms }`.
- `buildPipelinePreview` (`MergeRunReport.tsx`, copy in `MergeMeshesFlow`) shows the planned steps: `Prepare` per part, `mergeMeshes` per added part, `splitMeshRegions` if > 1 part, `stitchMesh` or `nonConformalCouple` per interface, `cleanup`, `checkMesh`.

### Server pipeline
`POST /api/v1/projects/:id/meshes/merge` (`mergePlanSchema`) → `mergeMeshesController` → `meshes.service.runMerge`:
0. Possible restore (re-merge), validation, `persistPlan` (`meshes/merge.json`).
1. Patch name resolution.
2. `prepare`: `resetMeshWork` (purges `meshes/.work/`), one sub-case `m1`, `m2`… per part; case base = `stageCaseMaster` (copy of the case polyMesh + `system/` trio), otherwise `stageSource` (copy, transform on `points`, `system/` trio, renaming of colliding patches only).
3. `mergeMeshes`: `MERGE_MESHES_BIN <master> <add> -overwrite` (ESI v2406 positional form), one step per added part.
4. `splitMeshRegions`: `SPLIT_MESH_REGIONS_BIN -makeCellZones -overwrite -case <master>` then `labelCellZones`.
5. Interfaces: `setCyclicAmiPair` (non-conformal) or `STITCH_MESH_BIN <a> <b> -partial -overwrite -case <master>` + `nFaces` check.
6. `cleanup` (`removeEmptyBoundaryPatches`), skipped if a non-conformal pair exists.
7. `checkMesh -case <master>` + analysis (`countCheckMeshFailures`, `lowestAmiWeight`).
8. Promotion: `ensureOriginalBackup`, `promoteMasterMesh` (replaces `case/constant/polyMesh`), `syncBoundaryFields`, `writeAppliedAssembly({ plan, baseIsCase, appliedAt })`.
Response `{ success, steps, notes, boundaryPatches, cellZones, entries }`. Every tool-backed step goes through `planOpenfoamCommand` and the `MERGE_STEP_TIMEOUT_MS` timeout.

### Front cache after merge
`useRunMerge`: if `success`, writes the case tree, removes manifest, GLB, edges and file contents, invalidates `meshes`, `mergePlan`, `assembly`; no effect if `success: false`.

### Disassemble
- `useAssemblyQuery` → `GET /meshes/assembly` → `getAppliedAssembly` (reads `assembly.json`).
- `Remove`: `reducedPlan` removes the part from `order`, `interfaces` and `transforms` → `useReapplyAssembly` (same `POST /meshes/merge` endpoint, the server restores first).
- `Undo assembly`: `useUndoAssembly` → `POST /mesh/backup/restore` → `restoreMeshBackup` (restore, `clearAppliedAssembly`, render rebuild); the hook sets the returned manifest and invalidates tree, assembly outputs and backup.

### Draft
`GET|PUT /meshes/plan` exist; the plan is persisted by the server on every run. No screen calls `PUT /meshes/plan`: the order and pairs that were not run do not survive a reload.

## 5. Data and storage
Under `<STORAGE_DIR>/projects/<id>/`:
- `meshes/<slug>/` (sources, never modified by the merge), `meshes/merge.json` (last `MergePlan`), `meshes/assembly.json` (`AppliedAssembly`, written only after a successful promotion, deleted by the restore), `meshes/.work/` (transient staging, purged on every run);
- `case/constant/polyMesh/` (including `cellZones`) and realigned `0/` fields;
- `backups/` (single slot, taken before the first promotion).
No Prisma model. TanStack caches: `['projects', id, 'meshes' | 'mergePlan' | 'assembly']`, geometries `['projects', id, 'mesh', 'glb']` and `['projects', id, 'meshSource', meshId, 'glb']`. See `brain/architecture/storage-layout.md` § `meshes/`.

## 6. Configuration and external dependencies
- Target: **ESI OpenFOAM v2406** (openfoam.com). `MERGE_MESHES_BIN` (`mergeMeshes`), `STITCH_MESH_BIN` (`stitchMesh`), `SPLIT_MESH_REGIONS_BIN` (`splitMeshRegions`), `CHECK_MESH_BIN`, `MERGE_STEP_TIMEOUT_MS` (10 min per step), `OPENFOAM_BASHRC`.
- Variables declared but never read: `STITCH_TOL` (ESI has no `-tol`), `NCC_COUPLE_BIN`. `createNonConformalCouples` (OpenFOAM.org v12) is no longer called: non-conformal coupling is a tool-free `cyclicAMI` retyping.
- Front: three.js (`OrbitControls`, `TransformControls`, `GLTFLoader`), WebGL required (message "3D rendering isn't available" otherwise).
- A `cyclicAMI` pair is only useful with a solver that computes the AMI weights at runtime; a moving rotor requires `pimpleFoam` (see `boundary-conditions.md`).

## 7. Tests
- API `meshes.test.ts`: steps and ESI argv locked (`mergeMeshes`, `stitchMesh -partial`, `splitMeshRegions -makeCellZones`), prefix only on collision, single part, short-circuit, stitch without merge, checkMesh with failed checks, 422, non-conformal coupling without external command, cleanup skipped, low AMI overlap as a note, cellZones renamed (`casing`, `rotor`) or kept, case base (`0/` physics preserved, `original` backup), transforms (parity, master stationary, 422 non-finite), plan `GET|PUT`, Disassemble (recording, reduced re-merge restoring the original without stacking, no restore on the first merge, record deleted by the restore).
- API `meshTransform.test.ts`: server half of the parity (ASCII and binary).
- Web `placement.test.ts` (client half of the parity, `computePlacement`, `anchorFromGeometry`), `AssemblyWorkspace.test.tsx` (merge without transform, transform only after repositioning, `stitch` toggle, case base by default), `AssemblyManagePanel.test.tsx` (Remove, Undo, no Undo without a case base), `MergeMeshesFlow.test.tsx` (locks, partial interface, plan sent).
- `meshes.test.ts` fails locally if `.env` defines `OPENFOAM_BASHRC` (fake runners without `logicalCommand`); green in CI.

## 8. History
- 2026-06-30: multi-mesh library and conformal merge `mergeMeshes` + `stitchMesh`; temporary switch to the OpenFOAM.org v11/v12 signature; reliability audit F2 to F5 (dashes, checkMesh, empty stitch, BC warning) (`brain/changelog/2026-06.md`).
- 2026-07-01: Assemble tab (3D placement, `Matrix4.compose` parity, per-source rendering); Assembly v2 (non-conformal coupling, base = case mesh); retargeting to ESI v2406 (back to positional, in-place `cyclicAMI`); optional placement + 6-DOF gizmo; Assembly v5 Disassemble; prefix only on collision (`2026-07.md`).
- 2026-07-02: parts rendered as transparent ghosts (`2026-07.md`).
- 2026-07-10: H6 (stale render after merge); Merge meshes `Import folder` fixed (`2026-07.md`).
- 2026-07-13: `splitMeshRegions -makeCellZones`, one cellZone per part (`2026-07.md`, commit `3426569`).
- 2026-08-12: "undo-all" test of `meshes.test.ts` stabilized in CI (`2026-08.md`).

## 9. Known limits and bugs
- M1: no "active run" guard on merge, restore and promotion.
- M2: a failed re-merge leaves the case restored to the original while the API reports "case mesh was not changed" and `assembly.json` still describes the assembly.
- M4: non-atomic backup slot (restore possible from a partial slot).
- M21: placement fields truncated to 3 decimals, typing "-" or "." first sends the part back to the origin; L14: gimbal lock of the rotation fields.
- M23: the viewer's `Try again` only reloads the base geometry.
- K7: the header of `meshes.service.ts` still describes `createNonConformalCouples`; `STITCH_TOL` unused.
- K18: split / rename of a part without purging its render (align unavailable on a renamed patch).
- K19: moving part no. 1 (library base) changes the base and deletes its draft without warning.
- K21: `MergeMeshesFlow` does not propagate a patch rename into the entered interfaces.
- L10: non-atomic slugs; L16: coupling ignored if the chosen base face has an empty patch name.
- `brain/known-issues.md` § 8 and `README.md` § 6 still mention `createNonConformalCouples` as to be validated: the code no longer uses it; what remains to validate on the server is the solver's `cyclicAMI` behavior.
- Findings of this sheet (code reading, not reproduced): the re-merge restore happens BEFORE plan validation, so a 422 (unknown id or patch) also leaves the case restored (extension of M2); the dialogs announce "cannot be undone" for a library base whereas the server takes an `original` backup if the case was not empty (restorable from Visualize, without an Undo button).

## 10. Changing this feature
- Parity: any convention change (quaternion component order, rotation / translation order, GLB flip) must change `placement.ts`, `AssemblyViewer.tsx`, `meshTransform.ts` and the two twin tests (`placement.test.ts`, `meshTransform.test.ts`) together.
- `buildPipelinePreview` exists in two copies (`MergeRunReport.tsx`, `MergeMeshesFlow.tsx`) and must reflect the step order of `runMerge`.
- The types `MergePlan`, `MeshInterface`, `PartTransform`, `AppliedAssembly`, `MERGE_BASE_CASE` are defined in `packages/shared` AND copied into `apps/web/src/lib/api/types.ts`: keep them aligned, then `npm run build:shared`.
- CLI syntax: ESI v2406 only (positional for `mergeMeshes`, `-partial` for `stitchMesh`). Do not reintroduce the OpenFOAM.org syntax (`-addCases`, `patchPairs`, `-tol`).
- Any new merge output must go through `invalidateAssemblyOutputs` on the front (case render, library, plan, assembly, file contents).
