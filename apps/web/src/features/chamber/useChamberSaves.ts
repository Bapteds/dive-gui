import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createChamberSave,
  deleteChamberSave,
  listChamberSaves,
  updateChamberSave,
} from '@/lib/api/chamberSaves';
import type { ChamberInput, ChamberSaveSummary } from '@/lib/api/types';

/**
 * useChamberSaves - React Query hooks for saved chamber builds. One shared
 * list (small: names + snapshots); every mutation invalidates it so the
 * dropdown always reflects the server.
 */

export const chamberSavesKey = ['chamber', 'saves'] as const;

/** The shared saved-builds list, newest-updated first. */
export function useChamberSavesQuery() {
  return useQuery<ChamberSaveSummary[]>({
    queryKey: chamberSavesKey,
    queryFn: listChamberSaves,
  });
}

/** Create a save (also used for Duplicate: post the source snapshot under a new name). */
export function useCreateChamberSave() {
  const queryClient = useQueryClient();
  return useMutation<ChamberSaveSummary, Error, { name: string; snapshot: ChamberInput }>({
    mutationFn: createChamberSave,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chamberSavesKey }),
  });
}

/** Overwrite the snapshot and/or rename a save. */
export function useUpdateChamberSave() {
  const queryClient = useQueryClient();
  return useMutation<
    ChamberSaveSummary,
    Error,
    { id: string; name?: string; snapshot?: ChamberInput }
  >({
    mutationFn: ({ id, ...body }) => updateChamberSave(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chamberSavesKey }),
  });
}

/** Delete a save. */
export function useDeleteChamberSave() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteChamberSave,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chamberSavesKey }),
  });
}
