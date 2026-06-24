// Filesystem storage for a project's rendered 3D-viewer artifacts.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/viz/patches.glb
//                                              .../manifest.json
//
// The artifacts are produced once by the offline boundary-patch extractor
// (scripts/extractPatches.py) and cached here. The `viz/` directory is a sibling
// of `case/` and `cgns/`, so importing or resetting a case never deletes the
// cached render (mirrors the CGNS decision). Staleness is decided by comparing
// the GLB's mtime against the mesh source files, so the render is rebuilt only
// when the underlying mesh actually changes.
//
// `assertSafeId` guards the id path segment, exactly like caseStorage/cgnsStorage.
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { VIZ_DIRNAME, type MeshPatch } from '@dive/shared';
import { assertSafeId, storageRoot } from './fileTreeStorage';
import { caseDirAbsolute } from './caseStorage';

/** Filenames of the artifacts within a project's viz directory. */
const GLB_NAME = 'patches.glb';
const MANIFEST_NAME = 'manifest.json';
const EDGES_NAME = 'edges.bin';

/**
 * The mesh source files whose mtime determines whether the cached render is
 * stale: if either changed after the GLB was built, the render is rebuilt.
 */
const VIZ_SOURCE_FILES = ['boundary', 'points'] as const;

/** Absolute filesystem paths of a project's viz artifacts. */
export interface VizArtifactPaths {
  glb: string;
  manifest: string;
  /** Raw cell-edge buffer (line-segment endpoint coords). */
  edges: string;
}

/** A manifest read from disk: the parsed patch list plus the build timestamp. */
export interface StoredVizManifest {
  patches: MeshPatch[];
  /** ISO 8601 timestamp derived from the manifest file's mtime. */
  generatedAt: string;
}

/** Absolute path to a project's viz root (the id is validated; dir may not exist). */
export function vizDirAbsolute(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, VIZ_DIRNAME);
}

/** Absolute paths of the GLB geometry, the JSON manifest, and the edge buffer. */
export function vizArtifactPaths(projectId: string): VizArtifactPaths {
  const dir = vizDirAbsolute(projectId);
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

/** Read the rendered GLB geometry bytes, or null if it has not been built. */
export async function readVizGlb(projectId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(vizArtifactPaths(projectId).glb);
  } catch {
    return null;
  }
}

/** Read the cell-edge buffer, or null when this render has none (older build). */
export async function readVizEdges(projectId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(vizArtifactPaths(projectId).edges);
  } catch {
    return null;
  }
}

/**
 * Read the patch manifest the extractor wrote (a bare `[{name,type,nFaces}]`
 * list), returning it alongside a `generatedAt` derived from the file mtime, or
 * null if it is missing/unreadable. The bare-list transport keeps the patch
 * table independent of the geometry format.
 */
export async function readVizManifest(projectId: string): Promise<StoredVizManifest | null> {
  const { manifest } = vizArtifactPaths(projectId);
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
 * next access), or when a mesh source file (constant/polyMesh/{boundary,points})
 * was modified after the GLB was built. A present, up-to-date render returns
 * false (cache hit).
 */
export async function vizIsStale(projectId: string): Promise<boolean> {
  const paths = vizArtifactPaths(projectId);
  const glbStat = await statOrNull(paths.glb);
  if (!glbStat) return true;
  if (!(await statOrNull(paths.edges))) return true;

  const polyMeshDir = path.join(caseDirAbsolute(projectId), 'constant', 'polyMesh');
  for (const file of VIZ_SOURCE_FILES) {
    const srcStat = await statOrNull(path.join(polyMeshDir, file));
    if (srcStat && srcStat.mtimeMs > glbStat.mtimeMs) return true;
  }
  return false;
}
