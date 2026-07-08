// Business logic for standalone MESHING sessions (STL -> snappyHexMesh ->
// constant/polyMesh). Not project-scoped: a session is its own throwaway
// OpenFOAM case under <STORAGE_DIR>/meshing/<id>. Access is gated only by
// authentication (requireAuth) — sessions are shared across the team, like the
// mesh library within a project.
//
// The snappy run and the result-mesh render both follow the established model:
// external tools run through the injectable command runner (never throwing on a
// tool failure — a per-step report is returned), the extractor script path is
// resolved relative to THIS module (cwd-independent), and a build that produces
// no GLB is treated as a failure.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  MeshBounds,
  MeshImportConversion,
  MeshManifest,
  MeshingConfig,
  MeshingEngine,
  MeshingPatch,
  MeshingRun,
  MeshingSession,
  MeshingSessionSummary,
} from '@dive/shared';
import { FMS_EXTENSION, STL_EXTENSION } from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { coreBudget } from '../../lib/cores';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { zipTreeAt } from '../../lib/fileTreeStorage';
import { parseStlBounds, unionBounds } from '../../lib/stlBounds';
import { parseFmsPatches, parseStlSolidNames } from '../../lib/meshPatches';
import { mergedSolidNames } from '../../lib/stlMerge';
import { runSnappyPipeline } from '../../lib/snappyPipeline';
import { runCfMeshPipeline } from '../../lib/cfMeshPipeline';
import {
  createSession as createSessionDir,
  deleteSession,
  deleteStl,
  hasResultMesh,
  listSessions as listSessionDirs,
  listStl,
  readConfig,
  readMeta,
  readRun,
  readStl,
  sessionCaseDir,
  sessionDirAbsolute,
  writeConfig,
  writeRun,
  writeStl,
  type MeshingMeta,
} from '../../lib/meshingStorage';
import {
  meshingVizDir,
  meshingVizIsStale,
  meshingVizPaths,
  readMeshingVizEdges,
  readMeshingVizGlb,
  readMeshingVizManifest,
} from '../../lib/meshingVizStorage';

/** One uploaded surface (raw multipart name + bytes). */
export interface StlUpload {
  name: string;
  data: Buffer;
}

/** Load the session's metadata or fail with a clean 404 (no existence leak). */
async function requireSession(sessionId: string): Promise<MeshingMeta> {
  const meta = await readMeta(sessionId);
  if (!meta) {
    throw new AppError(404, 'NOT_FOUND', 'Meshing session not found.');
  }
  return meta;
}

/** Compute the union bounding box of the session's STLs, or null when none/invalid. */
async function sessionBounds(sessionId: string): Promise<MeshBounds | null> {
  const files = await listStl(sessionId);
  const boxes = [];
  for (const file of files) {
    const bytes = await readStl(sessionId, file.name);
    if (!bytes) continue;
    const parsed = parseStlBounds(bytes);
    if (parsed.valid) boxes.push({ min: parsed.min, max: parsed.max });
  }
  return unionBounds(boxes);
}

/**
 * The boundary patch names of a cfMesh session's input surface (empty for snappy):
 *  - one FMS  -> its header patch names;
 *  - one STL  -> its `solid` names (else the file name as a fallback);
 *  - many STL -> the merged solid names (one per file), matching stlMerge exactly.
 * Drives the per-patch boundary-type editor.
 */
async function discoverPatches(sessionId: string, engine: MeshingEngine): Promise<MeshingPatch[]> {
  if (engine !== 'cfmesh') return [];
  const files = await listStl(sessionId);
  const fms = files.find((f) => isFms(f.name));
  if (fms) {
    const buffer = await readStl(sessionId, fms.name);
    // An FMS carries the current type of each patch — surface it so the user sees it.
    return buffer ? parseFmsPatches(buffer).map((p) => ({ name: p.name, type: p.type })) : [];
  }
  // An STL has no patch types; the names come from its solids (or the merged files).
  const stls = files.filter((f) => isStl(f.name)).map((f) => f.name);
  if (stls.length === 0) return [];
  const names =
    stls.length >= 2 ? mergedSolidNames(stls) : await stlSolidNamesOr(sessionId, stls);
  return names.map((name) => ({ name, type: null }));
}

/** A single STL's solid names, falling back to the file's merged name when unnamed. */
async function stlSolidNamesOr(sessionId: string, stls: string[]): Promise<string[]> {
  const buffer = await readStl(sessionId, stls[0]);
  const names = buffer ? parseStlSolidNames(buffer) : [];
  return names.length > 0 ? names : mergedSolidNames(stls);
}

/** Assemble the full session view (summary + STLs + bounds + last run + config). */
async function assembleSession(meta: MeshingMeta): Promise<MeshingSession> {
  const [stls, bounds, lastRun, savedConfig, hasMesh, patches] = await Promise.all([
    listStl(meta.id),
    sessionBounds(meta.id),
    readRun(meta.id),
    readConfig(meta.id),
    hasResultMesh(meta.id),
    discoverPatches(meta.id, meta.engine),
  ]);
  return {
    id: meta.id,
    name: meta.name,
    engine: meta.engine,
    createdAt: meta.createdAt,
    stlCount: stls.length,
    hasMesh,
    stls,
    bounds,
    lastRun,
    savedConfig,
    maxCores: coreBudget(),
    patches,
  };
}

/** List every session (summaries only — no per-session STL/bounds scan). */
export async function listMeshingSessions(): Promise<MeshingSessionSummary[]> {
  const metas = await listSessionDirs();
  return Promise.all(
    metas.map(async (meta) => ({
      id: meta.id,
      name: meta.name,
      engine: meta.engine,
      createdAt: meta.createdAt,
      stlCount: (await listStl(meta.id)).length,
      hasMesh: await hasResultMesh(meta.id),
    })),
  );
}

/** Create a new empty session with the chosen engine (fixed for its life). */
export async function createMeshingSession(
  name: string,
  engine: MeshingEngine,
): Promise<MeshingSession> {
  const meta = await createSessionDir(name, engine);
  return assembleSession(meta);
}

/** Get one session's full detail. @throws 404 when absent. */
export async function getMeshingSession(sessionId: string): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  return assembleSession(meta);
}

/** Delete a session entirely. @throws 404 when absent. */
export async function removeMeshingSession(sessionId: string): Promise<void> {
  await requireSession(sessionId);
  await deleteSession(sessionId);
}

/** Does a filename look like an STL / an FMS? */
function isStl(name: string): boolean {
  return name.toLowerCase().endsWith(STL_EXTENSION);
}
function isFms(name: string): boolean {
  return name.toLowerCase().endsWith(FMS_EXTENSION);
}

/**
 * Add one or more input surfaces to a session, validated for its engine:
 *  - snappy: only .stl, each parseable to a non-empty bounding box.
 *  - cfmesh: .stl (parseable) OR a single .fms. A session holds EITHER STLs OR one
 *    FMS — never both, and never two FMS — since cfMesh meshes one surfaceFile.
 * A malformed / disallowed upload is rejected before anything is written.
 *
 * @throws 404 when the session is absent.
 * @throws 400 NO_STL when no files were provided.
 * @throws 422 INVALID_STL for a wrong type / unparseable STL / a disallowed mix.
 */
export async function addStlFiles(sessionId: string, uploads: StlUpload[]): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  if (uploads.length === 0) {
    throw new AppError(400, 'NO_STL', 'No files were uploaded.');
  }

  const existing = await listStl(sessionId);
  const hasFms = existing.some((f) => isFms(f.name));
  const hasStl = existing.some((f) => isStl(f.name));

  for (const upload of uploads) {
    const stl = isStl(upload.name);
    const fms = meta.engine === 'cfmesh' && isFms(upload.name);
    if (!stl && !fms) {
      const allowed = meta.engine === 'cfmesh' ? 'an .stl or .fms' : 'an .stl';
      throw new AppError(422, 'INVALID_STL', `"${upload.name}" is not ${allowed} file.`);
    }
    if (stl && !parseStlBounds(upload.data).valid) {
      throw new AppError(422, 'INVALID_STL', `"${upload.name}" could not be read as an STL surface.`);
    }
  }

  // cfMesh: enforce "one surfaceFile" — STLs and an FMS are mutually exclusive.
  if (meta.engine === 'cfmesh') {
    const addingFms = uploads.filter((u) => isFms(u.name)).length;
    const addingStl = uploads.some((u) => isStl(u.name));
    if (addingFms + (hasFms ? 1 : 0) > 1) {
      throw new AppError(422, 'INVALID_STL', 'A cfMesh session takes a single .fms file.');
    }
    if ((addingFms > 0 && (hasStl || addingStl)) || (addingStl && hasFms)) {
      throw new AppError(
        422,
        'INVALID_STL',
        'Use either STL surfaces or one FMS file — not both. Remove the others first.',
      );
    }
  }

  for (const upload of uploads) {
    await writeStl(sessionId, upload.name, upload.data);
  }
  return assembleSession(meta);
}

/** Read one STL's raw bytes (for the client-side viewer). @throws 404 when absent. */
export async function readStlBytes(sessionId: string, name: string): Promise<Buffer> {
  await requireSession(sessionId);
  const bytes = await readStl(sessionId, name);
  if (!bytes) {
    throw new AppError(404, 'NOT_FOUND', 'STL file not found.');
  }
  return bytes;
}

/** Remove one STL from a session. @throws 404 when the session or file is absent. */
export async function removeStlFile(sessionId: string, name: string): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  const removed = await deleteStl(sessionId, name);
  if (!removed) {
    throw new AppError(404, 'NOT_FOUND', 'STL file not found.');
  }
  return assembleSession(meta);
}

/** Clamp a config's cores to the machine budget (a direct API call could exceed it). */
function clampCores<T extends MeshingConfig>(config: T): T {
  return { ...config, cores: Math.min(Math.max(1, Math.floor(config.cores || 1)), coreBudget()) };
}

/** The config's engine must match the session's (chosen at creation, fixed). */
function assertEngineMatches(meta: MeshingMeta, config: MeshingConfig): void {
  if (config.engine !== meta.engine) {
    throw new AppError(
      400,
      'ENGINE_MISMATCH',
      `This session uses ${meta.engine}; the config is for ${config.engine}.`,
    );
  }
}

/**
 * Run the session's mesher (snappyHexMesh or cfMesh, per its engine) with the given
 * config. Requires at least one input surface. Resolves with the refreshed session
 * and the per-step report even when a tool fails (result.success === false) — only
 * access / missing-surface / engine-mismatch problems throw. On success the cached
 * render is invalidated so the next manifest fetch rebuilds it.
 *
 * @throws 404 when the session is absent.
 * @throws 400 ENGINE_MISMATCH when the config engine differs from the session's.
 * @throws 400 NO_STL when the session has no usable input surface.
 */
export async function runMeshing(
  sessionId: string,
  config: MeshingConfig,
): Promise<{ session: MeshingSession; result: MeshImportConversion }> {
  const meta = await requireSession(sessionId);
  assertEngineMatches(meta, config);

  const surfaces = await listStl(sessionId);
  if (surfaces.length === 0) {
    throw new AppError(400, 'NO_STL', 'Add at least one input surface before meshing.');
  }
  const bounds = await sessionBounds(sessionId);
  const caseDir = sessionCaseDir(sessionId);
  const effectiveConfig = clampCores(config);

  let result: MeshImportConversion;
  if (effectiveConfig.engine === 'cfmesh') {
    // cfMesh takes one surfaceFile (merged STLs or an FMS); bounds may be null (FMS).
    result = await runCfMeshPipeline(caseDir, surfaces.map((s) => s.name), bounds, effectiveConfig);
  } else {
    // snappyHexMesh needs a readable STL bounding box to size the background mesh.
    if (!bounds) {
      throw new AppError(400, 'NO_STL', 'The uploaded STL surfaces could not be read.');
    }
    result = await runSnappyPipeline(caseDir, surfaces.map((s) => s.name), bounds, effectiveConfig);
  }

  // Persist the run report + config so the UI can show the last outcome on reload,
  // and mirror the config into the autosave sidecar so the two stay in sync.
  const run: MeshingRun = { config: effectiveConfig, result, at: new Date().toISOString() };
  await writeRun(sessionId, run);
  await writeConfig(sessionId, effectiveConfig);

  // Drop the stale render so the viewer rebuilds from the new polyMesh.
  await fs.rm(meshingVizDir(sessionId), { recursive: true, force: true }).catch(() => undefined);

  return { session: await assembleSession(meta), result };
}

/**
 * Persist the session's edited config (autosaved from the form), independent of a
 * run, so manual settings survive a reload even before the mesh is generated. The
 * cores are clamped to the machine budget, exactly as a run would. Returns the
 * refreshed session.
 *
 * @throws 404 when the session is absent.
 * @throws 400 ENGINE_MISMATCH when the config engine differs from the session's.
 */
export async function saveMeshingConfig(
  sessionId: string,
  config: MeshingConfig,
): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  assertEngineMatches(meta, config);
  await writeConfig(sessionId, clampCores(config));
  return assembleSession(meta);
}

// --- Result-mesh render (reuses scripts/extractPatches.py) -------------------

/** Resolve the boundary-patch extractor script (configured, else bundled default). */
function extractPatchesScript(): string {
  const configured = env.EXTRACT_PATCHES_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ is not compiled, so three levels up from src/modules/meshing (or
  // dist/modules/meshing) reaches apps/api/scripts from source and compiled output.
  return path.resolve(__dirname, '../../../scripts/extractPatches.py');
}

/** Does an absolute path exist on disk? */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Keep a captured stderr tail bounded when surfacing a build failure. */
function tail(text: string): string {
  return text.length <= 4000 ? text : `…(truncated)\n${text.slice(text.length - 4000)}`;
}

/** Build a concise failure message from a command result. */
function summarizeFailure(result: CommandResult): string {
  if (result.spawnError) return `Could not start the extractor: ${result.spawnError}`;
  if (result.timedOut) return 'The mesh extractor timed out.';
  const detail = tail(result.stderr || result.stdout || '');
  return `The mesh extractor exited with code ${result.exitCode ?? 'null'}.${detail ? `\n${detail}` : ''}`;
}

/**
 * Build (or rebuild) the cached render of the session's result polyMesh, exactly
 * like mesh.service.buildViz but pointed at the session case dir + its .viz store.
 *
 * @throws 500 SCRIPT_MISSING if the extractor is not on disk.
 * @throws 502 MESH_BUILD_FAILED if the run errors or produces no GLB.
 */
async function buildResultViz(sessionId: string): Promise<void> {
  const script = extractPatchesScript();
  if (!(await pathExists(script))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `Mesh extractor not found at ${script}. Set EXTRACT_PATCHES_SCRIPT to its absolute path.`,
    );
  }
  const caseDir = sessionCaseDir(sessionId);
  const { glb, manifest } = meshingVizPaths(sessionId);
  await fs.mkdir(meshingVizDir(sessionId), { recursive: true });

  const result = await runCommand({
    command: env.MESH_PYTHON_BIN,
    args: [script, caseDir, glb, manifest],
    cwd: caseDir,
    env: process.env,
    timeoutMs: env.MESH_BUILD_TIMEOUT_MS,
  });
  if (result.spawnError || result.timedOut || result.exitCode !== 0 || !(await pathExists(glb))) {
    throw new AppError(502, 'MESH_BUILD_FAILED', summarizeFailure(result));
  }
}

/**
 * Return the result-mesh manifest, building the render on demand when missing or
 * stale. @throws 404 session absent, 409 NO_MESH when no polyMesh yet, 500/502 on build.
 */
export async function getResultManifest(sessionId: string): Promise<MeshManifest> {
  await requireSession(sessionId);
  if (!(await hasResultMesh(sessionId))) {
    throw new AppError(409, 'NO_MESH', 'This session has no meshed result yet.');
  }
  if (await meshingVizIsStale(sessionId)) {
    await buildResultViz(sessionId);
  }
  const stored = await readMeshingVizManifest(sessionId);
  if (!stored) {
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The mesh manifest could not be read after build.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/** Return the rendered GLB bytes. @throws 404 session absent, 409 when not built. */
export async function getResultGeometry(sessionId: string): Promise<Buffer> {
  await requireSession(sessionId);
  const glb = await readMeshingVizGlb(sessionId);
  if (!glb) {
    throw new AppError(409, 'MESH_NOT_BUILT', 'The 3D preview has not been built yet.');
  }
  return glb;
}

/** Return the cell-edge buffer, or null when this render has none. @throws 404 session absent. */
export async function getResultEdges(sessionId: string): Promise<Buffer | null> {
  await requireSession(sessionId);
  return readMeshingVizEdges(sessionId);
}

/** Zip the whole session case for download. @throws 404 when the session is absent. */
export async function downloadSessionZip(sessionId: string): Promise<Buffer> {
  await requireSession(sessionId);
  return zipTreeAt(sessionDirAbsolute(sessionId));
}
