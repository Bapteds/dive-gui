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
  MeshingLogPayload,
  MeshingPatch,
  MeshingRun,
  MeshingRunState,
  MeshingRunStatus,
  MeshingSession,
  MeshingSessionSummary,
} from '@dive/shared';
import { CHAMBER_TRANSFER_EXCLUDED_STL, FMS_EXTENSION, STL_EXTENSION } from '@dive/shared';
import AdmZip from 'adm-zip';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { logger } from '../../lib/logger';
import { coreBudget } from '../../lib/cores';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import type { StreamHandle } from '../../lib/streamRunner';
import type { StreamRunControls } from '../../lib/meshPipelineRun';
import { zipTreeAt } from '../../lib/fileTreeStorage';
import { parseStlBounds, unionBounds } from '../../lib/stlBounds';
import { parseFmsPatches, parseStlSolidNames } from '../../lib/meshPatches';
import { mergedSolidNames } from '../../lib/stlMerge';
import { runSnappyPipeline } from '../../lib/snappyPipeline';
import { runCfMeshPipeline } from '../../lib/cfMeshPipeline';
import {
  appendMeshLog,
  copySessionSetup,
  createSession as createSessionDir,
  deleteSession,
  deleteStl,
  hasResultMesh,
  listRunningSessionIds,
  listSessions as listSessionDirs,
  listStl,
  meshLogAbsolute,
  readConfig,
  readMeshLog,
  readMeshStatus,
  readMeta,
  renameSession,
  readRun,
  readStl,
  sessionCaseDir,
  sessionDirAbsolute,
  truncateMeshLog,
  writeConfig,
  writeMeshStatus,
  writeRun,
  writeStl,
  type MeshingMeta,
} from '../../lib/meshingStorage';
import { readChamberExport } from '../../lib/chamberStorage';
import type { FromChamberInput } from './meshing.schemas';
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
  const [stls, bounds, lastRun, savedConfig, hasMesh, patches, runState] = await Promise.all([
    listStl(meta.id),
    sessionBounds(meta.id),
    readRun(meta.id),
    readConfig(meta.id),
    hasResultMesh(meta.id),
    discoverPatches(meta.id, meta.engine),
    readMeshStatus(meta.id),
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
    runStatus: runState?.status ?? 'idle',
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

/** Rename a session's display name (id/dir unchanged). @throws 404 when absent. */
export async function renameMeshingSession(
  sessionId: string,
  name: string,
): Promise<MeshingSession> {
  await requireSession(sessionId); // clean 404 before the write
  const meta = await renameSession(sessionId, name);
  if (!meta) throw new AppError(404, 'NOT_FOUND', 'Meshing session not found.');
  return assembleSession(meta);
}

/** Copy a session's setup (engine + config + surfaces) into a new session. */
export async function copyMeshingSession(sourceId: string, name?: string): Promise<MeshingSession> {
  await requireSession(sourceId); // clean 404 when the source is absent
  const meta = await copySessionSetup(sourceId, name);
  return assembleSession(meta);
}

/**
 * Read a built chamber's triSurface zip and return its per-patch STLs as uploads,
 * excluding the pre-merged domain.stl. @throws 409 CHAMBER_NOT_BUILT when the
 * build/zip is absent, 422 when the zip carries no usable patch STL.
 */
async function chamberPatchUploads(chamberHash: string): Promise<StlUpload[]> {
  const zipBytes = await readChamberExport(chamberHash, 'trisurface');
  if (!zipBytes) {
    throw new AppError(409, 'CHAMBER_NOT_BUILT', 'This chamber has not been built yet.');
  }
  const zip = new AdmZip(zipBytes);
  const uploads: StlUpload[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = entry.entryName.split('/').pop() ?? entry.entryName;
    if (!base.toLowerCase().endsWith('.stl')) continue;
    if (base === CHAMBER_TRANSFER_EXCLUDED_STL) continue;
    uploads.push({ name: base, data: entry.getData() });
  }
  if (uploads.length === 0) {
    throw new AppError(422, 'INVALID_STL', 'The chamber export has no patch surfaces to transfer.');
  }
  return uploads;
}

/**
 * Import a chamber build's patches into a meshing session (new / existing /
 * copyFrom) and return the resulting session. Reuses addStlFiles, so a cfMesh
 * target still enforces its one-surfaceFile rules and every STL is validated.
 */
export async function importChamberIntoMeshing(input: FromChamberInput): Promise<MeshingSession> {
  const uploads = await chamberPatchUploads(input.chamberHash);
  let sessionId: string;
  if (input.mode === 'new') {
    const meta = await createSessionDir(input.name, input.engine);
    sessionId = meta.id;
  } else if (input.mode === 'existing') {
    const meta = await requireSession(input.sessionId);
    sessionId = meta.id;
  } else {
    await requireSession(input.sourceId); // clean 404 when the source is absent
    const meta = await copySessionSetup(input.sourceId, input.name);
    sessionId = meta.id;
  }
  return addStlFiles(sessionId, uploads);
}

/** Delete a session entirely. @throws 404 when absent. */
export async function removeMeshingSession(sessionId: string): Promise<void> {
  await requireSession(sessionId);
  // Kill any run still executing for this session so we don't orphan a mesher
  // process after its case directory is gone.
  const entry = activeMeshRuns.get(sessionId);
  if (entry) {
    entry.aborted = true;
    try {
      entry.handle?.stop('SIGKILL');
    } catch {
      /* already exited */
    }
    activeMeshRuns.delete(sessionId);
  }
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

// --- Live meshing run: a background job with a streamed log + Stop ------------
//
// A run is no longer blocking: startMeshingRun validates, streams the pipeline's
// output to mesh.log in the BACKGROUND, and returns immediately with a 'running'
// status the client polls (getMeshingLog). This mirrors the solver's run model,
// but file-backed (status.json + mesh.log in the session dir) — meshing has no DB
// rows. One run per session is enforced by an in-process registry, which also
// backs Stop; a status left 'running' by a crash is reconciled on boot.

/** A locally-executing run: its current step's process + whether a stop was asked. */
interface ActiveMeshRun {
  /** The process of the step running right now, or null between steps. */
  handle: StreamHandle | null;
  /** Set once the user requests a stop; the finalizer then records 'stopped'. */
  aborted: boolean;
}

/** In-process registry of runs executing in THIS API process, keyed by session id. */
const activeMeshRuns = new Map<string, ActiveMeshRun>();

/** Keep the polled log tail bounded on the wire while preserving the useful end. */
const LOG_TAIL_CHARS = 20000;

/** Is a run for this session currently executing in this process? */
export function isMeshRunActive(sessionId: string): boolean {
  return activeMeshRuns.has(sessionId);
}

/**
 * Drive one meshing run to completion in the background: stream the engine's
 * pipeline to mesh.log, then persist the run report + terminal status and drop the
 * stale render. Never throws — any unexpected error is captured as a failed run so
 * the session never stays wedged 'running'. Always clears the active-run registry.
 */
async function finishMeshingRun(
  sessionId: string,
  config: MeshingConfig,
  surfaceNames: string[],
  bounds: MeshBounds | null,
  startedAt: string,
): Promise<void> {
  const caseDir = sessionCaseDir(sessionId);
  const logFile = meshLogAbsolute(sessionId);
  const entry = activeMeshRuns.get(sessionId);
  const controls: StreamRunControls = {
    onHandle: (handle) => {
      if (entry) entry.handle = handle;
    },
    aborted: () => entry?.aborted ?? false,
  };

  let result: MeshImportConversion;
  try {
    if (config.engine === 'cfmesh') {
      result = await runCfMeshPipeline(caseDir, surfaceNames, bounds, config, { logFile, controls });
    } else {
      // bounds is guaranteed non-null for snappy (checked before we went async).
      result = await runSnappyPipeline(caseDir, surfaceNames, bounds as MeshBounds, config, {
        logFile,
        controls,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Meshing run threw for session ${sessionId}`, err);
    await appendMeshLog(sessionId, `\n[runner] ${message}\n`).catch(() => undefined);
    result = { success: false, steps: [] };
  }

  const aborted = entry?.aborted ?? false;
  const status: MeshingRunStatus = aborted ? 'stopped' : result.success ? 'succeeded' : 'failed';

  // Persist the run report + config (so the report/last-run survive a reload), the
  // terminal status, and drop the stale render so the viewer rebuilds the polyMesh.
  const run: MeshingRun = { config, result, at: new Date().toISOString() };
  await writeRun(sessionId, run).catch(() => undefined);
  await writeConfig(sessionId, config).catch(() => undefined);
  await writeMeshStatus(sessionId, { status, startedAt, finishedAt: new Date().toISOString() }).catch(
    () => undefined,
  );
  await fs.rm(meshingVizDir(sessionId), { recursive: true, force: true }).catch(() => undefined);
  await appendMeshLog(
    sessionId,
    `\n=== ${status === 'succeeded' ? 'Done' : status === 'stopped' ? 'Stopped' : 'Failed'} ===\n`,
  ).catch(() => undefined);

  activeMeshRuns.delete(sessionId);
}

/**
 * START the session's mesher (snappyHexMesh or cfMesh) as a background job and
 * return immediately with the just-started 'running' status. The client polls
 * getMeshingLog for the live output and terminal state. Requires at least one
 * input surface; only ONE run per session may execute at a time.
 *
 * @throws 404 when the session is absent.
 * @throws 400 ENGINE_MISMATCH when the config engine differs from the session's.
 * @throws 400 NO_STL when the session has no usable input surface.
 * @throws 409 MESH_IN_PROGRESS when a run for this session is already executing.
 */
export async function startMeshingRun(
  sessionId: string,
  config: MeshingConfig,
): Promise<{ session: MeshingSession; status: MeshingRunState }> {
  const meta = await requireSession(sessionId);
  assertEngineMatches(meta, config);

  if (activeMeshRuns.has(sessionId)) {
    throw new AppError(409, 'MESH_IN_PROGRESS', 'A mesh run is already in progress for this session.');
  }

  const surfaces = await listStl(sessionId);
  if (surfaces.length === 0) {
    throw new AppError(400, 'NO_STL', 'Add at least one input surface before meshing.');
  }
  const bounds = await sessionBounds(sessionId);
  const effectiveConfig = clampCores(config);
  // snappyHexMesh needs a readable STL bounding box to size the background mesh —
  // fail fast (400), before starting the background job, exactly as the old
  // blocking path did. cfMesh may have null bounds (an FMS input carries its own).
  if (effectiveConfig.engine === 'snappy' && !bounds) {
    throw new AppError(400, 'NO_STL', 'The uploaded STL surfaces could not be read.');
  }

  const startedAt = new Date().toISOString();
  const state: MeshingRunState = { status: 'running', startedAt, finishedAt: null };
  // Register the active run BEFORE going async so a concurrent start is rejected,
  // then reset the log and persist the running status.
  activeMeshRuns.set(sessionId, { handle: null, aborted: false });
  await truncateMeshLog(sessionId);
  await appendMeshLog(sessionId, `=== Meshing (${effectiveConfig.engine}) ===\n`);
  await writeMeshStatus(sessionId, state);
  await writeConfig(sessionId, effectiveConfig);

  void finishMeshingRun(
    sessionId,
    effectiveConfig,
    surfaces.map((s) => s.name),
    bounds,
    startedAt,
  ).catch(async (err) => {
    // Belt-and-braces: finishMeshingRun already captures its own errors, but never
    // let a rejected job leave the session stuck 'running'.
    logger.error(`Meshing run orchestration failed for session ${sessionId}`, err);
    activeMeshRuns.delete(sessionId);
    await writeMeshStatus(sessionId, {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
  });

  return { session: await assembleSession(meta), status: state };
}

/**
 * Live-log poll payload for a session's current/last run: the lifecycle status, a
 * bounded tail of the streamed output, its size, and — once terminal — the run
 * report. @throws 404 when the session is absent.
 */
export async function getMeshingLog(sessionId: string): Promise<MeshingLogPayload> {
  await requireSession(sessionId);
  const state = await readMeshStatus(sessionId);
  // Bound memory on this per-poll hot path: read at most the last N bytes.
  const { content, size } = await readMeshLog(sessionId, env.SOLVER_LOG_MAX_BYTES);
  const logTail = content.length > LOG_TAIL_CHARS ? content.slice(-LOG_TAIL_CHARS) : content;
  // The report is only meaningful once the run has finished (config + per-step steps).
  const run = state && state.status !== 'running' ? await readRun(sessionId) : null;
  return {
    status: state?.status ?? 'idle',
    startedAt: state?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    logTail,
    logBytes: size,
    run,
  };
}

/**
 * Request a stop of the session's running mesh: mark it aborted and SIGTERM the
 * current step's process (SIGKILL after the grace period if it lingers). The
 * background finalizer then records the run 'stopped'. Idempotent — stopping a
 * session with no active run is a no-op. @throws 404 when the session is absent.
 */
export async function stopMeshingRun(sessionId: string): Promise<{ session: MeshingSession }> {
  const meta = await requireSession(sessionId);
  const entry = activeMeshRuns.get(sessionId);
  if (entry) {
    entry.aborted = true;
    const handle = entry.handle;
    if (handle) {
      handle.stop('SIGTERM');
      // Escalate to SIGKILL if the tool has not exited within the grace period.
      const timer = setTimeout(() => {
        if (activeMeshRuns.get(sessionId)?.handle === handle) handle.stop('SIGKILL');
      }, env.RUN_STOP_GRACE_MS);
      timer.unref();
    }
  } else {
    // No live handle (e.g. a status left 'running' by a crash): mark it stopped so
    // the UI unlocks instead of polling a run that will never finish.
    const state = await readMeshStatus(sessionId);
    if (state?.status === 'running') {
      await writeMeshStatus(sessionId, {
        status: 'stopped',
        startedAt: state.startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  return { session: await assembleSession(meta) };
}

/**
 * On API boot, reconcile meshing runs left 'running' by the previous process: this
 * fresh process holds no live handle for them, so they can never finish — mark them
 * failed so the Run button unlocks. The persisted log is preserved. Returns the count.
 */
export async function reconcileOrphanMeshingRuns(): Promise<number> {
  const ids = await listRunningSessionIds();
  for (const id of ids) {
    const state = await readMeshStatus(id);
    if (!state || state.status !== 'running') continue;
    await writeMeshStatus(id, {
      status: 'failed',
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await appendMeshLog(id, '\n[runner] Interrupted by a server restart.\n').catch(() => undefined);
  }
  return ids.length;
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
