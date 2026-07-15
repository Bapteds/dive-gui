// Diameter-optimization study business logic.
//
// A study is a saved morph + sweep + objective config that, once launched, runs the
// solver once per swept diameter (each realised by MORPHING the mesh, not re-meshing)
// and records the loss objective per value, to find the diameter with the least
// hydraulic loss. Persisted as a Prisma row (identity/status/progress) plus
// studies/<id>/study.json (config + samples), mirroring Run + its on-disk log.
//
// Phase 0 covers CRUD over the config; the background sweep orchestration
// (startStudy/stopStudy/reconcile) arrives in Phase 4. Access model: gated by project
// visibility (assertProjectVisible), same as runs; any member may manage a study.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  ACTIVE_STUDY_STATUSES,
  isTerminalRunStatus,
  sweepValuesM,
  type Study,
  type StudyMetric,
  type StudyMetrics,
  type StudySample,
  type StudyStatus,
  type SweepConfig,
} from '@dive/shared';
import { Prisma, type Study as StudyRow } from '@prisma/client';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { caseDirAbsolute, caseFileExists } from '../../lib/caseStorage';
import { extractCenterline, type CenterlineResult } from '../../lib/centerlineExtract';
import { runCheckMeshGate } from '../../lib/checkMeshGate';
import { morphMeshPoints } from '../../lib/meshTransform';
import {
  injectObjectiveFunctions,
  readObjective,
  removeObjectiveFunctions,
} from '../../lib/objective';
import {
  deleteStudyDir,
  readStudyDoc,
  studyOrigPointsAbsolute,
  writeStudyDoc,
  type StudyDoc,
} from '../../lib/studyStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import { getRun, startRun, stopRun } from './runs.service';
import type { CenterlineInput, CreateStudyInput, UpdateStudyInput } from './studies.schemas';

/** Assemble the wire `Study` from its Prisma row + on-disk doc. */
function toPublicStudy(row: StudyRow, doc: StudyDoc): Study {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status as StudyStatus,
    morph: doc.morph,
    sweep: doc.sweep,
    objective: doc.objective,
    samples: doc.samples,
    bestDiameterM: row.bestDiameterM ?? undefined,
    currentRunId: row.currentRunId ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
  };
}

/** Fetch a study row scoped to the project, or 404 (no cross-project leak). */
async function findStudyOrThrow(projectId: string, studyId: string): Promise<StudyRow> {
  const study = await prisma.study.findUnique({ where: { id: studyId } });
  if (!study || study.projectId !== projectId) {
    throw new AppError(404, 'STUDY_NOT_FOUND', 'Study not found');
  }
  return study;
}

/** One `pending` sample per swept diameter, in sweep order. */
function initialSamples(sweep: SweepConfig): StudySample[] {
  return sweepValuesM(sweep).map((diameterM) => ({ diameterM, status: 'pending' as const }));
}

/** A default study name based on how many studies the project already has. */
async function defaultStudyName(projectId: string): Promise<string> {
  const n = await prisma.study.count({ where: { projectId } });
  return `Étude de diamètre ${n + 1}`;
}

/** List a project's studies, newest first. */
export async function listStudies(viewer: Viewer, projectId: string): Promise<Study[]> {
  await assertProjectVisible(viewer, projectId);
  const rows = await prisma.study.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  const studies: Study[] = [];
  for (const row of rows) {
    const doc = await readStudyDoc(projectId, row.id);
    if (doc) studies.push(toPublicStudy(row, doc));
  }
  return studies;
}

/** Fetch a single study (row + on-disk doc). */
export async function getStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
): Promise<Study> {
  await assertProjectVisible(viewer, projectId);
  const row = await findStudyOrThrow(projectId, studyId);
  const doc = await readStudyDoc(projectId, studyId);
  if (!doc) throw new AppError(404, 'STUDY_NOT_FOUND', 'Study not found');
  return toPublicStudy(row, doc);
}

/** Create a draft study from a morph + sweep + objective config. */
export async function createStudy(
  viewer: Viewer,
  projectId: string,
  input: CreateStudyInput,
): Promise<Study> {
  await assertProjectVisible(viewer, projectId);
  const samples = initialSamples(input.sweep);
  const name = input.name?.trim() || (await defaultStudyName(projectId));
  const row = await prisma.study.create({
    data: { projectId, name, status: 'draft', totalSamples: samples.length, doneSamples: 0 },
  });
  const doc: StudyDoc = {
    morph: input.morph,
    sweep: input.sweep,
    objective: input.objective,
    samples,
  };
  await writeStudyDoc(projectId, row.id, doc);
  return toPublicStudy(row, doc);
}

/** Update a DRAFT study's name/config (rejected once the sweep has run). */
export async function updateStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
  input: UpdateStudyInput,
): Promise<Study> {
  await assertProjectVisible(viewer, projectId);
  const row = await findStudyOrThrow(projectId, studyId);
  if (row.status !== 'draft') {
    throw new AppError(409, 'STUDY_IN_PROGRESS', 'Only a draft study can be edited');
  }
  const doc = await readStudyDoc(projectId, studyId);
  if (!doc) throw new AppError(404, 'STUDY_NOT_FOUND', 'Study not found');
  const nextDoc: StudyDoc = {
    morph: input.morph ?? doc.morph,
    sweep: input.sweep ?? doc.sweep,
    objective: input.objective ?? doc.objective,
    // Re-seed the samples only when the sweep range changes.
    samples: input.sweep ? initialSamples(input.sweep) : doc.samples,
  };
  await writeStudyDoc(projectId, studyId, nextDoc);
  const updated = await prisma.study.update({
    where: { id: studyId },
    data: { name: input.name?.trim() || row.name, totalSamples: nextDoc.samples.length },
  });
  return toPublicStudy(updated, nextDoc);
}

/** Delete a study (row + on-disk subtree). Rejected while the sweep is active. */
export async function deleteStudy(
  viewer: Viewer,
  projectId: string,
  studyId: string,
): Promise<void> {
  await assertProjectVisible(viewer, projectId);
  const row = await findStudyOrThrow(projectId, studyId);
  if ((ACTIVE_STUDY_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError(409, 'STUDY_IN_PROGRESS', 'Stop the study before deleting it');
  }
  await prisma.study.delete({ where: { id: studyId } });
  await deleteStudyDir(projectId, studyId);
}

/**
 * Extract the pipe centerline + radius profile from the case's wall patch between the
 * two clicked endpoints, so the "Optimisation" UI can build a morph before a study
 * exists. Requires a built case mesh.
 */
export async function extractStudyCenterline(
  viewer: Viewer,
  projectId: string,
  input: CenterlineInput,
): Promise<CenterlineResult> {
  await assertProjectVisible(viewer, projectId);
  if (!(await caseFileExists(projectId, 'constant/polyMesh/points'))) {
    throw new AppError(409, 'NO_MESH', 'The project has no mesh to trace a centerline from');
  }
  return extractCenterline(
    caseDirAbsolute(projectId),
    input.wallPatch,
    input.endpointA,
    input.endpointB,
  );
}

// ---- Sweep orchestration ----------------------------------------------------
//
// Launching a study snapshots the original mesh points, injects the objective
// functionObjects into controlDict once, then runs the solver ONCE PER SWEPT
// DIAMETER in the background: restore -> morph -> checkMesh gate -> run -> poll to
// terminal -> read the loss -> record. Sequential falls out of the one-active-run
// rule. Mirrors the run lifecycle: an in-process active set + stop-request set + a
// per-project FIFO lock, terminal-guarded row writes, boot reconciliation, and a
// project-delete hook. A restart mid-sweep leaves the child run + study to be
// reconciled to `failed` on boot.

const POLL_INTERVAL_MS = 3000;
/** Study ids sweeping in THIS process (the DB row is the source of truth across restarts). */
const activeStudies = new Set<string>();
/** Study ids the user asked to stop; the sweep loop winds down and marks itself `stopped`. */
const stopRequestedStudies = new Set<string>();
/** Per-project FIFO lock, so the start-admission check is atomic against the row write. */
const studyLocks = new Map<string, Promise<unknown>>();

function studyExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = studyLocks.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  studyLocks.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The value of the objective metric that decides the optimum. */
function primaryMetricValue(metrics: StudyMetrics, primary: StudyMetric): number {
  return primary === 'headLoss' ? metrics.headLossM : metrics.pressureDropPa;
}

/** How many samples have reached a terminal (non pending/running) state. */
function countSettled(samples: StudySample[]): number {
  return samples.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
}

/**
 * Remove a case's numeric time dirs (>0), processor* and postProcessing, so the next
 * run starts fresh from 0/ (latestTime) with clean functionObject output.
 */
async function cleanRunArtifacts(caseDir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(caseDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const name = entry.name;
      const isTimeDir = /^\d+(\.\d+)?$/.test(name) && Number(name) > 0;
      const isProcessor = /^processor\d+$/.test(name);
      if (isTimeDir || isProcessor || name === 'postProcessing') {
        await fs.rm(path.join(caseDir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
}

/** Poll a run to a terminal state, honouring a study stop request (which stops it). */
async function pollRunToTerminal(
  viewer: Viewer,
  projectId: string,
  studyId: string,
  runId: string,
): Promise<string> {
  let stopSent = false;
  for (;;) {
    const run = await getRun(viewer, projectId, runId);
    if (isTerminalRunStatus(run.status)) return run.status;
    if (stopRequestedStudies.has(studyId) && !stopSent) {
      stopSent = true;
      await stopRun(viewer, projectId, runId).catch(() => undefined);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Persist the samples (disk) + denormalized progress (row); tolerant of a deleted study. */
async function persistSweep(
  projectId: string,
  studyId: string,
  doc: StudyDoc,
  extra: Prisma.StudyUpdateInput = {},
): Promise<void> {
  await writeStudyDoc(projectId, studyId, doc).catch(() => undefined);
  await prisma.study
    .update({ where: { id: studyId }, data: { doneSamples: countSettled(doc.samples), ...extra } })
    .catch(() => undefined);
}

/** Launch (or re-launch) a study's diameter sweep. Returns immediately; runs in the background. */
export async function startStudy(viewer: Viewer, projectId: string, studyId: string): Promise<Study> {
  await assertProjectVisible(viewer, projectId);
  return studyExclusive(projectId, async () => {
    const row = await findStudyOrThrow(projectId, studyId);
    if ((ACTIVE_STUDY_STATUSES as readonly string[]).includes(row.status)) {
      throw new AppError(409, 'STUDY_IN_PROGRESS', 'This study is already running');
    }
    const activeStudyCount = await prisma.study.count({
      where: { projectId, status: { in: [...ACTIVE_STUDY_STATUSES] } },
    });
    if (activeStudyCount > 0) {
      throw new AppError(409, 'STUDY_IN_PROGRESS', 'Another study is already running for this project');
    }
    const activeRunCount = await prisma.run.count({
      where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    if (activeRunCount > 0) {
      throw new AppError(409, 'RUN_IN_PROGRESS', 'A solver run is active; stop it before starting a study');
    }
    if (!(await caseFileExists(projectId, 'constant/polyMesh/points'))) {
      throw new AppError(409, 'NO_MESH', 'The project has no mesh to morph');
    }
    const doc = await readStudyDoc(projectId, studyId);
    if (!doc) throw new AppError(404, 'STUDY_NOT_FOUND', 'Study not found');

    // Reset the samples (this may be a re-run) and mark the study queued.
    doc.samples = doc.samples.map((s) => ({ diameterM: s.diameterM, status: 'pending' as const }));
    await writeStudyDoc(projectId, studyId, doc);
    const updated = await prisma.study.update({
      where: { id: studyId },
      data: {
        status: 'queued',
        doneSamples: 0,
        bestDiameterM: null,
        reason: null,
        currentRunId: null,
        startedAt: new Date(),
        finishedAt: null,
      },
    });

    stopRequestedStudies.delete(studyId);
    activeStudies.add(studyId);
    void runSweep(viewer, projectId, studyId)
      .catch((err) => logger.error(`Study sweep ${studyId} crashed`, err))
      .finally(() => {
        activeStudies.delete(studyId);
        stopRequestedStudies.delete(studyId);
      });
    return toPublicStudy(updated, doc);
  });
}

/** The background sweep loop (fire-and-forget from startStudy). */
async function runSweep(viewer: Viewer, projectId: string, studyId: string): Promise<void> {
  const caseDir = caseDirAbsolute(projectId);
  const pointsPath = path.join(caseDir, 'constant', 'polyMesh', 'points');
  const controlDictPath = path.join(caseDir, 'system', 'controlDict');
  const doc = await readStudyDoc(projectId, studyId);
  if (!doc) return;

  // 1) Snapshot the pristine points + inject the objective functionObjects.
  let original: Buffer;
  try {
    original = await fs.readFile(pointsPath);
  } catch {
    await prisma.study
      .update({
        where: { id: studyId },
        data: { status: 'failed', reason: 'points file missing', finishedAt: new Date(), currentRunId: null },
      })
      .catch(() => undefined);
    return;
  }
  const origAbs = studyOrigPointsAbsolute(projectId, studyId);
  await fs.mkdir(path.dirname(origAbs), { recursive: true });
  await fs.writeFile(origAbs, original);
  try {
    const controlDict = await fs.readFile(controlDictPath, 'utf8');
    await fs.writeFile(
      controlDictPath,
      injectObjectiveFunctions(controlDict, doc.objective.inletPatch, doc.objective.outletPatch),
    );
  } catch {
    /* no controlDict — the run will fail per-sample, surfaced there */
  }
  await prisma.study.update({ where: { id: studyId }, data: { status: 'running' } }).catch(() => undefined);

  let bestValue = Number.POSITIVE_INFINITY;
  let bestDiameter: number | null = null;

  // 2) One solver run per swept diameter, sequential.
  for (let i = 0; i < doc.samples.length; i += 1) {
    if (stopRequestedStudies.has(studyId)) break;
    const diameterM = doc.samples[i].diameterM;

    // a) Morph from the pristine original (never compound).
    await fs.writeFile(pointsPath, morphMeshPoints(original, doc.morph, diameterM));

    // b) checkMesh gate — skip a value whose morph inverts cells.
    const gate = await runCheckMeshGate(caseDir);
    if (!gate.ok) {
      doc.samples[i] = { diameterM, status: 'meshFailed', note: gate.note };
      await persistSweep(projectId, studyId, doc);
      continue;
    }

    // c) Fresh run (clean prior time dirs + FO output so we read only this solve).
    await cleanRunArtifacts(caseDir);
    let runId: string;
    try {
      const run = await startRun(viewer, projectId, {});
      runId = run.id;
    } catch (err) {
      doc.samples[i] = {
        diameterM,
        status: 'failed',
        note: err instanceof Error ? err.message : 'run failed to start',
      };
      await persistSweep(projectId, studyId, doc);
      continue;
    }
    doc.samples[i] = { diameterM, status: 'running', runId };
    await persistSweep(projectId, studyId, doc, { currentRunId: runId });

    // d) Await terminal, then read the objective.
    const finalStatus = await pollRunToTerminal(viewer, projectId, studyId, runId);
    if (finalStatus === 'converged' || finalStatus === 'completed') {
      const metrics = await readObjective(caseDir, doc.objective.densityKgM3);
      if (metrics) {
        doc.samples[i] = { diameterM, status: 'done', runId, metrics };
        const value = primaryMetricValue(metrics, doc.objective.primary);
        if (value < bestValue) {
          bestValue = value;
          bestDiameter = diameterM;
        }
      } else {
        doc.samples[i] = {
          diameterM,
          status: 'failed',
          runId,
          note: 'objective output not found (check the inlet/outlet patch names)',
        };
      }
    } else if (finalStatus === 'stopped') {
      doc.samples[i] = { diameterM, status: 'skipped', runId, note: 'run stopped' };
    } else {
      doc.samples[i] = { diameterM, status: 'failed', runId, note: `run ${finalStatus}` };
    }
    await persistSweep(projectId, studyId, doc, { currentRunId: null, bestDiameterM: bestDiameter });
  }

  // Any samples never reached (stopped early) become `skipped`.
  for (let i = 0; i < doc.samples.length; i += 1) {
    if (doc.samples[i].status === 'pending') {
      doc.samples[i] = { diameterM: doc.samples[i].diameterM, status: 'skipped', note: 'not reached' };
    }
  }

  // 3) Restore the original mesh + strip the objective FOs (leave the case as found).
  await fs.writeFile(pointsPath, original).catch(() => undefined);
  await cleanRunArtifacts(caseDir);
  try {
    const controlDict = await fs.readFile(controlDictPath, 'utf8');
    await fs.writeFile(controlDictPath, removeObjectiveFunctions(controlDict));
  } catch {
    /* best-effort cleanup */
  }

  // 4) Finalize.
  const stopped = stopRequestedStudies.has(studyId);
  const anyDone = doc.samples.some((s) => s.status === 'done');
  const status: StudyStatus = stopped ? 'stopped' : anyDone ? 'completed' : 'failed';
  await writeStudyDoc(projectId, studyId, doc).catch(() => undefined);
  await prisma.study
    .update({
      where: { id: studyId },
      data: {
        status,
        finishedAt: new Date(),
        currentRunId: null,
        bestDiameterM: bestDiameter,
        doneSamples: countSettled(doc.samples),
        reason: stopped ? 'stopped by user' : anyDone ? null : 'no diameter produced a result',
      },
    })
    .catch(() => undefined);
}

/** Stop a running study: request the wind-down and stop its current child run. */
export async function stopStudy(viewer: Viewer, projectId: string, studyId: string): Promise<Study> {
  await assertProjectVisible(viewer, projectId);
  const row = await findStudyOrThrow(projectId, studyId);
  if ((ACTIVE_STUDY_STATUSES as readonly string[]).includes(row.status)) {
    stopRequestedStudies.add(studyId);
    if (row.currentRunId) {
      await stopRun(viewer, projectId, row.currentRunId).catch(() => undefined);
    }
  }
  return getStudy(viewer, projectId, studyId);
}

/**
 * Boot reconciliation: a sweep is tied to this process, so any study still marked
 * active in the DB belongs to a previous, now-dead process. Mark such orphans failed
 * (their child run is reconciled by reconcileOrphanRuns). Returns the count.
 */
export async function reconcileOrphanStudies(): Promise<number> {
  const orphans = await prisma.study.findMany({
    where: { status: { in: [...ACTIVE_STUDY_STATUSES] } },
    select: { id: true },
  });
  let count = 0;
  for (const orphan of orphans) {
    if (activeStudies.has(orphan.id)) continue; // owned by this live process
    await prisma.study
      .update({
        where: { id: orphan.id },
        data: {
          status: 'failed',
          reason: 'interrupted by a server restart',
          finishedAt: new Date(),
          currentRunId: null,
        },
      })
      .catch(() => undefined);
    count += 1;
  }
  return count;
}

/** Request every active study of a project to stop (used when the project is deleted). */
export async function stopProjectStudies(projectId: string): Promise<void> {
  const active = await prisma.study.findMany({
    where: { projectId, status: { in: [...ACTIVE_STUDY_STATUSES] } },
    select: { id: true },
  });
  for (const s of active) stopRequestedStudies.add(s.id);
}
