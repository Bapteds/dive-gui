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
  MeshingRun,
  MeshingSession,
  MeshingSessionSummary,
  SnappyConfig,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { coreBudget } from '../../lib/cores';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { zipTreeAt } from '../../lib/fileTreeStorage';
import { parseStlBounds, unionBounds } from '../../lib/stlBounds';
import { runSnappyPipeline } from '../../lib/snappyPipeline';
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

/** Assemble the full session view (summary + STLs + bounds + last run + config). */
async function assembleSession(meta: MeshingMeta): Promise<MeshingSession> {
  const [stls, bounds, lastRun, savedConfig, hasMesh] = await Promise.all([
    listStl(meta.id),
    sessionBounds(meta.id),
    readRun(meta.id),
    readConfig(meta.id),
    hasResultMesh(meta.id),
  ]);
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    stlCount: stls.length,
    hasMesh,
    stls,
    bounds,
    lastRun,
    savedConfig,
    maxCores: coreBudget(),
  };
}

/** List every session (summaries only — no per-session STL/bounds scan). */
export async function listMeshingSessions(): Promise<MeshingSessionSummary[]> {
  const metas = await listSessionDirs();
  return Promise.all(
    metas.map(async (meta) => ({
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      stlCount: (await listStl(meta.id)).length,
      hasMesh: await hasResultMesh(meta.id),
    })),
  );
}

/** Create a new empty session. */
export async function createMeshingSession(name: string): Promise<MeshingSession> {
  const meta = await createSessionDir(name);
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

/**
 * Add one or more STL surfaces to a session. Each upload must be a .stl and must
 * parse to a non-empty bounding box; a malformed one is rejected before anything
 * is written for it. Returns the refreshed session.
 *
 * @throws 404 when the session is absent.
 * @throws 400 NO_STL when no files were provided.
 * @throws 422 INVALID_STL when a file is not a parseable STL.
 */
export async function addStlFiles(sessionId: string, uploads: StlUpload[]): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  if (uploads.length === 0) {
    throw new AppError(400, 'NO_STL', 'No STL files were uploaded.');
  }
  for (const upload of uploads) {
    if (!upload.name.toLowerCase().endsWith('.stl')) {
      throw new AppError(422, 'INVALID_STL', `"${upload.name}" is not an .stl file.`);
    }
    if (!parseStlBounds(upload.data).valid) {
      throw new AppError(422, 'INVALID_STL', `"${upload.name}" could not be read as an STL surface.`);
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

/**
 * Run the snappyHexMesh pipeline with the given config. Requires at least one
 * parseable STL. Resolves with the refreshed session and the per-step report
 * even when a tool fails (result.success === false) — only access / missing-STL
 * problems throw. On success the cached render is invalidated (mtime bump), so
 * the next manifest fetch rebuilds it.
 *
 * @throws 404 when the session is absent.
 * @throws 400 NO_STL when the session has no usable STL surface.
 */
export async function runSnappy(
  sessionId: string,
  config: SnappyConfig,
): Promise<{ session: MeshingSession; result: MeshImportConversion }> {
  const meta = await requireSession(sessionId);

  const stls = await listStl(sessionId);
  if (stls.length === 0) {
    throw new AppError(400, 'NO_STL', 'Add at least one STL surface before meshing.');
  }
  const bounds = await sessionBounds(sessionId);
  if (!bounds) {
    throw new AppError(400, 'NO_STL', 'The uploaded STL surfaces could not be read.');
  }

  // Clamp the requested cores to the machine budget: a run must never ask for more
  // MPI ranks than the host can offer (the UI already caps it, but a direct API
  // call could exceed it). cores <= 1 keeps the serial path.
  const effectiveConfig: SnappyConfig = {
    ...config,
    cores: Math.min(Math.max(1, Math.floor(config.cores || 1)), coreBudget()),
  };

  const caseDir = sessionCaseDir(sessionId);
  const result = await runSnappyPipeline(caseDir, stls.map((s) => s.name), bounds, effectiveConfig);

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
 * refreshed session. @throws 404 when the session is absent.
 */
export async function saveMeshingConfig(
  sessionId: string,
  config: SnappyConfig,
): Promise<MeshingSession> {
  const meta = await requireSession(sessionId);
  const clamped: SnappyConfig = {
    ...config,
    cores: Math.min(Math.max(1, Math.floor(config.cores || 1)), coreBudget()),
  };
  await writeConfig(sessionId, clamped);
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
