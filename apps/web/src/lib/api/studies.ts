import { apiClient } from './client';
import type {
  MorphDefinition,
  ObjectiveConfig,
  StudiesResponse,
  Study,
  StudyResponse,
  SweepConfig,
} from './types';

/**
 * studies.ts - diameter-optimization ("Optimisation" tab) endpoints
 * (authenticated, project-visibility scoped). Typed wrappers around
 * `/projects/:id/studies`.
 */

/** The morph + sweep + objective config sent to create or edit a study. */
export interface StudyConfigInput {
  name?: string;
  morph: MorphDefinition;
  sweep: SweepConfig;
  objective: ObjectiveConfig;
}

/** List the project's optimization studies (newest first). */
export async function listStudies(projectId: string): Promise<Study[]> {
  const data = await apiClient.get<StudiesResponse>(`/projects/${projectId}/studies`);
  return data.studies;
}

/** Fetch a single study (config + per-value samples). */
export async function getStudy(projectId: string, studyId: string): Promise<Study> {
  const data = await apiClient.get<StudyResponse>(`/projects/${projectId}/studies/${studyId}`);
  return data.study;
}

/** Create a draft study from a morph + sweep + objective config. */
export async function createStudy(projectId: string, config: StudyConfigInput): Promise<Study> {
  const data = await apiClient.post<StudyResponse>(`/projects/${projectId}/studies`, config);
  return data.study;
}

/** Edit a draft study (any subset of name / morph / sweep / objective). */
export async function updateStudy(
  projectId: string,
  studyId: string,
  config: Partial<StudyConfigInput>,
): Promise<Study> {
  const data = await apiClient.put<StudyResponse>(
    `/projects/${projectId}/studies/${studyId}`,
    config,
  );
  return data.study;
}

/** Delete a study. */
export async function deleteStudy(projectId: string, studyId: string): Promise<void> {
  await apiClient.delete<void>(`/projects/${projectId}/studies/${studyId}`);
}
