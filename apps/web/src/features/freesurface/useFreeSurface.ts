import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isFreeSurfaceJobActive,
  type FreeSurfaceJob,
  type FreeSurfaceOverview,
  type FreeSurfaceStartRequest,
} from '@dive/shared';
import {
  deleteFreeSurfaceJob,
  getFreeSurface,
  getFreeSurfaceJob,
  startFreeSurface,
  stopFreeSurfaceJob,
  type FreeSurfaceSelection,
} from '@/lib/api/projects';

/**
 * useFreeSurface - React Query hooks of the "Free surface" tab (WS-I).
 *
 * The overview (readiness checks for the current selection, defaults, mesh
 * origin, jobs) and the shown job are polled while a job runs, then polling
 * stops on a terminal status. Every poll is a full authenticated GET.
 */

/** Poll cadence while a job runs (stages last seconds to hours). */
const POLL_MS = 2000;

export const freeSurfaceQueryKey = (projectId: string) =>
  ['projects', projectId, 'free-surface'] as const;
export const freeSurfaceOverviewQueryKey = (projectId: string, selection: FreeSurfaceSelection) =>
  [...freeSurfaceQueryKey(projectId), 'overview', selection] as const;
export const freeSurfaceJobQueryKey = (projectId: string, jobId: string) =>
  [...freeSurfaceQueryKey(projectId), 'job', jobId] as const;

/** Readiness + jobs for a selection; polls while a job is running. */
export function useFreeSurfaceQuery(projectId: string, selection: FreeSurfaceSelection) {
  return useQuery<FreeSurfaceOverview>({
    queryKey: freeSurfaceOverviewQueryKey(projectId, selection),
    queryFn: () => getFreeSurface(projectId, selection),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => isFreeSurfaceJobActive(job.status)) ? POLL_MS : false,
  });
}

/** One job; polls while it runs (and while no data has arrived yet). */
export function useFreeSurfaceJobQuery(projectId: string, jobId: string | null) {
  return useQuery<FreeSurfaceJob>({
    queryKey: freeSurfaceJobQueryKey(projectId, jobId ?? ''),
    queryFn: () => getFreeSurfaceJob(projectId, jobId as string),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || isFreeSurfaceJobActive(status) ? POLL_MS : false;
    },
  });
}

/** Start a job: cache the job, refresh the overview (and the case views it changes). */
export function useStartFreeSurface(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<FreeSurfaceJob, Error, FreeSurfaceStartRequest>({
    mutationFn: (body) => startFreeSurface(projectId, body),
    onSuccess: (job) => {
      queryClient.setQueryData(freeSurfaceJobQueryKey(projectId, job.id), job);
      void queryClient.invalidateQueries({
        queryKey: [...freeSurfaceQueryKey(projectId), 'overview'],
      });
    },
  });
}

/** Stop a job (idempotent). */
export function useStopFreeSurface(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<FreeSurfaceJob, Error, string>({
    mutationFn: (jobId) => stopFreeSurfaceJob(projectId, jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(freeSurfaceJobQueryKey(projectId, job.id), job);
    },
  });
}

/** Remove a finished job. */
export function useDeleteFreeSurface(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (jobId) => deleteFreeSurfaceJob(projectId, jobId),
    onSuccess: (_void, jobId) => {
      queryClient.removeQueries({ queryKey: freeSurfaceJobQueryKey(projectId, jobId) });
      void queryClient.invalidateQueries({
        queryKey: [...freeSurfaceQueryKey(projectId), 'overview'],
      });
    },
  });
}
