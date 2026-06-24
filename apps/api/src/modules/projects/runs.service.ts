// Solver-run business logic: the app's first long-running background job.
//
// A run spawns an OpenFOAM solver (e.g. simpleFoam) in the project's case
// directory via the injectable streaming runner (streamRunner), which pipes the
// solver's output to a persisted solver.log and resolves a promise when the
// process ends. The run row is created `queued`, flipped to `running`, and then
// driven to a terminal state (converged / completed / diverged / failed /
// stopped) by classifying the exit code together with the parsed log tail.
//
// Live updates are delivered by the web client POLLING the catch-up log endpoint
// (getRunLog) while the run is active — simple, reload-proof, and reusing the
// normal authenticated fetch. A push stream (SSE/NDJSON) is a deferred
// optimization.
//
// Access model: gated by project visibility (assertProjectVisible), same as case
// files; any member may start/stop a run. A tool failure never throws (the run
// resolves `failed`); only validation/authorization errors throw (404/409/422).
import {
  ACTIVE_RUN_STATUSES,
  RUN_DIRNAME,
  SOLVER_IDS,
  isTerminalRunStatus,
  type ResidualSample,
  type RunStatus,
  type SolverId,
} from '@dive/shared';
import type { Run } from '@prisma/client';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { planOpenfoamCommand } from '../../lib/openfoamCommand';
import { runStream, type StreamExit, type StreamHandle } from '../../lib/streamRunner';
import {
  caseDirAbsolute,
  readCaseFile,
  writeCaseFile,
} from '../../lib/caseStorage';
import { ensureRunDir, readRunLog, runLogAbsolute } from '../../lib/runStorage';
import { downsampleResiduals, parseResiduals } from '../../lib/residualParser';
import { computeRunnable } from './files.service';
import { assertProjectVisible, type Viewer } from './projects.service';
import type { StartRunInput } from './runs.schemas';

/** Public shape of a run (no internal logPath / pid leak beyond what UI needs). */
export interface PublicRun {
  id: string;
  solver: string;
  status: RunStatus;
  exitCode: number | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Catch-up payload for the run log: the run, its residual series, and a log tail. */
export interface RunLogPayload {
  run: PublicRun;
  series: ResidualSample[];
  logTail: string;
  logBytes: number;
}

/**
 * Live process handles, keyed by run id. Only meaningful within this API process
 * (the DB row is the source of truth across restarts); used for stop() and to
 * know whether a run is still locally executing.
 */
const handles = new Map<string, StreamHandle>();
/** Run ids for which the user requested a stop (so we classify exit as `stopped`). */
const stopRequested = new Set<string>();

/** Keep the catch-up log tail bounded on the wire while preserving the useful end. */
const LOG_TAIL_CHARS = 20000;

/** Map a Run row to its public shape. */
function toPublicRun(run: Run): PublicRun {
  return {
    id: run.id,
    solver: run.solver,
    status: run.status as RunStatus,
    exitCode: run.exitCode,
    reason: run.reason,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
  };
}

/** Pick the solver to run: the case's controlDict wins, else input, else env. */
function resolveSolver(fromControlDict: string | null, fromInput?: SolverId): SolverId {
  const candidate = fromControlDict ?? fromInput ?? env.SOLVER_BIN;
  if ((SOLVER_IDS as readonly string[]).includes(candidate)) {
    return candidate as SolverId;
  }
  throw new AppError(
    422,
    'NOT_RUNNABLE',
    `Unsupported solver "${candidate}". This version runs: ${SOLVER_IDS.join(', ')}.`,
  );
}

/**
 * Ensure `runTimeModifiable yes;` in controlDict so a graceful stop (writing
 * `stopAt writeNow;`) takes effect mid-run. Best-effort and idempotent.
 */
async function ensureRunTimeModifiable(projectId: string): Promise<void> {
  const buffer = await readCaseFile(projectId, 'system/controlDict');
  if (!buffer) return;
  const content = buffer.toString('utf8');
  if (/runTimeModifiable\s+(yes|true)\s*;/.test(content)) return;

  let next: string;
  if (/runTimeModifiable\s+\w+\s*;/.test(content)) {
    next = content.replace(/runTimeModifiable\s+\w+\s*;/, 'runTimeModifiable true;');
  } else {
    next = `${content}\nrunTimeModifiable true;\n`;
  }
  await writeCaseFile(projectId, 'system/controlDict', next);
}

/** Request a graceful OpenFOAM stop: write `stopAt writeNow;` into controlDict. */
async function requestGracefulStop(projectId: string): Promise<void> {
  const buffer = await readCaseFile(projectId, 'system/controlDict');
  if (!buffer) return;
  const content = buffer.toString('utf8');
  const next = /stopAt\s+\w+\s*;/.test(content)
    ? content.replace(/stopAt\s+\w+\s*;/, 'stopAt writeNow;')
    : `${content}\nstopAt writeNow;\n`;
  if (next !== content) await writeCaseFile(projectId, 'system/controlDict', next);
}

/** Classify a finished process into a terminal status from its exit + log tail. */
function classifyExit(
  exit: StreamExit,
  wasStopped: boolean,
  log: string,
): { status: RunStatus; reason: string | null } {
  const parsed = parseResiduals(log);
  if (exit.spawnError) {
    return {
      status: 'failed',
      reason:
        'Solver binary not found. Check the OpenFOAM environment on the server ' +
        `(OPENFOAM_BASHRC), and that the solver in controlDict is installed. ${exit.spawnError}`,
    };
  }
  if (wasStopped) {
    return { status: 'stopped', reason: 'Stopped by user' };
  }
  if (exit.timedOut) {
    return { status: 'failed', reason: 'Run exceeded the maximum runtime' };
  }
  if (parsed.foamError) {
    return { status: 'diverged', reason: 'Solver error (see log)' };
  }
  if (parsed.diverged) {
    return { status: 'diverged', reason: 'Residuals diverged (nan/inf)' };
  }
  if (exit.exitCode === 0) {
    return parsed.converged
      ? { status: 'converged', reason: null }
      : { status: 'completed', reason: 'Reached endTime without meeting the convergence tolerance' };
  }
  return { status: 'failed', reason: `Solver exited with code ${exit.exitCode ?? 'null'}` };
}

/**
 * Drive a run to its terminal state once the process ends. Uses updateMany with
 * an active-status filter so a status already set elsewhere (e.g. boot
 * reconciliation, a direct stop) is never clobbered — first writer wins.
 */
async function finalizeRun(projectId: string, runId: string, exit: StreamExit): Promise<void> {
  handles.delete(runId);
  const wasStopped = stopRequested.delete(runId);

  let log = '';
  try {
    log = (await readRunLog(projectId, runId)).content;
  } catch {
    /* log unreadable — classify on exit alone */
  }

  const { status, reason } = classifyExit(exit, wasStopped, log);
  await prisma.run.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { status, reason, exitCode: exit.exitCode, pid: null, finishedAt: new Date() },
  });
}

/**
 * Start a solver run for a project's case.
 * @throws 409 RUN_IN_PROGRESS if a run is already active, 409 NO_MESH if there is
 *         no mesh, 422 NOT_RUNNABLE if solver files are missing / unsupported,
 *         404 NOT_FOUND if the project is not visible.
 */
export async function startRun(
  viewer: Viewer,
  projectId: string,
  input: StartRunInput,
): Promise<PublicRun> {
  await assertProjectVisible(viewer, projectId);

  // One active run per project (the case directory must not be shared).
  const active = await prisma.run.count({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  if (active >= env.SOLVER_MAX_CONCURRENT_RUNS) {
    throw new AppError(409, 'RUN_IN_PROGRESS', 'A run is already active for this project.');
  }

  // The case must be runnable (mesh + solver files present).
  const runnable = await computeRunnable(projectId);
  if (!runnable.hasMesh) {
    throw new AppError(409, 'NO_MESH', 'Import a mesh before running a solver.');
  }
  if (!runnable.runnable) {
    throw new AppError(
      422,
      'NOT_RUNNABLE',
      'The case is missing solver files. Generate them first (Make runnable).',
    );
  }

  const solver = resolveSolver(runnable.solver, input.solver);
  await ensureRunTimeModifiable(projectId);

  // Create the row first so we have an id to derive the log path from.
  const created = await prisma.run.create({
    data: { projectId, solver, status: 'queued', command: '', logPath: '' },
  });

  const caseDir = caseDirAbsolute(projectId);
  const logAbs = runLogAbsolute(projectId, created.id);
  await ensureRunDir(projectId, created.id);

  // argv-safe invocation; sources OPENFOAM_BASHRC when configured (same helper
  // the conversion/autoPatch pipeline uses).
  const plan = planOpenfoamCommand(solver, ['-case', caseDir], caseDir);
  const handle = runStream({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    logFile: logAbs,
    timeoutMs: env.SOLVER_MAX_RUNTIME_MS,
  });
  handles.set(created.id, handle);

  const run = await prisma.run.update({
    where: { id: created.id },
    data: {
      status: 'running',
      command: plan.display,
      logPath: `${RUN_DIRNAME}/${created.id}/solver.log`,
      pid: handle.pid,
      startedAt: new Date(),
    },
  });

  // Reconcile to a terminal state when the process ends (fire and forget).
  void handle.onExit
    .then((exit) => finalizeRun(projectId, created.id, exit))
    .catch((err) => logger.error('Run finalization failed', err));

  return toPublicRun(run);
}

/** List a project's runs, newest first. */
export async function listRuns(viewer: Viewer, projectId: string): Promise<PublicRun[]> {
  await assertProjectVisible(viewer, projectId);
  const runs = await prisma.run.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  return runs.map(toPublicRun);
}

/** Fetch a single run. @throws 404 RUN_NOT_FOUND. */
export async function getRun(
  viewer: Viewer,
  projectId: string,
  runId: string,
): Promise<PublicRun> {
  await assertProjectVisible(viewer, projectId);
  const run = await prisma.run.findFirst({ where: { id: runId, projectId } });
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Run not found');
  return toPublicRun(run);
}

/**
 * Catch-up log payload (polled by the client while a run is active): the run,
 * its downsampled residual series, a bounded log tail, and the total log size.
 * @throws 404 RUN_NOT_FOUND.
 */
export async function getRunLog(
  viewer: Viewer,
  projectId: string,
  runId: string,
): Promise<RunLogPayload> {
  await assertProjectVisible(viewer, projectId);
  const run = await prisma.run.findFirst({ where: { id: runId, projectId } });
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Run not found');

  const { content, size } = await readRunLog(projectId, runId);
  const parsed = parseResiduals(content);
  const series = downsampleResiduals(parsed.samples);
  const logTail =
    content.length > LOG_TAIL_CHARS ? content.slice(content.length - LOG_TAIL_CHARS) : content;

  return { run: toPublicRun(run), series, logTail, logBytes: size };
}

/**
 * Stop a run. Graceful first (write `stopAt writeNow;` so the solver writes its
 * latest state and exits), with a SIGTERM fallback after the grace period.
 * Idempotent: stopping a terminal run is a no-op. @throws 404 RUN_NOT_FOUND.
 */
export async function stopRun(
  viewer: Viewer,
  projectId: string,
  runId: string,
): Promise<PublicRun> {
  await assertProjectVisible(viewer, projectId);
  const run = await prisma.run.findFirst({ where: { id: runId, projectId } });
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Run not found');
  if (isTerminalRunStatus(run.status as RunStatus)) return toPublicRun(run);

  stopRequested.add(runId);
  await requestGracefulStop(projectId).catch(() => undefined);

  const handle = handles.get(runId);
  if (handle) {
    // Escalate to SIGTERM if the graceful stop has not taken effect in time.
    const timer = setTimeout(() => {
      if (handles.has(runId)) handle.stop('SIGTERM');
    }, env.RUN_STOP_GRACE_MS);
    timer.unref();
  } else {
    // No live handle (e.g. a row left running after a restart): mark stopped.
    await prisma.run.updateMany({
      where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: { status: 'stopped', reason: 'Stopped by user', finishedAt: new Date(), pid: null },
    });
  }

  const updated = await prisma.run.findFirst({ where: { id: runId, projectId } });
  return toPublicRun(updated ?? run);
}

/**
 * On API boot, mark any run still in an active state as failed: the child was
 * tied to the previous process and died with it (we do not re-adopt by pid —
 * pid reuse is unsafe). The persisted log is preserved. Returns the count fixed.
 */
export async function reconcileOrphanRuns(): Promise<number> {
  const result = await prisma.run.updateMany({
    where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: {
      status: 'failed',
      reason: 'Interrupted by a server restart',
      finishedAt: new Date(),
      pid: null,
    },
  });
  return result.count;
}
