// Filesystem storage for per-project OpenFOAM case files.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/case/<case tree>
//
// This is a thin façade over the shared, path-traversal-safe core in
// fileTreeStorage.ts: it pins every operation to the project's case root and
// owns the OpenFOAM-specific import normalization (a bare `polyMesh` folder
// lands under `constant/polyMesh/`, and a wrapping directory — the selected
// folder name or a case folder — is stripped). The generic I/O, sanitization
// and zip-slip confinement live in fileTreeStorage.
import path from 'node:path';
import {
  assertSafeId,
  clearTreeAt,
  commonWrapperSegment,
  deleteDirAt,
  deleteFileAt,
  extractArchiveAt,
  fileExistsAt,
  listTree,
  moveAt,
  readFileAt,
  removeTreeAt,
  sanitizeRelative,
  storageRoot,
  treeIsEmpty,
  writeFileAt,
  writeNormalizedAt,
  zipTreeAt,
  type FileEntry,
  type MoveResult,
} from './fileTreeStorage';

/** A single node in a project's case tree. */
export type CaseEntry = FileEntry;

/** The canonical OpenFOAM case directories; never stripped as wrappers. */
const CASE_DIRS = new Set(['system', 'constant', '0']);

/** Absolute path to a project's case root. */
function caseRootFor(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'case');
}

/**
 * Absolute path to a project's case root, for callers that must hand a real
 * filesystem path to an external process (e.g. the OpenFOAM mesh utilities run
 * with `-case <dir>`). The id is validated; the directory may not exist yet.
 */
export function caseDirAbsolute(projectId: string): string {
  return caseRootFor(projectId);
}

/**
 * Map uploaded paths onto a clean case-relative tree:
 *  - strip up to a few wrapper directories (selected folder name / case folder),
 *    but never strip a real case dir (system/constant/0) or a polyMesh root;
 *  - nest any bare `polyMesh/...` under `constant/`.
 */
export function normalizeCasePaths(rawPaths: string[]): string[] {
  let paths = rawPaths.map(sanitizeRelative);

  for (let depth = 0; depth < 4; depth += 1) {
    const root = commonWrapperSegment(paths);
    if (root === null || CASE_DIRS.has(root) || root === 'polyMesh') break;
    paths = paths.map((p) => p.split('/').slice(1).join('/'));
  }

  return paths.map((p) => {
    const segs = p.split('/');
    return segs[0] === 'polyMesh' ? ['constant', ...segs].join('/') : p;
  });
}

/** Persist files uploaded as a folder (each carrying its relative path). */
export function writeUploadedFiles(
  projectId: string,
  files: Array<{ relativePath: string; data: Buffer }>,
): Promise<string[]> {
  return writeNormalizedAt(
    caseRootFor(projectId),
    files.map((f) => ({ rawPath: f.relativePath, data: f.data })),
    normalizeCasePaths,
  );
}

/** Extract a .zip archive into the case tree. @throws INVALID_ARCHIVE on a bad zip. */
export function extractArchive(projectId: string, archive: Buffer): Promise<string[]> {
  return extractArchiveAt(caseRootFor(projectId), archive, normalizeCasePaths);
}

/** Walk a project's case tree (files and directories). Empty if not imported. */
export function listCaseTree(projectId: string): Promise<CaseEntry[]> {
  return listTree(caseRootFor(projectId));
}

/** True when the project has no case files yet. */
export function caseIsEmpty(projectId: string): Promise<boolean> {
  return treeIsEmpty(caseRootFor(projectId));
}

/** Does a specific case file exist? */
export function caseFileExists(projectId: string, relPath: string): Promise<boolean> {
  return fileExistsAt(caseRootFor(projectId), relPath);
}

/** Read a case file's bytes, or null if it does not exist. */
export function readCaseFile(projectId: string, relPath: string): Promise<Buffer | null> {
  return readFileAt(caseRootFor(projectId), relPath);
}

/** Write (or overwrite) a single case file, creating parent directories. */
export function writeCaseFile(
  projectId: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  return writeFileAt(caseRootFor(projectId), relPath, content);
}

/** Delete a single case file, pruning any parent directories left empty. */
export function deleteCaseFile(projectId: string, relPath: string): Promise<void> {
  return deleteFileAt(caseRootFor(projectId), relPath);
}

/** Recursively delete a case directory subtree, pruning empty parents. */
export function deleteCaseDir(projectId: string, relPath: string): Promise<void> {
  return deleteDirAt(caseRootFor(projectId), relPath);
}

/** Move (or rename) a case file or directory within the case tree. */
export function moveCasePath(
  projectId: string,
  fromRel: string,
  toRel: string,
): Promise<MoveResult> {
  return moveAt(caseRootFor(projectId), fromRel, toRel);
}

/** Build a .zip of the whole case tree (files only). */
export function zipCase(projectId: string): Promise<Buffer> {
  return zipTreeAt(caseRootFor(projectId));
}

/** Recursively remove a project's entire storage subtree (used on delete). */
export function removeProjectStorage(projectId: string): Promise<void> {
  assertSafeId(projectId);
  return removeTreeAt(path.join(storageRoot(), 'projects', projectId));
}

/** Remove all of a project's case files (the case dir is recreated on next import). */
export function clearCase(projectId: string): Promise<void> {
  return clearTreeAt(caseRootFor(projectId));
}
