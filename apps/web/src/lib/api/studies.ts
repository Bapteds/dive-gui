import type {
  CreateStudyRequest,
  PublicStudy,
  StudyDetail,
  StudyEvaluation,
  StudyEvaluationMetrics,
  StudySetup,
} from '@dive/shared';
import { apiClient } from './client';

/**
 * studies.ts - optimisation studies of a project (WS-H, "Optimisation" tab):
 * `/projects/:id/studies[...]`. Visibility follows the project; editing,
 * starting, pausing, resuming and deleting are for the study owner or a
 * super-admin (403 otherwise). One study runs at a time across the platform.
 */

const base = (projectId: string) => `/projects/${projectId}/studies`;

/** Every study of the project, newest first. */
export async function listStudies(projectId: string): Promise<PublicStudy[]> {
  const data = await apiClient.get<{ studies: PublicStudy[] }>(base(projectId));
  return data.studies;
}

/** What the creation form needs: mesh origin (+ its chamber), meshed sessions, defaults. */
export function getStudySetup(projectId: string): Promise<StudySetup> {
  return apiClient.get<StudySetup>(`${base(projectId)}/setup`);
}

/** Create a draft study (201). 422 VALIDATION_ERROR explains an empty range or a bad session. */
export async function createStudy(
  projectId: string,
  body: CreateStudyRequest,
): Promise<PublicStudy> {
  const data = await apiClient.post<{ study: PublicStudy }>(base(projectId), body);
  return data.study;
}

/** Edit a draft (409 STUDY_NOT_DRAFT once started). */
export async function updateStudy(
  projectId: string,
  studyId: string,
  body: Partial<CreateStudyRequest>,
): Promise<PublicStudy> {
  const data = await apiClient.patch<{ study: PublicStudy }>(`${base(projectId)}/${studyId}`, body);
  return data.study;
}

/** A study with its evaluations, best evaluation and Pareto front. */
export function getStudy(projectId: string, studyId: string): Promise<StudyDetail> {
  return apiClient.get<StudyDetail>(`${base(projectId)}/${studyId}`);
}

/** Start a draft (202). 409 STUDY_IN_PROGRESS / FREE_SURFACE_IN_PROGRESS / RUN_IN_PROGRESS. */
export async function startStudy(projectId: string, studyId: string): Promise<PublicStudy> {
  const data = await apiClient.post<{ study: PublicStudy }>(`${base(projectId)}/${studyId}/start`);
  return data.study;
}

/** Pause (running -> pausing -> paused). Idempotent. */
export async function stopStudy(projectId: string, studyId: string): Promise<PublicStudy> {
  const data = await apiClient.post<{ study: PublicStudy }>(`${base(projectId)}/${studyId}/stop`);
  return data.study;
}

/** Resume a paused study (202): the interrupted design is evaluated first. */
export async function resumeStudy(projectId: string, studyId: string): Promise<PublicStudy> {
  const data = await apiClient.post<{ study: PublicStudy }>(`${base(projectId)}/${studyId}/resume`);
  return data.study;
}

/** Delete a study (pauses it first; removes its meshing sessions and archive). */
export async function deleteStudy(projectId: string, studyId: string): Promise<void> {
  await apiClient.delete<void>(`${base(projectId)}/${studyId}`);
}

/** One evaluation with its archived series. */
export function getStudyEvaluation(
  projectId: string,
  studyId: string,
  index: number,
): Promise<{ evaluation: StudyEvaluation; metrics: StudyEvaluationMetrics | null }> {
  return apiClient.get(`${base(projectId)}/${studyId}/evaluations/${index}`);
}

/** The study as CSV (one row per evaluation). */
export function downloadStudyCsv(projectId: string, studyId: string): Promise<Blob> {
  return apiClient.getBlob(`${base(projectId)}/${studyId}/export.csv`);
}
