// Filesystem storage for standalone MESHING sessions (STL -> snappyHexMesh ->
// constant/polyMesh). Rooted at <STORAGE_DIR>/meshing/<sessionId>/, deliberately
// apart from the per-project case tree (caseStorage.ts) — a meshing session is
// its own throwaway OpenFOAM case, not tied to any project.
//
// Layout:  <STORAGE_DIR>/meshing/<sessionId>/
//            meta.json                         ({ id, name, createdAt })
//            run.json                          (the last MeshingRun, if any)
//            constant/triSurface/<name>.stl    (the uploaded input surfaces)
//            system/*                          (generated snappy/blockMesh dicts)
//            constant/polyMesh/*               (the produced volume mesh)
//            .viz/                             (cached GLB render of the result)
//            .work/                            (transient scratch, if needed)
//          <sessionId> is a READABLE slug of the session name (unique), the same
//          self-describing scheme as the mesh library (meshStorage.uniqueMeshId).
//
// This is a thin façade over the path-traversal-safe core in fileTreeStorage.ts,
// pinned to the meshing root. Mirrors meshStorage.ts (the per-project analogue).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MeshingRun, StlFile } from '@dive/shared';
import { STL_EXTENSION } from '@dive/shared';
import {
  assertSafeId,
  confineJoin,
  removeTreeAt,
  storageRoot,
} from './fileTreeStorage';

/** Persisted session metadata sidecar. */
export interface MeshingMeta {
  id: string;
  name: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Files produced/checked to decide whether a run yielded a usable polyMesh. */
const POLYMESH_REQUIRED = ['points', 'faces', 'owner', 'boundary'] as const;

/** Absolute path to the meshing root (all sessions live here). */
function meshingRoot(): string {
  return path.join(storageRoot(), 'meshing');
}

/** Absolute path to one session's directory (id validated + confined). */
export function sessionDirAbsolute(sessionId: string): string {
  assertSafeId(sessionId);
  return confineJoin(meshingRoot(), sessionId);
}

/** The session's OpenFOAM case root (the session dir itself). */
export function sessionCaseDir(sessionId: string): string {
  return sessionDirAbsolute(sessionId);
}

/** Absolute path to the session's constant/triSurface (the STL inputs). */
export function triSurfaceDir(sessionId: string): string {
  return path.join(sessionDirAbsolute(sessionId), 'constant', 'triSurface');
}

/** Absolute path to the session's produced constant/polyMesh. */
export function sessionPolyMeshDir(sessionId: string): string {
  return path.join(sessionDirAbsolute(sessionId), 'constant', 'polyMesh');
}

/** Absolute path to the session's system/ (generated dicts). */
export function sessionSystemDir(sessionId: string): string {
  return path.join(sessionDirAbsolute(sessionId), 'system');
}

/**
 * Turn a human name into an id/dir-safe slug: lowercase ASCII, every run of
 * other characters collapsed to a dash. Always assertSafeId-valid; falls back to
 * "session". Mirrors meshStorage.slugifyMeshName.
 */
export function slugifySessionName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'session';
}

/** A unique, readable session id derived from `name` (its slug, suffixed -2, -3, …). */
async function uniqueSessionId(name: string): Promise<string> {
  const base = slugifySessionName(name);
  let taken: Set<string>;
  try {
    const dirents = await fs.readdir(meshingRoot(), { withFileTypes: true });
    taken = new Set(dirents.filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    taken = new Set();
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Write a session's metadata sidecar. */
async function writeMeta(meta: MeshingMeta): Promise<void> {
  const file = path.join(sessionDirAbsolute(meta.id), 'meta.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(meta), 'utf8');
}

/** Create a new empty session, returning its metadata. */
export async function createSession(name: string): Promise<MeshingMeta> {
  const id = await uniqueSessionId(name);
  const meta: MeshingMeta = { id, name: name.trim(), createdAt: new Date().toISOString() };
  await writeMeta(meta);
  return meta;
}

/** Read one session's metadata, or null when absent/unreadable. */
export async function readMeta(sessionId: string): Promise<MeshingMeta | null> {
  try {
    assertSafeId(sessionId);
    const file = path.join(sessionDirAbsolute(sessionId), 'meta.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<MeshingMeta>;
    if (!parsed.id || !parsed.name || !parsed.createdAt) return null;
    return { id: parsed.id, name: parsed.name, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/** List every session, newest first. */
export async function listSessions(): Promise<MeshingMeta[]> {
  let dirents;
  try {
    dirents = await fs.readdir(meshingRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: MeshingMeta[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const meta = await readMeta(dirent.name);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return metas;
}

/** Does the session exist (has readable metadata)? */
export async function sessionExists(sessionId: string): Promise<boolean> {
  return (await readMeta(sessionId)) !== null;
}

/** Delete a session entirely (its directory and everything under it). */
export async function deleteSession(sessionId: string): Promise<void> {
  await removeTreeAt(sessionDirAbsolute(sessionId));
}

/**
 * Reduce an uploaded filename to a safe STL basename inside triSurface/: strip
 * any directory, keep a conservative charset, and force the .stl extension.
 */
export function sanitizeStlName(rawName: string): string {
  const base = rawName.replace(/\\/g, '/').split('/').pop() ?? rawName;
  const stem = base.replace(/\.[^.]+$/, '');
  const safe = stem
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return `${safe || 'surface'}${STL_EXTENSION}`;
}

/** Write one uploaded STL into the session (overwriting a same-named one). Returns its stored name. */
export async function writeStl(sessionId: string, rawName: string, data: Buffer): Promise<string> {
  const name = sanitizeStlName(rawName);
  const dir = triSurfaceDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const abs = confineJoin(dir, name);
  await fs.writeFile(abs, data);
  return name;
}

/** List the session's STL inputs (name + size), sorted by name. Empty when none. */
export async function listStl(sessionId: string): Promise<StlFile[]> {
  let dirents;
  try {
    dirents = await fs.readdir(triSurfaceDir(sessionId), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: StlFile[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.toLowerCase().endsWith(STL_EXTENSION)) continue;
    const stat = await fs.stat(path.join(triSurfaceDir(sessionId), dirent.name));
    files.push({ name: dirent.name, sizeBytes: stat.size });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Read one STL's bytes, or null when absent. */
export async function readStl(sessionId: string, name: string): Promise<Buffer | null> {
  try {
    const abs = confineJoin(triSurfaceDir(sessionId), sanitizeStlName(name));
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** Delete one STL. Returns true when a file was removed. */
export async function deleteStl(sessionId: string, name: string): Promise<boolean> {
  try {
    const abs = confineJoin(triSurfaceDir(sessionId), sanitizeStlName(name));
    await fs.unlink(abs);
    return true;
  } catch {
    return false;
  }
}

/** True once a run has produced a usable constant/polyMesh (core files present). */
export async function hasResultMesh(sessionId: string): Promise<boolean> {
  const dir = sessionPolyMeshDir(sessionId);
  for (const file of POLYMESH_REQUIRED) {
    try {
      await fs.stat(path.join(dir, file));
    } catch {
      return false;
    }
  }
  return true;
}

/** Persist the last run report (config + per-step result + timestamp). */
export async function writeRun(sessionId: string, run: MeshingRun): Promise<void> {
  const file = path.join(sessionDirAbsolute(sessionId), 'run.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(run), 'utf8');
}

/** Read the last run report, or null when none has run. */
export async function readRun(sessionId: string): Promise<MeshingRun | null> {
  try {
    const file = path.join(sessionDirAbsolute(sessionId), 'run.json');
    return JSON.parse(await fs.readFile(file, 'utf8')) as MeshingRun;
  } catch {
    return null;
  }
}
