import { apiClient } from './client';
import type {
  Centerline,
  MorphDefinition,
  ObjectiveConfig,
  StudiesResponse,
  Study,
  StudyResponse,
  SweepConfig,
} from './types';

/** Channel shape the axis is fitted as. */
export type ChannelShape = 'auto' | 'straight' | 'ring';

/** Result of the centerline-extraction helper (POST /studies/centerline). */
export interface CenterlineResult {
  centerline: Centerline;
  /** Mean wall radius (metres) at each centerline point; diameter = 2*radius. */
  radii: number[];
  /** Total polyline arc-length (metres). */
  length: number;
  /** The shape actually fitted (auto resolves to one of these). */
  shape: 'straight' | 'ring';
  /** True when the axis is a closed loop (a ring). */
  closed: boolean;
}

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

/** Launch a study's diameter sweep (returns the queued study; it runs in the background). */
export async function runStudy(projectId: string, studyId: string): Promise<Study> {
  const data = await apiClient.post<StudyResponse>(`/projects/${projectId}/studies/${studyId}/run`);
  return data.study;
}

/** Stop a running study sweep. */
export async function stopStudy(projectId: string, studyId: string): Promise<Study> {
  const data = await apiClient.post<StudyResponse>(`/projects/${projectId}/studies/${studyId}/stop`);
  return data.study;
}

/**
 * Fit the channel centerline + radius profile to the case's wall patch as `shape`
 * (study prep, before a study exists). Optional A/B hint points reposition/clip the
 * fitted axis (both or neither).
 */
export async function extractCenterline(
  projectId: string,
  wallPatch: string,
  shape: ChannelShape,
  endpointA?: [number, number, number],
  endpointB?: [number, number, number],
): Promise<CenterlineResult> {
  return apiClient.post<CenterlineResult>(`/projects/${projectId}/studies/centerline`, {
    wallPatch,
    shape,
    endpointA,
    endpointB,
  });
}
