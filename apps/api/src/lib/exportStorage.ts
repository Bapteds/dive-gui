// Filesystem storage for a project's CFD-Post export artifacts.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/export/out.cgns
//                                                .../convert.py
//                                                .../profile.json
//                                                .../validation.json
//                                                .../session.cse
//                                                .../LOAD_CFDPOST.md
//                                                .../REPORT.md
//
// The `export/` directory is a sibling of `case/`, `cgns/`, `viz/` and `runs/`,
// so producing (or clearing) an export never touches the OpenFOAM case inputs,
// and a case reset never deletes a produced CGNS. `assertSafeId` guards the id
// path segment, exactly like caseStorage / vizStorage.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { EXPORT_DIRNAME } from '@dive/shared';
import { assertSafeId, storageRoot } from './fileTreeStorage';

/** Filenames of the artifacts within a project's export directory. */
export const EXPORT_FILES = {
  // out.cgns is the convert step's output BASE: a single-time export writes
  // out.cgns; an all-times export writes out_<i>.cgns and the backend zips them
  // into out_cgns.zip (the actual download for a series).
  cgns: 'out.cgns',
  cgnsZip: 'out_cgns.zip',
  convertScript: 'convert.py',
  profile: 'profile.json',
  validation: 'validation.json',
  session: 'session.cse',
  memo: 'LOAD_CFDPOST.md',
  report: 'REPORT.md',
} as const;

/** Absolute path to a project's export root (the id is validated; may not exist). */
export function exportDirAbsolute(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, EXPORT_DIRNAME);
}

/** Absolute path to one named export artifact. */
export function exportFilePath(projectId: string, file: keyof typeof EXPORT_FILES): string {
  return path.join(exportDirAbsolute(projectId), EXPORT_FILES[file]);
}

/** Create the export directory (idempotent). */
export async function ensureExportDir(projectId: string): Promise<void> {
  await fs.mkdir(exportDirAbsolute(projectId), { recursive: true });
}

/** Remove the whole export directory, so a fresh run starts clean. Best-effort. */
export async function clearExport(projectId: string): Promise<void> {
  await fs.rm(exportDirAbsolute(projectId), { recursive: true, force: true });
}

/** Does a named export artifact exist (and, for files, have bytes)? */
export async function exportFileExists(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<boolean> {
  try {
    const stat = await fs.stat(exportFilePath(projectId, file));
    return stat.size > 0;
  } catch {
    return false;
  }
}

/** Absolute path + byte size of a named export artifact, or null when absent/empty. */
export async function exportFileStat(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<{ path: string; size: number } | null> {
  const filePath = exportFilePath(projectId, file);
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0 ? { path: filePath, size: stat.size } : null;
  } catch {
    return null;
  }
}

/** Write a text (or binary) export artifact, creating the directory if needed. */
export async function writeExportFile(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
  content: string | Buffer,
): Promise<void> {
  await ensureExportDir(projectId);
  await fs.writeFile(exportFilePath(projectId, file), content);
}

/** Read a text export artifact, or null when it does not exist. */
export async function readExportText(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<string | null> {
  try {
    return await fs.readFile(exportFilePath(projectId, file), 'utf8');
  } catch {
    return null;
  }
}

/** Read a binary export artifact (e.g. out.cgns), or null when absent. */
export async function readExportBytes(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(exportFilePath(projectId, file));
  } catch {
    return null;
  }
}

/** Read and JSON-parse an export artifact, or null when absent / unparseable. */
export async function readExportJson<T>(
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<T | null> {
  const raw = await readExportText(projectId, file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Numeric order of a produced CGNS filename: `out.cgns` first, then `out_<i>` by i. */
function cgnsOrder(name: string): number {
  if (name === EXPORT_FILES.cgns) return -1;
  const m = /^out_(\d+)\.cgns$/.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The CGNS files the convert step produced, sorted by their NUMERIC timestep
 * index. A single-time export is `out.cgns`; an all-times export is `out_0.cgns`,
 * `out_1.cgns`, … (one per solved time). A lexicographic sort put `out_10` before
 * `out_2`, which scrambled the merge and the zip order (C1). Excludes the zip
 * itself. Returns absolute paths.
 */
export async function listCgnsFiles(projectId: string): Promise<string[]> {
  const dir = exportDirAbsolute(projectId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.cgns') && (n === EXPORT_FILES.cgns || n.startsWith('out_')))
    .sort((a, b) => cgnsOrder(a) - cgnsOrder(b))
    .map((n) => path.join(dir, n));
}

/**
 * Zip the produced CGNS file(s) into out_cgns.zip for a single download, and
 * return how many were zipped (0 when none). The series-or-single output is
 * always offered as one archive so the download model stays uniform.
 */
export async function zipCgnsFiles(projectId: string): Promise<number> {
  const files = await listCgnsFiles(projectId);
  if (files.length === 0) return 0;
  const zip = new AdmZip();
  for (const file of files) {
    zip.addLocalFile(file);
  }
  await ensureExportDir(projectId);
  zip.writeZip(exportFilePath(projectId, 'cgnsZip'));
  return files.length;
}
