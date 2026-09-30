// Generic CFD-loop stages shared by the in-process job runners (WS-I free
// surface, WS-H optimisation study): mesh new surfaces with a session's setup,
// send the session mesh into a project's case, solve the case, and wait for the
// meshing / solver runs to end. Each stage reuses the public service functions
// (same gates, same storage) and never shells out itself.
//
// The awaits rely on the completion hooks of the run and meshing services
// (awaitRunTerminal is resolved by runs.service.finalizeRun, awaitMeshingTerminal
// by meshing.service's run finalizer), with a row / status.json poll fallback.
import type { MeshFromMeshingResult, MeshingConfig } from '@dive/shared';
import { AppError } from './AppError';
import { copySessionSetup, readConfig, readMeta, readRun, writeStl } from './meshingStorage';
import {
  awaitMeshingTerminal as awaitMeshingRunTerminal,
  startMeshingRun,
} from '../modules/meshing/meshing.service';
import {
  awaitRunTerminal as awaitSolverRunTerminal,
  startRun,
  type PublicRun,
} from '../modules/projects/runs.service';
import { importMeshFromMeshing } from '../modules/projects/mesh.service';
import type { Viewer } from '../modules/projects/projects.service';

/** Resolve with the solver run once it is terminal (see runs.service.awaitRunTerminal). */
export function awaitRunTerminal(runId: string, pollMs?: number): Promise<PublicRun> {
  return awaitSolverRunTerminal(runId, pollMs);
}

/** Resolve with the session's final run status, or `idle` (see meshing.service). */
export function awaitMeshingTerminal(
  sessionId: string,
  pollMs?: number,
): ReturnType<typeof awaitMeshingRunTerminal> {
  return awaitMeshingRunTerminal(sessionId, pollMs);
}

/** One surface file to write into a session (overwrites a same-name file). */
export interface SessionSurface {
  name: string;
  data: Buffer;
}

/** The meshing config a session last ran with (run.json), else its autosaved config. */
export async function sessionMeshingConfig(sessionId: string): Promise<MeshingConfig | null> {
  return (await readRun(sessionId))?.config ?? (await readConfig(sessionId));
}

/**
 * Create a NEW session as a copy of `sourceSessionId`'s setup (engine, config,
 * surfaces), overwrite its surfaces with `surfaces` (by file name), and START its
 * mesher with the source's config. Returns as soon as the run is started; await
 * it with awaitMeshingTerminal(sessionId).
 * @throws 404 NOT_FOUND unknown source; 409 MESHING_NOT_MESHED when the source
 *         has no config to reuse; the startMeshingRun errors (400 / 409).
 */
export async function meshSessionWithSurfaces(
  sourceSessionId: string,
  name: string,
  surfaces: SessionSurface[],
): Promise<{ sessionId: string; name: string }> {
  const source = await readMeta(sourceSessionId);
  if (!source) throw new AppError(404, 'NOT_FOUND', 'Meshing session not found.');
  const config = await sessionMeshingConfig(sourceSessionId);
  if (!config) {
    throw new AppError(
      409,
      'MESHING_NOT_MESHED',
      `The session "${source.name}" has no meshing settings to reuse. Mesh it once first.`,
    );
  }
  const meta = await copySessionSetup(sourceSessionId, name);
  for (const surface of surfaces) {
    await writeStl(meta.id, surface.name, surface.data);
  }
  await startMeshingRun(meta.id, config);
  return { sessionId: meta.id, name: meta.name };
}

/**
 * Send a (meshed, idle) session's polyMesh into the project's case: the WS-F
 * hand-off, case target (original backed up once, chamber patch types forced,
 * BCs of same-name patches kept, mesh origin recorded).
 */
export function sendSessionToCase(
  viewer: Viewer,
  projectId: string,
  sessionId: string,
): Promise<MeshFromMeshingResult> {
  return importMeshFromMeshing(viewer, projectId, { sessionId, target: 'case' });
}

/**
 * Start a solver run on the project's case with `cores` and wait for it to end.
 * `onStarted` receives the run id as soon as the row exists (so a caller can
 * stop it). Resolves with the terminal run; the start errors are thrown.
 */
export async function solveCase(
  viewer: Viewer,
  projectId: string,
  cores: number,
  onStarted?: (runId: string) => void | Promise<void>,
): Promise<PublicRun> {
  const run = await startRun(viewer, projectId, { cores });
  await onStarted?.(run.id);
  return awaitSolverRunTerminal(run.id);
}
