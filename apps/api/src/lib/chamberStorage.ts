// Cached artifacts for a built chamber, keyed by a hash of its geometry params.
//
// Layout:  <STORAGE_DIR>/chamber/<hash>/params.json      (resolved metres params)
//                                     .../chamber.glb     (GLB, one node per patch)
//                                     .../manifest.json   (bare MeshPatch[])
//                                     .../edges.bin        (float32 edge segments)
//                                     .../exports/{chamber.stl, chamber.step, trisurface.zip}
//          <STORAGE_DIR>/chamber-spiral/<spiralHash>/in.json    (semi-spiral tool inputs)
//                                              .../spiral.json (designSemiSpiral.py result)
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
const WARNINGS_NAME = 'warnings.json';
const BUILD_META_NAME = 'build-meta.json';
const EXPORTS_DIRNAME = 'exports';
/** Semi-spiral casing results, keyed by a hash of the spiral inputs (spec 2026-09-29). */
const CHAMBER_SPIRAL_DIRNAME = 'chamber-spiral';
const SPIRAL_INPUT_NAME = 'in.json';
const SPIRAL_RESULT_NAME = 'spiral.json';

/** The resolved builder params: numbers, strings, flags and the nested `spiral`. */
export type ChamberParams = Record<string, unknown>;

/** A chamber export artifact kind and its download file. stepMirrored is the
 * z-y-plane-mirrored STEP ("Change rotational direction"), generated on demand
 * at first download rather than at build time. */
export const CHAMBER_EXPORT_FILES = {
  stl: 'chamber.stl',
  step: 'chamber.step',
  stepMirrored: 'chamber-mirrored.step',
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
export function chamberHash(params: ChamberParams): string {
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
export async function writeChamberParams(hash: string, params: ChamberParams): Promise<void> {
  const paths = chamberPaths(hash);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.params, JSON.stringify(params), 'utf8');
}

/**
 * Write the ChamberInput that produced this build (input.json, next to
 * params.json). Metadata only (WS-I §4, used by WS-H): it never enters the hash.
 * `onlyIfMissing` keeps the first writer's copy on a cache hit.
 */
export async function writeChamberInput(
  hash: string,
  input: unknown,
  onlyIfMissing = false,
): Promise<void> {
  const paths = chamberPaths(hash);
  const file = path.join(paths.dir, 'input.json');
  if (onlyIfMissing && (await statOrNull(file)) !== null) return;
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(input), 'utf8');
}

/**
 * Persist the geometry clamp warnings the builder emitted (warnings.json in the
 * build dir), so a later cache hit can report them without re-running the build.
 */
export async function writeChamberWarnings(hash: string, warnings: string[]): Promise<void> {
  const paths = chamberPaths(hash);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(path.join(paths.dir, WARNINGS_NAME), JSON.stringify(warnings), 'utf8');
}

/** Read a build's persisted warnings; [] when none were recorded (incl. older builds). */
export async function readChamberWarnings(hash: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(chamberPaths(hash).dir, WARNINGS_NAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

/** Per-build meta the builder writes (guide-vane builds only today). */
export interface ChamberBuildMeta {
  /** Does the STEP export carry the real guide vanes? true = proper vane STEP,
   * false = vane-less fallback, null = not a guide-vane build (no meta file). */
  stepHasVanes: boolean | null;
}

/** Read the builder's per-build meta; every field null when absent/invalid. */
export async function readChamberBuildMeta(hash: string): Promise<ChamberBuildMeta> {
  try {
    const raw = await fs.readFile(path.join(chamberPaths(hash).dir, BUILD_META_NAME), 'utf8');
    const parsed = JSON.parse(raw) as { stepHasVanes?: unknown };
    return { stepHasVanes: typeof parsed.stepHasVanes === 'boolean' ? parsed.stepHasVanes : null };
  } catch {
    return { stepHasVanes: null };
  }
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

/** Absolute paths of one semi-spiral result (hash validated + confined). */
export interface ChamberSpiralPaths {
  dir: string;
  input: string;
  result: string;
}

/** Paths for a spiral hash under <STORAGE_DIR>/chamber-spiral/ (dir may not exist). */
export function chamberSpiralPaths(spiralHash: string): ChamberSpiralPaths {
  assertSafeId(spiralHash);
  const dir = confineJoin(path.join(storageRoot(), CHAMBER_SPIRAL_DIRNAME), spiralHash);
  return {
    dir,
    input: path.join(dir, SPIRAL_INPUT_NAME),
    result: path.join(dir, SPIRAL_RESULT_NAME),
  };
}

/** Read a cached spiral result (parsed JSON), or null when absent or unreadable. */
export async function readChamberSpiral(spiralHash: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(chamberSpiralPaths(spiralHash).result, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Write the spiral tool inputs next to its future result (the script's argv[1]). */
export async function writeChamberSpiralInput(spiralHash: string, inputs: object): Promise<void> {
  const paths = chamberSpiralPaths(spiralHash);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.input, JSON.stringify(inputs), 'utf8');
}
