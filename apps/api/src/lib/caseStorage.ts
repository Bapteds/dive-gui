// Filesystem storage for per-project OpenFOAM case files.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/case/<case tree>
//
// Everything here is path-traversal safe: every relative path coming from an
// upload, an archive, or a caller is sanitized and then confined to the
// project's case root before any filesystem access (defends against zip-slip
// and `../` escapes). Uploaded trees are also normalized so that importing a
// bare `polyMesh` folder lands under `constant/polyMesh/`, and a wrapping
// directory (the selected folder name, a case folder) is stripped.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { env } from '../config/env';
import { AppError } from './AppError';

/** A single node in a project's case tree. */
export interface CaseEntry {
  /** Forward-slash relative path from the case root. */
  path: string;
  type: 'file' | 'directory';
  /** Size in bytes (0 for directories). */
  size: number;
}

/** An item to write: its raw (pre-normalization) path and its bytes. */
interface RawUpload {
  rawPath: string;
  data: Buffer;
}

/** The canonical OpenFOAM case directories; never stripped as wrappers. */
const CASE_DIRS = new Set(['system', 'constant', '0']);

/** Absolute storage root, resolved from env relative to the process cwd. */
function storageRoot(): string {
  return path.resolve(process.cwd(), env.STORAGE_DIR);
}

/** Guard a project id used as a path segment (real ids are cuids: [a-z0-9]). */
function assertSafeProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid project id');
  }
}

/** Absolute path to a project's case root. */
function caseRootFor(projectId: string): string {
  assertSafeProjectId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'case');
}

/**
 * Sanitize a single relative path: normalize separators, drop leading slashes,
 * `.` segments and drive letters, and reject any `..` traversal. Returns a
 * clean forward-slash relative path with at least one segment.
 */
function sanitizeRelative(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new AppError(400, 'INVALID_ARCHIVE', `Unsafe path in upload: ${input}`);
  }
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new AppError(400, 'INVALID_ARCHIVE', `Unsafe path in upload: ${input}`);
  }
  const safe = segments.join('/');
  if (!safe) {
    throw new AppError(400, 'INVALID_ARCHIVE', 'Empty path in upload');
  }
  return safe;
}

/** The shared first segment of every path (each with depth >= 2), else null. */
function commonWrapperSegment(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/')[0];
  const allShare = paths.every((p) => {
    const segs = p.split('/');
    return segs.length >= 2 && segs[0] === first;
  });
  return allShare ? first : null;
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

/** Resolve a sanitized relative path under the case root, confined to it. */
function confineJoin(caseRoot: string, relPath: string): string {
  const abs = path.resolve(caseRoot, relPath);
  const root = path.resolve(caseRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new AppError(400, 'INVALID_ARCHIVE', `Unsafe path: ${relPath}`);
  }
  return abs;
}

/** Write a batch of raw uploads, returning the normalized relative paths written. */
async function writeNormalized(projectId: string, items: RawUpload[]): Promise<string[]> {
  const caseRoot = caseRootFor(projectId);
  const normalized = normalizeCasePaths(items.map((i) => i.rawPath));
  const written: string[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const rel = normalized[i];
    const abs = confineJoin(caseRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, items[i].data);
    written.push(rel);
  }
  return [...new Set(written)].sort((a, b) => a.localeCompare(b));
}

/** Persist files uploaded as a folder (each carrying its relative path). */
export function writeUploadedFiles(
  projectId: string,
  files: Array<{ relativePath: string; data: Buffer }>,
): Promise<string[]> {
  return writeNormalized(
    projectId,
    files.map((f) => ({ rawPath: f.relativePath, data: f.data })),
  );
}

/** Extract a .zip archive into the case tree. @throws INVALID_ARCHIVE on a bad zip. */
export function extractArchive(projectId: string, archive: Buffer): Promise<string[]> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(archive);
  } catch {
    throw new AppError(400, 'INVALID_ARCHIVE', 'The uploaded file is not a valid .zip archive');
  }
  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (fileEntries.length === 0) {
    throw new AppError(400, 'INVALID_ARCHIVE', 'The archive contains no files');
  }
  return writeNormalized(
    projectId,
    fileEntries.map((entry) => ({ rawPath: entry.entryName, data: entry.getData() })),
  );
}

/** Walk a project's case tree (files and directories). Empty if not imported. */
export async function listCaseTree(projectId: string): Promise<CaseEntry[]> {
  const caseRoot = caseRootFor(projectId);
  const entries: CaseEntry[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, type: 'directory', size: 0 });
        await walk(abs, rel);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(abs);
        entries.push({ path: rel, type: 'file', size: stat.size });
      }
    }
  }

  await walk(caseRoot, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** True when the project has no case files yet. */
export async function caseIsEmpty(projectId: string): Promise<boolean> {
  const tree = await listCaseTree(projectId);
  return tree.every((entry) => entry.type !== 'file');
}

/** Does a specific case file exist? */
export async function caseFileExists(projectId: string, relPath: string): Promise<boolean> {
  const abs = confineJoin(caseRootFor(projectId), sanitizeRelative(relPath));
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** Read a case file's bytes, or null if it does not exist. */
export async function readCaseFile(projectId: string, relPath: string): Promise<Buffer | null> {
  const abs = confineJoin(caseRootFor(projectId), sanitizeRelative(relPath));
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** Write (or overwrite) a single case file, creating parent directories. */
export async function writeCaseFile(
  projectId: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  const abs = confineJoin(caseRootFor(projectId), sanitizeRelative(relPath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/** Build a .zip of the whole case tree (files only). */
export async function zipCase(projectId: string): Promise<Buffer> {
  const caseRoot = caseRootFor(projectId);
  const tree = await listCaseTree(projectId);
  const zip = new AdmZip();
  for (const entry of tree) {
    if (entry.type !== 'file') continue;
    const data = await fs.readFile(path.join(caseRoot, entry.path));
    zip.addFile(entry.path, data);
  }
  return zip.toBuffer();
}

/** Recursively remove a project's entire storage subtree (used on delete). */
export async function removeProjectStorage(projectId: string): Promise<void> {
  assertSafeProjectId(projectId);
  const dir = path.join(storageRoot(), 'projects', projectId);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Remove all of a project's case files (the case dir is recreated on next import). */
export async function clearCase(projectId: string): Promise<void> {
  await fs.rm(caseRootFor(projectId), { recursive: true, force: true });
}
