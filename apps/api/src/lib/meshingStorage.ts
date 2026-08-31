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
import type { MeshingConfig, MeshingEngine, MeshingRun, MeshingRunState, StlFile } from '@dive/shared';
import { FMS_EXTENSION, MESHING_ENGINES, STL_EXTENSION } from '@dive/shared';
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
  /** The mesh generator this session uses (fixed at creation; legacy => 'snappy'). */
  engine: MeshingEngine;
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

/** Create a new empty session with the chosen engine, returning its metadata. */
export async function createSession(name: string, engine: MeshingEngine): Promise<MeshingMeta> {
  const id = await uniqueSessionId(name);
  const meta: MeshingMeta = { id, name: name.trim(), engine, createdAt: new Date().toISOString() };
  await writeMeta(meta);
  return meta;
}

/**
 * Rename a session's DISPLAY name only; the id and on-disk directory stay stable
 * (renaming the dir would break every stored path + reference). Returns the
 * updated metadata, or null when the session is absent.
 */
export async function renameSession(sessionId: string, name: string): Promise<MeshingMeta | null> {
  const meta = await readMeta(sessionId);
  if (!meta) return null;
  const updated: MeshingMeta = { ...meta, name: name.trim() };
  await writeMeta(updated);
  return updated;
}

/**
 * Copy a session's reusable setup into a NEW session: its engine (meta) + the
 * autosaved config.json + every file under constant/triSurface/. Deliberately
 * omits run output (run.json, constant/polyMesh, system/, .viz) — the copy is
 * meant to be re-meshed with fresh geometry. `name` defaults to "<source> (copy)".
 * @throws when the source session has no readable metadata.
 */
export async function copySessionSetup(sourceId: string, name?: string): Promise<MeshingMeta> {
  const source = await readMeta(sourceId);
  if (!source) {
    throw new Error(`Meshing session "${sourceId}" not found.`);
  }
  const meta = await createSession(name ?? `${source.name} (copy)`, source.engine);
  // Copy the input surfaces (if any) verbatim.
  const srcTri = triSurfaceDir(sourceId);
  try {
    await fs.cp(srcTri, triSurfaceDir(meta.id), { recursive: true });
  } catch {
    // No triSurface dir on the source (never had a surface) — nothing to copy.
  }
  // Copy the autosaved config (round-trips through the validated type).
  const config = await readConfig(sourceId);
  if (config) await writeConfig(meta.id, config);
  return meta;
}

/** Read one session's metadata, or null when absent/unreadable. */
export async function readMeta(sessionId: string): Promise<MeshingMeta | null> {
  try {
    assertSafeId(sessionId);
    const file = path.join(sessionDirAbsolute(sessionId), 'meta.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<MeshingMeta>;
    if (!parsed.id || !parsed.name || !parsed.createdAt) return null;
    // A session created before the engine choice existed is a snappy session.
    const engine = MESHING_ENGINES.includes(parsed.engine as MeshingEngine)
      ? (parsed.engine as MeshingEngine)
      : 'snappy';
    return { id: parsed.id, name: parsed.name, engine, createdAt: parsed.createdAt };
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
 * Reduce an uploaded filename to a safe surface basename inside triSurface/: strip
 * any directory, keep a conservative charset, and keep an .stl or .fms extension
 * (lower-cased) — any other extension is forced to .stl (the common case). Kept as
 * `sanitizeStlName` for callers/tests; it now also preserves cfMesh's .fms.
 */
export function sanitizeStlName(rawName: string): string {
  const base = rawName.replace(/\\/g, '/').split('/').pop() ?? rawName;
  const ext = (base.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  const keptExt = ext === FMS_EXTENSION ? FMS_EXTENSION : STL_EXTENSION;
  const stem = base.replace(/\.[^.]+$/, '');
  const safe = stem
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return `${safe || 'surface'}${keptExt}`;
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
    const lower = dirent.name.toLowerCase();
    if (!lower.endsWith(STL_EXTENSION) && !lower.endsWith(FMS_EXTENSION)) continue;
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

// --- Live run: streamed log + lifecycle status --------------------------------
//
// A run is a background job: its stdout+stderr stream to mesh.log (tailed live by
// the client) and its lifecycle state is a status.json sidecar. Both live at the
// session root, deliberately NOT under triSurface/ or system/, so copySessionSetup
// (which copies only the reusable setup) never carries a stale log/status into a
// fresh session, and cleanPriorMeshArtifacts (mesh output only) never touches them.

/** Absolute path to the session's streamed mesher log. */
export function meshLogAbsolute(sessionId: string): string {
  return path.join(sessionDirAbsolute(sessionId), 'mesh.log');
}

/** Reset the log to empty at the start of a fresh run (creating the session dir). */
export async function truncateMeshLog(sessionId: string): Promise<void> {
  const file = meshLogAbsolute(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '', 'utf8');
}

/** Append a chunk to the session's mesher log (creating it if needed). */
export async function appendMeshLog(sessionId: string, chunk: string): Promise<void> {
  const file = meshLogAbsolute(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, chunk, 'utf8');
}

/**
 * Read at most the last `maxBytes` of the mesher log, plus its total size on disk.
 * Bounds memory on the per-poll hot path (the log can grow large), exactly like the
 * solver's readRunLog. Returns empty/0 when no log exists yet.
 */
export async function readMeshLog(
  sessionId: string,
  maxBytes: number,
): Promise<{ content: string; size: number }> {
  const file = meshLogAbsolute(sessionId);
  try {
    const { size } = await fs.stat(file);
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return { content: '', size };
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return { content: buffer.toString('utf8'), size };
    } finally {
      await handle.close();
    }
  } catch {
    return { content: '', size: 0 };
  }
}

/**
 * Persist the session's run lifecycle state (status.json). Written to a temp file
 * and renamed into place: the log endpoint polls this file while the run finalizer
 * rewrites it, and a plain writeFile (truncate-then-write) would let a concurrent
 * read see an empty/partial file and mislabel a live run as 'idle'.
 */
export async function writeMeshStatus(sessionId: string, state: MeshingRunState): Promise<void> {
  const file = path.join(sessionDirAbsolute(sessionId), 'status.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Read the session's run lifecycle state, or null when no run has ever started.
 * A concurrent atomic replace by writeMeshStatus can still surface as a transient
 * ENOENT or partial read on non-POSIX filesystems (notably WSL's /mnt/c), so a
 * failed read is retried briefly before concluding there is no state — otherwise
 * a poll could mislabel a live run as 'idle'.
 */
export async function readMeshStatus(sessionId: string): Promise<MeshingRunState | null> {
  const file = path.join(sessionDirAbsolute(sessionId), 'status.json');
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as MeshingRunState;
    } catch {
      if (attempt >= 4) return null;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Session ids whose persisted status is still 'running' (for boot reconciliation). */
export async function listRunningSessionIds(): Promise<string[]> {
  const metas = await listSessions();
  const running: string[] = [];
  for (const meta of metas) {
    const state = await readMeshStatus(meta.id);
    if (state?.status === 'running') running.push(meta.id);
  }
  return running;
}

/**
 * Persist the last-edited config (autosaved from the form, independent of a run),
 * so manual settings survive a reload even before the mesh is generated. A run
 * also refreshes this via the same writer, keeping the two in sync.
 */
export async function writeConfig(sessionId: string, config: MeshingConfig): Promise<void> {
  const file = path.join(sessionDirAbsolute(sessionId), 'config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config), 'utf8');
}

/** Read the last-edited config, or null when the session was never configured. */
export async function readConfig(sessionId: string): Promise<MeshingConfig | null> {
  try {
    const file = path.join(sessionDirAbsolute(sessionId), 'config.json');
    return JSON.parse(await fs.readFile(file, 'utf8')) as MeshingConfig;
  } catch {
    return null;
  }
}
