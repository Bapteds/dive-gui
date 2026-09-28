# Feature · Templates (reusable case file sets)

> **Status**: in production · **Updated**: 2026-09-28
> **Specs**: no dedicated spec · **Codemaps**: `brain/codemap/api-core.md` (module `templates`), `brain/codemap/api-lib.md` (`templateStorage`, `fileTreeStorage`), `brain/codemap/web-features-platform.md` (`features/templates/`, `features/files/`), `brain/codemap/web-core.md` (`pages/TemplatesPage.tsx`, `pages/TemplateEditPage.tsx`, `lib/api/templates.ts`), `brain/codemap/root-shared-mcp.md` (limits and `normalizeTags`)

## 1. Purpose
A template is a free-form file tree (typically `system/`, `constant/`, `0/`) shared among all users, tagged and described, that can be applied to any project to complete or repair its case. Three uses: completing a case after `Verify case`, providing the configuration during a CGNS conversion, and copying a few chosen files during solver setup.
Access: any authenticated user lists, reads and applies all templates; only the author or a super-admin edits or deletes a template and its files; applying to a project additionally requires project visibility.

## 2. User journey
**Page `/templates`** (`TemplatesPage`):
- Header with orange CTA `New template`; states skeleton, `ErrorState` + retry, empty ("No templates yet."), list.
- Toolbar: search `Search templates…` (name, description, tags) and cumulative tag filters (click on a row's tag chip; active chips removable). No client-side sort: order is the server's (`createdAt` descending). No match: "No templates match your search.".
- Table `Name` (link to the editor + tag chips) / `Description` / `Author` (`You` or email) / `Created`; actions `Edit … details` and `Delete …` visible only to the author or a super-admin (`AlertDialog` "Delete this template? This cannot be undone.").
- `TemplateFormDialog` (creation and metadata editing): `Name`, `Tags` (separated by commas or line breaks), `Description`, and on creation `Start with`: `Empty file set` or `Single file` (fields `File path` + `Content`, the "inline" template). After creation, redirect to the editor.

**Editor `/templates/:id/edit`** (`TemplateEditPage` → `FileTreeEditor`, Advanced mode only): same tree + CodeMirror + autosave as the case editor (see `case-files.md`). For the author or a super-admin: `Import folder` (select a parent folder then `FolderImportDialog` to check the immediate children to keep, checkbox `Keep the <root> folder`) and `Import .zip`. For others: read-only (`canEdit = false`).

**Applying to a project**:
- `ApplyTemplateFlow` (from `Verify case` in Case files): `Use a saved template…` → template list (author `You` or email) → conflict preview. No conflict: direct application. With conflicts: `ConflictsDialog`, radio `Keep` / `Overwrite` per file (default `Keep`), CTA `Apply (overwrite N)`. Checkbox checked by default "Apply the boundary type and name to the 0/ fields" which then runs a `boundaryField` synchronization. Toast `Applied N file(s) from the template.`.
- `ConvertToFoamFlow`: choosing a template is mandatory before CGNS conversion (see `mesh-library-and-conversion.md`).
- `TemplateFilePicker` ("Add from template file", files step of the solver wizard): pick a template, check files, `Import N file(s)`; these files always overwrite those of the case.

## 3. Business rules and invariants
- Rights: `canManageTemplate` = author or `SUPER_ADMIN`, otherwise 403 `FORBIDDEN` ("Only the template author can change this template") on update, delete, import, file creation / save / deletion / move. Reading files is open to any authenticated user.
- Metadata: `name` 1 to 120 characters, `description` ≤ 2,000; tags normalized by `normalizeTags` (lowercase, spaces to hyphens, charset `a-z0-9-`, 24 characters max, deduplicated, 12 max). The input schema accepts up to 24 raw tags of 72 characters before normalization.
- Files: no wrapper folder removal on import ("what you import is what you get", `normalizeTemplatePaths` only sanitizes); same path protections as the case (zip-slip, traversal) and same upload caps; editing limited to 2 MB (413 `FILE_TOO_LARGE`).
- Inline template: the initial file is written after the database row is created; > 2 MB → 413 (see M10).
- Full application (`applyTemplate`): conflicts recomputed on the server; an existing file is only overwritten if the decision is `overwrite` (default: keep); new files always written; binary copy without size cap. Result `{ applied, skipped, entries }`.
- Per-file application (`applyTemplateFiles`): `paths` 1 to 1,000; each path present in the template overwrites the case file; the others are `skipped`.
- Deleting a template or its author: best-effort disk purge (`removeTemplateStorage`).

## 4. Technical flow

### CRUD and files
- Hooks `features/templates/useTemplates.ts` → `lib/api/templates.ts` → router `/api/v1/templates` (`templates.routes.ts`, `requireAuth`) → `templates.controller` → `templates.service` → `lib/templateStorage` (facade over `fileTreeStorage`).
- `useTemplatesQuery` (`GET /templates`), `useCreateTemplate` (`POST /templates`), `useUpdateTemplate` (`PATCH /templates/:id`), `useDeleteTemplate` (`DELETE /templates/:id`).
- Files: `GET /templates/:id/files`, `POST /templates/:id/files/import` (multipart via `parseCaseUpload`), `GET|PUT|POST|DELETE /templates/:id/files/content`, `DELETE /templates/:id/files/dir`, `POST /templates/:id/files/move`. `TemplateEditPage` wires these hooks into `FileTreeEditor` through a `FileTreeResource`.
- Folder import: `folderImport.groupPickedFolder` groups the `webkitdirectory` selection by immediate child; `uploadPath` strips the root unless `keepRoot`.

### Applying to a project
- `usePreviewApplyTemplate` → `GET /projects/:id/apply-template/:templateId/preview` → `previewApplyTemplate` (`{ files, conflicts, newFiles }`).
- `useApplyTemplate` → `POST /projects/:id/apply-template/:templateId` (`{ decisions? }`) → `applyTemplate` → `writeCaseFile`. The hook writes the case tree.
- Then, if the checkbox is checked, `useSyncBoundaries` → `POST /projects/:id/files/sync-boundaries` → `syncBoundaryFields` in `merge` mode (existing BCs kept, mesh patches added with a generic default; 409 `NO_MESH` without a mesh, shown as a toast).
- `useApplyTemplateFiles` → `POST /projects/:id/apply-template/:templateId/files` (`{ paths }`) → `applyTemplateFiles`.
- CGNS conversion: `conversion.service` calls `getTemplate` then `applyTemplate` directly without decisions (existing files kept).

## 5. Data and storage
- Prisma `Template`: `name`, `description?`, `tags` (JSON text), `ownerId` (cascade on owner deletion), dates.
- Disk: `<STORAGE_DIR>/templates/<templateId>/files/<free-form tree>`.
- TanStack caches: `['templates']`, `['templates', id]`, `['templates', id, 'files']`, `['templates', id, 'files', 'content', path]`. Invalidating `['templates']` invalidates by prefix all template trees and contents. Applying writes `['projects', id, 'files']` but does not purge the case file contents (M14).

## 6. Configuration and external dependencies
- No external tool.
- Env: `STORAGE_DIR`, upload caps (`MAX_UPLOAD_MB`, `MAX_UPLOAD_TOTAL_MB`, `MAX_ARCHIVE_UNCOMPRESSED_MB`). Global API JSON limit: 16 KB (`app.ts`), which applies to the creation body (inline template) and to `paths` / `decisions` (M9).
- Shared constants: `TEMPLATE_NAME_MAX_LENGTH`, `TEMPLATE_DESCRIPTION_MAX_LENGTH`, `TEMPLATE_TAG_MAX_LENGTH`, `TEMPLATE_TAGS_MAX`, `EDITABLE_FILE_MAX_BYTES`.

## 7. Tests
- API `templates.test.ts`: 401, creation / list with `owner.email`, update and delete by the author (403 for others, super-admin allowed), files (409, 403, read by everyone, zip import 403 for others, delete, move), preview and apply (keeps existing by default, explicit `overwrite`, 404 invisible project, collaborator allowed with a third party's template), per-file apply (overwrites, skips missing paths, 422 empty list), tag normalization, inline template.
- API `conversion.test.ts`: "Applied template" note in the conversion.
- Web: `features/templates/schemas.test.ts` (`parseTagInput`, `templateFormSchema`), `features/files/folderImport.test.ts`, `CaseFilesSection.test.tsx` (opening `ApplyTemplateFlow`).
- Not covered: `TemplatesPage`, `TemplateEditPage`, `ApplyTemplateFlow`, `TemplateFilePicker`, `FileTreeEditor` (K30).

## 8. History
- 2026-06-22: shared templates applicable to a project with per-file conflict resolution (`brain/changelog/2026-06.md`).
- 2026-06-23: import of a parent folder with a selection overlay, root stripped by default; moving and deleting folders (`2026-06.md`).
- 2026-07-02: inline single-file template, tags, search and tag filter (Slice T1); import of chosen files from a template in the solver wizard (Slice S3) (`2026-07.md`).

## 9. Known limits and bugs
- M9: 16 KB JSON limit incompatible with an inline template close to 2 MB and with an apply of 1,000 paths (raw 413).
- M10: `createTemplate` creates the row before validating the initial file (empty ghost template on 413).
- M14: applying a template does not clear the cached file contents; the open editor may re-autosave the stale content.
- L20: `FolderImportDialog` keeps the previous selection for a folder with the same name and the same number of children.
- K25: orange CTA of `ApplyTemplateFlow` in inline classes with `text-white`.
- K27: `parseTagInput` does not split on spaces despite its doc (normalization on the server).
- K28: no error state in `TemplateFilePicker`; closing not blocked during import.
- The header comment of `templateStorage.ts` announces a wrapper removal that the code does not do.

## 10. Changing this feature
- Rights are duplicated: `canManageTemplate` in the service and `canManage` / `canEdit` in the pages (`TemplatesPage`, `TemplateEditPage`). Change them together.
- Any new limit (tags, names) lives in `packages/shared`: rebuild with `npm run build:shared` before typecheck and tests.
- A change in application semantics (overwrite, decisions) touches `templates.service`, `ApplyTemplateFlow`, `TemplateFilePicker` and the CGNS conversion (which applies without decisions).
- To fix M14, purge `['projects', id, 'files', 'content']` in `useApplyTemplate` and `useApplyTemplateFiles`.
