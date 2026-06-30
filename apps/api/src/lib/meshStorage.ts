// Filesystem storage for a project's reusable LIBRARY of imported polyMesh
// sources, plus the transient workspace used to merge them.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/meshes/
//            <meshId>/polyMesh/{points,faces,owner,neighbour,boundary,...}
//            <meshId>/meta.json    ({ id, name, kind, createdAt })
//            merge.json            (the last MergePlan, for re-runs)
//            .work/                (transient merge workspace, purged each run)
//
// Mesh sources are *inputs* to the merge, kept deliberately apart from the
// OpenFOAM case tree (caseStorage.ts) so importing a mesh — or resetting the
// case — never touches them. This is a thin façade over the shared,
// path-traversal-safe core in fileTreeStorage.ts, pinned to the project's
// meshes root. Mirrors cgnsStorage.ts (the single-CGNS-source equivalent).
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MergePlan } from '@dive/shared';
import {
  assertSafeId,
  confineJoin,
  extractArchiveAt,
  readFileAt,
  removeTreeAt,
  sanitizeRelative,
  storageRoot,
  writeNormalizedAt,
  type RawUpload,
} from './fileTreeStorage';

/** Persisted metadata for one imported mesh source. */
export interface MeshMeta {
  id: string;
  name: string;
  kind: 'folder' | 'zip';
  /** ISO 8601 import timestamp. */
  createdAt: string;
}

/** The workspace subdirectory name (hidden; never a valid mesh id collision). */
const WORK_DIRNAME = '.work';
/** The merge-plan file name (sibling of the mesh dirs). */
const MERGE_PLAN_FILE = 'merge.json';

/** Absolute path to a project's meshes root. */
function meshesRootFor(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'meshes');
}

/** Absolute path to one mesh source's directory (confined; id validated). */
export function meshDirAbsolute(projectId: string, meshId: string): string {
  assertSafeId(meshId);
  return confineJoin(meshesRootFor(projectId), meshId);
}

/** Absolute path to one mesh source's polyMesh directory. */
export function meshPolyMeshDir(projectId: string, meshId: string): string {
  return path.join(meshDirAbsolute(projectId, meshId), 'polyMesh');
}

/** Absolute path to the transient merge workspace (purged before each run). */
export function meshWorkRoot(projectId: string): string {
  return path.join(meshesRootFor(projectId), WORK_DIRNAME);
}

/**
 * Map every uploaded path onto a clean `polyMesh/<...>` tree: slice from a
 * `polyMesh` segment when present (dropping any wrapper dirs and the case's
 * `constant/`), else nest the file directly under `polyMesh/`. Stays 1:1 with
 * the input — writeNormalizedAt aligns items to normalized paths by index.
 */
export function normalizeMeshPaths(rawPaths: string[]): string[] {
  return rawPaths.map((raw) => {
    const segs = sanitizeRelative(raw).split('/');
    const idx = segs.lastIndexOf('polyMesh');
    const rel = idx >= 0 ? segs.slice(idx + 1) : segs;
    return ['polyMesh', ...rel].join('/');
  });
}

/** A new opaque mesh id (also serves as the source's directory name). */
function newMeshId(): string {
  return randomUUID();
}

/** Write a mesh source's metadata sidecar. */
async function writeMeshMeta(projectId: string, meta: MeshMeta): Promise<void> {
  const file = path.join(meshDirAbsolute(projectId, meta.id), 'meta.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(meta), 'utf8');
}

/** Persist a folder upload as a new mesh source. Returns its metadata. */
export async function importMeshFolder(
  projectId: string,
  name: string,
  files: RawUpload[],
): Promise<MeshMeta> {
  const id = newMeshId();
  await writeNormalizedAt(meshDirAbsolute(projectId, id), files, normalizeMeshPaths);
  const meta: MeshMeta = { id, name, kind: 'folder', createdAt: new Date().toISOString() };
  await writeMeshMeta(projectId, meta);
  return meta;
}

/** Persist a .zip upload as a new mesh source. Returns its metadata. */
export async function importMeshArchive(
  projectId: string,
  name: string,
  archive: Buffer,
): Promise<MeshMeta> {
  const id = newMeshId();
  await extractArchiveAt(meshDirAbsolute(projectId, id), archive, normalizeMeshPaths);
  const meta: MeshMeta = { id, name, kind: 'zip', createdAt: new Date().toISOString() };
  await writeMeshMeta(projectId, meta);
  return meta;
}

/** Read one mesh source's metadata, or null when absent/unreadable. */
export async function readMeshMeta(projectId: string, meshId: string): Promise<MeshMeta | null> {
  try {
    assertSafeId(meshId);
    const file = path.join(meshDirAbsolute(projectId, meshId), 'meta.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<MeshMeta>;
    if (!parsed.id || !parsed.name || !parsed.createdAt) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      kind: parsed.kind === 'zip' ? 'zip' : 'folder',
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

/** List every mesh source in the library, oldest first (the default merge order). */
export async function listMeshSources(projectId: string): Promise<MeshMeta[]> {
  let dirents;
  try {
    dirents = await fs.readdir(meshesRootFor(projectId), { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: MeshMeta[] = [];
  for (const dirent of dirents) {
    // Skip files (merge.json) and hidden dirs (.work); only real source dirs.
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const meta = await readMeshMeta(projectId, dirent.name);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return metas;
}

/** Does this mesh source exist (has readable metadata)? */
export async function meshSourceExists(projectId: string, meshId: string): Promise<boolean> {
  return (await readMeshMeta(projectId, meshId)) !== null;
}

/** Read a mesh source's polyMesh/boundary file, or null when absent. */
export function readMeshBoundary(projectId: string, meshId: string): Promise<Buffer | null> {
  return readFileAt(meshDirAbsolute(projectId, meshId), 'polyMesh/boundary');
}

/** Delete a mesh source entirely (its directory and everything under it). */
export async function deleteMeshSource(projectId: string, meshId: string): Promise<void> {
  await removeTreeAt(meshDirAbsolute(projectId, meshId));
}

/** Read the last saved merge plan, or null when none has been saved. */
export async function readMergePlan(projectId: string): Promise<MergePlan | null> {
  try {
    const file = path.join(meshesRootFor(projectId), MERGE_PLAN_FILE);
    return JSON.parse(await fs.readFile(file, 'utf8')) as MergePlan;
  } catch {
    return null;
  }
}

/** Persist the merge plan so it can be re-run with the same pairings. */
export async function writeMergePlan(projectId: string, plan: MergePlan): Promise<void> {
  const file = path.join(meshesRootFor(projectId), MERGE_PLAN_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(plan), 'utf8');
}

/** Purge and recreate the transient merge workspace, returning its absolute path. */
export async function resetMeshWork(projectId: string): Promise<string> {
  const root = meshWorkRoot(projectId);
  await removeTreeAt(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}
