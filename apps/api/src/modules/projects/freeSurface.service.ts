// Free surface (lid iteration) tool, WS-I spec 2026-09-30-free-surface-tool-design.
//
// From a project whose case has a converged rigid-lid run, compute the free
// surface z_s = Z_lid + (p_lid − p0_inlet)/g and iterate the lid shape by
// REMESHING: export the lid (postProcess -func lidSurfaces) → surface
// (lidkit_surface.py) → fit the flat base STL to z_s (lidkit_fitlid.py) → mesh a
// copy of the source meshing session with the fitted surfaces → send it to the
// case (WS-F) → solve → export + surface again, until the lid residual RMS is
// below the tolerance or the iterations are done. The kit's maths live in the
// vendored scripts (scripts/lidkit/); its shell driver is re-implemented here as
// an in-process job (argv only, no shell, no setsid).
//
// One job per project at a time; the project is locked meanwhile (409
// FREE_SURFACE_IN_PROGRESS on manual runs and case / mesh mutations, see
// freeSurfaceLock); the job's own calls go straight to the services. State is
// persisted as job.json before each stage; a job left running by a dead process
// is reconciled to `interrupted` on boot.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  FREE_SURFACE_DEFAULTS,
  type FreeSurfaceCheck,
  type FreeSurfaceChecks,
  type FreeSurfaceFitStats,
  type FreeSurfaceIteration,
  type FreeSurfaceJob,
  type FreeSurfaceOverview,
  type FreeSurfacePatchLevel,
  type FreeSurfaceSettings,
  type FreeSurfaceStage,
  type FreeSurfaceSurfaceStats,
  type RunStatus,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import { caseDirAbsolute, deleteCaseDir, readCaseFile, writeCaseFile } from '../../lib/caseStorage';
import { getFieldPatchType, parseApplication } from '../../lib/openfoamCase';
import { readPatchLevels, type PatchLevel } from '../../lib/polyMeshLevels';
import { readMeshOrigin } from '../../lib/meshOriginStorage';
import {
  hasCompleteResultMesh,
  listSessions,
  readMeshLog,
  readMeta,
} from '../../lib/meshingStorage';
import {
  buildBaseStl,
  lidkitPython,
  lidkitScript,
  listTimeDirs,
  parseMeshCells,
  readDp0,
  readSessionSolids,
  renderLidSurfacesDict,
  solidZStats,
  splitFittedStl,
  type LidkitScript,
  type SurfaceFile,
} from '../../lib/lidkit';
import {
  deleteJobDir,
  jobDirAbsolute,
  jobFileAbsolute,
  listJobs,
  listProjectsWithJobs,
  newJobId,
  readJob,
  writeJob,
} from '../../lib/freeSurfaceStorage';
import {
  awaitMeshingTerminal,
  clearCaseSolution,
  meshSessionWithSurfaces,
  sendSessionToCase,
  sessionMeshingConfig,
  solveCase,
} from '../../lib/pipelineStages';
import { isSessionRunning, stopMeshingRun } from '../meshing/meshing.service';
import { stopRun } from './runs.service';
import { isStudyActiveForProject, studyInProgressError } from '../studies/studyRegistry';
import { assertProjectVisible, type Viewer } from './projects.service';
import type { FreeSurfaceSelectionQuery, FreeSurfaceStartInput } from './freeSurface.schemas';

/** Steady incompressible solvers (the kit's p is kinematic). */
const STEADY_INCOMPRESSIBLE = new Set(['simpleFoam', 'SRFSimpleFoam', 'porousSimpleFoam']);
/** Lid U types the kit assumes (a slip rigid lid). */
const SLIP_TYPES = new Set(['slip', 'symmetry', 'symmetryPlane']);
/** Flatness half-width of the lid (m): face centres within ±1 mm of one z. */
const FLAT_TOL_M = 0.001;

const NO_FLAT_PATCH =
  'This mesh has no flat top patch. The free surface needs a rigid-lid run whose top is its own patch (e.g. `atmosphere`); meshes whose top is part of `walls` cannot use this tool.';
const PICK_SESSION = 'Pick the meshing session that produced this mesh.';
const RUN_FIRST = 'Run the solver to convergence first.';

// ---------------------------------------------------------------------------
// In-process registry (one job per project; lost on restart => reconciliation)
// ---------------------------------------------------------------------------

interface ActiveJob {
  job: FreeSurfaceJob;
  viewer: Viewer;
  /** The meshing session / solver run of the current stage (for Stop). */
  sessionId: string | null;
  runId: string | null;
}

const activeJobs = new Map<string, ActiveJob>();

/** Is a free-surface job running for this project (the project lock)? */
export function isFreeSurfaceActive(projectId: string): boolean {
  return activeJobs.has(projectId);
}

/** Thrown inside the runner when the user asked to stop. */
class StopSignal extends Error {}

/** A stage failure with a user-facing reason. */
class StageError extends Error {}

// ---------------------------------------------------------------------------
// Readiness (spec §2)
// ---------------------------------------------------------------------------

/** Everything the checks resolved, reused by start(). */
interface ReadinessContext {
  checks: FreeSurfaceChecks;
  surfaceFiles: SurfaceFile[];
  sessionName: string | null;
}

/** Per-patch flatness of the case mesh, cached on the mesh files' mtimes. */
async function casePatchLevels(projectId: string): Promise<PatchLevel[] | null> {
  const polyMesh = path.join(caseDirAbsolute(projectId), 'constant', 'polyMesh');
  const stats = await Promise.all(
    ['points', 'faces', 'boundary'].map((f) => fs.stat(path.join(polyMesh, f)).catch(() => null)),
  );
  const key = stats.map((s) => (s ? `${s.size}:${s.mtimeMs}` : '-')).join('|');
  const cacheFile = path.join(
    path.dirname(jobDirAbsolute(projectId, 'cache')),
    'patch-levels.json',
  );
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as {
      key: string;
      levels: PatchLevel[] | null;
    };
    if (cached.key === key) return cached.levels;
  } catch {
    /* no cache */
  }
  const levels = await readPatchLevels(polyMesh, FLAT_TOL_M);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => undefined);
  await fs.writeFile(cacheFile, JSON.stringify({ key, levels }), 'utf8').catch(() => undefined);
  return levels;
}

/** Latest run of the project (the parent run). */
function latestRun(projectId: string) {
  return prisma.run.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
}

/** Compute the §2 checks for a selection (query or start body), with defaults. */
async function computeReadiness(
  projectId: string,
  selection: FreeSurfaceSelectionQuery,
): Promise<ReadinessContext> {
  const items: FreeSurfaceCheck[] = [];
  const levels = await casePatchLevels(projectId);
  const patches: FreeSurfacePatchLevel[] = (levels ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    nFaces: p.nFaces,
    flat: p.flat,
    z: p.z,
  }));
  const flat = patches.filter((p) => p.flat && p.nFaces > 0);

  // --- Lid patch
  let lidPatch: string | null = null;
  if (levels === null) {
    items.push({
      id: 'lidPatch',
      status: 'blocking',
      message:
        'The case mesh could not be read (binary or compressed polyMesh): its flat top patch cannot be found.',
    });
  } else if (flat.length === 0) {
    items.push({ id: 'lidPatch', status: 'blocking', message: NO_FLAT_PATCH });
  } else {
    const wanted = selection.lidPatch;
    if (wanted && !flat.some((p) => p.name === wanted)) {
      items.push({
        id: 'lidPatch',
        status: 'blocking',
        message: `The patch \`${wanted}\` is not a flat horizontal patch. Pick the lid among the flat top patches.`,
      });
    } else {
      lidPatch =
        wanted ??
        (flat.some((p) => p.name === 'atmosphere')
          ? 'atmosphere'
          : flat.length === 1
            ? flat[0].name
            : null);
      if (!lidPatch) {
        items.push({
          id: 'lidPatch',
          status: 'blocking',
          message: 'Pick the lid patch among the flat top patches.',
        });
      } else {
        const z = flat.find((p) => p.name === lidPatch)?.z ?? 0;
        items.push({
          id: 'lidPatch',
          status: 'ok',
          message: `Lid patch ${lidPatch} is flat at z = ${z.toFixed(3)} m.`,
        });
      }
    }
  }

  // --- Lid BC (warning only)
  if (lidPatch) {
    const u = await readCaseFile(projectId, '0/U');
    const type = u ? getFieldPatchType(u.toString('utf8'), lidPatch) : null;
    if (type && SLIP_TYPES.has(type)) {
      items.push({ id: 'lidBc', status: 'ok', message: `The lid is slip (U: ${type}).` });
    } else {
      items.push({
        id: 'lidBc',
        status: 'warning',
        message: `The lid is not slip (U: ${type ?? 'not set'}). The kit assumes a slip rigid lid.`,
      });
    }
  }

  // --- Inlet patch
  const inletName =
    selection.inletPatch ?? (patches.some((p) => p.name === 'inlet') ? 'inlet' : null);
  const inlet = patches.find((p) => p.name === inletName && p.type === 'patch');
  const inletPatch = inlet ? inlet.name : null;
  items.push(
    inletPatch
      ? { id: 'inletPatch', status: 'ok', message: `Inlet patch ${inletPatch}.` }
      : { id: 'inletPatch', status: 'blocking', message: 'Pick the inlet patch.' },
  );

  // --- Parent run
  const run = await latestRun(projectId);
  const active = await prisma.run.count({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  const times = (await listTimeDirs(caseDirAbsolute(projectId))).filter((t) => Number(t) > 0);
  if (active > 0) {
    items.push({
      id: 'parentRun',
      status: 'blocking',
      message: 'A solver run is active. Wait for it to finish.',
    });
  } else if (!run || !['converged', 'completed'].includes(run.status) || times.length === 0) {
    items.push({ id: 'parentRun', status: 'blocking', message: RUN_FIRST });
  } else {
    items.push({
      id: 'parentRun',
      status: 'ok',
      message: `Parent run ${run.status} (${run.cores} core(s)).`,
    });
  }

  // --- Source meshing session
  const origin = await readMeshOrigin(projectId);
  const sessionId = selection.sessionId ?? origin?.sessionId ?? null;
  let surfaceFiles: SurfaceFile[] = [];
  let zLid: number | null = null;
  let sessionName: string | null = null;
  const meta = sessionId ? await readMeta(sessionId).catch(() => null) : null;
  if (!meta) {
    items.push({ id: 'sourceSession', status: 'blocking', message: PICK_SESSION });
  } else {
    sessionName = meta.name;
    const blocking = (message: string) =>
      items.push({ id: 'sourceSession', status: 'blocking', message });
    if ((await isSessionRunning(meta.id)) || !(await hasCompleteResultMesh(meta.id))) {
      blocking(`The session "${meta.name}" has no finished mesh. ${PICK_SESSION}`);
    } else if (!(await sessionMeshingConfig(meta.id))) {
      blocking(`The session "${meta.name}" has no meshing settings to reuse.`);
    } else {
      surfaceFiles = await readSessionSolids(meta.id);
      const solids = new Map(
        surfaceFiles.flatMap((f) => f.solids.map((s) => [s.name, s] as const)),
      );
      const lidSolid = lidPatch ? solids.get(lidPatch) : undefined;
      const lidStats = lidSolid ? solidZStats(lidSolid.triangles) : null;
      if (surfaceFiles.length === 0) {
        blocking(`The session "${meta.name}" has no STL surface.`);
      } else if (lidPatch && !lidSolid) {
        blocking(`The session has no surface named \`${lidPatch}\`.`);
      } else if (inletPatch && !solids.has(inletPatch)) {
        blocking(`The session has no surface named \`${inletPatch}\`.`);
      } else if (lidStats && lidStats.max - lidStats.min > 2 * FLAT_TOL_M) {
        blocking(
          `The surface \`${lidPatch}\` of the session is not flat: the free surface needs the flat base geometry.`,
        );
      } else {
        zLid = lidStats ? lidStats.mean : null;
        items.push({
          id: 'sourceSession',
          status: 'ok',
          message: `Source session ${meta.name} (${meta.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'}).`,
        });
      }
    }
  }

  // --- Solver
  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  const solver = controlDict ? parseApplication(controlDict.toString('utf8')) : null;
  items.push(
    solver && STEADY_INCOMPRESSIBLE.has(solver)
      ? { id: 'solver', status: 'ok', message: `${solver} (steady, incompressible).` }
      : {
          id: 'solver',
          status: 'blocking',
          message: 'The free-surface tool needs a steady incompressible solver (simpleFoam).',
        },
  );

  const meshed: FreeSurfaceChecks['sessions'] = [];
  for (const session of await listSessions()) {
    if (await hasCompleteResultMesh(session.id)) {
      meshed.push({ id: session.id, name: session.name, engine: session.engine });
    }
  }

  return {
    checks: {
      items,
      ready: !items.some((c) => c.status === 'blocking'),
      patches,
      lidPatch,
      inletPatch,
      sourceSessionId: meta?.id ?? null,
      sessions: meshed,
      zLid,
      solver,
      parentRun: run ? { id: run.id, status: run.status as RunStatus, cores: run.cores } : null,
    },
    surfaceFiles,
    sessionName,
  };
}

/** The in-memory copy of an active job, else the persisted one. */
async function currentJob(projectId: string, jobId: string): Promise<FreeSurfaceJob | null> {
  const active = activeJobs.get(projectId);
  if (active && active.job.id === jobId) return active.job;
  return readJob(projectId, jobId);
}

/** GET /projects/:id/free-surface. @throws 404 when the project is not visible. */
export async function getFreeSurfaceOverview(
  viewer: Viewer,
  projectId: string,
  selection: FreeSurfaceSelectionQuery,
): Promise<FreeSurfaceOverview> {
  await assertProjectVisible(viewer, projectId);
  const { checks } = await computeReadiness(projectId, selection);
  const active = activeJobs.get(projectId);
  const jobs = (await listJobs(projectId)).map((j) =>
    active && active.job.id === j.id ? active.job : j,
  );
  return {
    checks,
    defaults: FREE_SURFACE_DEFAULTS,
    origin: await readMeshOrigin(projectId),
    jobs,
  };
}

/** GET /projects/:id/free-surface/:jobId. @throws 404 unknown job. */
export async function getFreeSurfaceJob(
  viewer: Viewer,
  projectId: string,
  jobId: string,
): Promise<FreeSurfaceJob> {
  await assertProjectVisible(viewer, projectId);
  const job = await currentJob(projectId, jobId);
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Free-surface job not found.');
  return job;
}

// ---------------------------------------------------------------------------
// Start / stop / delete / files
// ---------------------------------------------------------------------------

/**
 * POST /projects/:id/free-surface: check readiness, write base.stl, persist the
 * job and run it in the background. @throws 404, 409 FREE_SURFACE_IN_PROGRESS /
 * RUN_IN_PROGRESS, 422 FREE_SURFACE_NOT_READY (message = the failed check).
 */
export async function startFreeSurfaceJob(
  viewer: Viewer,
  projectId: string,
  input: FreeSurfaceStartInput,
): Promise<FreeSurfaceJob> {
  await assertProjectVisible(viewer, projectId);
  if (activeJobs.has(projectId)) {
    throw new AppError(
      409,
      'FREE_SURFACE_IN_PROGRESS',
      'A free-surface job is already running for this project.',
    );
  }
  // An optimisation study running on this project owns its case (WS-H §0 A7).
  if (isStudyActiveForProject(projectId)) throw studyInProgressError();
  const running = await prisma.run.count({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  if (running > 0) {
    throw new AppError(
      409,
      'RUN_IN_PROGRESS',
      'A solver run is active for this project. Wait for it to finish.',
    );
  }

  const now = new Date().toISOString();
  const jobId = newJobId();
  // Claim the project lock before any await on the readiness, so two starts race safely.
  const placeholder = {
    job: { id: jobId } as FreeSurfaceJob,
    viewer,
    sessionId: null,
    runId: null,
  };
  activeJobs.set(projectId, placeholder);
  try {
    const ctx = await computeReadiness(projectId, {
      lidPatch: input.lidPatch,
      inletPatch: input.inletPatch,
      sessionId: input.sourceSessionId,
    });
    const blocking = ctx.checks.items.find((c) => c.status === 'blocking');
    if (blocking) throw new AppError(422, 'FREE_SURFACE_NOT_READY', blocking.message);
    const { lidPatch, inletPatch, sourceSessionId, zLid, parentRun } = ctx.checks;
    if (!lidPatch || !inletPatch || !sourceSessionId || zLid === null) {
      throw new AppError(422, 'FREE_SURFACE_NOT_READY', PICK_SESSION);
    }

    const settings: FreeSurfaceSettings = {
      ...FREE_SURFACE_DEFAULTS,
      ...stripUndefined(input),
      lidPatch,
      inletPatch,
      sourceSessionId,
    };
    const job: FreeSurfaceJob = {
      id: jobId,
      status: 'running',
      stage: null,
      iteration: 0,
      settings,
      zLid,
      parentRunId: parentRun?.id ?? null,
      cores: parentRun?.cores ?? 1,
      surfaces: [],
      iterations: [],
      notes: [],
      reason: null,
      failedStage: null,
      stopRequested: false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    const dir = jobDirAbsolute(projectId, jobId);
    await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'base.stl'), buildBaseStl(ctx.surfaceFiles), 'utf8');
    await writeJob(projectId, job);

    const entry: ActiveJob = { job, viewer, sessionId: null, runId: null };
    activeJobs.set(projectId, entry);
    void runJob(projectId, entry, ctx.surfaceFiles, ctx.sessionName ?? sourceSessionId).catch(
      (err) => logger.error(`Free-surface job ${jobId} crashed`, err),
    );
    return job;
  } catch (err) {
    if (activeJobs.get(projectId) === placeholder) activeJobs.delete(projectId);
    throw err;
  }
}

/** Drop undefined keys so the defaults are kept. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * POST …/:jobId/stop: stop the current stage (the meshing run or the solver run;
 * a Python step finishes first), then the job ends `stopped`. Idempotent.
 */
export async function stopFreeSurfaceJob(
  viewer: Viewer,
  projectId: string,
  jobId: string,
): Promise<FreeSurfaceJob> {
  await assertProjectVisible(viewer, projectId);
  const job = await currentJob(projectId, jobId);
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Free-surface job not found.');
  if (job.status !== 'running') return job;
  const entry = activeJobs.get(projectId);
  if (!entry || entry.job.id !== jobId) {
    // No live runner (left running by a dead process): settle it now.
    const now = new Date().toISOString();
    const settled: FreeSurfaceJob = {
      ...job,
      status: 'stopped',
      reason: 'Stopped by user',
      updatedAt: now,
      finishedAt: now,
    };
    await writeJob(projectId, settled);
    return settled;
  }
  if (!entry.job.stopRequested) {
    entry.job.stopRequested = true;
    await save(projectId, entry.job);
    if (entry.sessionId) await stopMeshingRun(entry.sessionId).catch(() => undefined);
    if (entry.runId) await stopRun(entry.viewer, projectId, entry.runId).catch(() => undefined);
  }
  return entry.job;
}

/** DELETE …/:jobId (not while active: 409). */
export async function deleteFreeSurfaceJob(
  viewer: Viewer,
  projectId: string,
  jobId: string,
): Promise<void> {
  await assertProjectVisible(viewer, projectId);
  const job = await currentJob(projectId, jobId);
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Free-surface job not found.');
  const entry = activeJobs.get(projectId);
  if (entry && entry.job.id === jobId) {
    throw new AppError(
      409,
      'FREE_SURFACE_IN_PROGRESS',
      'Stop the free-surface job before deleting it.',
    );
  }
  await deleteJobDir(projectId, jobId);
}

/** GET …/:jobId/files/:name: an allow-listed file's bytes. @throws 404. */
export async function readFreeSurfaceFile(
  viewer: Viewer,
  projectId: string,
  jobId: string,
  name: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  await assertProjectVisible(viewer, projectId);
  if (!(await currentJob(projectId, jobId)))
    throw new AppError(404, 'NOT_FOUND', 'Free-surface job not found.');
  const abs = jobFileAbsolute(projectId, jobId, name);
  if (!abs) throw new AppError(404, 'NOT_FOUND', 'File not found.');
  try {
    const bytes = await fs.readFile(abs);
    return { bytes, contentType: name.endsWith('.png') ? 'image/png' : 'model/stl' };
  } catch {
    throw new AppError(404, 'NOT_FOUND', 'File not found.');
  }
}

/**
 * Boot reconciliation: a job left `running` by a previous process can never
 * finish; mark it `interrupted`. Returns the count.
 */
export async function reconcileOrphanFreeSurfaceJobs(): Promise<number> {
  let count = 0;
  for (const projectId of await listProjectsWithJobs()) {
    const active = activeJobs.get(projectId);
    for (const job of await listJobs(projectId)) {
      if (job.status !== 'running' || (active && active.job.id === job.id)) continue;
      const now = new Date().toISOString();
      await writeJob(projectId, {
        ...job,
        status: 'interrupted',
        reason: 'Interrupted by a server restart',
        updatedAt: now,
        finishedAt: now,
      }).catch(() => undefined);
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Persist the job (updatedAt refreshed). */
async function save(projectId: string, job: FreeSurfaceJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await writeJob(projectId, job);
}

/** The last lines of a tool output, for a failure reason. */
function outputTail(result: CommandResult, lines = 4): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return 'timed out';
  return (result.stderr || result.stdout || '')
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join(' ')
    .slice(0, 600);
}

/** Run one kit script with the kit interpreter; its output goes to logs/<log>. */
async function runKit(
  dir: string,
  script: LidkitScript,
  args: string[],
  log: string,
): Promise<CommandResult> {
  const result = await runCommand({
    command: lidkitPython(),
    args: [lidkitScript(script), ...args],
    cwd: dir,
    env: process.env,
    timeoutMs: env.LIDKIT_TIMEOUT_MS,
  });
  await fs
    .writeFile(path.join(dir, 'logs', log), `${result.stdout}\n${result.stderr}`, 'utf8')
    .catch(() => undefined);
  return result;
}

/** The kit's optional ring / datum arguments ('=' form: negative numbers). */
function statArgs(settings: FreeSurfaceSettings): string[] {
  const args: string[] = [];
  if (settings.axis) {
    args.push(`--axis=${settings.axis.join(',')}`);
    if (settings.rings.length)
      args.push(`--rings=${settings.rings.map(([a, b]) => `${a}:${b}`).join(',')}`);
  }
  if (settings.datumY !== null && settings.datumY !== undefined)
    args.push(`--datum-y=${settings.datumY}`);
  return args;
}

async function runJob(
  projectId: string,
  entry: ActiveJob,
  surfaceFiles: SurfaceFile[],
  sourceName: string,
): Promise<void> {
  const job = entry.job;
  const s = job.settings;
  const dir = jobDirAbsolute(projectId, job.id);
  const caseDir = caseDirAbsolute(projectId);
  const zArg = String(job.zLid);

  const checkStop = (): void => {
    if (job.stopRequested) throw new StopSignal();
  };
  const enter = async (stage: FreeSurfaceStage, iteration: number): Promise<void> => {
    checkStop();
    job.stage = stage;
    job.iteration = iteration;
    await save(projectId, job);
  };

  // Figures need matplotlib in the kit interpreter: probe once.
  const probe = await runCommand({
    command: lidkitPython(),
    args: ['-c', 'import matplotlib'],
    cwd: dir,
    env: process.env,
    timeoutMs: 60000,
  });
  const figures = !commandFailed(probe);
  if (!figures)
    job.notes.push(
      'Figures skipped: matplotlib is not installed for the kit interpreter (LIDKIT_PYTHON_BIN).',
    );

  /** exporting + surface of solution j (0 = the parent run). */
  const exportAndSurface = async (j: number): Promise<FreeSurfaceSurfaceStats> => {
    await enter('exporting', j);
    const times = (await listTimeDirs(caseDir)).filter((t) => Number(t) > 0);
    if (times.length === 0)
      throw new StageError('The case has no solution time directory to export.');
    await writeCaseFile(
      projectId,
      'system/lidSurfaces',
      await renderLidSurfacesDict(s.lidPatch, s.inletPatch),
    );
    await deleteCaseDir(projectId, 'postProcessing/lidSurfaces').catch(() => undefined);
    const plan = planOpenfoamCommand(
      'postProcess',
      ['-case', caseDir, '-func', 'lidSurfaces', '-latestTime'],
      caseDir,
    );
    const pp = await runCommand({ ...plan, timeoutMs: env.LIDKIT_TIMEOUT_MS });
    await fs
      .writeFile(path.join(dir, 'logs', `postProcess_iter${j}.log`), `${pp.stdout}\n${pp.stderr}`)
      .catch(() => undefined);
    if (commandFailed(pp))
      throw new StageError(
        `The lid export (postProcess -func lidSurfaces) failed: ${outputTail(pp)}`,
      );
    const exportRoot = path.join(caseDir, 'postProcessing', 'lidSurfaces');
    const exported = (await listTimeDirs(exportRoot)).reverse();
    let source: string | null = null;
    for (const t of exported) {
      const candidate = path.join(exportRoot, t);
      if ((await fs.stat(path.join(candidate, 'lid.vtk')).catch(() => null)) !== null) {
        source = candidate;
        break;
      }
    }
    if (!source)
      throw new StageError('The lid export produced no lid.vtk (see the postProcess log).');
    const exportDir = path.join(dir, `export_iter${j}`);
    await fs.mkdir(exportDir, { recursive: true });
    for (const f of ['lid.vtk', 'inlet.vtk']) {
      await fs.copyFile(path.join(source, f), path.join(exportDir, f)).catch(() => undefined);
    }

    await enter('surface', j);
    const npy = path.join(dir, `zs_iter${j}.npy`);
    const res = await runKit(
      dir,
      'lidkit_surface.py',
      [exportDir, npy, '--z-lid', zArg, ...statArgs(s)],
      `surface_iter${j}.log`,
    );
    if (commandFailed(res)) throw new StageError(`The surface estimate failed: ${outputTail(res)}`);
    let rep: {
      n_lid_faces: number;
      zs_vs_Z_LID_mm: { mean: number; min: number; max: number };
      lid_residual_mm: { rms: number; max_abs: number };
    };
    try {
      rep = JSON.parse(await fs.readFile(path.join(dir, `zs_iter${j}.json`), 'utf8'));
    } catch {
      throw new StageError('The surface estimate wrote no report.');
    }
    const stats: FreeSurfaceSurfaceStats = {
      index: j,
      zsMeanMm: rep.zs_vs_Z_LID_mm.mean,
      zsMinMm: rep.zs_vs_Z_LID_mm.min,
      zsMaxMm: rep.zs_vs_Z_LID_mm.max,
      residualRmsMm: rep.lid_residual_mm.rms,
      residualMaxMm: rep.lid_residual_mm.max_abs,
      lidFaces: rep.n_lid_faces,
      dp0Pa: await readDp0(caseDir),
    };
    job.surfaces.push(stats);

    // Post figure of solution j (optional, never fails the job).
    if (figures && j >= 1) {
      const png = path.join(dir, `lid_iter${j}.png`);
      const post = await runKit(
        dir,
        'lidkit_post.py',
        [
          path.join(exportDir, 'lid.vtk'),
          dir,
          String(j),
          png,
          '--z-lid',
          zArg,
          '--tol',
          String(s.tolRmsMm),
          '--name',
          sourceName,
          ...statArgs(s),
        ],
        `post_iter${j}.log`,
      );
      const iteration = job.iterations.find((it) => it.index === j);
      if (!commandFailed(post) && iteration) iteration.files.push(`lid_iter${j}.png`);
      else if (commandFailed(post))
        job.notes.push(`Figure of iteration ${j} skipped: ${outputTail(post, 2)}`);
    }
    await save(projectId, job);
    return stats;
  };

  try {
    let last = await exportAndSurface(0);
    for (let k = 1; k <= s.iterations && last.residualRmsMm >= s.tolRmsMm; k += 1) {
      const iteration: FreeSurfaceIteration = {
        index: k,
        sessionId: null,
        sessionName: null,
        runId: null,
        fit: null,
        meshCells: null,
        files: [],
      };
      job.iterations.push(iteration);

      // --- fitting: always from the flat base STL
      await enter('fitting', k);
      const geometry = path.join(dir, 'geometry');
      await fs.mkdir(geometry, { recursive: true });
      const stl = path.join(geometry, `domain_lidIter${k}.stl`);
      const report = path.join(geometry, `domain_lidIter${k}.json`);
      const png = path.join(geometry, `domain_lidIter${k}.png`);
      const fitArgs = [
        path.join(dir, 'base.stl'),
        stl,
        '--zs',
        path.join(dir, `zs_iter${k - 1}.npy`),
        '--z-lid',
        zArg,
        '--atmosphere',
        s.lidPatch,
        '--upstand-patch',
        s.lidPatch,
        '--smooth',
        String(s.smooth),
        '--tmin',
        String(s.tmin),
        '--sub',
        String(s.sub),
        '--steiner',
        String(s.steiner),
        '--clear',
        String(s.clear),
        '--report',
        report,
        ...(figures ? ['--figure', png] : []),
        ...(s.cut ? [] : ['--no-cut']),
      ];
      const fit = await runKit(dir, 'lidkit_fitlid.py', fitArgs, `fit_iter${k}.log`);
      if (commandFailed(fit)) throw new StageError(`The lid fit failed: ${outputTail(fit)}`);
      let rep: {
        lid: { faces: number };
        lid_z_vs_Z_LID_mm: { min: number; max: number };
        clamped_lid_points: number;
        upstand_facets: number;
        cut?: { components?: number };
        audit_all: { open_edges: number };
        audit_base_all: { open_edges: number };
      };
      try {
        rep = JSON.parse(await fs.readFile(report, 'utf8'));
      } catch {
        throw new StageError('The lid fit wrote no report.');
      }
      const fitStats: FreeSurfaceFitStats = {
        lidFaces: rep.lid.faces,
        lidZMinMm: rep.lid_z_vs_Z_LID_mm.min,
        lidZMaxMm: rep.lid_z_vs_Z_LID_mm.max,
        clampedLidPoints: rep.clamped_lid_points,
        upstandFacets: rep.upstand_facets,
        cutSolids: rep.cut?.components ?? 0,
        openEdges: rep.audit_all.open_edges,
        baseOpenEdges: rep.audit_base_all.open_edges,
      };
      iteration.fit = fitStats;
      if (fitStats.openEdges > fitStats.baseOpenEdges && !fitStats.cutSolids) {
        throw new StageError(
          `The fitted STL has more open edges than the base (${fitStats.openEdges} > ${fitStats.baseOpenEdges}). Inspect the fit report.`,
        );
      }
      iteration.files.push(`domain_lidIter${k}.stl`);
      if (figures && (await fs.stat(png).catch(() => null)))
        iteration.files.push(`domain_lidIter${k}.png`);
      await save(projectId, job);

      // --- meshing: a copy of the source session with the fitted surfaces
      await enter('meshing', k);
      const surfaces = splitFittedStl(await fs.readFile(stl), surfaceFiles, s.lidPatch);
      const meshed = await meshSessionWithSurfaces(
        s.sourceSessionId,
        `${sourceName}-lid${k}`,
        surfaces,
      );
      iteration.sessionId = meshed.sessionId;
      iteration.sessionName = meshed.name;
      entry.sessionId = meshed.sessionId;
      await save(projectId, job);
      if (job.stopRequested) await stopMeshingRun(meshed.sessionId).catch(() => undefined);
      const meshStatus = await awaitMeshingTerminal(meshed.sessionId);
      entry.sessionId = null;
      checkStop();
      if (meshStatus !== 'succeeded') {
        throw new StageError(
          `The meshing session "${meshed.name}" ${meshStatus === 'stopped' ? 'was stopped' : 'failed'}. Open it to read the log.`,
        );
      }
      const log = await readMeshLog(meshed.sessionId, env.SOLVER_LOG_MAX_BYTES).catch(() => ({
        content: '',
      }));
      iteration.meshCells = parseMeshCells(log.content);

      // --- transferring: WS-F hand-off to the case, then drop the stale solution
      await enter('transferring', k);
      await sendSessionToCase(entry.viewer, projectId, meshed.sessionId);
      await clearCaseSolution(projectId);

      // --- solving
      await enter('solving', k);
      const run = await solveCase(entry.viewer, projectId, job.cores, async (runId) => {
        iteration.runId = runId;
        entry.runId = runId;
        await save(projectId, job);
        if (job.stopRequested) await stopRun(entry.viewer, projectId, runId).catch(() => undefined);
      });
      entry.runId = null;
      checkStop();
      if (run.status !== 'converged' && run.status !== 'completed') {
        throw new StageError(
          `The solver run ended ${run.status}${run.reason ? `: ${run.reason}` : ''}.`,
        );
      }

      last = await exportAndSurface(k);
    }

    const rms = last.residualRmsMm.toFixed(1);
    const tol = s.tolRmsMm.toFixed(1);
    const converged = last.residualRmsMm < s.tolRmsMm;
    job.status = converged ? 'converged' : 'completed';
    job.reason = converged
      ? `Converged: the lid residual RMS is ${rms} mm (tolerance ${tol} mm).`
      : `Iterations done: the lid residual RMS is ${rms} mm (tolerance ${tol} mm).`;
  } catch (err) {
    if (err instanceof StopSignal || job.stopRequested) {
      job.status = 'stopped';
      job.reason = 'Stopped by user';
    } else {
      job.status = 'failed';
      job.failedStage = job.stage;
      job.reason =
        err instanceof StageError || err instanceof AppError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      if (!(err instanceof StageError) && !(err instanceof AppError))
        logger.error('Free-surface job failed', err);
    }
  } finally {
    const now = new Date().toISOString();
    job.finishedAt = now;
    job.stage = job.status === 'failed' ? job.stage : null;
    await save(projectId, job).catch((e) => logger.error('Free-surface job save failed', e));
    if (activeJobs.get(projectId) === entry) activeJobs.delete(projectId);
  }
}
