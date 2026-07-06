import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApplyBoundaryConditionsRequest, ApplyBoundaryConditionsResult } from '@dive/shared';
import { applyBoundaryConditions } from '@/lib/api/boundary';
import {
  meshBackupQueryKey,
  meshEdgesQueryKey,
  meshGeometryQueryKey,
  meshManifestQueryKey,
} from '@/features/visualize/useMesh';

/**
 * useBoundaryConditions - React Query hook for the "boundary conditions" overlay.
 */

/** Input to the apply mutation: the plan + the optional draft-tube CSV. */
export interface ApplyBoundaryInput {
  request: ApplyBoundaryConditionsRequest;
  csv?: File | null;
}

/**
 * Apply a component BC preset. The boundary file (wall types) and the 0/ fields
 * change server-side, and the first apply captures the mesh backup, so drop the
 * cached render (rebuilt on the next manifest fetch) and refresh the case tree +
 * backup status. The mutation resolves even when the CSV -> boundaryData step
 * failed (result.success is about the apply, not the toolchain), so callers read
 * result.notes / result.csvSteps rather than only onError.
 */
export function useApplyBoundaryConditions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ApplyBoundaryConditionsResult, Error, ApplyBoundaryInput>({
    mutationFn: ({ request, csv }) => applyBoundaryConditions(projectId, request, csv),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      void queryClient.invalidateQueries({ queryKey: meshBackupQueryKey(projectId) });
    },
  });
}
