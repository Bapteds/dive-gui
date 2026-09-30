// The optimisation study runner (WS-H spec §6, amended by §0): an in-process,
// persisted state machine that evaluates one chamber design at a time in the
// study's project, then asks Optuna (scripts/optimiseSuggest.py, ask / tell
// rebuilt from the Evaluation rows) for the next design.
//
// Per evaluation (each stage persisted in Evaluation.status before it starts):
//   building      buildChamber(base + Exact params); 422 (VALIDATION_ERROR or
//                 CHAMBER_REFUSED) => infeasible, 502 => failed; a chamber hash
//                 already evaluated reuses its result ("duplicate of #k");
//   meshing       copy of the reference session with the chamber surfaces
//                 (importChamberIntoMeshing copyFrom), meshed with the reference's
//                 settings; failed checkMesh checks => infeasible, a mesher
//                 failure => failed;
//   transferring  WS-F hand-off into the project case, old solution cleared;
//   configuring   the study's criteria snapshot written back as the project's
//                 cfd-criteria.json (startRun installs it);
//   solving       startRun + awaitRunTerminal; converged / completed (time budget,
//                 budgetHit) => metrics, else failed;
//   done          dp0 = mean Δp₀ over the criterion window, headLoss = dp0 / (ρ g),
//                 WS-G on-demand vortex metrics, archive, objective, disk hygiene.
// Stop = pause: the current stage is stopped, the evaluation is `interrupted` and
// re-run in place on resume. A study left running by a dead process is paused on
// boot (reconcileOrphanStudies).
import path from 'node:path';
import type { Evaluation, Study } from '@prisma/client';
import {
  COUNTED_EVALUATION_STATUSES,
  EVALUATION_STAGES,
  GRAVITY,
  cfdCriteriaSchema,
  chamberInputWithExact,
  weightedObjective,
  type CfdCriteriaSettings,
  type ChamberInput,
  type ChamberOutputKey,
  type EvaluationStage,
  type EvaluationStatus,
  type ParamRange,
  type StudyNormalisation,
  type StudyWeights,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { caseDirAbsolute } from '../../lib/caseStorage';
import { readConfig, readMeshLog, slugifySessionName } from '../../lib/meshingStorage';
import { readRunLog } from '../../lib/runStorage';
import { downsampleSeries, parseMonitors } from '../../lib/monitorParser';
import {
  awaitMeshingTerminal,
  clearCaseSolution,
  sendSessionToCase,
  sessionMeshingConfig,
  solveCase,
} from '../../lib/pipelineStages';
import {
  archivePostProcessing,
  studyDirAbsolute,
  writeEvaluationMetrics,
  writeSuggestRequest,
} from '../../lib/studyStorage';
import { buildChamber } from '../chamber/chamber.service';
import {
  importChamberIntoMeshing,
  removeMeshingSession,
  startMeshingRun,
  stopMeshingRun,
} from '../meshing/meshing.service';
import { stopRun } from '../projects/runs.service';
import {
  computeVortexOnDemand,
  resolveProjectCriteria,
  writeProjectCriteria,
} from '../projects/criteria.service';
import type { Viewer } from '../projects/projects.service';
import {
  clearActiveStudy,
  getActiveStudy,
  setActiveStudy,
  type ActiveStudy,
} from './studyRegistry';

/** Evaluation statuses of a design still in flight (re-run on resume). */
const IN_FLIGHT: readonly string[] = ['pending', ...EVALUATION_STAGES];

/** Thrown inside the runner when the study is paused (stop) or deleted. */
class PauseSignal extends Error {}

/** A stage outcome with a user-facing reason (infeasible or failed trial). */
class TrialOutcome extends Error {
  constructor(
    readonly status: 'infeasible' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** A study-level failure (the optimiser, the baseline). */
class StudyFailure extends Error {}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

/**
 * Claim the global study slot for `studyId` (the caller checked it is free) and
 * return the entry; `run()` starts the runner in the background, `release()`
 * gives the slot back when the start is refused after the claim.
 */
export function claimStudySlot(
  studyId: string,
  projectId: string,
  viewer: Viewer,
): { entry: ActiveStudy; run: () => void; release: () => void } {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry: ActiveStudy = {
    studyId,
    projectId,
    viewer,
    abort: false,
    sessionId: null,
    runId: null,
    done,
  };
  setActiveStudy(entry);
  return {
    entry,
    run: () => {
      void runStudy(entry)
        .catch((err) => logger.error(`Study ${studyId} runner crashed`, err))
        .finally(() => {
          clearActiveStudy(entry);
          settle();
        });
    },
    release: () => {
      clearActiveStudy(entry);
      settle();
    },
  };
}

/**
 * Ask the live runner to pause: stop the current meshing run / solver run (a
 * chamber build or a suggestion finishes first). Idempotent.
 */
export async function requestStudyAbort(entry: ActiveStudy): Promise<void> {
  if (entry.abort) return;
  entry.abort = true;
  if (entry.sessionId) await stopMeshingRun(entry.sessionId).catch(() => undefined);
  if (entry.runId) {
    await stopRun(entry.viewer, entry.projectId, entry.runId).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The criteria snapshot of the study, else the project's current criteria. */
async function studyCriteria(study: Study): Promise<CfdCriteriaSettings> {
  const parsed = cfdCriteriaSchema.safeParse(parseJson<unknown>(study.criteria, null));
  if (parsed.success) return parsed.data;
  return (await resolveProjectCriteria(study.projectId)).criteria;
}

/** The value of the picked vortex metric of an evaluation. */
export function pickedVortex(
  study: Pick<Study, 'vortexMetric'>,
  row: Pick<Evaluation, 'maskedQVolume' | 'omegaRms'>,
): number | null {
  return study.vortexMetric === 'omegaRms' ? row.omegaRms : row.maskedQVolume;
}

/** Normalised score used to rank done evaluations (weighted objective, or equal weights). */
export function evaluationScore(
  study: Pick<Study, 'vortexMetric' | 'mode' | 'weights'>,
  norm: StudyNormalisation | null,
  row: Pick<Evaluation, 'headLoss' | 'maskedQVolume' | 'omegaRms' | 'status'>,
): number | null {
  const vortex = pickedVortex(study, row);
  if (row.status !== 'done' || !norm || row.headLoss == null || vortex == null) return null;
  const weights: StudyWeights =
    study.mode === 'pareto'
      ? { headLoss: 0.5, vortex: 0.5 }
      : parseJson<StudyWeights>(study.weights, { headLoss: 0.5, vortex: 0.5 });
  return weightedObjective({ headLoss: row.headLoss, vortex }, norm, weights);
}

/** The failed checks of the last checkMesh report of a mesher log, or null when OK. */
export function failedMeshChecks(log: string): string | null {
  const failed = [...log.matchAll(/Failed (\d+) mesh checks?\./g)];
  const okAt = log.lastIndexOf('Mesh OK.');
  const last = failed[failed.length - 1];
  if (!last || (last.index ?? 0) < okAt) return null;
  const sectionStart = Math.max(0, log.lastIndexOf('Mesh stats', last.index));
  const details = log
    .slice(sectionStart, last.index)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('***'))
    .map((l) => l.replace(/^\*+\s*/, '').replace(/\.$/, ''))
    .slice(0, 5);
  return `The mesh fails checkMesh: ${last[0]}${details.length ? ` (${details.join('; ')})` : ''}`;
}

/** Interpreter and script of the suggestion step. */
function optimPython(): string {
  return env.OPTIM_PYTHON_BIN.trim() || env.MESH_PYTHON_BIN;
}
function optimiseSuggestScript(): string {
  const configured = env.OPTIMISE_SUGGEST_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ is not compiled: three levels up from src/modules/studies (or dist/…).
  return path.resolve(__dirname, '../../../scripts/optimiseSuggest.py');
}

/** Last lines of a tool output, for a failure reason. */
function outputTail(result: CommandResult): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return 'timed out';
  const ko = /^KO:\s*(.+)$/m.exec(result.stderr || '')?.[1]?.trim();
  if (ko) return ko;
  return (result.stderr || result.stdout || '')
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(' ')
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Suggestion (ask / tell rebuilt from the rows)
// ---------------------------------------------------------------------------

async function suggestDesign(
  study: Study,
  space: ParamRange[],
  rows: Evaluation[],
): Promise<Partial<Record<ChamberOutputKey, number>>> {
  const norm = parseJson<StudyNormalisation | null>(study.normalisation, null);
  type HistoryEntry = {
    params: Record<string, number>;
    values: number[] | null;
    state: 'COMPLETE' | 'FAIL';
    feasible?: boolean;
  };
  const history = rows.flatMap((row): HistoryEntry[] => {
    const params = parseJson<Record<string, number>>(row.designParams, {});
    if (row.status === 'done') {
      const vortex = pickedVortex(study, row);
      if (!norm || row.headLoss == null || vortex == null) return [];
      const values =
        study.mode === 'pareto'
          ? [row.headLoss / norm.headLoss, vortex / norm.vortex]
          : [row.objective ?? (evaluationScore(study, norm, row) as number)];
      return [{ params, values, state: 'COMPLETE', feasible: true }];
    }
    if (row.status === 'infeasible') {
      return [{ params, values: null, state: 'COMPLETE', feasible: false }];
    }
    if (row.status === 'failed') return [{ params, values: null, state: 'FAIL' }];
    return [];
  });
  const request = {
    space: space.map((r) => ({ key: r.key, low: r.min, high: r.max, step: r.step })),
    sampler: study.sampler,
    seed: study.seed,
    mode: study.mode,
    history,
  };
  const file = await writeSuggestRequest(study.id, request);
  const result = await runCommand({
    command: optimPython(),
    args: [optimiseSuggestScript(), file],
    cwd: studyDirAbsolute(study.id),
    env: process.env,
    timeoutMs: env.OPTIM_SUGGEST_TIMEOUT_MS,
  });
  const line = /^OK:\s*(\{.*\})\s*$/m.exec(result.stdout || '')?.[1];
  if (result.exitCode !== 0 || !line) {
    throw new StudyFailure(`The optimiser could not suggest a design: ${outputTail(result)}`);
  }
  const params = parseJson<{ params?: Record<string, unknown> }>(line, {}).params ?? {};
  const out: Partial<Record<ChamberOutputKey, number>> = {};
  for (const range of space) {
    const value = params[range.key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
      throw new StudyFailure(
        `The optimiser suggested an invalid value for ${range.label} (${String(value)}).`,
      );
    }
    out[range.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One evaluation
// ---------------------------------------------------------------------------

async function evaluate(
  entry: ActiveStudy,
  study: Study,
  row: Evaluation,
  input: ChamberInput,
  priorRows: Evaluation[],
): Promise<void> {
  const projectId = study.projectId;
  const set = (data: Parameters<typeof prisma.evaluation.update>[0]['data']) =>
    prisma.evaluation.update({ where: { id: row.id }, data });
  let stage: EvaluationStage = 'building';
  const warnings: string[] = [];
  const enter = async (next: EvaluationStage): Promise<void> => {
    if (entry.abort) throw new PauseSignal();
    stage = next;
    await set({ status: next, stage: next });
  };

  try {
    await set({ status: 'building', stage: 'building', startedAt: new Date(), projectId });
    if (entry.abort) throw new PauseSignal();

    // --- building
    let build;
    try {
      build = await buildChamber(input);
    } catch (err) {
      if (err instanceof AppError) {
        throw new TrialOutcome(err.status === 422 ? 'infeasible' : 'failed', err.message);
      }
      throw err;
    }
    warnings.push(...build.warnings);
    await set({ chamberHash: build.hash, warnings: JSON.stringify(warnings) });

    // Same geometry already evaluated with the same (study-fixed) mesh, BCs and
    // criteria: reuse its result instead of re-solving.
    const dup = priorRows.find(
      (r) =>
        r.index !== row.index &&
        r.chamberHash === build.hash &&
        (r.status === 'done' || r.status === 'infeasible'),
    );
    if (dup) {
      warnings.push(`duplicate of #${dup.index}`);
      await set({
        status: dup.status,
        stage: dup.stage,
        dp0: dup.dp0,
        headLoss: dup.headLoss,
        maskedQVolume: dup.maskedQVolume,
        omegaRms: dup.omegaRms,
        runStatus: dup.runStatus,
        budgetHit: dup.budgetHit,
        refusalReason: dup.refusalReason,
        warnings: JSON.stringify(warnings),
        finishedAt: new Date(),
      });
      return;
    }

    // --- meshing
    await enter('meshing');
    const session = await importChamberIntoMeshing({
      mode: 'copyFrom',
      chamberHash: build.hash,
      sourceId: study.meshingSourceId,
      name: `study-${slugifySessionName(study.name)}-${row.index}`,
    });
    entry.sessionId = session.id;
    await set({ meshingSessionId: session.id, meshingSessionName: session.name, sessionDeleted: false });
    const config =
      (await sessionMeshingConfig(study.meshingSourceId)) ?? (await readConfig(session.id));
    if (!config) {
      throw new TrialOutcome(
        'failed',
        'The reference meshing session has no meshing settings to reuse. Mesh it once first.',
      );
    }
    await startMeshingRun(session.id, config);
    if (entry.abort) await stopMeshingRun(session.id).catch(() => undefined);
    const meshStatus = await awaitMeshingTerminal(session.id);
    entry.sessionId = null;
    if (entry.abort) throw new PauseSignal();
    const meshLog = await readMeshLog(session.id, env.SOLVER_LOG_MAX_BYTES).catch(() => ({
      content: '',
    }));
    const failedChecks = failedMeshChecks(meshLog.content);
    if (failedChecks) throw new TrialOutcome('infeasible', failedChecks);
    if (meshStatus !== 'succeeded') {
      throw new TrialOutcome(
        'failed',
        `The meshing session "${session.name}" failed. Open it to read the log.`,
      );
    }

    // --- transferring
    await enter('transferring');
    await sendSessionToCase(entry.viewer, projectId, session.id);
    await clearCaseSolution(projectId);

    // --- configuring
    await enter('configuring');
    const criteria = await studyCriteria(study);
    await writeProjectCriteria(projectId, criteria);

    // --- solving
    await enter('solving');
    const cores = parseJson<{ cores?: number }>(study.solverSetup, {}).cores ?? 1;
    const run = await solveCase(entry.viewer, projectId, cores, async (runId) => {
      entry.runId = runId;
      await set({ runId });
      if (entry.abort) await stopRun(entry.viewer, projectId, runId).catch(() => undefined);
    });
    entry.runId = null;
    await set({ runStatus: run.status });
    if (entry.abort) throw new PauseSignal();
    if (run.status !== 'converged' && run.status !== 'completed') {
      throw new TrialOutcome(
        'failed',
        `The solver run ended ${run.status}${run.reason ? `: ${run.reason}` : ''}.`,
      );
    }

    // --- metrics
    const { content } = await readRunLog(projectId, run.id, 0, env.SOLVER_LOG_MAX_BYTES);
    const samples = parseMonitors(content, Number.MAX_SAFE_INTEGER).pressureDrop;
    if (samples.length === 0) {
      throw new TrialOutcome(
        'failed',
        'The run reported no pressure drop. Check the inlet and outlet patches of the convergence criteria.',
      );
    }
    const window =
      criteria.convergence.method === 'robust'
        ? criteria.convergence.robust.W
        : criteria.convergence.simplePDrop.window;
    const tail = samples.slice(-window);
    const dp0 = tail.reduce((sum, s) => sum + s.dp0, 0) / tail.length;
    const headLoss = dp0 / (criteria.convergence.rho * GRAVITY);
    let vortex;
    try {
      vortex = await computeVortexOnDemand(entry.viewer, projectId);
    } catch (err) {
      if (err instanceof AppError) {
        throw new TrialOutcome('failed', `The vortex metrics could not be computed: ${err.message}`);
      }
      throw err;
    }
    await writeEvaluationMetrics(study.id, row.index, {
      pressureDrop: downsampleSeries(samples, 500),
      window: tail.length,
      vortex,
    }).catch((err) => logger.error('Study metrics archive failed', err));
    await archivePostProcessing(study.id, row.index, caseDirAbsolute(projectId));
    await set({
      status: 'done',
      dp0,
      headLoss,
      maskedQVolume: vortex.maskedQVolume,
      omegaRms: vortex.omegaRms,
      budgetHit: run.status === 'completed',
      refusalReason: null,
      warnings: JSON.stringify(warnings),
      finishedAt: new Date(),
    });
  } catch (err) {
    entry.sessionId = null;
    entry.runId = null;
    if (err instanceof PauseSignal || entry.abort) {
      await set({ status: 'interrupted', stage, finishedAt: new Date() }).catch(() => undefined);
      throw new PauseSignal();
    }
    const status: EvaluationStatus = err instanceof TrialOutcome ? err.status : 'failed';
    const message =
      err instanceof TrialOutcome || err instanceof AppError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof TrialOutcome) && !(err instanceof AppError)) {
      logger.error(`Study ${study.id} evaluation #${row.index} failed`, err);
    }
    await set({
      status,
      stage,
      refusalReason: message,
      warnings: JSON.stringify(warnings),
      finishedAt: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------
// After an evaluation: objectives, disk hygiene
// ---------------------------------------------------------------------------

/** Store the weighted objective of every done evaluation (weighted mode). */
async function scoreEvaluations(study: Study): Promise<void> {
  if (study.mode !== 'weighted') return;
  const norm = parseJson<StudyNormalisation | null>(study.normalisation, null);
  if (!norm) return;
  const rows = await prisma.evaluation.findMany({ where: { studyId: study.id, status: 'done' } });
  for (const row of rows) {
    const objective = evaluationScore(study, norm, row);
    if (objective !== null && objective !== row.objective) {
      await prisma.evaluation.update({ where: { id: row.id }, data: { objective } });
    }
  }
}

/**
 * Keep the meshing sessions of the best `keepBest` done evaluations and of the
 * last `keepLast` evaluations; delete the others (their metrics are archived).
 */
async function cleanupSessions(study: Study): Promise<void> {
  const norm = parseJson<StudyNormalisation | null>(study.normalisation, null);
  const rows = await prisma.evaluation.findMany({
    where: {
      studyId: study.id,
      meshingSessionId: { not: null },
      sessionDeleted: false,
      status: { in: [...COUNTED_EVALUATION_STATUSES] },
    },
    orderBy: { index: 'desc' },
  });
  const keep = new Set<string>(rows.slice(0, study.keepLast).map((r) => r.id));
  rows
    .map((r) => ({ r, score: evaluationScore(study, norm, r) }))
    .filter((x): x is { r: Evaluation; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.r.index - b.r.index)
    .slice(0, study.keepBest)
    .forEach((x) => keep.add(x.r.id));
  for (const row of rows) {
    if (keep.has(row.id) || !row.meshingSessionId) continue;
    if (row.meshingSessionId === study.meshingSourceId) continue;
    await removeMeshingSession(row.meshingSessionId).catch(() => undefined);
    await prisma.evaluation.update({ where: { id: row.id }, data: { sessionDeleted: true } });
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function finishStudy(
  studyId: string,
  status: 'completed' | 'failed' | 'paused',
  reason: string,
): Promise<void> {
  await prisma.study
    .update({
      where: { id: studyId },
      data: { status, reason, finishedAt: status === 'paused' ? null : new Date() },
    })
    .catch(() => undefined);
}

async function runStudy(entry: ActiveStudy): Promise<void> {
  const studyId = entry.studyId;
  try {
    for (;;) {
      if (entry.abort) throw new PauseSignal();
      const study = await prisma.study.findUnique({ where: { id: studyId } });
      if (!study) return; // deleted under the runner
      const rows = await prisma.evaluation.findMany({
        where: { studyId },
        orderBy: { index: 'asc' },
      });

      // Budgets (checked before each evaluation; the current one always finishes).
      const counted = rows.filter((r) =>
        COUNTED_EVALUATION_STATUSES.includes(r.status as EvaluationStatus),
      ).length;
      if (counted >= study.maxEvaluations) {
        await finishStudy(studyId, 'completed', `Evaluation budget reached (${counted} evaluations).`);
        return;
      }
      if (study.maxDurationHours != null) {
        const elapsedMs = rows.reduce(
          (sum, r) =>
            r.startedAt && r.finishedAt ? sum + (r.finishedAt.getTime() - r.startedAt.getTime()) : sum,
          0,
        );
        if (elapsedMs >= study.maxDurationHours * 3_600_000) {
          await finishStudy(
            studyId,
            'completed',
            `Time budget reached (${study.maxDurationHours} h of evaluations, ${counted} evaluations).`,
          );
          return;
        }
      }

      const space = parseJson<ParamRange[]>(study.paramSpace, []);
      const baseInput = parseJson<ChamberInput>(study.baseInput, {} as ChamberInput);
      let row: Evaluation;
      const redo = rows.find((r) => r.status === 'interrupted' || IN_FLIGHT.includes(r.status));
      if (redo) {
        // The interrupted design is re-proposed first, in place.
        row = await prisma.evaluation.update({
          where: { id: redo.id },
          data: {
            status: 'pending',
            stage: null,
            runId: null,
            runStatus: null,
            refusalReason: null,
            budgetHit: false,
            dp0: null,
            headLoss: null,
            maskedQVolume: null,
            omegaRms: null,
            objective: null,
            startedAt: null,
            finishedAt: null,
          },
        });
      } else if (rows.length === 0) {
        const params = Object.fromEntries(space.map((r) => [r.key, r.base]));
        row = await prisma.evaluation.create({
          data: { studyId, index: 0, designParams: JSON.stringify(params), projectId: study.projectId },
        });
      } else {
        const params = await suggestDesign(study, space, rows);
        if (entry.abort) throw new PauseSignal();
        row = await prisma.evaluation.create({
          data: {
            studyId,
            index: rows[rows.length - 1].index + 1,
            designParams: JSON.stringify(params),
            projectId: study.projectId,
          },
        });
      }
      const params = parseJson<Partial<Record<ChamberOutputKey, number>>>(row.designParams, {});
      const input = row.index === 0 ? baseInput : chamberInputWithExact(baseInput, params);

      await evaluate(entry, study, row, input, rows);

      const done = await prisma.evaluation.findUnique({ where: { id: row.id } });
      if (!done) return;
      if (row.index === 0) {
        if (done.status !== 'done') {
          throw new StudyFailure(
            `The baseline design could not be evaluated (${done.status}): ${done.refusalReason ?? 'no reason given'}`,
          );
        }
        const vortex = pickedVortex(study, done);
        if (!(done.headLoss != null && done.headLoss > 0) || !(vortex != null && vortex > 0)) {
          throw new StudyFailure(
            `The baseline design gives a zero or negative ${done.headLoss != null && done.headLoss > 0 ? study.vortexMetric : 'head loss'}: the objectives cannot be normalised.`,
          );
        }
        await prisma.study.update({
          where: { id: studyId },
          data: { normalisation: JSON.stringify({ headLoss: done.headLoss, vortex }) },
        });
      }
      const fresh = await prisma.study.findUnique({ where: { id: studyId } });
      if (!fresh) return;
      await scoreEvaluations(fresh);
      await cleanupSessions(fresh);
    }
  } catch (err) {
    if (err instanceof PauseSignal || entry.abort) {
      await finishStudy(studyId, 'paused', 'Paused by user');
      return;
    }
    const reason =
      err instanceof StudyFailure || err instanceof AppError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof StudyFailure) && !(err instanceof AppError)) {
      logger.error(`Study ${studyId} failed`, err);
    }
    await finishStudy(studyId, 'failed', reason);
  }
}

/**
 * Boot reconciliation: a study left `running` / `pausing` by a previous process
 * can never continue by itself; pause it and mark its in-flight evaluation
 * `interrupted` (re-run on resume). Returns the count.
 */
export async function reconcileOrphanStudies(): Promise<number> {
  const stale = await prisma.study.findMany({
    where: { status: { in: ['running', 'pausing'] } },
  });
  let count = 0;
  for (const study of stale) {
    if (getActiveStudy()?.studyId === study.id) continue;
    const inflight = await prisma.evaluation.findMany({
      where: { studyId: study.id, status: { in: [...IN_FLIGHT] } },
    });
    for (const row of inflight) {
      const stage =
        row.stage ?? ((EVALUATION_STAGES as readonly string[]).includes(row.status) ? row.status : null);
      await prisma.evaluation.update({
        where: { id: row.id },
        data: { status: 'interrupted', stage, finishedAt: new Date() },
      });
    }
    await prisma.study.update({
      where: { id: study.id },
      data: { status: 'paused', reason: 'Interrupted by a server restart' },
    });
    count += 1;
  }
  return count;
}
