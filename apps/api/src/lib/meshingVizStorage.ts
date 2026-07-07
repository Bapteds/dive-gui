// Cached 3D-viewer artifacts for a meshing session's RESULT mesh.
//
// Layout:  <STORAGE_DIR>/meshing/<sessionId>/.viz/patches.glb
//                                          .../manifest.json
//                                          .../edges.bin
//
// A near-verbatim copy of meshSourceVizStorage.ts, re-rooted at a session's own
// directory: the produced constant/polyMesh is rendered the same way the project
// meshes are (scripts/extractPatches.py -> GLB + manifest + edges). The `.viz`
// directory is hidden inside the session dir, so deleting the session removes its
// cached render too. Staleness is decided against the result polyMesh's
// {boundary,points} mtime, exactly like the case render (vizStorage.vizIsStale).
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { MeshPatch } from '@dive/shared';
import { sessionDirAbsolute, sessionPolyMeshDir } from './meshingStorage';

/** Hidden viz cache directory inside a session's own directory. */
const VIZ_DIRNAME = '.viz';
const GLB_NAME = 'patches.glb';
const MANIFEST_NAME = 'manifest.json';
const EDGES_NAME = 'edges.bin';

/** Result polyMesh files whose mtime determines whether the cached render is stale. */
const VIZ_SOURCE_FILES = ['boundary', 'points'] as const;

/** Absolute filesystem paths of a session's viz artifacts. */
export interface MeshingVizPaths {
  glb: string;
  manifest: string;
  edges: string;
}

/** A manifest read from disk: the parsed patch list plus the build timestamp. */
export interface StoredMeshingVizManifest {
  patches: MeshPatch[];
  /** ISO 8601 timestamp derived from the manifest file's mtime. */
  generatedAt: string;
}

/** Absolute path to a session's viz root (id validated; dir may not exist). */
export function meshingVizDir(sessionId: string): string {
  return path.join(sessionDirAbsolute(sessionId), VIZ_DIRNAME);
}

/** Absolute paths of the GLB geometry, the JSON manifest, and the edge buffer. */
export function meshingVizPaths(sessionId: string): MeshingVizPaths {
  const dir = meshingVizDir(sessionId);
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

/** Read a session's rendered GLB geometry bytes, or null if it has not been built. */
export async function readMeshingVizGlb(sessionId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(meshingVizPaths(sessionId).glb);
  } catch {
    return null;
  }
}

/** Read a session's cell-edge buffer, or null when this render has none. */
export async function readMeshingVizEdges(sessionId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(meshingVizPaths(sessionId).edges);
  } catch {
    return null;
  }
}

/** Read a session's patch manifest alongside a `generatedAt` from the file mtime, or null. */
export async function readMeshingVizManifest(
  sessionId: string,
): Promise<StoredMeshingVizManifest | null> {
  const { manifest } = meshingVizPaths(sessionId);
  const stat = await statOrNull(manifest);
  if (!stat) return null;
  try {
    const raw = await fs.readFile(manifest, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return { patches: parsed as MeshPatch[], generatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * Is the cached render stale (or absent)? True when the GLB is missing, the edge
 * buffer is missing, or a result polyMesh file ({boundary,points}) was modified
 * after the GLB was built. A present, up-to-date render returns false.
 */
export async function meshingVizIsStale(sessionId: string): Promise<boolean> {
  const paths = meshingVizPaths(sessionId);
  const glbStat = await statOrNull(paths.glb);
  if (!glbStat) return true;
  if (!(await statOrNull(paths.edges))) return true;

  const polyMeshDir = sessionPolyMeshDir(sessionId);
  for (const file of VIZ_SOURCE_FILES) {
    const srcStat = await statOrNull(path.join(polyMeshDir, file));
    if (srcStat && srcStat.mtimeMs > glbStat.mtimeMs) return true;
  }
  return false;
}
