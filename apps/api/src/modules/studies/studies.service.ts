// Optimisation studies of a project (WS-H spec 2026-09-29-optimisation-loop-design,
// amendment §0): CRUD, permissions, base-design resolution, search-space
// validation, start / stop (pause) / resume / delete, evaluation detail and CSV.
// The stage machine lives in studyRunner.ts; the global one-study slot and the
// project lock in studyRegistry.ts.
//
// Access: visibility = the project's (an invisible project is 404); control
// (edit, start, stop, resume, delete) = the study owner or a super-admin (403).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Prisma, type Evaluation, type Study } from '@prisma/client';
import {
  ACTIVE_RUN_STATUSES,
  COUNTED_EVALUATION_STATUSES,
  STUDY_DEFAULTS,
  computeParamSpace,
  paretoFront,
  type ChamberInput,
  type ChamberOutputKey,
  type EvaluationStage,
  type EvaluationStatus,
  type ParamRange,
  type PublicStudy,
  type RunStatus,
  type StudyBaseSource,
  type StudyDetail,
  type StudyEvaluation,
  type StudyEvaluationMetrics,
  type StudyMode,
  type StudyNormalisation,
  type StudySampler,
  type StudySetup,
  type StudyStatus,
  type StudyVortexMetric,
  type StudyWeights,
} from '@dive/shared';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { chamberPaths } from '../../lib/chamberStorage';
import { readMeshOrigin } from '../../lib/meshOriginStorage';
import { hasCompleteResultMesh, listSessions, readMeta } from '../../lib/meshingStorage';
import { sessionMeshingConfig } from '../../lib/pipelineStages';
import { readEvaluationMetrics, removeStudyStorage } from '../../lib/studyStorage';
import { chamberBuildSchema } from '../chamber/chamber.schemas';
import { isSessionRunning, removeMeshingSession } from '../meshing/meshing.service';
import { resolveProjectCriteria } from '../projects/criteria.service';
import { isFreeSurfaceActive } from '../projects/freeSurface.service';
import { assertProjectVisible, type Viewer } from '../projects/projects.service';
import { getActiveStudy, type ActiveStudy } from './studyRegistry';
import { claimStudySlot, evaluationScore, pickedVortex, requestStudyAbort } from './studyRunner';
import type { CreateStudyInput, UpdateStudyInput } from './studies.schemas';

type StudyWithOwner = Study & { owner: { id: string; fullName: string } };

const ownerInclude = { owner: { select: { id: true, fullName: true } } } as const;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function canControl(viewer: Viewer, study: { ownerId: string }): boolean {
  return viewer.role === 'SUPER_ADMIN' || study.ownerId === viewer.id;
}

function assertControl(viewer: Viewer, study: { ownerId: string }): void {
  if (!canControl(viewer, study)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the study owner or a super-admin can change or run this study.',
    );
  }
}

function toPublicStudy(
  viewer: Viewer,
  study: StudyWithOwner,
  evaluations: Pick<Evaluation, 'status' | 'index'>[],
): PublicStudy {
  const counted = evaluations.filter((e) =>
    COUNTED_EVALUATION_STATUSES.includes(e.status as EvaluationStatus),
  ).length;
  const current = evaluations.find(
    (e) => !['done', 'infeasible', 'failed', 'interrupted'].includes(e.status),
  );
  return {
    id: study.id,
    name: study.name,
    projectId: study.projectId,
    owner: { id: study.owner.id, fullName: study.owner.fullName },
    baseSource: study.baseSource as StudyBaseSource,
    baseLabel: study.baseLabel,
    baseInput: parseJson<ChamberInput>(study.baseInput, {} as ChamberInput),
    paramSpace: parseJson<ParamRange[]>(study.paramSpace, []),
    bandPct: study.bandPct,
    weights: parseJson<StudyWeights>(study.weights, STUDY_DEFAULTS.weights),
    mode: study.mode as StudyMode,
    sampler: study.sampler as StudySampler,
    seed: study.seed,
    vortexMetric: study.vortexMetric as StudyVortexMetric,
    maxEvaluations: study.maxEvaluations,
    maxDurationHours: study.maxDurationHours,
    keepBest: study.keepBest,
    keepLast: study.keepLast,
    meshingSourceId: study.meshingSourceId,
    cores: parseJson<{ cores?: number }>(study.solverSetup, {}).cores ?? 1,
    criteria: parseJson(study.criteria, null),
    normalisation: parseJson<StudyNormalisation | null>(study.normalisation, null),
    status: study.status as StudyStatus,
    reason: study.reason,
    counted,
    currentIndex: study.status === 'running' || study.status === 'pausing' ? (current?.index ?? null) : null,
    canControl: canControl(viewer, study),
    startedAt: iso(study.startedAt),
    finishedAt: iso(study.finishedAt),
    createdAt: study.createdAt.toISOString(),
    updatedAt: study.updatedAt.toISOString(),
  };
}

function toPublicEvaluation(row: Evaluation): StudyEvaluation {
  return {
    index: row.index,
    status: row.status as EvaluationStatus,
    stage: (row.stage as EvaluationStage | null) ?? null,
    designParams: parseJson(row.designParams, {}),
    chamberHash: row.chamberHash,
    meshingSessionId: row.meshingSessionId,
    meshingSessionName: row.meshingSessionName,
    sessionAvailable: !!row.meshingSessionId && !row.sessionDeleted,
    runId: row.runId,
    runStatus: (row.runStatus as RunStatus | null) ?? null,
    budgetHit: row.budgetHit,
    dp0: row.dp0,
    headLoss: row.headLoss,
    maskedQVolume: row.maskedQVolume,
    omegaRms: row.omegaRms,
    objective: row.objective,
    refusalReason: row.refusalReason,
    warnings: parseJson<string[]>(row.warnings, []),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

/** Load a study of a visible project. @throws 404. */
async function findStudy(viewer: Viewer, projectId: string, studyId: string): Promise<StudyWithOwner> {
  await assertProjectVisible(viewer, projectId);
  const study = await prisma.study.findFirst({
    where: { id: studyId, projectId },
    include: ownerInclude,
  });
  if (!study) throw new AppError(404, 'NOT_FOUND', 'Study not found.');
  return study;
}

async function evaluationStatuses(studyId: string) {
  return prisma.evaluation.findMany({
    where: { studyId },
    select: { status: true, index: true },
    orderBy: { index: 'asc' },
  });
}

async function publicStudy(viewer: Viewer, studyId: string): Promise<PublicStudy> {
  const study = await prisma.study.findUniqueOrThrow({ where: { id: studyId }, include: ownerInclude });
  return toPublicStudy(viewer, study, await evaluationStatuses(studyId));
}

// ---------------------------------------------------------------------------
// Setup (creation form)
// ---------------------------------------------------------------------------

/** The ChamberInput behind a build hash (input.json), validated, or null. */
async function readOriginInput(hash: string): Promise<ChamberInput | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(chamberPaths(hash).dir, 'input.json'), 'utf8'),
    ) as unknown;
    return chamberBuildSchema.safeParse(raw).success ? (raw as ChamberInput) : null;
  } catch {
    return null;
  }
}

/** Is this session usable as the reference (finished mesh + reusable settings)? */
async function sessionUsable(sessionId: string): Promise<boolean> {
  const meta = await readMeta(sessionId).catch(() => null);
  if (!meta) return false;
  if (await isSessionRunning(sessionId)) return false;
  return (await hasCompleteResultMesh(sessionId)) && (await sessionMeshingConfig(sessionId)) !== null;
}

async function defaultCores(projectId: string): Promise<number> {
  const run = await prisma.run.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  return run?.cores ?? 1;
}

async function runningStudy(): Promise<StudySetup['runningStudy']> {
  const active = getActiveStudy();
  const row = active
    ? await prisma.study.findUnique({ where: { id: active.studyId } })
    : await prisma.study.findFirst({ where: { status: { in: ['running', 'pausing'] } } });
  return row ? { id: row.id, name: row.name, projectId: row.projectId } : null;
}

/** GET /projects/:id/studies/setup */
export async function getStudySetup(viewer: Viewer, projectId: string): Promise<StudySetup> {
  await assertProjectVisible(viewer, projectId);
  const origin = await readMeshOrigin(projectId);
  const sessions: StudySetup['sessions'] = [];
  for (const meta of await listSessions()) {
    if (await sessionUsable(meta.id)) {
      sessions.push({ id: meta.id, name: meta.name, engine: meta.engine });
    }
  }
  return {
    origin,
    originInput: origin?.chamberHash ? await readOriginInput(origin.chamberHash) : null,
    sessions,
    defaultSessionId:
      origin && sessions.some((s) => s.id === origin.sessionId) ? origin.sessionId : null,
    criteriaApplicable: (await resolveProjectCriteria(projectId)).applicable,
    defaultCores: await defaultCores(projectId),
    runningStudy: await runningStudy(),
  };
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

/** Resolve the base design of a create / update body. @throws 422. */
async function resolveBase(
  projectId: string,
  base: CreateStudyInput['base'],
): Promise<{ baseInput: ChamberInput; baseLabel: string; baseSource: StudyBaseSource; originSession: string | null }> {
  if (base.kind === 'save') {
    const save = await prisma.chamberSave.findUnique({ where: { id: base.saveId } });
    if (!save) throw new AppError(422, 'VALIDATION_ERROR', 'The chamber save was not found.');
    const raw = parseJson<unknown>(save.snapshot, null);
    if (!chamberBuildSchema.safeParse(raw).success) {
      throw new AppError(422, 'VALIDATION_ERROR', `The chamber save "${save.name}" is not a valid design.`);
    }
    return { baseInput: raw as ChamberInput, baseLabel: save.name, baseSource: 'save', originSession: null };
  }
  const origin = await readMeshOrigin(projectId);
  const input = origin?.chamberHash ? await readOriginInput(origin.chamberHash) : null;
  if (!origin || !input) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      "This project's mesh does not come from a chamber build (no mesh origin with a chamber). Pick a chamber save as the base design.",
    );
  }
  return {
    baseInput: input,
    baseLabel: `Mesh origin (${origin.sessionName})`,
    baseSource: 'meshOrigin',
    originSession: origin.sessionId,
  };
}

/** Validate the reference meshing session. @throws 422. */
async function assertReferenceSession(sessionId: string | null | undefined): Promise<string> {
  if (!sessionId) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Pick the reference meshing session.');
  }
  const meta = await readMeta(sessionId).catch(() => null);
  if (!meta) throw new AppError(422, 'VALIDATION_ERROR', 'The reference meshing session was not found.');
  if (!(await sessionUsable(sessionId))) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `The meshing session "${meta.name}" has no finished mesh with settings to reuse. Mesh it first, or pick another reference meshing session.`,
    );
  }
  return sessionId;
}

/** Compute the search space or fail with every message (422). */
function spaceOrThrow(
  baseInput: ChamberInput,
  keys: ChamberOutputKey[],
  bandPct: number,
  overrides: Partial<Record<ChamberOutputKey, number>>,
): ParamRange[] {
  const { ranges, errors } = computeParamSpace(baseInput, keys, bandPct, overrides);
  if (errors.length) throw new AppError(422, 'VALIDATION_ERROR', errors.join(' '));
  if (ranges.length === 0) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Tick at least one parameter to optimise.');
  }
  return ranges;
}

/** POST /projects/:id/studies: a draft in this project. */
export async function createStudy(
  viewer: Viewer,
  projectId: string,
  input: CreateStudyInput,
): Promise<PublicStudy> {
  await assertProjectVisible(viewer, projectId);
  const base = await resolveBase(projectId, input.base);
  const origin = await readMeshOrigin(projectId);
  const meshingSourceId = await assertReferenceSession(
    input.meshingSourceId ?? base.originSession ?? origin?.sessionId,
  );
  const bandPct = input.bandPct ?? STUDY_DEFAULTS.bandPct;
  const space = spaceOrThrow(base.baseInput, input.keys, bandPct, input.bandOverrides ?? {});
  const mode = input.mode ?? STUDY_DEFAULTS.mode;
  const study = await prisma.study.create({
    data: {
      name: input.name,
      ownerId: viewer.id,
      projectId,
      baseSource: base.baseSource,
      baseLabel: base.baseLabel,
      baseInput: JSON.stringify(base.baseInput),
      paramSpace: JSON.stringify(space),
      bandPct,
      weights: JSON.stringify(input.weights ?? STUDY_DEFAULTS.weights),
      mode,
      sampler: input.sampler ?? (mode === 'pareto' ? 'nsga2' : STUDY_DEFAULTS.sampler),
      seed: input.seed ?? null,
      vortexMetric: input.vortexMetric ?? STUDY_DEFAULTS.vortexMetric,
      maxEvaluations: input.maxEvaluations ?? STUDY_DEFAULTS.maxEvaluations,
      maxDurationHours: input.maxDurationHours ?? null,
      keepBest: input.keepBest ?? STUDY_DEFAULTS.keepBest,
      keepLast: input.keepLast ?? STUDY_DEFAULTS.keepLast,
      meshingSourceId,
      solverSetup: JSON.stringify({ cores: input.cores ?? (await defaultCores(projectId)) }),
    },
    include: ownerInclude,
  });
  return toPublicStudy(viewer, study, []);
}

/** PATCH /projects/:id/studies/:studyId (draft only). */
export async function updateStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
  input: UpdateStudyInput,
): Promise<PublicStudy> {
  const study = await findStudy(viewer, projectId, studyId);
  assertControl(viewer, study);
  if (study.status !== 'draft') {
    throw new AppError(409, 'STUDY_NOT_DRAFT', 'Only a draft study can be edited.');
  }
  const data: Prisma.StudyUpdateInput = {};
  let baseInput = parseJson<ChamberInput>(study.baseInput, {} as ChamberInput);
  if (input.base) {
    const base = await resolveBase(projectId, input.base);
    baseInput = base.baseInput;
    data.baseInput = JSON.stringify(base.baseInput);
    data.baseLabel = base.baseLabel;
    data.baseSource = base.baseSource;
  }
  const current = parseJson<ParamRange[]>(study.paramSpace, []);
  const bandPct = input.bandPct ?? study.bandPct;
  const keys = input.keys ?? current.map((r) => r.key);
  const overrides =
    input.bandOverrides ??
    Object.fromEntries(current.filter((r) => r.bandPct !== study.bandPct).map((r) => [r.key, r.bandPct]));
  data.paramSpace = JSON.stringify(spaceOrThrow(baseInput, keys, bandPct, overrides));
  data.bandPct = bandPct;
  if (input.name !== undefined) data.name = input.name;
  if (input.weights !== undefined) data.weights = JSON.stringify(input.weights);
  if (input.mode !== undefined) data.mode = input.mode;
  if (input.sampler !== undefined) data.sampler = input.sampler;
  if (input.seed !== undefined) data.seed = input.seed;
  if (input.vortexMetric !== undefined) data.vortexMetric = input.vortexMetric;
  if (input.maxEvaluations !== undefined) data.maxEvaluations = input.maxEvaluations;
  if (input.maxDurationHours !== undefined) data.maxDurationHours = input.maxDurationHours;
  if (input.keepBest !== undefined) data.keepBest = input.keepBest;
  if (input.keepLast !== undefined) data.keepLast = input.keepLast;
  if (input.meshingSourceId !== undefined) {
    data.meshingSourceId = await assertReferenceSession(input.meshingSourceId);
  }
  if (input.cores !== undefined) data.solverSetup = JSON.stringify({ cores: input.cores });
  await prisma.study.update({ where: { id: studyId }, data });
  return publicStudy(viewer, studyId);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** GET /projects/:id/studies (newest first). */
export async function listStudies(viewer: Viewer, projectId: string): Promise<PublicStudy[]> {
  await assertProjectVisible(viewer, projectId);
  const studies = await prisma.study.findMany({
    where: { projectId },
    include: { ...ownerInclude, evaluations: { select: { status: true, index: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return studies.map((s) => toPublicStudy(viewer, s, s.evaluations));
}

/** GET /projects/:id/studies/:studyId */
export async function getStudyDetail(
  viewer: Viewer,
  projectId: string,
  studyId: string,
): Promise<StudyDetail> {
  const study = await findStudy(viewer, projectId, studyId);
  const rows = await prisma.evaluation.findMany({ where: { studyId }, orderBy: { index: 'asc' } });
  const norm = parseJson<StudyNormalisation | null>(study.normalisation, null);
  const done = rows.filter((r) => r.status === 'done');
  let best: number | null = null;
  if (study.mode === 'weighted') {
    let bestScore = Infinity;
    for (const r of done) {
      const score = r.objective ?? evaluationScore(study, norm, r);
      if (score !== null && score < bestScore) {
        bestScore = score;
        best = r.index;
      }
    }
  }
  const points = done.flatMap((r) => {
    const vortex = pickedVortex(study, r);
    return r.headLoss != null && vortex != null ? [{ id: r.index, headLoss: r.headLoss, vortex }] : [];
  });
  return {
    study: toPublicStudy(viewer, study, rows),
    evaluations: rows.map(toPublicEvaluation),
    best,
    paretoFront: paretoFront(points),
  };
}

/** GET /projects/:id/studies/:studyId/evaluations/:index */
export async function getEvaluation(
  viewer: Viewer,
  projectId: string,
  studyId: string,
  index: number,
): Promise<{ evaluation: StudyEvaluation; metrics: StudyEvaluationMetrics | null }> {
  await findStudy(viewer, projectId, studyId);
  const row = await prisma.evaluation.findUnique({ where: { studyId_index: { studyId, index } } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Evaluation not found.');
  return {
    evaluation: toPublicEvaluation(row),
    metrics: await readEvaluationMetrics(studyId, index),
  };
}

/** A CSV cell (quoted when needed). */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** GET /projects/:id/studies/:studyId/export.csv: one row per evaluation. */
export async function exportStudyCsv(
  viewer: Viewer,
  projectId: string,
  studyId: string,
): Promise<{ filename: string; csv: string }> {
  const study = await findStudy(viewer, projectId, studyId);
  const keys = parseJson<ParamRange[]>(study.paramSpace, []).map((r) => r.key);
  const rows = await prisma.evaluation.findMany({ where: { studyId }, orderBy: { index: 'asc' } });
  const header = [
    'index',
    'status',
    ...keys,
    'dp0_Pa',
    'headLoss_m',
    'maskedQVolume_m3',
    'omegaRms_1_s',
    'objective',
    'budgetHit',
    'runStatus',
    'chamberHash',
    'reason',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const params = parseJson<Record<string, number>>(r.designParams, {});
    lines.push(
      [
        r.index,
        r.status,
        ...keys.map((k) => params[k]),
        r.dp0,
        r.headLoss,
        r.maskedQVolume,
        r.omegaRms,
        r.objective,
        r.budgetHit,
        r.runStatus,
        r.chamberHash,
        r.refusalReason,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const slug = study.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return { filename: `${slug}.csv`, csv: `${lines.join('\r\n')}\r\n` };
}

// ---------------------------------------------------------------------------
// Start / resume / stop / delete
// ---------------------------------------------------------------------------

/**
 * POST …/start (draft) and …/resume (paused): claim the global slot, check the
 * project, snapshot the criteria (first start) and run in the background.
 * @throws 403, 404, 409 STUDY_NOT_DRAFT / STUDY_NOT_PAUSED / STUDY_IN_PROGRESS /
 *         FREE_SURFACE_IN_PROGRESS / RUN_IN_PROGRESS, 422 VALIDATION_ERROR.
 */
export async function startStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
  mode: 'start' | 'resume',
): Promise<PublicStudy> {
  const study = await findStudy(viewer, projectId, studyId);
  assertControl(viewer, study);
  if (mode === 'start' && study.status !== 'draft') {
    throw new AppError(409, 'STUDY_NOT_DRAFT', 'This study has already been started.');
  }
  if (mode === 'resume' && study.status !== 'paused') {
    throw new AppError(409, 'STUDY_NOT_PAUSED', 'Only a paused study can be resumed.');
  }
  const inProgress = () =>
    new AppError(
      409,
      'STUDY_IN_PROGRESS',
      'Another optimisation study is running. One study runs at a time: wait for it or pause it.',
    );
  if (getActiveStudy()) throw inProgress();
  // Claim the slot before any further await so two starts race safely.
  const slot = claimStudySlot(studyId, projectId, viewer);
  try {
    const other = await prisma.study.count({
      where: { id: { not: studyId }, status: { in: ['running', 'pausing'] } },
    });
    if (other > 0) throw inProgress();
    if (isFreeSurfaceActive(projectId)) {
      throw new AppError(
        409,
        'FREE_SURFACE_IN_PROGRESS',
        'A free-surface job is running on this project. Wait for it to finish or stop it.',
      );
    }
    const active = await prisma.run.count({
      where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    if (active > 0) {
      throw new AppError(409, 'RUN_IN_PROGRESS', 'A solver run is active for this project. Wait for it to finish.');
    }
    const { criteria, applicable } = await resolveProjectCriteria(projectId);
    if (!applicable) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        "The optimisation needs a steady incompressible solver (simpleFoam) in this project's case. Set it up in the Solver tab first.",
      );
    }
    await assertReferenceSession(study.meshingSourceId);
    await prisma.study.update({
      where: { id: studyId },
      data: {
        status: 'running',
        reason: null,
        finishedAt: null,
        startedAt: study.startedAt ?? new Date(),
        criteria: study.criteria ?? JSON.stringify(criteria),
      },
    });
  } catch (err) {
    slot.release();
    throw err;
  }
  slot.run();
  return publicStudy(viewer, studyId);
}

/** POST …/stop: pause (running → pausing → paused). Idempotent. */
export async function stopStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
): Promise<PublicStudy> {
  const study = await findStudy(viewer, projectId, studyId);
  assertControl(viewer, study);
  if (study.status === 'running' || study.status === 'pausing') {
    const entry = getActiveStudy();
    if (entry && entry.studyId === studyId) {
      if (!entry.abort) {
        await prisma.study.update({ where: { id: studyId }, data: { status: 'pausing' } });
        await requestStudyAbort(entry);
      }
    } else {
      // No live runner (left running by a dead process): settle it now.
      await prisma.study.update({
        where: { id: studyId },
        data: { status: 'paused', reason: 'Paused by user' },
      });
    }
  }
  return publicStudy(viewer, studyId);
}

/** Stop a live runner and wait for it to settle. */
async function stopAndWait(entry: ActiveStudy): Promise<void> {
  await requestStudyAbort(entry);
  await entry.done;
}

/** Remove the meshing sessions and the archive of studies about to disappear. */
async function removeStudyArtefacts(studyIds: string[]): Promise<void> {
  if (studyIds.length === 0) return;
  const sessions = await prisma.evaluation.findMany({
    where: { studyId: { in: studyIds }, meshingSessionId: { not: null }, sessionDeleted: false },
    select: { meshingSessionId: true },
  });
  for (const s of sessions) {
    if (s.meshingSessionId) await removeMeshingSession(s.meshingSessionId).catch(() => undefined);
  }
  for (const id of studyIds) await removeStudyStorage(id);
}

/** DELETE …/:studyId (stops first; removes its sessions and archive). */
export async function deleteStudy(viewer: Viewer, projectId: string, studyId: string): Promise<void> {
  const study = await findStudy(viewer, projectId, studyId);
  assertControl(viewer, study);
  const entry = getActiveStudy();
  if (entry && entry.studyId === studyId) await stopAndWait(entry);
  await removeStudyArtefacts([studyId]);
  await prisma.study.delete({ where: { id: studyId } }).catch(() => undefined);
}

/**
 * Before a project or a user is deleted (the rows cascade): stop the running
 * study among `where` and remove the studies' sessions and archives. Best-effort.
 */
export async function cleanupStudies(where: Prisma.StudyWhereInput): Promise<void> {
  const studies = await prisma.study.findMany({ where, select: { id: true } });
  const ids = studies.map((s) => s.id);
  const entry = getActiveStudy();
  if (entry && ids.includes(entry.studyId)) await stopAndWait(entry).catch(() => undefined);
  await removeStudyArtefacts(ids).catch(() => undefined);
}
