# Known issues and debt

> Living register of known bugs, environment limits and open threads.
> Source: bug audit (branch `feat/export-cfdpost`, ~65k LOC, read-only) + v1.0.1 fix log + chamber handover.
> Updated 2026-09-28. **When an item is fixed**: set its status to ✅, add the date and link to the changelog entry.
> The `file:line` references from the original audit may have drifted: re-read the code before acting.

Legend: ✅ fixed · ⚠️ fixed but to validate on the Debian server · ⬜ open · 🟡 product decision pending

## 1. Bug audit: summary

| Severity | Total | Fixed | Open |
|---|---|---|---|
| CRITICAL | 4 | 4 | 0 (C2: product decision remaining) |
| HIGH | 10 | 10 | 0 |
| MEDIUM | 24 | 2 (M3, M16) | 22 |
| LOW | 21 | 0 | 21 |

Recommended fix order going forward: M1, M2, M4 (case integrity during a run or a merge), then M9 and M10 (broken templates), then the rest by severity.

## 2. Fixed (v1.0.1)

Full details in `brain/changelog/2026-07.md` (entries dated 2026-07-10 carrying the identifier C*, H* or M*).

| ID | Subject | Status |
|---|---|---|
| C1 | Transient CGNS export: time steps out of order (lexicographic sort, `out_10` before `out_2`) | ⚠️ numeric sort + `out.cgns.times` sidecar; verify on the server that `FoamToCgns.py` writes the sidecar |
| C2 | Account deletion: destructive cascade + orphaned storage + ghost solvers | ✅ + 🟡 **shared** projects of the deleted account still disappear for their collaborators (reassign ownership or block the deletion: to decide) |
| C3 | `streamRunner`: write stream without an `error` listener (process crash) | ⚠️ |
| C4 | Logout does not clear the React Query cache | ✅ `queryClient.clear()` on logout and on refresh failure |
| H1 | Orphaned solvers surviving an API restart | ⚠️ kill by PID verified through `/proc/<pid>/cmdline` (Linux only) |
| H2 | Two solvers in the same case (TOCTOU) | ✅ in-process FIFO lock `runExclusive` |
| H3 | Unbounded run logs, fully re-read on every poll | ✅ tail read bounded by `SOLVER_LOG_MAX_BYTES` |
| H4 | Editor autosave overwrites keystrokes during the save | ✅ |
| H5 | Live polling stopped after a failed fetch | ✅ |
| H6 | Visualize/Assembly show the old mesh after merge/convert/reset | ✅ |
| H7 | Multi-zone CGNS merge: only the first zone animated | ⚠️ verify an assembly with ≥ 2 zones in CFD-Post |
| H8 | Foam parser: `#include` swallows the next entry | ✅ |
| H9 | OOM DoS through uploads (no total cap, zip bomb) | ✅ `MAX_UPLOAD_TOTAL_MB`, `MAX_ARCHIVE_UNCOMPRESSED_MB`; remaining: streaming cap for chunked uploads |
| H10 | Fallback terminal: EPIPE on a dead shell (crash) | ✅ |
| M3 | Deleting a project does not stop its solver | ✅ `stopProjectRuns` |
| M16 | Time directories in scientific notation rejected by the export | ✅ |

## 3. Open: MEDIUM

- **M1**: no "active run" guard on destructive case mutations (reset, merge restore/promote, restore backup, autoPatch, patch editing, CGNS convert, file move/delete). The solver dies, or a parallel run's `reconstructPar` runs on the NEW mesh (corrupted case). Areas: `files.service.ts`, `meshes.service.ts`, `mesh.service.ts`.
- **M2**: a failed re-merge silently reinstates the applied assembly (backup restored BEFORE staging) while the API answers "case untouched" and `assembly.json` still claims an assembly is applied (`meshes.service.ts`).
- **M4**: single-slot mesh backup: destroy-before-replace + stale `meta.json` ⇒ `backupExists()` lies and `restoreBackup` wipes the case before copying an empty slot (`meshBackupStorage.ts`).
- **M5**: meshers killed at 16 MB of output (`maxBuffer`) and reported as "binary not found" (`commandRunner.ts`).
- **M6**: SIGKILL on timeout orphans the MPI ranks (`streamRunner.ts`).
- **M7**: applying boundary conditions validates the rotor/6-DoF patches AFTER rewriting the case (and can overwrite the only backup) (`boundary.service.ts`).
- **M8**: `csv_to_boundaryData.py` writes corrupted output and exits 0 (short lines → `None`, empty CSV, Excel BOM); the UI shows "Boundary conditions applied" with no condition.
- **M9**: global 16 KB JSON limit (`app.ts`, `express.json({ limit: '16kb' })`, re-verified on 2026-09-28) incompatible with inline templates (up to 2 MB) and with applies of 1,000 paths ⇒ raw 413.
- **M10**: `createTemplate` creates the DB row before validating the file ⇒ ghost template + error code not mapped by the form.
- **M11**: the Export tab loses the in-progress export on tab change (unmount) ⇒ invites a concurrent double export.
- **M12**: `Number(x) || DEFAULT` in `SnappyConfigForm.tsx` and `CfMeshConfigForm.tsx` replaces a legitimate `0` with the default (re-verified on 2026-09-28).
- **M13**: solver Easy form: two quick edits ⇒ the second overwrites the first on the server (`SolverConfigPanel.tsx`).
- **M14**: applying a template does not clear the file content caches ⇒ the open editor re-autosaves the stale content (`useTemplates.ts`).
- **M15**: deleting an open, modified file resurrects it (autosave armed); dragging a modified file loses the edit (`FileTreeEditor.tsx`).
- **M17**: padded binary STLs rejected (exact length required) (`stlBounds.ts`, `stlMerge.ts`).
- **M18**: `buildSolverSpec` (`packages/shared`) gives non-RANS solvers (interFoam, solidDisplacementFoam…) the incompressible RANS family and required files.
- **M19**: `extractPatches.py` loads the whole internal volume (possible OOM/timeout); `CgnsInspect.py` can segfault on a corrupted CGNS.
- **M20**: downloads fully buffered in memory, on the server (`zip.toBuffer()`) and on the client (`getBlob`).
- **M21**: placement numeric fields: precision truncated to 3 decimals, and typing "-" or "." first moves the part back to the origin (`PlacementPanel.tsx`).
- **M22**: the Home page never tests `isError`: endless skeletons + "Live" badge if the API fails (`HomePage.tsx`, re-verified on 2026-09-28).
- **M23**: the assembly viewer retry only reloads the base geometry; a corrupted part GLB stays cached for 5 min (`AssemblyWorkspace.tsx`).
- **M24**: patch names with a hyphen badly indexed in the manifest (`extractPatches.py`, regex).

## 4. Open: LOW

- **L1**: the login rate limit also counts successes and relies on `req.ip` (`TRUST_PROXY` defaults to 0) ⇒ lockout behind a NAT (re-verified: no `skipSuccessfulRequests`).
- **L2**: timing oracle at login (unknown email ⇒ no argon2 verification).
- **L3**: 500s expose internal codes (`P2025`, `ENOENT`); validation `details` never reach the client.
- **L4**: `revokeRefreshTokens` returns 500 if the user has disappeared.
- **L5**: stop/start race: a stop between decompose and the recording of the handle marks the run stopped while mpirun keeps going.
- **L6**: the documented solver override of `startRun` is ignored (controlDict always wins).
- **L7**: the generic scaffold writes `application foamRun;` (does not exist on ESI v2406).
- **L8**: `fmtFoamNumber` crushes |x| < 5e-7 to `0` (rotor axes/origins).
- **L9**: a `.fms` upload in a snappy session poisons the generated dicts. Probably obsolete: a snappy session now refuses `.fms` with a 422 (to confirm, then close).
- **L10**: readdir-then-create slug generation: two concurrent imports with the same name overwrite each other.
- **L11**: sourcing the OpenFOAM bashrc passes it the tools' argv.
- **L12**: the seed rewrites the super-admin password on every run (`upsert` with `update`).
- **L13**: `edges.bin`: synchronous rebuild loop if it cannot be written, or stale buffer.
- **L14**: editing the rotation fields near gimbal lock (Euler round trip).
- **L15**: autoPatch accepts an empty field as a 0° angle.
- **L16**: coupling ignored if the chosen base face has an empty patch name.
- **L17**: the Summary tab fires one GET per case file (hundreds after a run).
- **L18**: `ResidualChart`: duplicated tick keys for t < 1.
- **L19**: `StlViewer` silently swallows unreadable STLs; no viewer handles WebGL context loss.
- **L20**: `FolderImportDialog`: same folder ⇒ previous selection kept; empty folder ⇒ nothing.
- **L21**: miscellaneous (terminal session cap checked before auth, meshing mpirun jobs outside the core budget, unnamed GLB materials never released, silent `useRebuildMesh` failure, `EditPatchesDialog` wipes in-progress renames on refetch, `FoamToCgns.py` ignores its fields argument, `CgnsInspect` `velocityMax` on the 1st zone only, absolute server paths in step reports).

## 5. Verified sound (audit)

Path traversal (`sanitizeRelative`, `confineJoin`, zip-slip) watertight; no shell injection (everything as argv through `execFile`/`spawn`); auth/IDOR (role re-read from the DB on every request, project visibility everywhere, terminal WebSocket auth); single-flight token refresh; mergeMeshes/stitchMesh/cyclicAMI pipeline compliant with the ESI v2406 syntax; `meshTransform` identical term by term to three.js `Matrix4.compose`; residual parsing robust to nan/inf.

## 6. Open threads outside the audit (Chamber Creation)

Implement nothing without an explicit request from the user.

- **Hub shoulder monotonicity**: the builder warning only fires if P1 > P2 (fold-back towards Runner Ø ≈ 2,179 mm at ratio 0.45, ≈ 1,961 mm at 0.50). Proposed but not requested: early alert (P2 − P1 < a fraction of the 97 mm spacing) and/or promotion to a refusal.
- **Builder texts still using the old vocabulary** ("stick out of the box", "the cylinder shoulder…"): sweep proposed, not requested (requires updating the assertions of the geometry suite).
- **Simplify Generator visual browser pass**: geometry proven by tests, never checked by eye in the 3D preview.
- **Inverted STL patch normals** (deprioritized), **cascade of saves on owner deletion** (product decision), **multi-instance build lock** (the per-hash lock is in-process).
- 🟡 **Name of the `outlet` patch in Closed generator without vanes**: `classify` (`buildChamber.py`) names `outlet` the side face of the cylinder with the median z, i.e. the middle cylinder, which seems to contradict the rule "outlet = fluid exit, never the middle cylinder". It remains to be determined whether it is physically the exit in this design (user decision). Noted on 2026-09-28.
- **Chamber, doc/code gaps noted on 2026-09-28** (details: `brain/features/chamber-creation.md` §9):
  - `partScale` in With cone is still described as "scaled down to fit" (UI help, `ChamberInput` doc, comments), whereas the builder has refused since 2026-08-31.
  - With cone without vanes: no `outlet` patch produced, and no pytest test covers this case.
  - `vaneAngleDeg`, `outletRatio` and `outletOuterD` always enter the hash, even without vanes: a needless rebuild happens for identical geometry.
  - The transfer to Meshing returns 409 whereas the spec announces 404 `CHAMBER_NOT_BUILT`.
  - The parameter table marks a chamfer ≤ 0 as "not buildable" even when Chamfer is unchecked.
  - `brain/assets/chamber-parameter-map.html` stops at the v2 model of 2026-08-04.
- **Semi-spiral tool**: approved spec and reference implementation in `documents/Semi-spiral-creation/` (added on 2026-09-22), not yet integrated into the application.

## 7. Findings from the 2026-09-28 mapping (code reading, not reproduced)

Noted while reading the entire code base to build the codemaps. **None has been verified at runtime**: confirm (red test) before fixing. Fix nothing without a request.

### Backend
- ⬜ **K1** `createCaseFileController` reads `req.body.content` but `createFileSchema` only declares `path`; `validate` replaces `req.body` ⇒ `content` is always `undefined` through `POST …/files/content`.
- ⬜ **K2** `renameMeshPatch` and `setPatchType` do not write a backup before modifying (unlike `editMeshPatches` and `autoPatchMesh`).
- ⬜ **K3** Edges route: 404 for the case without edges, 204 for a library source (contract inconsistency).
- ⬜ **K4** Circular import `projects.service` ↔ `runs.service`.
- ⬜ **K5** `decomposePar` / `reconstructPar` hard-coded whereas all other binaries go through the env.
- ⬜ **K6** The `runExclusive('startRun')` lock has a global key: run starts are serialized across ALL projects (intended for the core budget, keep it in mind).
- ⬜ **K7** JSDoc/code gaps: `startRunSchema` (`solver` override actually ignored, see L6), `editPatchesSchema` (cites `MESH_PATCH_TYPES`, validates `MESH_PATCH_SETTINGS`), patch name message (does not announce that the hyphen is accepted), `meshes.service` header (describes `createNonConformalCouples` whereas the code retypes to non-conformal `cyclicAMI`; `STITCH_TOL` unused), `readArtifacts` (the CGNS download serves `out.cgns` first).

### Python
- ⬜ **K8** `requirements.txt` does not include `scipy`, imported by every build with guide vanes (present only in `requirements-geometry.txt`).
- ⬜ **K9** `FoamToCgns.py`: the docstring announces ADF CGNS whereas the code writes HDF5; `fields` argument ignored (see L21).
- ⬜ **K10** Scripts outside the `OK:`/`KO:` contract: `mirrorStep.py` (usage ⇒ exit 1), `bakeVaneBladeProfile.py` (`OK:` on stderr), `csv_to_boundaryData.py` (no `OK:`), `CgnsMergeTime.py` (checks h5py before argc).
- ⬜ **K11** `buildChamber.py --step` without `outletOuterD`/`outletRatio` always produces a STEP without vanes (`NameError` guard); comments still say "no boolean"; references to `prepare_openfoam.py`, `_diag_*.py`, which are absent from the repository.
- ⬜ **K12** `_test_hub_shroud_math.py` is not collected by pytest and hard-codes `/home/hristo/cadquery-env`.
- ⬜ **K13** Chamber manifest: `nFaces` = CAD faces without vanes but triangles with vanes; `edges.bin` empty in that case.

### Frontend
- ⬜ **K14** `foamSummary.ts` did not get the H8 fix: in the Summary tab, `#include` without `;` still swallows the next entry.
- ⬜ **K15** `BoundaryConditionDialog`: success toast without reading `result.success`; the CSV report shows "OK" for a `skipped` step (see M8).
- ⬜ **K16** Overly broad invalidations: `useProjects` invalidates `['projects']` without `exact` (trees, contents, meshes of all projects); `useSaveCaseFile` invalidates the content it just wrote; invalidating `['meshing']` refreshes every active meshing query.
- ⬜ **K17** `useImportCase` does not remove the 3D render of the case mesh (same family as H6); `useConvertToFoam` rewrites the caches even if `result.success` is false.
- ⬜ **K18** `PartsRail`: `useAutoPatchMeshSource` and `useRenameMeshSourcePatch` do not remove the source's render caches (5 min) ⇒ old patch names in the viewer.
- ⬜ **K19** Assemble: reordering part no. 1 changes the base and deletes the coupling draft without warning.
- ⬜ **K20** Chamber: hidden fields (`x4`, `centralDiameter`, `domeHeight`…) stay recorded and go into the body of a `stepped` variant (verified: the server ignores them and `x4` never reaches the builder, so no effect); `SendToMeshingDialog` sends `name: ''` without validation; a failed save deletion still closes the confirmation.
- ⬜ **K21** `MergeMeshesFlow`: renaming a patch does not update the interfaces already entered.
- ⬜ **K22** `TurbulenceCalculator`: ω formula with `Cmu^0.75` instead of `Cmu^0.25` (gap ≈ ×3.3 against the usual formula; the code is FAITHFUL to `documents/calculator/turbulence_cfd_notes.md`, which itself writes `0.09^0.75`: it is the reference note that must be settled with the user); if the case has both `0/epsilon` and `0/omega`, only `0/omega` is written.
- ⬜ **K23** `RawFileEditor` (`SolverConfigPanel`): if a solver change rewrites the open file, the autosave might send back the old draft (to verify).
- ⬜ **K24** `TopoSetDialog` never reset (reopens on the last step); empty components of `p1`/`p2` not validated. `SolverConfigPanel.clampCores` returns 0 if `maxCores` is 0.
- ⬜ **K25** Brand guideline gaps: hard-coded `rounded-[6px]` and `text-white` in `BoundaryConditionDialog`; Download button in `text-cta` on `text-sm` in `CaseFilesSection` (AA contrast to verify); `ManualEasyNote` shows literal backticks; `helpId` not wired to `aria-describedby` (`MergeMeshesFlow`, chamber); `text-white` on orange/destructive buttons (`ApplyTemplateFlow`, `FileTreeEditor`), `rounded-[6px]` (`ModeButton`), `rounded-full` (`DistributionBar`); no orange `Button` variant: the `bg-cta` classes are repeated by hand.
- ⬜ **K26** Dead code: `useRenamePatch` and `useSetPatchType` (visualize) are imported nowhere. Duplicate keys: `useAssembly.ts` redeclares the manifest/glb keys of `useMesh.ts`, which hard-codes `['projects', id, 'files']`.
- ⬜ **K27** `UsersTable` defines `SortableHead` inside the render (recreated on every render: possible focus loss after a sort); `admin/schemas.ts` hard-codes `max(120)` instead of `FULL_NAME_MAX_LENGTH`; `parseTagInput` does not split on spaces despite its doc.
- ⬜ **K28** Missing states: `TerminalView` does not go back to `connecting` after "Reconnect"; `MeshViewer` "Restore" not disabled during the restore; no error state in `TemplateFilePicker`; `ExportTab` shows neither loading nor error for the status query; focus on the first invalid field uncertain (`ChangePasswordSection`, `UserFormDialog`).

### Cross-cutting (backend, tests, contract, configuration, CI)
- ⬜ **K29** Backend lib: `renderSolverFile('constant/turbulenceProperties')` always writes `kOmegaSST`; the `chamber/` cache is never purged by the code (manual purge only); two same-named `listCgnsFiles` exports (`cgnsStorage`, `exportStorage`) with different semantics; `INVALID_ARCHIVE` also returned for a read or a move; timeouts: `commandRunner` kills with SIGTERM, `streamRunner` with SIGKILL (see M6).
- ⬜ **K30** Tests: uneven hygiene (`chamber.test.ts`, `chamberSaves.test.ts`, `meshing.test.ts` without `prisma.$disconnect`; `meshing*.test.ts` and `fileTreeStorage.test.ts` do not clean `test-storage`; `snappyPipeline.test.ts` leaves temporary directories behind); helpers (`ok()`, `buildMultipart`, `makeProject`, `writePolyMesh`…) duplicated instead of living in `tests/helpers.ts`. No tests for `FileTreeEditor`, `ExportTab`, `AuthProvider`, `ApplyTemplateFlow`, `TerminalView`, `DashboardCharts`.
- ⬜ **K31** Security (design reminder): the project terminal is a full shell not confined to the project folder (hence `TERMINAL_ENABLED=false` by default); all locks are in memory ⇒ **a single API instance** supported; the storage root depends on the current directory (`path.resolve(process.cwd(), STORAGE_DIR)`) if `STORAGE_DIR` is relative.
- ⬜ **K32** Misaligned error contract: `SERVER_ERROR_CODES` (`@dive/shared`) declares `CONVERSION_FAILED`, `MESH_MERGE_FAILED`, `BC_APPLY_FAILED`, never emitted; the API emits codes missing from the list (`NAME_TAKEN`, `ENGINE_MISMATCH`, `MESH_IN_PROGRESS`, `NOT_ENOUGH_CORES`, `TOO_MANY_CORES`, `ARCHIVE_TOO_LARGE`, `INTERNAL_SERVER_ERROR`, `ERROR`).
- ⬜ **K33** Configuration: 11 variables of the `env.ts` schema missing from `apps/api/.env.example` (including `CHAMBER_PYTHON_BIN`, snappy binaries, `MAX_UPLOAD_TOTAL_MB`); 4 declared but never read (`STITCH_TOL`, `NCC_COUPLE_BIN`, `FOAM_DICTIONARY_BIN`, `POST_PROCESS_BIN`); `SEED_ADMIN_*` mandatory even just to start the server. Details: `brain/architecture/configuration.md`.
- ⬜ **K34** Miscellaneous contract: `footAngleDeg` defaults to 40 (schema, service) but 45 in the `ChamberInput` doc; dead exports in shared (`CGNS_EXTENSION`, `MESH_IMPORT_EXTENSIONS`, `MESHES_DIRNAME`, `MESHING_DIRNAME`); MCP tool `merge_meshes` described as "couples/patchPairs" whereas the plan expects `order`, `interfaces`, `transforms`.
- ⬜ **K35** Auth: after a logout, the access token stays valid until it expires (~15 min; only the refresh token is revoked), mitigated by `requireAuth`, which re-reads role and `isActive`. Deleting a user also deletes their chamber saves, which are shared with the team (see product decision C2).
- ⬜ **K36** CI on Node 20 whereas `.nvmrc` says 24; web `.tsbuildinfo` files tracked by git (artifacts).
- ⬜ **K37** Export: if `CgnsMergeTime.py` fails after copying the first step, a partial `out.cgns` stays on disk and would be served for download instead of the fallback zip (not covered by the fallback test); on the front end, the fallback zip is saved under the name `out.cgns`.
- ⬜ **K38** Meshing: on API restart, `running` sessions switch to `failed` but a still-alive mesher is not killed (no equivalent of the H1 fix for solver runs).
- ⬜ **K39** Solver: the "known but non-configurable solver" branch of `computeRunnable` is unreachable (`isConfigurableSolver` is true for the whole library); effective levels: `full`, `base`, `foamRun` placeholder. `foamDictionary` is cited by README §6 and the UI ("Inspect case") but never called.
- ⬜ **K40** Meshes and BCs (code reading, details in the feature sheets §9): a re-merge restores the backup BEFORE validating the plan, so a 422 also leaves the case restored (extension of M2); the merge UI on a library base announces "cannot be undone" whereas an `original` backup is taken; switching from Frozen to Moving Rotor (or the reverse) does not remove the old dict (`MRFProperties` and `dynamicMeshDict` can coexist); applying BCs also rewrites `0.orig/` and the already solved time directories; autoPatch of a library part deletes its `system/` folder; a part's manifest does not correct its patch types from `boundary` (type `?` possible).
- ⬜ **K41** Platform (details in the feature sheets §9): `requireAuth` ignores `tokenVersion`, so after a logout or a password change the access tokens of OTHER sessions stay valid for up to 15 min (complements K35); an unprotected super-admin can demote themselves, and the protected account's password can be changed by another super-admin; the dashboard's "x of cores in use" indicator compares a number of runs with a number of cores; `LoginPage` has no dedicated message for `RATE_LIMITED`; an open terminal session survives account deactivation; the `AuthProvider` comment still describes a `me()` call at bootstrap.
- ⬜ **K42** Deployment docs and config (found while writing the playbooks, 2026-09-28): `brain/operations/installation.md` had no step for the CadQuery environment (`CHAMBER_PYTHON_BIN`) nor for `apps/web/.env` / `VITE_API_URL` (required at build time); it used `/api/v1/health` (not a route) and `db:migrate` (= `prisma migrate dev`) in production. Health check and migration command are fixed in the guide and the README; the two missing setup steps are not written yet. `apps/mcp/.env.example` points at the server over plain HTTP, so the service-account password travels in clear text.
- ⬜ **K43** Found while writing the playbooks (2026-09-28): several `ChamberPage.tsx` toasts contain em dashes (e.g. "Inverted Min/Max range — see the notes below the preview."), against the visible-strings rule; `SOLVER_FILE_PATHS` (`openfoamCase.ts`) looks unused; no test checks that `TURBULENCE_MODEL_IDS` matches `TURBULENCE_MODELS` (20 each today); the `buildChamber.py` docstring omits `[--step]` and lists only four patches, and the `test_build_chamber.py` docstring still mentions a "hollow fit-to-box clamp" (refusal since 2026-08-31).

## 8. Known environment limits

- On a dev machine without OpenFOAM/ParaView/CadQuery, CFD actions return a clean "not found" per step: intended behavior.
- `conversion.test.ts` and `meshes.test.ts` fail locally (≈ 21 tests) but pass in CI. Identified cause: `apps/api/vitest.config.ts` does not neutralize `OPENFOAM_BASHRC`; if `apps/api/.env` defines it, commands are wrapped in `bash -c …` and the fake runners that compare `spec.command` (instead of `logicalCommand()`) no longer recognize anything. `export.test.ts` does the same comparison for `checkMesh` (impact to verify). Workaround: empty `OPENFOAM_BASHRC` in `.env` to run these suites, or run targeted suites. Fix identified, not applied.
- Assemble coupling: non-conformal retyping to `cyclicAMI` (no external utility); validate a coupled case end to end on the server before relying on it in production.
- The chamber build cache is keyed on parameters, not on code: **any change to `buildChamber.py` requires purging `apps/api/storage/chamber/*`**.
