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
import { promises as fs } from 'node:fs';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import { runCommand } from '../../lib/commandRunner';
import { runStream, type StreamExit, type StreamHandle } from '../../lib/streamRunner';
import {
  caseDirAbsolute,
  deleteCaseDir,
  readCaseFile,
  writeCaseFile,
} from '../../lib/caseStorage';
import { renderDecomposeParDict } from '../../lib/openfoamCase';
import { coreBudget } from '../../lib/cores';
import { appendRunLog, ensureRunDir, readRunLog, runLogAbsolute } from '../../lib/runStorage';
import { downsampleResiduals, parseResiduals } from '../../lib/residualParser';
import { computeRunnable } from './files.service';
import { assertProjectVisible, type Viewer } from './projects.service';
import type { StartRunInput } from './runs.schemas';

/** Public shape of a run (no internal logPath / pid leak beyond what UI needs). */
export interface PublicRun {
  id: string;
  solver: string;
  /** Cores (parallel subdomains) the run used; 1 = serial single-core. */
  cores: number;
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

/**
 * A tiny FIFO async lock. `runExclusive(key, fn)` runs `fn` only after every
 * prior call with the same key has settled, serialising a critical section
 * across concurrent requests in this (single) API process. Used to make the
 * start-run admission check atomic with the row create (H2).
 */
const locks = new Map<string, Promise<unknown>>();
function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  locks.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Keep the catch-up log tail bounded on the wire while preserving the useful end. */
const LOG_TAIL_CHARS = 20000;

/** Map a Run row to its public shape. */
function toPublicRun(run: Run): PublicRun {
  return {
    id: run.id,
    solver: run.solver,
    cores: run.cores,
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

/**
 * Undo a previous graceful stop before launching a new run. A stopped run leaves
 * `stopAt writeNow;` in the controlDict (see requestGracefulStop) and, combined
 * with `runTimeModifiable`, would make the next run write once and exit after a
 * single iteration. Restore `stopAt endTime;` so a fresh run runs to completion.
 * Best-effort and idempotent (a no-op unless stopAt is currently writeNow).
 */
async function clearGracefulStop(projectId: string): Promise<void> {
  const buffer = await readCaseFile(projectId, 'system/controlDict');
  if (!buffer) return;
  const content = buffer.toString('utf8');
  if (!/stopAt\s+writeNow\s*;/.test(content)) return;
  const next = content.replace(/stopAt\s+writeNow\s*;/, 'stopAt endTime;');
  if (next !== content) await writeCaseFile(projectId, 'system/controlDict', next);
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
  // Divergence: the residuals ended at nan/inf, or a floating-point exception fired —
  // the solution blew up. `parsed.fpe` is used rather than searching the raw log for
  // "floating point exception": OpenFOAM prints
  //   "trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE)."
  // at STARTUP of every run when FOAM_SIGFPE is set (the default), and matching that
  // banner classified every healthy run as diverged.
  if (parsed.diverged || parsed.fpe) {
    return { status: 'diverged', reason: 'Residuals diverged (the solution blew up).' };
  }
  // A FOAM fatal error (bad config, a missing patch or file, ...) is a failure,
  // not divergence.
  if (/FOAM FATAL/i.test(log)) {
    return { status: 'failed', reason: 'Solver stopped on a fatal error. See the log.' };
  }
  if (exit.exitCode === 0) {
    return parsed.converged
      ? { status: 'converged', reason: null }
      : { status: 'completed', reason: 'Reached endTime without meeting the convergence tolerance' };
  }
  return { status: 'failed', reason: `Solver exited with code ${exit.exitCode ?? 'null'}` };
}

/**
 * After a parallel run finishes, reassemble ALL decomposed time directories with
 * `reconstructPar`, then drop the processor* directories on success (kept on
 * failure for debugging). We reconstruct every written time, not just the latest,
 * because the processor* dirs are deleted right after — reconstructing only the
 * latest would throw away all the intermediate time steps the user wrote. Best-
 * effort: a reconstruct failure is logged, never thrown — the run's terminal
 * status already stands.
 */
async function reconstructParallel(projectId: string, cores: number): Promise<void> {
  const caseDir = caseDirAbsolute(projectId);
  try {
    const result = await runCommand({
      ...planOpenfoamCommand('reconstructPar', ['-case', caseDir], caseDir),
      timeoutMs: env.SOLVER_MAX_RUNTIME_MS,
    });
    if (commandFailed(result)) {
      logger.error(`reconstructPar failed for project ${projectId}; processor dirs kept.`);
      return;
    }
    for (let i = 0; i < cores; i += 1) {
      await deleteCaseDir(projectId, `processor${i}`).catch(() => undefined);
    }
  } catch (err) {
    logger.error('reconstructPar orchestration failed', err);
  }
}

/**
 * Drive a run to its terminal state once the process ends. Uses updateMany with
 * an active-status filter so a status already set elsewhere (e.g. boot
 * reconciliation, a direct stop) is never clobbered — first writer wins. For a
 * parallel run (cores > 1) the decomposed result is reassembled afterwards.
 */
async function finalizeRun(
  projectId: string,
  runId: string,
  exit: StreamExit,
  cores = 1,
): Promise<void> {
  handles.delete(runId);
  const wasStopped = stopRequested.delete(runId);

  let log = '';
  try {
    // Classification only needs the tail (residuals + last lines); cap the read
    // so finalizing a huge log never OOMs (same bound as the poll path, H3).
    log = (await readRunLog(projectId, runId, 0, env.SOLVER_LOG_MAX_BYTES)).content;
  } catch {
    /* log unreadable — classify on exit alone */
  }

  const { status, reason } = classifyExit(exit, wasStopped, log);

  // A parallel run's output is written per-processor; reassemble it BEFORE marking
  // the run terminal, so the reconstructed result is ready when the status flips
  // (skipped when the solver never spawned).
  if (cores > 1 && !exit.spawnError) {
    await reconstructParallel(projectId, cores);
  }

  await prisma.run.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { status, reason, exitCode: exit.exitCode, pid: null, finishedAt: new Date() },
  });
}

/** Mark a run failed with a reason — best-effort, and only while it is still active. */
async function failRun(runId: string, reason: string): Promise<void> {
  await prisma.run.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { status: 'failed', reason: reason.slice(0, 800), pid: null, finishedAt: new Date() },
  });
}

/**
 * Launch a PARALLEL run in the background: decompose the mesh (a blocking pre-step),
 * then spawn `mpirun -np N <solver> -parallel` and drive it to a terminal state.
 * Detached from the start request so a slow decomposePar never blocks the HTTP call —
 * the run stays 'queued' until MPI actually starts. Progress and tool output are
 * written to the run log so it never looks like "queued, nothing happening", and
 * ANY failure (decompose error, stop during decompose, or an unexpected throw) ends
 * the run as `failed` with a reason rather than leaving it stuck.
 */
async function launchParallelRun(
  projectId: string,
  runId: string,
  solver: SolverId,
  cores: number,
  caseDir: string,
  logAbs: string,
): Promise<void> {
  try {
    await appendRunLog(
      projectId,
      runId,
      `Decomposing the mesh into ${cores} subdomains (decomposePar)...\n`,
    );
    await writeCaseFile(
      projectId,
      'system/decomposeParDict',
      renderDecomposeParDict(cores, env.DECOMPOSE_METHOD),
    );

    const decompose = await runCommand({
      ...planOpenfoamCommand('decomposePar', ['-case', caseDir, '-force'], caseDir),
      timeoutMs: env.SOLVER_DECOMPOSE_TIMEOUT_MS,
    });
    // Mirror decomposePar's output into the run log so it is visible in the UI.
    await appendRunLog(projectId, runId, `${decompose.stdout}${decompose.stderr}\n`);
    if (commandFailed(decompose)) {
      const why = decompose.spawnError
        ? `decomposePar could not start (${decompose.spawnError})`
        : decompose.timedOut
          ? 'decomposePar timed out'
          : `decomposePar exited with code ${decompose.exitCode}`;
      const tail = (decompose.stderr || decompose.stdout || '').trim().split('\n').slice(-3).join(' ');
      logger.error(
        `Parallel run: ${why} (project ${projectId})\n${decompose.stderr || decompose.stdout}`,
      );
      await failRun(runId, tail ? `${why}. ${tail}` : `${why}. Check the mesh, or try fewer cores.`);
      return;
    }
    // Stop requested while decomposing: stopRun already marked the run stopped.
    if (stopRequested.has(runId)) {
      stopRequested.delete(runId);
      return;
    }

    // `mpirun <MPI_RUN_FLAGS> -np N <solver> -case <dir> -parallel`. The configured
    // flags (default --allow-run-as-root --use-hwthread-cpus --oversubscribe) make the
    // requested core count map to MPI slots, avoiding the common "not enough slots"
    // failure on a hyperthreaded host; adjust MPI_RUN_FLAGS for a non-OpenMPI launcher.
    const mpiFlags = env.MPI_RUN_FLAGS.split(/\s+/).filter(Boolean);
    const plan = planOpenfoamCommand(
      env.MPI_BIN,
      [...mpiFlags, '-np', String(cores), solver, '-case', caseDir, '-parallel'],
      caseDir,
    );
    const handle = runStream({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      logFile: logAbs,
      timeoutMs: env.SOLVER_MAX_RUNTIME_MS,
      // On timeout, SIGTERM the (mpi)run so it forwards to its ranks, then SIGKILL
      // after this grace if still alive — never orphan MPI ranks (M6).
      killGraceMs: env.RUN_STOP_GRACE_MS,
    });
    handles.set(runId, handle);
    await prisma.run.updateMany({
      where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: {
        status: 'running',
        command: plan.display,
        logPath: `${RUN_DIRNAME}/${runId}/solver.log`,
        pid: handle.pid,
        startedAt: new Date(),
      },
    });

    const exit = await handle.onExit;
    await finalizeRun(projectId, runId, exit, cores);
  } catch (err) {
    // Never leave the run stuck 'queued' on an unexpected error.
    logger.error(`Parallel run orchestration threw (project ${projectId})`, err);
    await failRun(
      runId,
      `Parallel run setup failed: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => undefined);
  }
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
  /**
   * INTERNAL (the sweep only, not exposed over HTTP): run the solver in this case
   * directory instead of the project's. The per-project one-active-run guard exists
   * to protect the SHARED project case dir; a caller providing its own isolated dir
   * (a per-sample clone) manages its own exclusivity, so that guard is skipped -
   * the GLOBAL core budget still applies. Serial (1-core) runs only: the parallel
   * launch path writes decomposeParDict through the project-file API.
   */
  internal?: { caseDir: string },
): Promise<PublicRun> {
  await assertProjectVisible(viewer, projectId);

  if (internal && (input.cores ?? 1) > 1) {
    throw new AppError(422, 'TOO_MANY_CORES', 'A clone-directory run must be serial (1 core).');
  }

  // One active run per project (the case directory must not be shared).
  if (!internal) {
    const active = await prisma.run.count({
      where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    if (active >= env.SOLVER_MAX_CONCURRENT_RUNS) {
      throw new AppError(409, 'RUN_IN_PROGRESS', 'A run is already active for this project.');
    }
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

  // The case's controlDict decides the solver (its system/ + 0/ files are
  // scaffolded for it). If the caller ALSO passed a different solver, don't silently
  // ignore it — reject so the mismatch is explicit, since running another solver on
  // these files would fail (L6). A matching or absent override runs normally.
  if (input.solver && runnable.solver && input.solver !== runnable.solver) {
    throw new AppError(
      409,
      'SOLVER_MISMATCH',
      `This case is configured to run ${runnable.solver}. Change the solver in the Solver tab before running ${input.solver}.`,
    );
  }
  const solver = resolveSolver(runnable.solver, input.solver);
  // A prior stop persisted `stopAt writeNow;` in the controlDict; undo it (and
  // ensure runTimeModifiable) so this run runs to completion instead of writing
  // once and exiting after a single iteration. These write through the PROJECT
  // file API, so a clone-directory caller sanitises its own controlDict instead.
  if (!internal) {
    await clearGracefulStop(projectId);
    await ensureRunTimeModifiable(projectId);
  }

  // Resolve the requested cores and enforce the GLOBAL core budget: the sum of all
  // active runs' cores (across every project) plus this request must fit, so two
  // projects cannot oversubscribe the machine.
  const cores = input.cores ?? 1;
  const budget = coreBudget();
  if (cores > budget) {
    throw new AppError(
      422,
      'TOO_MANY_CORES',
      `This machine has ${budget} core(s); a run cannot use ${cores}.`,
    );
  }

  // Admission (active-run guard + global core budget) and the row create must be
  // ATOMIC. Counting then creating with a gap between them lets a double-click or
  // two tabs both pass the checks and spawn two solvers into the SAME case
  // directory (corrupt case), or two projects oversubscribe the machine (H2).
  // Serialise in-process — the whole run subsystem is already process-local.
  const created = await runExclusive('startRun', async () => {
    if (!internal) {
      const activeNow = await prisma.run.count({
        where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      });
      if (activeNow >= env.SOLVER_MAX_CONCURRENT_RUNS) {
        throw new AppError(409, 'RUN_IN_PROGRESS', 'A run is already active for this project.');
      }
    }
    const used =
      (
        await prisma.run.aggregate({
          where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
          _sum: { cores: true },
        })
      )._sum.cores ?? 0;
    if (used + cores > budget) {
      throw new AppError(
        409,
        'NOT_ENOUGH_CORES',
        `Not enough free cores: ${used} in use, ${cores} requested, ${budget} total. ` +
          'Wait for a run to finish, or use fewer cores.',
      );
    }
    // Create inside the lock so the next contender counts this run as active.
    return prisma.run.create({
      data: { projectId, solver, cores, status: 'queued', command: '', logPath: '' },
    });
  });

  const caseDir = internal?.caseDir ?? caseDirAbsolute(projectId);
  const logAbs = runLogAbsolute(projectId, created.id);
  await ensureRunDir(projectId, created.id);

  // Parallel run: decomposePar can be slow on a big mesh, so decompose + MPI launch
  // happen in the BACKGROUND. The request returns immediately with a 'queued' run the
  // client polls, instead of blocking the HTTP call until the solver spawns.
  if (cores > 1) {
    void launchParallelRun(projectId, created.id, solver, cores, caseDir, logAbs).catch((err) =>
      logger.error('Parallel run launch failed', err),
    );
    return toPublicRun(created);
  }

  // Serial: spawn `<solver> -case <dir>` now and return 'running'. argv-safe; sources
  // OPENFOAM_BASHRC when configured (same helper the conversion/autoPatch pipeline uses).
  const plan = planOpenfoamCommand(solver, ['-case', caseDir], caseDir);
  const handle = runStream({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    logFile: logAbs,
    timeoutMs: env.SOLVER_MAX_RUNTIME_MS,
    // On timeout, SIGTERM the (mpi)run so it forwards to its ranks, then SIGKILL
    // after this grace if still alive — never orphan MPI ranks (M6).
    killGraceMs: env.RUN_STOP_GRACE_MS,
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
    .then((exit) => finalizeRun(projectId, created.id, exit, cores))
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

  // Bound memory on this per-poll hot path: read at most the last
  // SOLVER_LOG_MAX_BYTES of the log, never the whole (possibly huge) file (H3).
  const { content, size } = await readRunLog(projectId, runId, 0, env.SOLVER_LOG_MAX_BYTES);
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
 * Force-terminate every live solver for a project (best-effort). Used when the
 * project — or its owner's account — is being deleted, so a ghost mpirun does
 * not keep burning cores after the run rows (and case storage) are gone. Unlike
 * stopRun this does no visibility check and does not wait: it SIGTERMs each
 * registered handle (mpirun forwards SIGTERM to its ranks) and marks the still-
 * running rows stopped. The caller's cascade delete removes the rows afterwards.
 */
export async function stopProjectRuns(projectId: string): Promise<void> {
  const active = await prisma.run.findMany({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  for (const { id } of active) {
    stopRequested.add(id);
    const handle = handles.get(id);
    if (handle) {
      try {
        handle.stop('SIGTERM');
      } catch {
        /* already exited */
      }
    }
  }
  if (active.length > 0) {
    await prisma.run
      .updateMany({
        where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: { status: 'stopped', reason: 'Project or account deleted', finishedAt: new Date(), pid: null },
      })
      .catch(() => undefined);
  }
}

/**
 * Kill a leftover solver by pid, but ONLY when /proc confirms it is still OUR run
 * — its argv references this run's case directory. On Linux a child of the old
 * API process is reparented to init and keeps running after a restart; the
 * recorded pid may since have been reused by an unrelated process, so we verify
 * before killing (H1). Linux-only (no /proc elsewhere): a no-op when it cannot
 * verify. SIGTERM, then SIGKILL after the stop grace.
 */
async function killOrphanIfOurs(pid: number, caseDir: string): Promise<void> {
  let cmdline: string;
  try {
    cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return; // no /proc, or the process is already gone — cannot verify, don't kill
  }
  // argv is NUL-separated; a solver/mpirun for this run carries `-case <caseDir>`.
  if (!cmdline.replace(/\0/g, ' ').includes(caseDir)) return; // not ours (or pid reused)
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already exited
  }
  await new Promise((resolve) => setTimeout(resolve, env.RUN_STOP_GRACE_MS));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/**
 * On API boot, reconcile runs left active by the previous process: KILL any
 * still-running child first (verified by pid via /proc so pid reuse is safe),
 * then mark the rows failed. Without the kill, a reparented mpirun keeps burning
 * cores unkillable from the UI while the user could launch a SECOND solver into
 * the same case (H1). The persisted log is preserved. Returns the count fixed.
 */
export async function reconcileOrphanRuns(): Promise<number> {
  const orphans = await prisma.run.findMany({
    where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { pid: true, projectId: true },
  });
  await Promise.all(
    orphans.map((r) =>
      r.pid != null
        ? killOrphanIfOurs(r.pid, caseDirAbsolute(r.projectId)).catch(() => undefined)
        : undefined,
    ),
  );

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
