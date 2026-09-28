# Feature · Case files (OpenFOAM case files)

> **Status**: in production · **Updated**: 2026-09-28
> **Specs**: no dedicated spec (history in the changelog) · **Codemaps**: `brain/codemap/web-features-projects.md` (`CaseFilesSection`, `CaseSummary`, `CaseFileForm`, `CaseFileEditor`, `foam*`, `useCaseFiles`), `brain/codemap/web-features-platform.md` (`features/files/`), `brain/codemap/api-projects.md` (`files.*`), `brain/codemap/api-lib.md` (`caseStorage`, `fileTreeStorage`, `openfoamCase`)

## 1. Purpose
Gives each project an OpenFOAM case folder (`0/`, `constant/`, `system/`): import of a folder or a `.zip`, file tree, in-place editing (guided "Easy" form or raw "Advanced" editor) with autosave, check of required files and generation of missing base files, zip download, reset and a read-only summary. It is also the hub from which CGNS conversion, merge, boundary conditions, the turbulence calculator and TopoSet are launched.
Access: any member who can see the project (owner, collaborator, super-admin) reads AND writes; a non-member gets 404.

## 2. User journey
**"Case files" card** (`Detail` tab of `/projects/:id`, component `CaseFilesSection`), two Radix tabs `Files` and `Summary`.
- `Files` tab, states: skeleton (`CaseTreeSkeleton`); error + `Try again`; empty (`ImportPrompt`: diamond, orange CTA `Import folder`, secondary `Import .zip`, ghost links `Convert a CGNS mesh` / `Merge meshes`); data (toolbar + indented tree with sizes).
- Toolbar: `Import folder`, `Import .zip`, `Convert mesh` (see `mesh-library-and-conversion.md`), `Merge meshes` (see `merge-and-assembly.md`), `Boundary conditions` (only if the case contains `constant/polyMesh/`, see `boundary-conditions.md`), `Edit files` (link `/projects/:id/edit`), `Calculator` and `TopoSet` (see `solver-and-runs.md`), `Download` (ghost), then `Reset` and the orange CTA `Verify case`.
- **Import**: toast `Imported N files.`; if a written path contains `polyMesh/`, the Boundary conditions dialog opens automatically.
- **Verify case**: opens `ApplyTemplateFlow` (step `choice`) listing the missing base files, with `Add minimal base files` (CTA, if `canScaffold`), `Use a saved template…` (see `templates.md`) or `Ignore`. A note is shown if the mesh is missing.
- **Reset**: confirmation `AlertDialog`, not closable during deletion; toast "Imported files removed.".
- **Download**: zip `case-<projectId>.zip` built through a temporary anchor (`URL.createObjectURL`).
- `Summary` tab (`CaseSummary`): for each file ≤ 2 MB outside `constant/polyMesh/`, a header (folder, `object`, `class` badge, number of entries) and a recursive key → value `<dl>`; mention of the number of skipped files; empty state "Nothing to summarise yet".

**Full-screen editor** `/projects/:id/edit` (`ProjectEditPage` → `FileTreeEditor` with `enableEasyMode`):
- Left pane: tree (clickable files, folders as drop targets), `New file`, per-row menu (move, delete), drag and drop.
- Right pane: empty (diamond), skeleton, `FILE_TOO_LARGE` (file > 2 MB not editable), error + retry, otherwise Easy form or CodeMirror. `Easy` / `Advanced` toggle (`aria-pressed`); Easy is selected by default when the file is recognized by the catalog.
- Save status: `Editing…`, `Saving…`, `All changes saved`, `Save failed` + `Retry`. `UnsavedChangesPrompt` blocks navigation if a draft is not saved.

## 3. Business rules and invariants
- Project visibility required (`assertProjectVisible`, 404 `NOT_FOUND` without leaking existence). No owner / collaborator distinction for files.
- Import: a zip (`archive`) or `files` parts named by their relative path; nothing → 400 `NO_FILES_UPLOADED`. Paths sanitized and confined (`..`, drive letter, zip-slip → 400 `INVALID_ARCHIVE`).
- Normalization on import (`normalizeCasePaths`): removal of up to 4 common wrapper folders (never `system`, `constant`, `0`, `polyMesh`), then a bare `polyMesh/` is moved under `constant/`. Import writes over existing content, it does not empty the case.
- Caps: `Content-Length` > `MAX_UPLOAD_TOTAL_MB` refused before buffering (413); each file ≤ `MAX_UPLOAD_MB`; at most 5,000 files; uncompressed zip ≤ `MAX_ARCHIVE_UNCOMPRESSED_MB` (413 `ARCHIVE_TOO_LARGE`, H9).
- Editing: read and save limited to `EDITABLE_FILE_MAX_BYTES` (2 MB, 413 `FILE_TOO_LARGE`); `PUT` requires the file to exist (404); creation refuses an existing path (409 `FILE_EXISTS`); move refuses an existing destination (409) or a folder into itself (400).
- Verify: presence of the 5 `MESH_FILES` (`constant/polyMesh/{points,faces,owner,neighbour,boundary}`, never generated) and of the 5 `BASE_FILE_PATHS` (`system/controlDict`, `system/fvSchemes`, `system/fvSolution`, `0/U`, `0/p`).
- Minimal scaffold: writes only the missing `BASE_FILE_PATHS`, never overwrites; the generated `0/U` and `0/p` cover the patches read from `constant/polyMesh/boundary`. This skeleton is not runnable (`application foamRun`, see L7): the per-solver "Make runnable" belongs to `solver-and-runs.md`.
- Easy mode: each change replaces only the character range of the value (`setFoamValue`); banner, comments, directives and unknown content are preserved byte for byte. `#include` directives are terminated at the line break (H8). Sections that are too deep (> 4 levels) or unknown: "Edit in Advanced mode".
- Autosave: 600 ms after the last keystroke, immediate flush before switching files; the draft is only reloaded when the file changes (H4).
- Reset: `rm -rf` of `case/` only; CGNS sources, the mesh library, the `viz/` render, run logs and the `backups/` slot survive.
- Download: 404 if the case is empty.

## 4. Technical flow

### Import
`CaseFilesSection.handleImport` → `useImportCase(projectId)` (`{ kind: 'folder', files } | { kind: 'zip', file }`) → `POST /api/v1/projects/:id/files/import` (multipart via `parseCaseUpload`, `preservePath`) → `importCaseFilesController` → `files.service.importCaseFiles` → `caseStorage.extractArchive` or `writeUploadedFiles` → `fileTreeStorage.writeNormalizedAt`. Response `{ written, entries }`; the hook writes `entries` into `['projects', id, 'files']` and removes cached contents.

### Tree and content
- `useCaseFilesQuery` → `GET /projects/:id/files` → `listCaseTree` (sort `comparePaths`, `0` before `0.orig`).
- `useCaseFileContentQuery(path)` → `GET /files/content?path=` → `readCaseFileContent`.
- `useSaveCaseFile` → `PUT /files/content?path=` (raw text body, `express.text` limited to 2 MB) → `saveCaseFileContent`; the hook writes the content locally then invalidates the tree.
- `useCreateCaseFile` (`POST /files/content`), `useDeleteCaseFile` (`DELETE /files/content`), `useDeleteCaseDir` (`DELETE /files/dir`), `useMoveCaseEntry` (`POST /files/move`): each rewrites the returned tree and purges the affected contents.
- `FileTreeEditor` receives these seven hooks through a `FileTreeResource` (the same component is used for templates).

### Easy mode
`foamForm.matchFoamFileDef` reads `FoamFile.object` / `class` and finds the entry in `FOAM_FIELD_CATALOG` (`0/` fields U, p, k, omega, nut, epsilon, nuTilda; `transportProperties`, `turbulenceProperties`; `controlDict`, `decomposeParDict`, `fvSchemes`, `fvSolution`). `foamEasyModeAvailable` decides whether the toggle is offered (false for list-format files such as `polyMesh/boundary`). `CaseFileForm` parses with `foamModel.parseFoamModel` (positional parser) and renders a `<select>` for `enum` / `bool` (including a "Boundary type" per `boundaryField` patch), and a text field validated on blur for the rest.

### Verify and scaffold
`useVerifyCase` → `GET /files/verify` → `verifyCase` (`CaseVerification`: `hasMesh`, `missingMesh`, `presentBase`, `missingBase`, `complete`, `canScaffold`). `Add minimal base files` → `useScaffoldCase` → `POST /files/scaffold` → `scaffoldCase` → `renderBaseFile(file, patches)`.

### Download and reset
- `downloadCase` (`GET /files/download`) → `buildCaseArchive` → `zipCase` (files only, in-memory buffer).
- `ResetCaseButton` → `useResetCase` → `DELETE /projects/:id/files` → `resetCase` → `clearCase`. The hook removes the contents and the 3D render of the case and invalidates `meshes`, `assembly`, `mergePlan` (H6).

### Summary
`CaseSummary` filters the tree then runs a `useQueries` (same key as the editor, shared cache); each content is parsed by `foamSummary.parseFoam` (tolerant parser without positions, distinct from `foamModel`).

### Cross-references
- TopoSet (`TopoSetDialog`) and the turbulence calculator (`TurbulenceCalculatorDialog`) are mounted by `CaseFilesSection` but described in `solver-and-runs.md`.
- `POST /files/sync-boundaries` (`useSyncBoundaries`, mode `merge`) is triggered by applying a template (`templates.md`) and by the solver.

## 5. Data and storage
- No Prisma model: everything is on disk under `<STORAGE_DIR>/projects/<projectId>/case/` (`caseStorage`, core `fileTreeStorage`). In-place writes, no atomicity.
- TanStack caches: `['projects', id, 'files']` (tree) and `['projects', id, 'files', 'content', path]` (contents, prefixed by the tree key: invalidating the tree also invalidates all contents).
- See `brain/architecture/storage-layout.md` § `projects/<id>/case/` for the list of writers (conversion, merge, BC, runs).

## 6. Configuration and external dependencies
- No external tool: pure file editing.
- Env: `STORAGE_DIR` (relative to the API cwd), `MAX_UPLOAD_MB` (1024), `MAX_UPLOAD_TOTAL_MB` (2048), `MAX_ARCHIVE_UNCOMPRESSED_MB` (2048). Shared constant `EDITABLE_FILE_MAX_BYTES` (2 MB).
- Front end: CodeMirror (`@uiw/react-codemirror`, language `cpp()`) loaded in the lazy chunk of `ProjectEditPage`.

## 7. Tests
- API `projectFiles.test.ts`: tree, folder import (bare polyMesh relocated), zip, zip-slip 400, reset, verify, scaffold without overwrite, download (404 if empty), collaborator / super-admin rights, content (404, traversal, 413), creation 409, deletion, move.
- API `fileTreeStorage.test.ts` (sort `0` / `0.orig`, H9 cap), `openfoamCase.test.ts` (`normalizeCasePaths`, `renderBaseFile`).
- Web `CaseFilesSection.test.tsx` (empty state, tree, confirmed reset, Verify opening `ApplyTemplateFlow`, scaffold, Summary tab without reading `polyMesh/points`), `CaseFileForm.test.tsx`, `foamModel.test.ts` (including H8 regression), `foamForm.test.ts`, `pages/ProjectEditPage.test.tsx` (selection, debounced autosave).
- Not covered: `FileTreeEditor` (no direct test), `foamSummary`.

## 8. History
- 2026-06-22: case import (tree, download, verify, scaffold), CodeMirror editor, 600 ms debounced autosave, Files / Summary tabs, Reset (`brain/changelog/2026-06.md`).
- 2026-06-23: catalog-driven Easy / Advanced mode; moving and deleting folders (`2026-06.md`).
- 2026-07-09: `Calculator` and `TopoSet` buttons in the toolbar (`2026-07.md`).
- 2026-07-10: fixes H4 (autosave), H8 (`#include`), H9 (upload caps), H6 (3D caches after reset) (`2026-07.md`).

## 9. Known limits and bugs
- M1: no "active run" guard on reset, move or delete of files.
- M15: deleting an open, modified file resurrects it (autosave armed); dragging a modified file loses the edit.
- M9: global JSON limit of 16 KB (mostly affects templates).
- M20: download buffered in memory (server and client).
- K1: `POST /files/content` ignores `content` (only `path` passes validation).
- K14: `foamSummary.ts` does not have the H8 fix (Summary wrong after an `#include` without `;`).
- K16: `useSaveCaseFile` invalidates the content it just wrote; `useProjects` invalidates all of `['projects']`.
- K17: `useImportCase` does not purge the 3D render although an import can replace `constant/polyMesh`.
- K25: `Download` button in `text-cta` on `text-sm` (AA contrast to verify); `text-white` and `rounded-[6px]` in `FileTreeEditor`.
- K29: `INVALID_ARCHIVE` also returned for a file read or move.
- L7: generic scaffold with `application foamRun;` (does not exist in ESI v2406).
- L17: the Summary tab issues one GET per file (hundreds after a run).

## 10. Changing this feature
- Any new mutation that touches `constant/polyMesh` must purge `['projects', id, 'mesh', 'manifest' | 'glb' | 'edges']` (H6 pattern) and invalidate `meshes` / `assembly` / `mergePlan`.
- `FileTreeEditor` is shared with templates and the solver: do not introduce a project dependency in it, go through the `FileTreeResource`.
- Two FOAM parsers coexist: `foamModel.ts` (editing, positions) and `foamSummary.ts` (reading). A parsing fix must be ported to both.
- The Easy catalog (`foamFieldCatalog.ts`) contains exact OpenFOAM tokens: do not "clean them up".
- Changing a size limit requires touching together `EDITABLE_FILE_MAX_BYTES` (`packages/shared`, then `npm run build:shared`), `parseFileContent` (`projects.routes.ts`) and the templates text parser.
