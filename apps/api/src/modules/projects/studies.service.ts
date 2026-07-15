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
import {
  ACTIVE_STUDY_STATUSES,
  sweepValuesM,
  type Study,
  type StudySample,
  type StudyStatus,
  type SweepConfig,
} from '@dive/shared';
import type { Study as StudyRow } from '@prisma/client';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import { deleteStudyDir, readStudyDoc, writeStudyDoc, type StudyDoc } from '../../lib/studyStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import type { CreateStudyInput, UpdateStudyInput } from './studies.schemas';

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
