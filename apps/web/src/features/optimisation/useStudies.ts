import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateStudyRequest,
  PublicStudy,
  StudyDetail,
  StudySetup,
  StudyStatus,
} from '@dive/shared';
import {
  createStudy,
  deleteStudy,
  getStudy,
  getStudySetup,
  listStudies,
  resumeStudy,
  startStudy,
  stopStudy,
  updateStudy,
} from '@/lib/api/studies';

/**
 * useStudies - React Query hooks of the project's "Optimisation" tab (WS-H).
 *
 * The list and the shown study are polled while a study runs (an evaluation
 * lasts minutes to hours, the stage changes are what the tab follows), then
 * polling stops on a terminal status. After a control mutation the study cache
 * takes the server response and the list is invalidated.
 */

/** Poll cadence while a study runs. */
const POLL_MS = 3000;

/** Statuses during which the runner works (polled). */
export function isStudyActive(status: StudyStatus): boolean {
  return status === 'running' || status === 'pausing';
}

export const studiesQueryKey = (projectId: string) => ['projects', projectId, 'studies'] as const;
export const studiesListQueryKey = (projectId: string) =>
  [...studiesQueryKey(projectId), 'list'] as const;
export const studySetupQueryKey = (projectId: string) =>
  [...studiesQueryKey(projectId), 'setup'] as const;
export const studyQueryKey = (projectId: string, studyId: string) =>
  [...studiesQueryKey(projectId), 'detail', studyId] as const;

/** The project's studies; polls while one of them runs. */
export function useStudiesQuery(projectId: string) {
  return useQuery<PublicStudy[]>({
    queryKey: studiesListQueryKey(projectId),
    queryFn: () => listStudies(projectId),
    refetchInterval: (query) =>
      query.state.data?.some((s) => isStudyActive(s.status)) ? POLL_MS : false,
  });
}

/** The creation form's context (mesh origin, meshed sessions, defaults). */
export function useStudySetupQuery(projectId: string, enabled = true) {
  return useQuery<StudySetup>({
    queryKey: studySetupQueryKey(projectId),
    queryFn: () => getStudySetup(projectId),
    enabled,
  });
}

/** One study with its evaluations; polls while it runs (and while no data has arrived). */
export function useStudyQuery(projectId: string, studyId: string | null) {
  return useQuery<StudyDetail>({
    queryKey: studyQueryKey(projectId, studyId ?? ''),
    queryFn: () => getStudy(projectId, studyId as string),
    enabled: !!studyId,
    refetchInterval: (query) => {
      const status = query.state.data?.study.status;
      return status === undefined || isStudyActive(status) ? POLL_MS : false;
    },
  });
}

/** Refresh the list and the detail of a study after a mutation. */
function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return (study: PublicStudy) => {
    queryClient.setQueryData<StudyDetail>(studyQueryKey(projectId, study.id), (prev) =>
      prev ? { ...prev, study } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: studyQueryKey(projectId, study.id) });
    void queryClient.invalidateQueries({ queryKey: studiesListQueryKey(projectId) });
  };
}

/** Create a draft. */
export function useCreateStudy(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation<PublicStudy, Error, CreateStudyRequest>({
    mutationFn: (body) => createStudy(projectId, body),
    onSuccess: refresh,
  });
}

/** Edit a draft. */
export function useUpdateStudy(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation<PublicStudy, Error, { studyId: string; body: Partial<CreateStudyRequest> }>({
    mutationFn: ({ studyId, body }) => updateStudy(projectId, studyId, body),
    onSuccess: refresh,
  });
}

/** Start, pause or resume. */
export function useStudyControl(projectId: string) {
  const refresh = useRefresh(projectId);
  const queryClient = useQueryClient();
  return useMutation<PublicStudy, Error, { studyId: string; action: 'start' | 'stop' | 'resume' }>({
    mutationFn: ({ studyId, action }) =>
      action === 'start'
        ? startStudy(projectId, studyId)
        : action === 'resume'
          ? resumeStudy(projectId, studyId)
          : stopStudy(projectId, studyId),
    onSuccess: (study) => {
      refresh(study);
      // The study now owns (or releases) the project case: runs and files change.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'runs'] });
    },
  });
}

/** Delete a study. */
export function useDeleteStudy(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (studyId) => deleteStudy(projectId, studyId),
    onSuccess: (_void, studyId) => {
      queryClient.removeQueries({ queryKey: studyQueryKey(projectId, studyId) });
      void queryClient.invalidateQueries({ queryKey: studiesListQueryKey(projectId) });
    },
  });
}
