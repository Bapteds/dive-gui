import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  convertCgnsToFoam,
  deleteCgns,
  listCgns,
  uploadCgns,
} from '@/lib/api/conversion';
import type {
  CgnsFile,
  ConversionResult,
  ConvertCgnsInput,
  DeleteCgnsResponse,
  UploadCgnsResponse,
} from '@/lib/api/types';
import { caseFilesQueryKey } from '@/features/projects/useCaseFiles';

/**
 * useConversion - React Query hooks for a project's CGNS sources and the
 * CGNS -> OpenFOAM conversion.
 *
 * The CGNS roster is cached per project; upload/delete write the refreshed list
 * straight back into the cache. A successful conversion writes a new mesh into
 * the case, so it refreshes that project's case-tree cache and drops stale
 * per-file content caches.
 */

/** Query key for a project's CGNS source files. */
export const cgnsFilesQueryKey = (projectId: string) => ['projects', projectId, 'cgns'] as const;

/** Load the project's CGNS source files. */
export function useCgnsFilesQuery(projectId: string) {
  return useQuery<CgnsFile[]>({
    queryKey: cgnsFilesQueryKey(projectId),
    queryFn: () => listCgns(projectId),
  });
}

/** Upload a CGNS file, then write the refreshed list into the cache. */
export function useUploadCgns(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<UploadCgnsResponse, Error, File>({
    mutationFn: (file) => uploadCgns(projectId, file),
    onSuccess: (result) => {
      queryClient.setQueryData(cgnsFilesQueryKey(projectId), result.files);
    },
  });
}

/** Delete a CGNS file, then write the refreshed list into the cache. */
export function useDeleteCgns(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteCgnsResponse, Error, { name: string }>({
    mutationFn: ({ name }) => deleteCgns(projectId, name),
    onSuccess: (result) => {
      queryClient.setQueryData(cgnsFilesQueryKey(projectId), result.files);
    },
  });
}

/**
 * Run the conversion. On success the case mesh changed, so refresh the case
 * tree and drop stale file-content caches. Note: the mutation resolves even when
 * the pipeline itself failed (result.success === false) — only transport/
 * validation errors reject — so callers inspect result.success, not just onError.
 */
export function useConvertToFoam(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ConversionResult, Error, ConvertCgnsInput>({
    mutationFn: (input) => convertCgnsToFoam(projectId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
      queryClient.removeQueries({ queryKey: [...caseFilesQueryKey(projectId), 'content'] });
    },
  });
}
