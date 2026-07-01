// Filesystem storage for a mesh LIBRARY source's rendered 3D-viewer artifacts.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/meshes/<meshId>/.viz/patches.glb
//                                                          .../manifest.json
//                                                          .../edges.bin
//
// Mirrors vizStorage.ts (the case-mesh render cache) but rooted at a library
// source's own directory, so the "Assemble" tab can preview each imported part
// before it is placed and merged. The `.viz` directory is hidden inside the
// source dir, so it never appears as a sibling source (listMeshSources skips
// '.'-prefixed entries at the meshes root) and deleting the source removes its
// cached render with it. Only constant/polyMesh is copied when staging a source
// for a merge, so the cache never leaks into the combined mesh. Staleness is
// decided against the source polyMesh's {boundary,points} mtime, exactly like the
// case render (vizStorage.vizIsStale).
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { MeshPatch } from '@dive/shared';
import { meshDirAbsolute, meshPolyMeshDir } from './meshStorage';

/** Hidden viz cache directory inside a source's own directory. */
const SOURCE_VIZ_DIRNAME = '.viz';

/** Filenames of the artifacts within a source's viz directory (match vizStorage). */
const GLB_NAME = 'patches.glb';
const MANIFEST_NAME = 'manifest.json';
const EDGES_NAME = 'edges.bin';

/**
 * The source polyMesh files whose mtime determines whether the cached render is
 * stale: if either changed after the GLB was built (e.g. an autoPatch re-split),
 * the render is rebuilt.
 */
const VIZ_SOURCE_FILES = ['boundary', 'points'] as const;

/** Absolute filesystem paths of a source's viz artifacts. */
export interface MeshSourceVizPaths {
  glb: string;
  manifest: string;
  /** Raw cell-edge buffer (line-segment endpoint coords). */
  edges: string;
}

/** A manifest read from disk: the parsed patch list plus the build timestamp. */
export interface StoredMeshSourceVizManifest {
  patches: MeshPatch[];
  /** ISO 8601 timestamp derived from the manifest file's mtime. */
  generatedAt: string;
}

/** Absolute path to a source's viz root (the ids are validated; dir may not exist). */
export function meshSourceVizDir(projectId: string, meshId: string): string {
  return path.join(meshDirAbsolute(projectId, meshId), SOURCE_VIZ_DIRNAME);
}

/** Absolute paths of the GLB geometry, the JSON manifest, and the edge buffer. */
export function meshSourceVizPaths(projectId: string, meshId: string): MeshSourceVizPaths {
  const dir = meshSourceVizDir(projectId, meshId);
  return {
    glb: path.join(dir, GLB_NAME),
    manifest: path.join(dir, MANIFEST_NAME),
    edges: path.join(dir, EDGES_NAME),
  };
}

/** `fs.stat` that resolves to null instead of throwing when the path is absent. */
async function statOrNull(absPath: string): Promise<Stats | null> {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

/** Read a source's rendered GLB geometry bytes, or null if it has not been built. */
export async function readMeshSourceVizGlb(projectId: string, meshId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(meshSourceVizPaths(projectId, meshId).glb);
  } catch {
    return null;
  }
}

/** Read a source's cell-edge buffer, or null when this render has none. */
export async function readMeshSourceVizEdges(projectId: string, meshId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(meshSourceVizPaths(projectId, meshId).edges);
  } catch {
    return null;
  }
}

/**
 * Read a source's patch manifest (a bare `[{name,type,nFaces}]` list) alongside a
 * `generatedAt` derived from the file mtime, or null if missing/unreadable.
 */
export async function readMeshSourceVizManifest(
  projectId: string,
  meshId: string,
): Promise<StoredMeshSourceVizManifest | null> {
  const { manifest } = meshSourceVizPaths(projectId, meshId);
  const stat = await statOrNull(manifest);
  if (!stat) return null;
  try {
    const raw = await fs.readFile(manifest, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const patches = parsed as MeshPatch[];
    return { patches, generatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * Is the cached render stale (or absent)? True when the GLB is missing, when the
 * edge buffer is missing (so a render built before edges existed is upgraded on
 * next access), or when a source polyMesh file ({boundary,points}) was modified
 * after the GLB was built. A present, up-to-date render returns false (cache hit).
 */
export async function meshSourceVizIsStale(projectId: string, meshId: string): Promise<boolean> {
  const paths = meshSourceVizPaths(projectId, meshId);
  const glbStat = await statOrNull(paths.glb);
  if (!glbStat) return true;
  if (!(await statOrNull(paths.edges))) return true;

  const polyMeshDir = meshPolyMeshDir(projectId, meshId);
  for (const file of VIZ_SOURCE_FILES) {
    const srcStat = await statOrNull(path.join(polyMeshDir, file));
    if (srcStat && srcStat.mtimeMs > glbStat.mtimeMs) return true;
  }
  return false;
}
