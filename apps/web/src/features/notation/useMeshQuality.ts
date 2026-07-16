import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMeshQuality, runMeshQuality } from '@/lib/api/projects';
import type { MeshQualityResult } from '@/lib/api/types';

/**
 * useMeshQuality - React Query hooks for the "Notation" (mesh quality) tab.
 *
 * The status query serves the last persisted rating (null until one has run);
 * the mutation runs checkMesh -allGeometry server-side and writes the fresh
 * rating back into the cache. A poor mesh still RESOLVES - the rating is the
 * result - so the UI inspects the grades, not just onError.
 */

/** Query key for a project's persisted mesh quality rating. */
export const meshQualityQueryKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'quality'] as const;

/**
 * Mutation key for the rating RUN. Keyed so the in-flight state is observable
 * globally (useIsRating) and survives the tab being unmounted on a tab switch -
 * a component-local mutation would reset to idle on remount and re-enable the
 * button, inviting a second concurrent checkMesh over the same case.
 */
export const meshQualityMutationKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'quality', 'run'] as const;

/** Load the last persisted rating (or null when none has run yet). */
export function useMeshQualityQuery(projectId: string, enabled = true) {
  return useQuery<MeshQualityResult | null>({
    queryKey: meshQualityQueryKey(projectId),
    queryFn: () => getMeshQuality(projectId),
    enabled,
  });
}

/** Run checkMesh -allGeometry and grade the case mesh; refresh the cached rating. */
export function useRunMeshQuality(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshQualityResult, Error>({
    mutationKey: meshQualityMutationKey(projectId),
    mutationFn: () => runMeshQuality(projectId),
    onSuccess: (quality) => {
      queryClient.setQueryData<MeshQualityResult | null>(meshQualityQueryKey(projectId), quality);
    },
  });
}

/** Is a rating run in flight for this project? (read from the mutation cache) */
export function useIsRating(projectId: string): boolean {
  return useIsMutating({ mutationKey: meshQualityMutationKey(projectId) }) > 0;
}
