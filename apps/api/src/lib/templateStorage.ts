// Filesystem storage for reusable file templates.
//
// Layout:  <STORAGE_DIR>/templates/<templateId>/files/<free tree>
//
// A template holds a free-form tree of files (no OpenFOAM structure is assumed,
// unlike a project case). Like caseStorage this is a thin façade over the shared
// path-traversal-safe core in fileTreeStorage; the only template-specific bit is
// a lightweight import normalization that strips a single common wrapper folder
// (the selected folder name) so picking a folder does not nest everything under
// its own name.
import path from 'node:path';
import {
  assertSafeId,
  clearTreeAt,
  deleteFileAt,
  extractArchiveAt,
  fileExistsAt,
  listTree,
  readFileAt,
  removeTreeAt,
  sanitizeRelative,
  storageRoot,
  writeFileAt,
  writeNormalizedAt,
  type FileEntry,
} from './fileTreeStorage';

/** A single node in a template's file tree. */
export type TemplateEntry = FileEntry;

/** Absolute path to a template's files root. */
function templateRootFor(templateId: string): string {
  assertSafeId(templateId);
  return path.join(storageRoot(), 'templates', templateId, 'files');
}

/** Absolute path to a template's whole storage subtree (used on delete). */
function templateDirFor(templateId: string): string {
  assertSafeId(templateId);
  return path.join(storageRoot(), 'templates', templateId);
}

/**
 * Map uploaded paths onto a clean template-relative tree. A template is a
 * free-form tree, so — unlike a project case — we apply no wrapper stripping or
 * OpenFOAM nesting: every path is just sanitized (separators, leading slashes,
 * `..` traversal) and otherwise preserved exactly as uploaded ("what you import
 * is what you get"). This keeps a legitimate top-level folder (e.g. `system/`)
 * intact instead of silently collapsing it.
 */
export function normalizeTemplatePaths(rawPaths: string[]): string[] {
  return rawPaths.map(sanitizeRelative);
}

/** Persist files uploaded as a folder (each carrying its relative path). */
export function writeUploadedTemplateFiles(
  templateId: string,
  files: Array<{ relativePath: string; data: Buffer }>,
): Promise<string[]> {
  return writeNormalizedAt(
    templateRootFor(templateId),
    files.map((f) => ({ rawPath: f.relativePath, data: f.data })),
    normalizeTemplatePaths,
  );
}

/** Extract a .zip archive into the template tree. @throws INVALID_ARCHIVE on a bad zip. */
export function extractTemplateArchive(templateId: string, archive: Buffer): Promise<string[]> {
  return extractArchiveAt(templateRootFor(templateId), archive, normalizeTemplatePaths);
}

/** Walk a template's file tree (files and directories). Empty until something is added. */
export function listTemplateTree(templateId: string): Promise<TemplateEntry[]> {
  return listTree(templateRootFor(templateId));
}

/** Does a specific template file exist? */
export function templateFileExists(templateId: string, relPath: string): Promise<boolean> {
  return fileExistsAt(templateRootFor(templateId), relPath);
}

/** Read a template file's bytes, or null if it does not exist. */
export function readTemplateFile(templateId: string, relPath: string): Promise<Buffer | null> {
  return readFileAt(templateRootFor(templateId), relPath);
}

/** Write (or overwrite) a single template file, creating parent directories. */
export function writeTemplateFile(
  templateId: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  return writeFileAt(templateRootFor(templateId), relPath, content);
}

/** Delete a single template file, pruning any parent directories left empty. */
export function deleteTemplateFile(templateId: string, relPath: string): Promise<void> {
  return deleteFileAt(templateRootFor(templateId), relPath);
}

/** Remove all of a template's files (the root is recreated on next write). */
export function clearTemplateFiles(templateId: string): Promise<void> {
  return clearTreeAt(templateRootFor(templateId));
}

/** Recursively remove a template's entire storage subtree (used on delete). */
export function removeTemplateStorage(templateId: string): Promise<void> {
  return removeTreeAt(templateDirFor(templateId));
}
