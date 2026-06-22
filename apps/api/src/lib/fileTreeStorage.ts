// Root-parameterized filesystem storage for arbitrary file trees.
//
// This is the shared, path-traversal-safe core used by both per-project case
// files (see caseStorage.ts) and reusable templates (see templateStorage.ts).
// Every relative path coming from an upload, an archive, or a caller is
// sanitized and then confined to the given absolute root before any filesystem
// access (defends against zip-slip and `../` escapes). The OpenFOAM-specific
// path normalization (polyMesh nesting, case-dir wrappers) lives in caseStorage;
// this module knows nothing about it and takes a `normalize` function instead.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { env } from '../config/env';
import { AppError } from './AppError';

/** A single node in a stored file tree. */
export interface FileEntry {
  /** Forward-slash relative path from the tree root. */
  path: string;
  type: 'file' | 'directory';
  /** Size in bytes (0 for directories). */
  size: number;
}

/** An item to write: its raw (pre-normalization) path and its bytes. */
export interface RawUpload {
  rawPath: string;
  data: Buffer;
}

/** A function mapping raw upload paths onto a clean relative tree. */
export type PathNormalizer = (rawPaths: string[]) => string[];

/** Absolute storage root, resolved from env relative to the process cwd. */
export function storageRoot(): string {
  return path.resolve(process.cwd(), env.STORAGE_DIR);
}

/** Guard an id used as a path segment (real ids are cuids: [a-z0-9]). */
export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid id');
  }
}

/**
 * Sanitize a single relative path: normalize separators, drop leading slashes,
 * `.` segments and drive letters, and reject any `..` traversal. Returns a
 * clean forward-slash relative path with at least one segment.
 */
export function sanitizeRelative(input: string): string {
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
export function commonWrapperSegment(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/')[0];
  const allShare = paths.every((p) => {
    const segs = p.split('/');
    return segs.length >= 2 && segs[0] === first;
  });
  return allShare ? first : null;
}

/** Resolve a sanitized relative path under the root, confined to it. */
export function confineJoin(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const resolvedRoot = path.resolve(root);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    throw new AppError(400, 'INVALID_ARCHIVE', `Unsafe path: ${relPath}`);
  }
  return abs;
}

/** Write a batch of raw uploads under a root, returning the normalized paths written. */
export async function writeNormalizedAt(
  root: string,
  items: RawUpload[],
  normalize: PathNormalizer,
): Promise<string[]> {
  const normalized = normalize(items.map((i) => i.rawPath));
  const written: string[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const rel = normalized[i];
    const abs = confineJoin(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, items[i].data);
    written.push(rel);
  }
  return [...new Set(written)].sort((a, b) => a.localeCompare(b));
}

/** Extract a .zip archive into a root. @throws INVALID_ARCHIVE on a bad/empty zip. */
export function extractArchiveAt(
  root: string,
  archive: Buffer,
  normalize: PathNormalizer,
): Promise<string[]> {
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
  return writeNormalizedAt(
    root,
    fileEntries.map((entry) => ({ rawPath: entry.entryName, data: entry.getData() })),
    normalize,
  );
}

/** Walk a file tree (files and directories). Empty if the root does not exist. */
export async function listTree(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

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

  await walk(root, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** True when the tree has no files yet. */
export async function treeIsEmpty(root: string): Promise<boolean> {
  const tree = await listTree(root);
  return tree.every((entry) => entry.type !== 'file');
}

/** Does a specific file exist under the root? */
export async function fileExistsAt(root: string, relPath: string): Promise<boolean> {
  const abs = confineJoin(root, sanitizeRelative(relPath));
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** Read a file's bytes under the root, or null if it does not exist. */
export async function readFileAt(root: string, relPath: string): Promise<Buffer | null> {
  const abs = confineJoin(root, sanitizeRelative(relPath));
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** Write (or overwrite) a single file under the root, creating parent directories. */
export async function writeFileAt(
  root: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  const abs = confineJoin(root, sanitizeRelative(relPath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/**
 * Delete a single file under the root, then prune any parent directories that
 * became empty (up to, but never including, the root). The caller is expected
 * to have verified the file exists (the service layer returns 404 otherwise).
 */
export async function deleteFileAt(root: string, relPath: string): Promise<void> {
  const abs = confineJoin(root, sanitizeRelative(relPath));
  await fs.unlink(abs);

  const resolvedRoot = path.resolve(root);
  let dir = path.dirname(abs);
  while (dir !== resolvedRoot && dir.startsWith(resolvedRoot + path.sep)) {
    let remaining: string[];
    try {
      remaining = await fs.readdir(dir);
    } catch {
      break;
    }
    if (remaining.length > 0) break;
    await fs.rmdir(dir);
    dir = path.dirname(dir);
  }
}

/** Build a .zip of the whole tree (files only). */
export async function zipTreeAt(root: string): Promise<Buffer> {
  const tree = await listTree(root);
  const zip = new AdmZip();
  for (const entry of tree) {
    if (entry.type !== 'file') continue;
    const data = await fs.readFile(path.join(root, entry.path));
    zip.addFile(entry.path, data);
  }
  return zip.toBuffer();
}

/** Remove all files under the root (the root dir is recreated on next write). */
export async function clearTreeAt(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

/** Recursively remove an arbitrary directory subtree (used on entity delete). */
export async function removeTreeAt(absDir: string): Promise<void> {
  await fs.rm(absDir, { recursive: true, force: true });
}
