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
import { EXPORT_DIRNAME } from '@dive/shared';
import { assertSafeId, storageRoot } from './fileTreeStorage';

/** Filenames of the artifacts within a project's export directory. */
export const EXPORT_FILES = {
  cgns: 'out.cgns',
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
