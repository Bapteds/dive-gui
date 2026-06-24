// Filesystem storage for per-project CGNS mesh sources (and the intermediate
// VTK produced from them during conversion).
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/cgns/<name>.cgns
//                                              .../<name>.vtk   (conversion work)
//
// CGNS files are *inputs* to the mesh conversion, kept deliberately apart from
// the OpenFOAM case tree (caseStorage.ts) so importing/resetting a case never
// touches them. This is a thin façade over the shared, path-traversal-safe core
// in fileTreeStorage.ts, pinned to the project's cgns root. Uploaded names are
// flattened to a single safe segment (no sub-directories).
import path from 'node:path';
import {
  assertSafeId,
  clearTreeAt,
  confineJoin,
  deleteFileAt,
  fileExistsAt,
  listTree,
  readFileAt,
  sanitizeRelative,
  storageRoot,
  writeFileAt,
  type FileEntry,
} from './fileTreeStorage';

/** A single stored CGNS (or intermediate VTK) file entry. */
export type CgnsEntry = FileEntry;

/** Absolute path to a project's cgns root. */
function cgnsRootFor(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'cgns');
}

/**
 * Reduce an uploaded filename to a single safe segment: drop any directory
 * components a browser/client may include, then sanitize. Keeps the basename so
 * the stored name matches what the user uploaded.
 */
export function cgnsBaseName(rawName: string): string {
  const base = rawName.replace(/\\/g, '/').split('/').pop() ?? rawName;
  return sanitizeRelative(base);
}

/** Absolute path of a named file under a project's cgns root (confined). */
export function cgnsFileAbsolute(projectId: string, name: string): string {
  return confineJoin(cgnsRootFor(projectId), sanitizeRelative(name));
}

/** Persist an uploaded CGNS file under its (sanitized) basename. Returns the name. */
export async function writeCgnsUpload(
  projectId: string,
  rawName: string,
  data: Buffer,
): Promise<string> {
  const name = cgnsBaseName(rawName);
  await writeFileAt(cgnsRootFor(projectId), name, data);
  return name;
}

/** List the CGNS source files a project holds (the intermediate .vtk is hidden). */
export async function listCgnsFiles(projectId: string): Promise<CgnsEntry[]> {
  const tree = await listTree(cgnsRootFor(projectId));
  return tree.filter((entry) => entry.type === 'file' && entry.path.toLowerCase().endsWith('.cgns'));
}

/** Does a specific CGNS file exist in the project? */
export function cgnsFileExists(projectId: string, name: string): Promise<boolean> {
  return fileExistsAt(cgnsRootFor(projectId), name);
}

/** Read a CGNS file's bytes, or null if absent. */
export function readCgnsFile(projectId: string, name: string): Promise<Buffer | null> {
  return readFileAt(cgnsRootFor(projectId), name);
}

/** Delete a single CGNS (or intermediate) file, pruning empty parents. */
export function deleteCgnsFile(projectId: string, name: string): Promise<void> {
  return deleteFileAt(cgnsRootFor(projectId), name);
}

/** Remove every CGNS file for a project (the dir is recreated on next upload). */
export function clearCgns(projectId: string): Promise<void> {
  return clearTreeAt(cgnsRootFor(projectId));
}
