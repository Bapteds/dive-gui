// Filesystem storage for a project's reusable LIBRARY of imported polyMesh
// sources, plus the transient workspace used to merge them.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/meshes/
//            <meshId>/constant/polyMesh/{points,faces,owner,neighbour,boundary,...}
//            <meshId>/meta.json    ({ id, name, kind, createdAt })
//            merge.json            (the last MergePlan, for re-runs)
//            .work/                (transient merge workspace, purged each run)
//          <meshId> is a READABLE slug of the source name (unique per project,
//          e.g. meshes/rotor/), not an opaque UUID — see uniqueMeshId.
//
// Mesh sources are *inputs* to the merge, kept deliberately apart from the
// OpenFOAM case tree (caseStorage.ts) so importing a mesh — or resetting the
// case — never touches them. This is a thin façade over the shared,
// path-traversal-safe core in fileTreeStorage.ts, pinned to the project's
// meshes root. Mirrors cgnsStorage.ts (the single-CGNS-source equivalent).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppliedAssembly, MergePlan } from '@dive/shared';
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

/** How a mesh source was imported. */
export type MeshSourceKind = 'folder' | 'zip' | 'cgns' | 'msh';

const MESH_SOURCE_KINDS: readonly MeshSourceKind[] = ['folder', 'zip', 'cgns', 'msh'];

/** Persisted metadata for one imported mesh source. */
export interface MeshMeta {
  id: string;
  name: string;
  kind: MeshSourceKind;
  /** ISO 8601 import timestamp. */
  createdAt: string;
}

/** The workspace subdirectory name (hidden; never a valid mesh id collision). */
const WORK_DIRNAME = '.work';
/** The merge-plan file name (sibling of the mesh dirs). */
const MERGE_PLAN_FILE = 'merge.json';
/** The applied-assembly record file name (sibling of the mesh dirs + merge.json). */
const ASSEMBLY_FILE = 'assembly.json';

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

/**
 * Absolute path to one mesh source's polyMesh directory. Each source is a
 * minimal OpenFOAM case (constant/polyMesh + system/), so the mesh-file
 * converters (vtkUnstructuredToFoam / fluent3DMeshToFoam, run with `-case
 * <meshDir>`) write straight into it and the merge can stage it as a case.
 */
export function meshPolyMeshDir(projectId: string, meshId: string): string {
  return path.join(meshDirAbsolute(projectId, meshId), 'constant', 'polyMesh');
}

/** Absolute path to a mesh source's upload/work directory (`.src`, hidden). */
export function meshSrcDir(projectId: string, meshId: string): string {
  return path.join(meshDirAbsolute(projectId, meshId), '.src');
}

/** Absolute path to the transient merge workspace (purged before each run). */
export function meshWorkRoot(projectId: string): string {
  return path.join(meshesRootFor(projectId), WORK_DIRNAME);
}

/**
 * Map every uploaded path onto a clean `constant/polyMesh/<...>` tree: slice from
 * a `polyMesh` segment when present (dropping any wrapper dirs and the case's
 * `constant/`), else nest the file directly under it. Stays 1:1 with the input —
 * writeNormalizedAt aligns items to normalized paths by index.
 */
export function normalizeMeshPaths(rawPaths: string[]): string[] {
  return rawPaths.map((raw) => {
    const segs = sanitizeRelative(raw).split('/');
    const idx = segs.lastIndexOf('polyMesh');
    const rel = idx >= 0 ? segs.slice(idx + 1) : segs;
    return ['constant', 'polyMesh', ...rel].join('/');
  });
}

/**
 * Turn a human mesh name into an id- and directory-safe slug: lowercase ASCII,
 * every run of other characters collapsed to a single dash. Always assertSafeId-
 * valid (/^[A-Za-z0-9_-]+$/); falls back to "mesh" when nothing survives.
 */
export function slugifyMeshName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '') // strip accents (é -> e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'mesh';
}

/**
 * A unique, READABLE mesh id derived from `name`: its slug, suffixed -2, -3, …
 * when a sibling source already occupies that directory. Replaces the old opaque
 * UUID so a source's folder — and the merge plan that references it by id — are
 * self-describing (meshes/rotor/, meshes/stator/). The id IS the directory name.
 */
export async function uniqueMeshId(projectId: string, name: string): Promise<string> {
  const base = slugifyMeshName(name);
  let taken: Set<string>;
  try {
    const dirents = await fs.readdir(meshesRootFor(projectId), { withFileTypes: true });
    taken = new Set(dirents.filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    taken = new Set(); // no meshes/ dir yet
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Write a mesh source's metadata sidecar. */
export async function writeMeshMeta(projectId: string, meta: MeshMeta): Promise<void> {
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
  const id = await uniqueMeshId(projectId, name);
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
  const id = await uniqueMeshId(projectId, name);
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
      kind: MESH_SOURCE_KINDS.includes(parsed.kind as MeshSourceKind)
        ? (parsed.kind as MeshSourceKind)
        : 'folder',
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

/** Read a mesh source's constant/polyMesh/boundary file, or null when absent. */
export function readMeshBoundary(projectId: string, meshId: string): Promise<Buffer | null> {
  return readFileAt(meshDirAbsolute(projectId, meshId), 'constant/polyMesh/boundary');
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

/**
 * Read the applied-assembly record (meshes/assembly.json), or null when no
 * assembly is currently applied. Lives at the meshes/ root beside merge.json (never
 * a source directory: listMeshSources only walks directories, so this file is not
 * mistaken for a library source). Mirrors readMergePlan.
 */
export async function readAppliedAssembly(projectId: string): Promise<AppliedAssembly | null> {
  try {
    const file = path.join(meshesRootFor(projectId), ASSEMBLY_FILE);
    return JSON.parse(await fs.readFile(file, 'utf8')) as AppliedAssembly;
  } catch {
    return null;
  }
}

/**
 * Record that an assembly was successfully applied (written ONLY on a successful
 * merge promote): marks "an assembly is applied" and captures the plan so the
 * Disassemble UI can list the added parts and build a reduced re-merge. Mirrors
 * writeMergePlan.
 */
export async function writeAppliedAssembly(
  projectId: string,
  assembly: AppliedAssembly,
): Promise<void> {
  const file = path.join(meshesRootFor(projectId), ASSEMBLY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(assembly), 'utf8');
}

/**
 * Clear the applied-assembly record (a no-op when none exists): restoring the mesh
 * backup reverts the case to its pre-merge original, so no assembly is applied any
 * more (undo-all). Best-effort removal, never throws on a missing file.
 */
export async function clearAppliedAssembly(projectId: string): Promise<void> {
  const file = path.join(meshesRootFor(projectId), ASSEMBLY_FILE);
  await fs.rm(file, { force: true }).catch(() => undefined);
}

/** Purge and recreate the transient merge workspace, returning its absolute path. */
export async function resetMeshWork(projectId: string): Promise<string> {
  const root = meshWorkRoot(projectId);
  await removeTreeAt(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}
