import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudy,
  deleteStudy,
  extractCenterline,
  getStudy,
  listStudies,
  runStudy,
  stopStudy,
  updateStudy,
  type CenterlineResult,
  type StudyConfigInput,
} from '@/lib/api/studies';
import type { Study, StudyStatus } from '@/lib/api/types';

/**
 * useOptimisation - React Query hooks for the "Optimisation" tab.
 *
 * A diameter sweep is a long-running background job (one solver run per swept
 * value). Like the Solver tab, the server does not push: the client POLLS the
 * study while it is active (queued/running) and stops the moment it reaches a
 * terminal status, so an idle tab makes no network noise. Reload-proof: every poll
 * is a full authenticated GET.
 */

/** Poll cadence while a study sweep is active (a touch slower than the run log). */
const POLL_MS = 2000;

/** Study statuses that are still executing (keep polling while one of these). */
const ACTIVE_STATUSES: readonly StudyStatus[] = ['queued', 'running'];

/** Is this study status still active (worth polling)? */
export function isStudyActive(status: StudyStatus | undefined): boolean {
  return status !== undefined && ACTIVE_STATUSES.includes(status);
}

export const studiesQueryKey = (projectId: string) =>
  ['projects', projectId, 'studies'] as const;
export const studyQueryKey = (projectId: string, studyId: string) =>
  ['projects', projectId, 'studies', studyId] as const;

/** List the project's studies. Polls while any study is active. */
export function useStudiesQuery(projectId: string, enabled = true) {
  return useQuery<Study[]>({
    queryKey: studiesQueryKey(projectId),
    queryFn: () => listStudies(projectId),
    enabled,
    refetchInterval: (query) => {
      const studies = query.state.data;
      if (!studies) return POLL_MS; // keep polling through an initial/failed fetch
      return studies.some((s) => isStudyActive(s.status)) ? POLL_MS : false;
    },
  });
}

/** Fetch one study (config + per-value samples). Polls while it is active. */
export function useStudyQuery(projectId: string, studyId: string | null) {
  return useQuery<Study>({
    queryKey: studyQueryKey(projectId, studyId ?? 'none'),
    queryFn: () => getStudy(projectId, studyId as string),
    enabled: !!studyId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && !isStudyActive(status)) return false;
      return POLL_MS;
    },
  });
}

/** Create a draft study; refresh the list and prime the study cache. */
export function useCreateStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<Study, Error, StudyConfigInput>({
    mutationFn: (config) => createStudy(projectId, config),
    onSuccess: (study) => {
      queryClient.setQueryData(studyQueryKey(projectId, study.id), study);
      void queryClient.invalidateQueries({ queryKey: studiesQueryKey(projectId) });
    },
  });
}

/** Edit a draft study. */
export function useUpdateStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<Study, Error, { studyId: string; config: Partial<StudyConfigInput> }>({
    mutationFn: ({ studyId, config }) => updateStudy(projectId, studyId, config),
    onSuccess: (study) => {
      queryClient.setQueryData(studyQueryKey(projectId, study.id), study);
      void queryClient.invalidateQueries({ queryKey: studiesQueryKey(projectId) });
    },
  });
}

/** Delete a study. */
export function useDeleteStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (studyId) => deleteStudy(projectId, studyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studiesQueryKey(projectId) });
    },
  });
}

/** Launch a study's sweep, then refresh so it flips to its running state. */
export function useRunStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<Study, Error, string>({
    mutationFn: (studyId) => runStudy(projectId, studyId),
    onSuccess: (study) => {
      queryClient.setQueryData(studyQueryKey(projectId, study.id), study);
      void queryClient.invalidateQueries({ queryKey: studiesQueryKey(projectId) });
    },
  });
}

/** Stop a running sweep. */
export function useStopStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<Study, Error, string>({
    mutationFn: (studyId) => stopStudy(projectId, studyId),
    onSuccess: (study) => {
      queryClient.setQueryData(studyQueryKey(projectId, study.id), study);
      void queryClient.invalidateQueries({ queryKey: studiesQueryKey(projectId) });
    },
  });
}

/** Trace the pipe centerline from the wall patch + two endpoints (study prep). */
export function useExtractCenterline(projectId: string) {
  return useMutation<
    CenterlineResult,
    Error,
    { wallPatch: string; endpointA: [number, number, number]; endpointB: [number, number, number] }
  >({
    mutationFn: ({ wallPatch, endpointA, endpointB }) =>
      extractCenterline(projectId, wallPatch, endpointA, endpointB),
  });
}
