import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CfdCriteriaResponse,
  CfdCriteriaSettings,
  SaveCfdCriteriaResponse,
  VortexMetricsSample,
} from '@dive/shared';
import { computeVortexMetrics, getCriteria, saveCriteria } from '@/lib/api/projects';

/**
 * useCriteria - React Query hooks for the Solver tab's convergence criteria and
 * vortex metrics (WS-G). The settings are per project; the server installs them
 * into the case on save and at every run start.
 */

export const criteriaQueryKey = (projectId: string) =>
  ['projects', projectId, 'criteria'] as const;

/** The project's criteria (or defaults), its mesh patches and whether they apply. */
export function useCriteriaQuery(projectId: string, enabled = true) {
  return useQuery<CfdCriteriaResponse>({
    queryKey: criteriaQueryKey(projectId),
    queryFn: () => getCriteria(projectId),
    enabled,
    staleTime: 10_000,
  });
}

/** Save the criteria; the cache takes the server's echo (no refetch needed). */
export function useSaveCriteria(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<SaveCfdCriteriaResponse, Error, CfdCriteriaSettings>({
    mutationFn: (criteria) => saveCriteria(projectId, criteria),
    onSuccess: (result) => {
      queryClient.setQueryData<CfdCriteriaResponse>(criteriaQueryKey(projectId), (current) =>
        current ? { ...current, criteria: result.criteria, installed: result.installed } : current,
      );
      // The install rewrote system/ files: keep the case tree / editors in sync.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
    },
  });
}

/** Compute the vortex metrics at the latest time (server post-process). */
export function useComputeVortex(projectId: string) {
  return useMutation<VortexMetricsSample, Error, void>({
    mutationFn: () => computeVortexMetrics(projectId),
  });
}
