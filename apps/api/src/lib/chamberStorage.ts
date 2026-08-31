// Cached artifacts for a built chamber, keyed by a hash of its geometry params.
//
// Layout:  <STORAGE_DIR>/chamber/<hash>/params.json      (resolved metres params)
//                                     .../chamber.glb     (GLB, one node per patch)
//                                     .../manifest.json   (bare MeshPatch[])
//                                     .../edges.bin        (float32 edge segments)
//                                     .../exports/{chamber.stl, chamber.step, trisurface.zip}
//
// Global, NOT project-scoped (mirrors meshingStorage): the chamber generator is a
// standalone tool. The cache key is a content hash of the resolved geometry
// params, so identical inputs reuse a build and a new param set lands in a new
// directory — there is no mtime staleness to track (the params ARE the key).
// A thin façade over the traversal-safe core in fileTreeStorage.ts.
import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { CHAMBER_DIRNAME, type MeshPatch } from '@dive/shared';
import { assertSafeId, confineJoin, storageRoot } from './fileTreeStorage';

const GLB_NAME = 'chamber.glb';
const MANIFEST_NAME = 'manifest.json';
const EDGES_NAME = 'edges.bin';
const PARAMS_NAME = 'params.json';
const EXPORTS_DIRNAME = 'exports';

/** A chamber export artifact kind and its download file. */
export const CHAMBER_EXPORT_FILES = {
  stl: 'chamber.stl',
  step: 'chamber.step',
  trisurface: 'trisurface.zip',
} as const;
export type ChamberExportKind = keyof typeof CHAMBER_EXPORT_FILES;

/** Absolute filesystem paths for one chamber build. */
export interface ChamberPaths {
  dir: string;
  params: string;
  glb: string;
  manifest: string;
  edges: string;
  exportsDir: string;
}

/** Root under which every chamber build's artifacts live. */
function chamberRoot(): string {
  return path.join(storageRoot(), CHAMBER_DIRNAME);
}

/**
 * Stable 16-hex content hash of the resolved geometry params (order-independent),
 * used as the build's directory name / cache key.
 */
export function chamberHash(params: Record<string, number | string | boolean>): string {
  const canonical = JSON.stringify(
    Object.keys(params)
      .sort()
      .map((key) => [key, params[key]]),
  );
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/** Absolute paths for a build (hash validated + confined; dir may not exist). */
export function chamberPaths(hash: string): ChamberPaths {
  assertSafeId(hash);
  const dir = confineJoin(chamberRoot(), hash);
  return {
    dir,
    params: path.join(dir, PARAMS_NAME),
    glb: path.join(dir, GLB_NAME),
    manifest: path.join(dir, MANIFEST_NAME),
    edges: path.join(dir, EDGES_NAME),
    exportsDir: path.join(dir, EXPORTS_DIRNAME),
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

/** Has this chamber already been built (its GLB is on disk)? */
export async function chamberGlbExists(hash: string): Promise<boolean> {
  return (await statOrNull(chamberPaths(hash).glb)) !== null;
}

/** Write the resolved params JSON (the buildChamber.py input) into the build dir. */
export async function writeChamberParams(
  hash: string,
  params: Record<string, number | string | boolean>,
): Promise<void> {
  const paths = chamberPaths(hash);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.params, JSON.stringify(params), 'utf8');
}

/** Read the rendered GLB bytes, or null when this chamber has not been built. */
export async function readChamberGlb(hash: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(chamberPaths(hash).glb);
  } catch {
    return null;
  }
}

/** Read the edge buffer, or null when this render has none. */
export async function readChamberEdges(hash: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(chamberPaths(hash).edges);
  } catch {
    return null;
  }
}

/** A manifest read from disk: the parsed patch list plus a build timestamp. */
export interface StoredChamberManifest {
  patches: MeshPatch[];
  generatedAt: string;
}

/** Read the patch manifest (with a `generatedAt` from the file mtime), or null. */
export async function readChamberManifest(hash: string): Promise<StoredChamberManifest | null> {
  const { manifest } = chamberPaths(hash);
  const stat = await statOrNull(manifest);
  if (!stat) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(manifest, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    return { patches: parsed as MeshPatch[], generatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Read one export artifact's bytes, or null when absent. */
export async function readChamberExport(
  hash: string,
  kind: ChamberExportKind,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(chamberPaths(hash).exportsDir, CHAMBER_EXPORT_FILES[kind]));
  } catch {
    return null;
  }
}
