# Codebase Bug Audit

> Read-only audit of the DIVE Turbinen CFD web app (~65k LOC). Every finding below was verified by reading the actual code path involved; several were found independently by more than one reviewer and have been merged. **Nothing has been fixed** — this is a findings list only.
>
> Branch audited: `feat/export-cfdpost`. Deploy target: Linux/Debian, ESI OpenFOAM.com v2406.

## Severity summary

| Severity | Count | What it means |
|----------|-------|---------------|
| CRITICAL | 4 | Silent data corruption, data loss, or full-API crash |
| HIGH | 10 | Corruption/loss under realistic conditions, or API/tab takedown |
| MEDIUM | 24 | Broken features, wrong results, stuck or lying UI |
| LOW | 21 | Edge cases, leaks, papercuts |

---

## CRITICAL — silent data corruption, data loss, or full-API crash

### C1. Transient CGNS export ships time steps in scrambled order
`export.service.ts:369` + `exportStorage.ts:133` sort `out_10.cgns` before `out_2.cgns` (lexicographic), and `CgnsMergeTime.py` pairs files with time values positionally. Any export with ≥10 written time steps (and `EXPORT_ALL_TIMES` defaults to `true`) produces an `out.cgns` where t=0.2 renders the t=1.0 field — reported as success. This is the flagship feature of the current branch.

Related to the same export path:
- Time values from `listSolvedTimeValues` include t=0 while pvbatch's series usually excludes it, so on count mismatch `CgnsMergeTime.py:122` silently substitutes fake index times.
- The merge-failure fallback (`export.service.ts:394`) validates `out_9.cgns` instead of the true latest timestep.

### C2. Deleting a user silently cascade-destroys all their projects
`schema.prisma:55` (`onDelete: Cascade`) + `users.service.ts:216-251` only clean up templates. Collaborators' shared projects vanish with no warning, multi-GB project storage is orphaned on disk forever (never calls `removeProjectStorage`), and any running solver for those projects keeps burning cores with no way to see or stop it. *Found independently by two reviewers.*

### C3. The API process can crash mid-run from the solver log stream
`streamRunner.ts:67,94` pipes solver output into a `createWriteStream` with no `'error'` listener. Disk-full (realistic for logs the file itself says reach "hundreds of MB"), permissions, or EIO emits an unhandled stream error → the whole Node process dies, every user is disconnected, and the run row is stuck `running`.

### C4. Logout never clears the React Query cache
`AuthProvider.tsx:37-65` resets only auth state; no `queryClient.clear()` exists anywhere. On a shared workstation, the next user who logs in sees the previous user's dashboard, user list, project lists, and cached meshes (staleTime 30s, mesh artifacts 5min, `refetchOnWindowFocus: false`).

---

## HIGH — corruption/loss under realistic conditions, or API/tab takedown

### H1. Orphaned solvers survive an API restart → double-writer case corruption
`runs.service.ts:567-583` assumes children died with the parent; on Linux they're reparented and keep running. After a deploy: run marked failed, mpirun still burning N cores, unkillable from the UI, and the user can launch a *second* solver into the same case directory. Nothing kills by recorded PID or process group.

### H2. Two solvers can start in the same case (TOCTOU)
`runs.service.ts:378-435` counts active runs then creates the row with no transaction or constraint (the `@@index` commented as a "concurrency guard" guards nothing). Double-click or two tabs → two OpenFOAM processes writing the same case. The global core-budget check has the same race.

### H3. Solver logs are unbounded and fully re-read into memory on every poll
`SOLVER_LOG_MAX_BYTES` is declared (`env.ts:234`) but referenced nowhere; `getRunLog` (`runs.service.ts:521`) reads the entire file from byte 0 and re-parses residuals on each client poll. A multi-hour run → hundreds of MB allocated per poll per viewer; past ~1GB, `toString` throws and the live view 500s for the rest of the run. *Found independently by two reviewers.*

### H4. Editor autosave clobbers keystrokes typed during the save round-trip
`FileTreeEditor.tsx:118-120` + `useCaseFiles.ts:180-186`: on save success, `setQueryData` resets the CodeMirror draft to the saved snapshot, deleting everything typed while the request was in flight and jumping the cursor. Same pattern in the solver wizard's raw editor (`SolverConfigPanel.tsx:1060-1074`) and the template editor.

### H5. Live run polling permanently stops after one failed fetch
`useRuns.ts:85-124` derives `refetchInterval` from `query.state.data`; if the first log fetch fails (network blip, server restart), data stays `undefined`, the interval resolves to `false`, and with `refetchOnWindowFocus: false` nothing ever retries. Chart and log freeze on a run that says "Running" until a hard reload.

### H6. Visualize/Assembly show the OLD mesh after merge, convert, or reset
`useRunMerge` (`useMeshes.ts:144-155`), `useConvertToFoam`, and `useResetCase` never drop the mesh manifest/GLB/edges caches (5-min TTL) or the assembly record, unlike their siblings which do. After merging, the "Applied assembly"/Disassemble panel never appears, Visualize renders the pre-merge mesh, and the Boundary Conditions dialog offers the *old* patch names.

### H7. Multi-zone CGNS merge freezes all zones except the first
`CgnsMergeTime.py:135-163` builds the time series only for the first zone of the first base. Assemblies deliberately keep parts as separate zones — in CFD-Post every zone except one sits frozen at step 0 while the first animates.

### H8. Foam parser mangles `#include` → Easy mode corrupts case files
`foamModel.ts:164-186` has no terminator for `#include "file"` (no `;`), so it swallows the next entry into one garbled leaf. Editing that row in Easy mode splices over and deletes the neighbouring entry (e.g. `application`); any real case using `#include` hits this.

### H9. Authenticated OOM DoS via uploads
Two vectors: `multer.memoryStorage()` with 1GB/file × 5000 files and no total cap (`files.controller.ts:33-40`), and no decompressed-size cap in `extractArchiveAt` (`fileTreeStorage.ts:107-128`) — a 50MB zip bomb inflates fully in memory. Either kills the API for everyone.

### H10. Terminal fallback can crash the API on keystrokes to a dead shell
`terminalSession.ts:151-153`: the non-pty path writes to `child.stdin` with no exit guard or `'error'` listener → EPIPE as an unhandled stream error → process down. This is the exact code path used when node-pty's native build is absent on the deploy box.

---

## MEDIUM — broken features, wrong results, stuck or lying UI

### M1. Destructive case mutations have no active-run guard
Reset, merge restore/promote, backup restore, autoPatch, patch edits, CGNS convert, and file move/delete can all rewrite or delete the mesh a live solver is using (`files.service.ts:139`, `meshes.service.ts:816`, `mesh.service.ts:598-780`, …). Run dies with a cryptic FOAM fatal; a parallel run can `reconstructPar` processor dirs onto the *new* mesh (corrupt case).

### M2. Failed re-merge silently reverts the applied assembly
`meshes.service.ts:816-818` restores the pre-assembly backup *before* staging; if any later step fails the API reports "merge failed, case untouched" while the case was actually reverted and `assembly.json` still claims an assembly is applied.

### M3. Deleting a project never stops its running solver
`projects.service.ts:137-145` cascades the Run rows and deletes storage but never calls `handle.stop()`; the ghost mpirun burns cores up to 6h while the freed budget lets new runs oversubscribe the machine.

### M4. Single-slot mesh backup: destroy-before-replace + stale metadata → restore destroys the case
`meshBackupStorage.ts:66-102`: `writeBackup` deletes the old slot before copying and never removes stale `meta.json` on failure, so `backupExists()` lies; `restoreBackup` then wipes the live case *before* copying from the (empty/partial) slot.

### M5. Meshers killed at 16MB of output and misreported as "not installed"
`commandRunner.ts:51,82-93`: `maxBuffer` overflow is mapped to `spawnError` ("binary could not be started"), sending the user down the wrong debugging path on any big snappy/cartesianMesh run.

### M6. SIGKILL on timeout orphans MPI ranks
`streamRunner.ts:104-109` SIGKILLs `mpirun`, which can't forward it; the N solver ranks keep computing and writing after the run is marked timed-out.

### M7. Boundary-conditions apply validates rotor/6-DoF patches only *after* mutating the case
`boundary.service.ts:179-274`: a typo'd rotor patch returns 422 "nothing applied" when the boundary file and all 0/ fields were already rewritten — and the call may have just overwritten the only backup slot.

### M8. CSV → boundaryData writes corrupt output and exits 0
`csv_to_boundaryData.py:38-79`: short rows produce literal `None` in `0/U`, header-only CSVs write 0-point files, empty CSVs traceback, Excel BOM breaks the `x` column — the UI then toasts "Boundary conditions applied" unconditionally (`BoundaryConditionDialog.tsx:269`), and the failure only surfaces when the solver crashes later.

### M9. 16KB global JSON body limit breaks documented flows
`app.ts:45` vs template inline content allowed up to 2MB and 1000-path template applies. Pasting any real OpenFOAM dict into "create template" → raw 413.

### M10. `createTemplate` creates the DB row before validating the file
`templates.service.ts:162-185`: a rejected create still leaves a phantom empty template in everyone's roster, with an error code (`INVALID_ARCHIVE`) the form can't map.

### M11. Export tab loses the running export on tab switch → invites a double export
`ProjectDetailPage.tsx:259-268` unmounts `ExportTab`; coming back shows the *previous* export's status and an active "Export" button that launches a second concurrent pipeline over the same case.

### M12. Meshing forms silently replace a legitimate `0` with the default
`Number(x) || DEFAULT` in `SnappyConfigForm.tsx:168,217` and `CfMeshConfigForm.tsx:160`: margin 0 → 0.1, feature level 0 → 2, feature angle 0 → 45. The form displays 0; the persisted config and the mesh differ from what the user set.

### M13. Easy solver form loses the first of two quick edits
`SolverConfigPanel.tsx:503-519` splices into the cached file content; editing `endTime` then `writeInterval` before the first save lands makes the second save overwrite the first server-side.

### M14. Applying a template doesn't drop file-content caches
`useTemplates.ts:225-248`: an open editor keeps stale pre-import content; one keystroke autosaves the stale text and silently wipes the imported file.

### M15. Deleting an open, dirty file resurrects it
`FileTreeEditor.tsx:125-290`: the armed 600ms autosave fires after the delete and the PUT re-creates the file. Dragging a dirty file to another folder loses the pending edit.

### M16. Scientific-notation time dirs break export
`export.service.ts:101` regex rejects `1e-05`-style directories (default `timeFormat general` with small `deltaT`) → "No solved results to export" on a fully solved case.

### M17. Padded binary STLs rejected as unreadable
`stlBounds.ts:58` / `stlMerge.ts:20` require the exact byte length; files with trailing padding get parsed as ASCII, yield 0 triangles, and the error blames the user's file.

### M18. `buildSolverSpec` gives every non-RANS solver the wrong family/required files
`packages/shared/src/index.ts:1571-1596`: `interFoam`, `solidDisplacementFoam`, etc. are told they need incompressible RANS files (`0/p`, `transportProperties`) and not the ones they actually read (`0/p_rgh`, `0/alpha.water`).

### M19. `extractPatches.py` loads the full internal volume mesh
`extractPatches.py:114-121` enables all regions including `internalMesh` despite the boundary-only design; the synchronous in-request viz build can OOM or hit its timeout on production meshes. Related: `CgnsInspect.py:96-115` can segfault (not fail cleanly) on a corrupt CGNS — the known vtkCGNSReader hazard `CgnsToVtk.py` documents and guards against.

### M20. Downloads buffer entire artifacts in memory, both sides
Server: `zipTreeAt`/`buildCaseArchive` build whole zips via `zip.toBuffer()`; client: `getBlob` for `out.cgns` (potentially GBs) with no streaming or progress — tab or API OOM on large cases.

### M21. Placement numeric fields mangle precision input
`PlacementPanel.tsx:334-393`: values snap back to 3 decimals (sub-mm untypeable), and typing "-" or "." first commits position 0 with `reposition: true` — a stray keystroke silently moves the part to origin.

### M22. Home dashboard shows skeletons + a green "Live" badge forever on API failure
`HomePage.tsx` never checks `isError`; no error or retry surface.

### M23. Assembly viewer retry can never recover from a corrupt part GLB
`AssemblyWorkspace.tsx:494-497` retries only the base geometry; the broken part buffer stays cached 5min → stuck error loop.

### M24. Hyphenated patch names mis-keyed in the patch manifest
`extractPatches.py:49` regex captures `inlet-1` as `1` and can match `physicalType` instead of `type`; meshing/library consumers get wrong types (the Visualize path happens to re-enrich and recover).

---

## LOW — edge cases, leaks, papercuts

- **L1.** Login rate limiter counts successful logins and keys on `req.ip` with `TRUST_PROXY` defaulting to 0 — 11 people behind one NAT/proxy Monday morning → 429 lockout (`rateLimit.ts:12`, `env.ts:272`).
- **L2.** Login timing oracle: unknown emails skip the argon2 verify, defeating the uniform-error anti-enumeration design (`auth.service.ts:28-39`).
- **L3.** 500s leak internal codes (`P2025`, `ENOENT`) on the wire, and validation `details` never reach the client (`errorHandler.ts:53-56`).
- **L4.** `revokeRefreshTokens` 500s if the user row vanished, contradicting its own "safe if deleted" doc (`auth.service.ts:101-110`).
- **L5.** Stop-vs-launch race: a stop arriving between decompose and handle registration marks the run stopped while mpirun runs to endTime (`runs.service.ts:318-341,556`).
- **L6.** `startRun`'s documented solver override is silently ignored — controlDict always wins (`runs.service.ts:99-101`).
- **L7.** Generic scaffold writes `application foamRun;` — doesn't exist on the ESI v2406 deploy box (gated in the Run tab, but fails from the built-in terminal) (`openfoamCase.ts:448`). The merge/couple pipeline itself is confirmed clean for v2406.
- **L8.** `fmtFoamNumber` flushes |x| < 5e-7 to `0` — tiny rotor-axis components/origins silently zeroed in `MRFProperties`/`dynamicMeshDict` (`openfoamCase.ts:213`).
- **L9.** An `.fms` upload into a snappy session poisons the generated dicts → opaque runtime failure instead of a 400 at upload (`meshingStorage.ts:172`, `snappyDicts.ts:263`).
- **L10.** Slug generation is readdir-then-create: two concurrent same-name imports overwrite each other (`meshStorage.ts:121`, `meshingStorage.ts:90`).
- **L11.** Sourcing the OpenFOAM bashrc leaks tool argv into it; openfoam.com's bashrc will `eval` any future `name=value` argument (`openfoamCommand.ts:40`).
- **L12.** Seed resets the super-admin password on every deploy/seed run (`seed.ts:18-23`).
- **L13.** `edges.bin` failure modes: permanent synchronous rebuild loop if it can't be written, or a stale buffer rendering garbage edge overlays (`vizStorage.ts:121`).
- **L14.** Rotation field edits jump the part near gimbal lock (Euler round-trip on the committed quaternion, `AssemblyWorkspace.tsx:334`).
- **L15.** autoPatch accepts a blanked input as feature angle 0° — shatters the boundary into maximal patches (`PartsRail.tsx:513`).
- **L16.** Coupling silently dropped when the picked base face has an empty patch name — UI shows "Coupled", merge receives zero interfaces (`placement.ts:201`, `AssemblyWorkspace.tsx:381`).
- **L17.** Summary tab fires one GET per case file including every solver time directory — hundreds of parallel requests after a run (`CaseSummary.tsx:31`).
- **L18.** ResidualChart: duplicate tick keys / meaningless "0…0" axis for transient runs with t < 1 (`ResidualChart.tsx:104`).
- **L19.** StlViewer silently swallows unparseable STLs (blank stage, no message); neither 3D viewer handles WebGL context loss (`StlViewer.tsx:163`).
- **L20.** FolderImportDialog: same-name/same-count folder keeps the previous selection; empty folder pick does nothing silently (`FolderImportDialog.tsx:63`).
- **L21.** Misc: terminal session cap checked pre-auth/incremented post-auth; meshing mpirun jobs not counted against the solver core budget; unnamed-GLB materials never disposed; `useRebuildMesh` failure silent; `EditPatchesDialog` wipes in-progress renames on refetch; `FoamToCgns.py` ignores its fields argument; `CgnsInspect` `velocityMax` only covers the first zone; step reports embed absolute server paths.

---

## Verified clean (checked, not broken)

- Path traversal (`sanitizeRelative` / `confineJoin` / zip-slip) is airtight everywhere.
- No shell injection — everything is argv-based (`execFile`/`spawn`).
- Auth / IDOR: per-request DB role check, project visibility on all endpoints, WebSocket terminal auth.
- Token refresh is correctly single-flight.
- The mergeMeshes / stitchMesh / cyclicAMI pipeline is correctly migrated to ESI v2406 syntax.
- `meshTransform` matches three.js `Matrix4.compose` term-for-term (preview↔server parity holds).
- Residual parsing handles nan/inf.

---

## Suggested fix order

1. **C1 + H7 + M16** — same export path, actively shipping wrong physics with a green checkmark, on the current branch. Fix first.
2. **C2, C3, C4** — must-fix before real users: data loss on user delete, API crash, cross-account data exposure.
3. **H1, H2, H3** — one bad afternoon from a corrupted case or a downed server.
4. Everything else by severity.
