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
  // The EnSight Gold output (a directory tree written by foamToEnsight into
  // export/ensight/) zipped into a single download.
  ensightZip: 'ensight.zip',
  profile: 'profile.json',
  validation: 'validation.json',
  session: 'session.cse',
  memo: 'LOAD_CFDPOST.md',
  report: 'REPORT.md',
} as const;

/** EnSight output sub-directory name within a project's export directory. */
export const ENSIGHT_SUBDIR = 'ensight';

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

/** Absolute path to the EnSight output sub-directory (export/ensight/). */
export function ensightDirAbsolute(projectId: string): string {
  return path.join(exportDirAbsolute(projectId), ENSIGHT_SUBDIR);
}

/** Recursively list files under the EnSight output dir (relative paths). */
async function walkRelative(root: string, base = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(root, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkRelative(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Find the EnSight master "case" file in the output dir, or null. foamToEnsight
 * names it `EnSight_Case` (no extension) on some versions and `*.case` on others,
 * so try the conventional extensions, then the bare name, then any file whose
 * first line declares the EnSight Gold format. Returns the relative filename.
 */
export async function findEnsightCaseFile(projectId: string): Promise<string | null> {
  const dir = ensightDirAbsolute(projectId);
  const files = await walkRelative(dir);
  if (files.length === 0) return null;

  const byExt = files.find((f) => /\.(case|encas)$/i.test(f));
  if (byExt) return byExt;
  const named = files.find((f) => /(^|\/)EnSight_Case$/.test(f));
  if (named) return named;
  // Last resort: a top-level file whose header is an EnSight case ("FORMAT ...").
  for (const f of files) {
    if (f.includes('/')) continue;
    try {
      const head = await fs.readFile(path.join(dir, f), 'utf8');
      if (/^\s*FORMAT[\s\S]{0,80}ensight/i.test(head)) return f;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Ensure the EnSight master has a `.case` extension. foamToEnsight names it
 * `EnSight_Case` (no extension), which Ansys CFD-Post's "Load Results" dialog
 * does NOT show (it filters on *.case / *.encas). Copy it to `<name>.case` so
 * CFD-Post can pick it. No-op when a `.case`/`.encas` master already exists.
 * Returns the relative name of the `.case` file to load (or null when no master).
 */
export async function ensureEnsightCaseExtension(projectId: string): Promise<string | null> {
  const master = await findEnsightCaseFile(projectId);
  if (!master) return null;
  if (/\.(case|encas)$/i.test(master)) return master;
  const dir = ensightDirAbsolute(projectId);
  const withExt = `${master}.case`;
  try {
    await fs.copyFile(path.join(dir, master), path.join(dir, withExt));
    return withExt;
  } catch {
    return master;
  }
}

/**
 * Zip the whole EnSight output directory into ensight.zip for a single download,
 * returning the number of files zipped (0 when the dir is missing/empty).
 */
export async function zipEnsightDir(projectId: string): Promise<number> {
  const dir = ensightDirAbsolute(projectId);
  const files = await walkRelative(dir);
  if (files.length === 0) return 0;
  const zip = new AdmZip();
  // Keep the files under an `ensight/` root inside the archive so it unzips tidily.
  zip.addLocalFolder(dir, ENSIGHT_SUBDIR);
  await ensureExportDir(projectId);
  zip.writeZip(exportFilePath(projectId, 'ensightZip'));
  return files.length;
}
