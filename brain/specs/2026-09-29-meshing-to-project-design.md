# Meshing session → project mesh transfer (WS-F) — design

**Date:** 2026-09-29
**Status:** approved (2026-09-29)
**Feature:** Meshing → Projects hand-off (closes the "no direct bridge to a project" gap of `brain/features/meshing.md` §3)
**Scope:** shared types + API (projects module, one new route) + web (dialog on `/meshing/:id`, `?view=` initial tab on `/projects/:id`) + tests. **No change** to the meshing pipelines, to `buildChamber.py`, to the BC presets or to the solver.
**Related:** `brain/specs/2026-08-11-chamber-to-meshing-transfer-design.md` (same "building block used by the UI and by the future optimisation loop" philosophy), WS-H `2026-09-29-optimisation-loop-design.md` (consumer).

---

## 1. Goal

Send the `constant/polyMesh` produced by a meshing session into a project, in one call, either:

- **`case`**: as the project's case mesh (replaces `case/constant/polyMesh`), keeping the case's existing physics where patch names still match; or
- **`library`**: as a new part of the project's mesh library (`meshes/<slug>/`), reusable by Merge meshes / Assemble.

Today the hand-off is manual (`Download case` zip, then an import whose behaviour with the extra files `meta.json`, `mesh.log`, `.viz/` is unverified). The new route is also step 5 of the WS-H loop ("WS-F into a case").

## 2. Current mechanism (verified in code)

| Concern | Where | Notes |
|---|---|---|
| Session mesh presence | `apps/api/src/lib/meshingStorage.ts:41` `POLYMESH_REQUIRED = ['points','faces','owner','boundary']`, `hasResultMesh` `:276` | **No `neighbour`** in the list, whereas the solver gate (`computeRunnable`) requires `points, faces, owner, neighbour, boundary`. |
| Session run state | `meshing.service.ts:398-405` `activeMeshRuns` / `isMeshRunActive(sessionId)`; `readMeshStatus` (atomic `status.json`) | In-memory registry + persisted status. |
| Project visibility | `projects.service.ts:94` `assertProjectVisible` (404 for an outsider), `:73` `canManage` | Every case mutation today is **Visible** (owner, collaborator, super-admin). |
| Replace the case mesh | `meshes.service.ts:765` `promoteMasterMesh` (`rm -rf` dest polyMesh, `mkdir`, `fs.cp` recursive) | Exactly the copy we need; private today. |
| Backup before destructive write | `meshBackupStorage.ts:88` `ensureOriginalBackup` (takes `original` only if no slot yet); guarded by `caseIsEmpty` (`lib/caseStorage.ts:122`) as in `meshes.service.ts:1272` | A mesh-only / empty project has no `case/` to back up (ensureOriginalBackup would fail). |
| BC realignment | `files.service.ts:745` `syncBoundaryFields(viewer, id, { mode: 'merge' })` (merge keeps existing BCs of surviving patches, new patches get `fieldBcBody` defaults); throws 409 `NO_MESH` without `boundary` | Merge promote wraps it in `try/catch` because a mesh-only project has no `0/` yet (`meshes.service.ts:1276-1290`). |
| Applied assembly record | `meshStorage.clearAppliedAssembly` | Must be cleared when the case mesh is replaced by something that is not an assembly (otherwise Disassemble offers a stale plan). |
| Library slug | `meshStorage.ts:105` `slugifyMeshName` (NFKD, no diacritics, lowercase, `[^a-z0-9]+`→`-`, fallback `mesh`), `:121` `uniqueMeshId` (`-2`, `-3`… ; not atomic, L10) | `MeshSourceKind = 'folder'|'zip'|'cgns'|'msh'` (`:33`), validated on read by `MESH_SOURCE_KINDS`. |
| Render caches ("H6 pattern") | server: `vizStorage.vizIsStale` (mtime of `boundary`/`points` vs GLB) ; web: `removeQueries(['projects', id, 'mesh', 'manifest'|'glb'|'edges'])` + `invalidateQueries(['projects', id, 'meshes'|'assembly'|'mergePlan'])` (`brain/features/case-files.md` §10, `useConvertToFoam`, `useResetCase`, `useRunMerge`) | H6 = fix of 2026-07-10 "Visualize/Assembly show the old mesh after merge/convert/reset". Server needs nothing (mtime); the **client** must purge. |
| Patch types produced by the meshers | snappy: `snappyDicts.ts:289-295` `refinementSurfaces` without `patchInfo` ⇒ every surface patch is `wall` (OpenFOAM default), plus a leftover `domainBoundary` (`type patch`, possibly 0 faces in internal mode). cfMesh: `patchTypes` per patch, default `wall`. Chamber intent: `buildChamber.py:114-123` `PATCH_TYPES` (`inlet`/`outlet` = `patch`, others `wall`). | So a chamber meshed with defaults arrives with `inlet`/`outlet` typed `wall`. |
| BC preset retyping | `boundary.service.ts:182` retypes **walls only** to `wall`; inlet/outlet keep their geometric type | The chamber BC preset alone will not fix `inlet`/`outlet` = `wall`. Visualize roles do (`mesh.service.ts:431,532`: role ⇒ `patch`). |
| Active-run guard | none on case mutations (M1) | This route adds one (cheap, see §4.2). |
| Empty-patch removal | `openfoamCase.ts:2102` `removeEmptyBoundaryPatches(content)` drops **every** 0-face patch | Too broad here (it would also hide a chamber patch that snappy failed to populate): add a targeted option. |
| Minimal `system/` | `files.service.ts:187` `scaffoldCase(viewer, projectId)` | Already used by autoPatch and conversion when `controlDict` is missing. |
| Project tabs | `ProjectDetailPage.tsx:183-186` `ProjectView` in local `useState('detail')` | Tabs are **not URL-addressable** today: landing on Visualize needs a small change (§4.3). |

## 3. Decisions (all taken with the user on 2026-09-29)

| # | Topic | Decision |
|---|---|---|
| 1 | Default target | **`case`**. |
| 2 | Permission | **Visible** may write (owner, collaborators, super-admin), consistent with merge, BC, autoPatch, convert. An invisible project answers 404. |
| 3 | Chamber patch types (case target) | After the copy, force the geometric type of every patch whose name matches the chamber contract (`buildChamber.py:114-123` `PATCH_TYPES`): `inlet`, `outlet` => `patch`; `walls`, `cylinder_walls`, `hub`, `shroud`, `guide_vanes` => `wall`. Any other name is untouched; a constraint type (`cyclic*`, `symmetry*`, `empty`, `wedge`, `processor`) is never overwritten. Done before the merge sync so the fields get BCs consistent with the forced type. Reported in `retyped` + a note. The library target keeps the mesher's types (editable in Visualize). |
| 4 | Leftover snappy patch | Remove a **0-face `domainBoundary`** patch (and only that name) from the copied `boundary`, for both targets. A `domainBoundary` with faces (external meshing) is kept. Note added when removed. To validate on the Debian server that snappy leaves it in `boundary` in internal mode. |
| 5 | Empty project (case target) | Scaffold a minimal `system/` (`scaffoldCase`) when there is no `system/controlDict`; no backup (nothing to protect); merge sync skipped silently when there is no `0/`. |
| 6 | Error code | New **`MESHING_NOT_MESHED`** (409), distinct from the project's own `NO_MESH`. |
| 7 | Landing | Navigate to **`/projects/:id?view=visualize`** (Visualize tab, new mesh visible). |
| 8 | What is copied | Only `constant/polyMesh/**` (including `cellZones`, `faceZones`, `pointZones`, `sets/` if present). Never `system/`, `0/`, `.viz/`, `processor*/`, logs. |

## 4. Changes per layer

### 4.1 Shared (`packages/shared/src/index.ts`)
- `MESH_TO_PROJECT_TARGETS = ['case', 'library'] as const` (first = default `case`), `type MeshToProjectTarget`.
- `CHAMBER_PATCH_TYPES: Readonly<Record<string, 'patch' | 'wall'>>` = `{ inlet: 'patch', outlet: 'patch', walls: 'wall', cylinder_walls: 'wall', hub: 'wall', shroud: 'wall', guide_vanes: 'wall' }`, mirror of `PATCH_TYPES` in `buildChamber.py` (comment on both sides: keep aligned; a unit test compares them by parsing the Python constant).
- `interface MeshFromMeshingRequest { sessionId: string; target: MeshToProjectTarget; name?: string }` (`name` only used by `library`; 1..120 chars).
- `interface MeshFromMeshingResult { target; mesh?: MeshSource; entries?: CaseEntry[]; notes: string[]; retyped?: string[]; syncedFields?: string[] }`.
- New error code in `SERVER_ERROR_CODES`: `MESHING_NOT_MESHED`. `MESH_IN_PROGRESS` and `RUN_IN_PROGRESS` are already used by the API (check they are in the list; add them if not).
- `npm run build:shared` before API/web typecheck.

### 4.2 API
- **Route** (`projects.routes.ts`): `POST /api/v1/projects/:id/mesh/from-meshing`, `requireAuth` (router-level), body `meshFromMeshingSchema` (`mesh.schemas.ts`: `sessionId` = safe id, `target` enum, `name?` trimmed 1..120).
- **Controller** `meshFromMeshingController` (`mesh.controller.ts`, reuse its local `requireViewer`) → `200 { result }` for both targets (like `runMerge`; the library part is returned in `result.mesh`).
- **Service** `importMeshFromMeshing(viewer, projectId, input)` in `mesh.service.ts` (case) delegating the library branch to `meshes.service.ts`:
  1. `assertProjectVisible` (404 `NOT_FOUND` for an outsider, before touching the session so existence of sessions is not probed through a foreign project).
  2. Session: `requireSession` (404 `NOT_FOUND` "Meshing session not found."); `isMeshRunActive(sessionId) || readMeshStatus()?.status === 'running'` ⇒ 409 `MESH_IN_PROGRESS`; session polyMesh incomplete (`hasResultMesh` **+ `neighbour`**) ⇒ 409 `MESHING_NOT_MESHED` "This session has no mesh yet. Generate the mesh first.".
  3. `case` target only: active project run (`prisma.run.count({ projectId, status in ACTIVE_RUN_STATUSES })`) ⇒ 409 `RUN_IN_PROGRESS` (M1 guard for this route).
  4. **Copy to a staging dir first** (`projects/<id>/meshes/.work/from-meshing-<ts>/constant/polyMesh`, under `meshWorkRoot`), edit the staged `boundary`, then move into place, so a failed copy or edit never leaves a half-written case (M4 lesson). The staging dir is removed in a `finally`.
     - both targets: `removeEmptyBoundaryPatches(content, { only: ['domainBoundary'] })` (new optional filter on the existing helper; default behaviour unchanged for autoPatch);
     - case target: patch-type forcing (decision 3) on the staged `boundary` via a pure helper `forceChamberPatchTypes(content)`: for each patch whose name is a key of `CHAMBER_PATCH_TYPES`, whose type differs and is not a constraint type, `setBoundaryPatchType(content, name, CHAMBER_PATCH_TYPES[name])` (`openfoamCase.ts:2187`); record `retyped`.
  5. `case`:
     - `if (!(await caseIsEmpty(projectId))) await ensureOriginalBackup(projectId)`;
     - move `promoteMasterMesh` (`meshes.service.ts:765`) into `lib/caseStorage.ts` as the exported `replaceCasePolyMesh(projectId, srcPolyMeshDir)`; the merge promote calls it unchanged (pure refactor, covered by the existing merge tests);
     - `clearAppliedAssembly(projectId)`;
     - no `system/controlDict` => `scaffoldCase(viewer, projectId)` (`files.service.ts:187`), note "Created a minimal system/ so the Solver tab can take over.";
     - `syncBoundaryFields(viewer, projectId, { mode: 'merge' })` in `try/catch` (409 `NO_MESH` impossible here; "no `0/` yet" is not a failure);
     - response `entries = listCaseTree`, `notes` (backup taken, patches kept / added, retyped).
     - No server render work: `vizIsStale` sees the new `boundary`/`points` mtime and the next manifest request rebuilds.
  6. `library`: `name = input.name?.trim() || meta.name` (session display name); `id = uniqueMeshId(projectId, name)`; move staging polyMesh to `meshes/<id>/constant/polyMesh`; `writeMeshMeta({ id, name, kind: 'meshing', createdAt, origin?: { sessionId } })`; add `'meshing'` to `MeshSourceKind` and `MESH_SOURCE_KINDS` (otherwise `readMeshMeta` drops the part); response `mesh` + `meshes`.
  7. Audit: none (the audit log only covers auth/admin today).
- `MeshSource` public type: add the `kind` value `'meshing'` wherever the web displays kinds.

### 4.3 Web
- `lib/api/projects.ts`: `importMeshFromMeshing(projectId, body)`.
- Hook `useImportMeshFromMeshing(projectId)` in `features/projects/useMesh.ts`: on success, **H6 pattern**: `removeQueries` `['projects', id, 'mesh', 'manifest'|'glb'|'edges']`, `invalidateQueries` `['projects', id, 'meshes'|'assembly'|'mergePlan'|'files'|'runnable']` and `['projects', id, 'mesh', 'backup']` (case target); library target: `setQueryData(meshesQueryKey, result.meshes)`. The hook takes `projectId` from the mutation variables since the dialog chooses the project.
- **`SendToProjectDialog`** (`features/meshing/SendToProjectDialog.tsx`), modelled on `features/chamber/SendToMeshingDialog.tsx`:
  - project `NativeSelect` fed by `useProjectsQuery()` (visible projects only, server-filtered); empty state with a link to `/projects`;
  - target `SegmentedRadioGroup` "Case mesh" (default) / "Mesh library part";
  - `case`: warning text "Replaces the project's case mesh. The original case is backed up once; boundary conditions of patches with the same name are kept.";
  - `library`: `Name` field prefilled with the session name, validated non-empty client-side (avoid K20's `name: ''`);
  - one primary CTA `Send to project`; errors mapped from `ApiError.code` (`RUN_IN_PROGRESS`, `MESH_IN_PROGRESS`, `MESHING_NOT_MESHED`, `NOT_FOUND`) to inline messages; success toast "Mesh sent to <project>." then `navigate(`/projects/${id}?view=visualize`)`.
- `MeshingSessionPage.tsx` header: secondary button `Send to project` next to `Download case` (`:204`), shown only when the session is meshed; `aria-disabled` + tooltip "Wait for the mesh run to finish." while running.
- `ProjectDetailPage.tsx` `ProjectTabs`: initial `view` read once from `useSearchParams().get('view')` when it is a valid `ProjectView` (`detail` otherwise); the param is then dropped with `setSearchParams({}, { replace: true })` so tab clicks stay local state (no other behaviour change).
- UI rules: skill sequence of `apps/web/AGENTS.md` before JSX; tokens only; one primary per zone.

### 4.4 MCP (optional, only if asked)
`send_meshing_to_project` tool, destructive.

## 5. API contract

```
POST /api/v1/projects/:id/mesh/from-meshing
Auth: Bearer; access = Visible (owner, collaborator, super-admin)
Body: { "sessionId": "chamber-3f2a91c0", "target": "case" | "library", "name"?: "Chamber v3" }
200 { "result": {
  "target": "case",
  "entries": [...CaseEntry],            // case only
  "mesh": { id, name, kind: "meshing", createdAt, ... }, "meshes": [...],  // library only
  "retyped": ["inlet", "outlet"],       // case only: patches whose type was forced to the chamber contract
  "syncedFields": ["0/U", "0/p", ...],
  "notes": ["Original case backed up.", "Kept boundary conditions for 3 patches; 2 new patches got defaults."]
} }
401 UNAUTHENTICATED
404 NOT_FOUND            project not visible / absent, or session absent
409 MESH_IN_PROGRESS     session run active
409 MESHING_NOT_MESHED   session has no complete polyMesh (points, faces, owner, neighbour, boundary)
409 RUN_IN_PROGRESS      case target while a solver run is queued/running
422 VALIDATION_ERROR     bad body (unknown target, unsafe sessionId, empty name)
```

## 6. Out of scope

- Moving/deleting the session after transfer; any cleanup policy of sessions (WS-H concern).
- Copying `system/` numerics or any `0/` field from the session.
- Fixing M1 globally (only this route gets the guard), M4 (backup slot atomicity), L10 (slug race).
- Changing snappy/cfMesh dicts to emit `patchInfo` types (alternative to decision 3, would be a separate spec).
- Forcing chamber patch types on the library target.
- Full URL routing of project tabs (only an initial `?view=` is read).
- Assembling several sessions at once.

## 7. Tests (test-first)

API `apps/api/tests/meshFromMeshing.test.ts` (fake session built on disk with the five polyMesh files; no OpenFOAM needed):
- 401 without token; 404 for a stranger (project invisible) even with a valid session; 404 unknown session; 422 bad target / unsafe id.
- 409 `MESH_IN_PROGRESS` (session `status.json` `running` and/or registry entry via a hanging fake `setStreamRunner`).
- 409 `MESHING_NOT_MESHED` (missing `neighbour`).
- `case` on an empty project: polyMesh copied byte-identical, no backup, `controlDict` scaffolded, no throw on missing `0/`.
- `case` on a configured project: `original` backup taken once (second call does not overwrite), `0/U` keeps `inlet` BC in merge mode, a new patch gets defaults, `assembly.json` cleared, `viz` considered stale.
- 0-face `domainBoundary` removed (both targets) and the patch count renumbered; a `domainBoundary` with faces kept; another 0-face patch (`outlet` with `nFaces 0`) kept.
- `case` with `inlet`/`outlet` typed `wall` => retyped `patch`, `hub` typed `patch` ⇒ `wall`, a non-chamber name (`domainBoundary`, `rotor_x`) untouched, a `cyclicAMI` named `walls` untouched; the `0/` fields of `inlet` get non-wall defaults (no wall function).
- Contract parity: `CHAMBER_PATCH_TYPES` equals `PATCH_TYPES` parsed from `buildChamber.py`.
- `library` target keeps the mesher's types (no forcing).
- 409 `RUN_IN_PROGRESS` with an active `Run` row.
- `library`: slug from `name`, `-2` on collision, `kind: 'meshing'` listed by `GET /meshes`, case untouched.
- Super-admin allowed on someone else's project.
Unit (`openfoamCase.test.ts`): `removeEmptyBoundaryPatches` with the `only` filter (default behaviour unchanged); `forceChamberPatchTypes`.
Web `SendToProjectDialog.test.tsx`: project list, `case` selected by default, target switch, name required for library, body sent, navigation to `/projects/:id?view=visualize`, error codes mapped (`MESHING_NOT_MESHED`, `MESH_IN_PROGRESS`, `RUN_IN_PROGRESS`, `NOT_FOUND`); hook test that the H6 keys are removed/invalidated. `ProjectDetailPage.test.tsx`: `?view=visualize` opens Visualize, an invalid value falls back to Detail.

## 8. Brain updates at implementation time
Changelog, `features/meshing.md` (§3 "no direct bridge" rewritten), `features/mesh-library-and-conversion.md` (new kind), `architecture/api-routes.md`, `architecture/storage-layout.md` (`.work/from-meshing-*`), codemaps (`api-projects.md`, `web-features-meshing-solver.md`), `known-issues.md` (M1 partially addressed).

## 9. Decision log

No open question left. Answered by the user on 2026-09-29: default target `case`; force chamber patch types on the case target (other names untouched); remove a 0-face `domainBoundary`; Visible may write; scaffold a minimal `system/` on an empty project; new `MESHING_NOT_MESHED` code; land on the Visualize tab. Record the patch-type forcing and the Visible permission as rows in `brain/decisions.md` at implementation time.

## 10. Implementation plan (test-first: red test, then code, then green, per task)

Branch `feat/chamber-v2-cfd-loop` (never `main`). Spec committed first in a separate `docs(meshing): ...` commit, then implementation commits (`feat(meshing): ...`, `refactor(mesh): ...`). Run targeted suites only (`brain/conventions/testing.md` §5).

| # | Task | Files | Tests (written first, seen failing) |
|---|---|---|---|
| 1 | Shared contract: `MESH_TO_PROJECT_TARGETS`, `MeshToProjectTarget`, `MeshFromMeshingRequest` / `MeshFromMeshingResult`, `CHAMBER_PATCH_TYPES`, error code `MESHING_NOT_MESHED`; then `npm run build:shared` | `packages/shared/src/index.ts` | `apps/api/tests/chamberPatchTypes.test.ts`: `CHAMBER_PATCH_TYPES` equals `PATCH_TYPES` read from `apps/api/scripts/buildChamber.py` (regex on the dict literal) |
| 2 | `removeEmptyBoundaryPatches(content, { only? })` | `apps/api/src/lib/openfoamCase.ts` | `apps/api/tests/openfoamCase.test.ts`: filter removes only a 0-face `domainBoundary` and renumbers; no option = old behaviour |
| 3 | Pure `forceChamberPatchTypes(content): { content, retyped }` (skips constraint types, idempotent) | `apps/api/src/lib/openfoamCase.ts` | same file: inlet/outlet `wall` to `patch`, hub `patch` to `wall`, `cyclicAMI` named `walls` untouched, unknown names untouched, second pass no-op |
| 4 | Refactor `promoteMasterMesh` into `replaceCasePolyMesh` | `apps/api/src/lib/caseStorage.ts`, `apps/api/src/modules/projects/meshes.service.ts` | existing merge tests in `meshes.test.ts` stay green (CI configuration, or locally without `OPENFOAM_BASHRC`) |
| 5 | `'meshing'` mesh source kind | `apps/api/src/lib/meshStorage.ts` (`MeshSourceKind`, `MESH_SOURCE_KINDS`), shared `MeshSource` kind if mirrored | covered by task 7 library tests |
| 6 | Session readiness: `hasCompleteResultMesh` (adds `neighbour`), `isSessionRunning` (registry or `status.json`) | `apps/api/src/lib/meshingStorage.ts`, `apps/api/src/modules/meshing/meshing.service.ts` | `apps/api/tests/meshingStorage.test.ts`: missing `neighbour` gives false |
| 7 | Schema, service (`importMeshFromMeshing`: staging, boundary edits, backup, replace, clear assembly, scaffold, merge sync; library branch), controller, route | `mesh.schemas.ts`, `mesh.service.ts`, `meshes.service.ts`, `mesh.controller.ts`, `projects.routes.ts` (all under `apps/api/src/modules/projects/`) | `apps/api/tests/meshFromMeshing.test.ts`: every case of §7. Fake sessions written on disk; hanging `setStreamRunner` fake for `MESH_IN_PROGRESS`; `setStreamRunner(null)` in `afterEach` |
| 8 | Web API client + hook with the H6 purge | `apps/web/src/lib/api/projects.ts`, `apps/web/src/lib/api/types.ts`, `apps/web/src/features/projects/useMesh.ts` | hook test (mocked API): removed and invalidated keys per target |
| 9 | UI skill sequence (`ui-ux-pro-max`, `frontend-design`, `design-taste-frontend`, `web-design-guidelines`, given `brain/design/design-system.md` and `brain/design/product.md`), then `SendToProjectDialog` + header button | `apps/web/src/features/meshing/SendToProjectDialog.tsx`, `apps/web/src/pages/MeshingSessionPage.tsx` | `apps/web/src/features/meshing/SendToProjectDialog.test.tsx` (§7) |
| 10 | Initial tab from `?view=` | `apps/web/src/pages/ProjectDetailPage.tsx` | `ProjectDetailPage.test.tsx`: `?view=visualize`, invalid value |
| 11 | Gates: `npm run build:shared`, targeted API files (tasks 1-7), `npx vitest run src/features/meshing src/features/projects src/pages/ProjectDetailPage.test.tsx`, `npm run typecheck`, `npm run lint` | | report any suite not run |
| 12 | Brain: changelog entry; `features/meshing.md` (§3 bridge now exists, §4, §7); `features/mesh-library-and-conversion.md` (kind `meshing`); `features/projects.md` (`?view=`); `architecture/api-routes.md`; `architecture/storage-layout.md` (`meshes/.work/from-meshing-*`); codemaps (`api-projects.md`, `api-lib.md`, `api-tests.md`, `web-features-meshing-solver.md`, `web-features-projects.md`, `web-core.md`, `root-shared-mcp.md`); `python brain/codemap/build-index.py`; `known-issues.md` (M1 addressed for this route only); `decisions.md` (§9); `STATUS.md` | `brain/**` | `python brain/codemap/build-index.py --check` |
| 13 | To validate on the Debian server: a real snappy chamber session (internal mode) sent to a project; confirm the 0-face `domainBoundary` and the `wall` types before forcing, `checkMesh` on the case, Solver gate runnable after the chamber BC preset | | manual; result recorded in the changelog |
