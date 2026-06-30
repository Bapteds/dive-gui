import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteMesh,
  getMergePlan,
  importMeshFile,
  importMeshFolder,
  importMeshZip,
  listMeshes,
  runMerge,
} from '@/lib/api/meshes';
import type {
  DeleteMeshResponse,
  ImportMeshResponse,
  MergePlan,
  MergeRunResult,
  MeshSource,
} from '@/lib/api/types';
import { caseFilesQueryKey } from '@/features/projects/useCaseFiles';

/**
 * useMeshes - React Query hooks for a project's mesh library and the merge
 * pipeline.
 *
 * The library is cached per project; import/delete write the refreshed list
 * straight back into the cache. A successful merge writes a new combined mesh
 * into the case, so it refreshes that project's case-tree cache and drops stale
 * per-file content caches (mirrors useConvertToFoam).
 */

/** Query key for a project's imported mesh library. */
export const meshesQueryKey = (projectId: string) => ['projects', projectId, 'meshes'] as const;

/** Query key for a project's last-saved merge plan. */
export const mergePlanQueryKey = (projectId: string) =>
  ['projects', projectId, 'mergePlan'] as const;

/** Load the project's mesh library (sources + their patches). */
export function useMeshesQuery(projectId: string) {
  return useQuery<MeshSource[]>({
    queryKey: meshesQueryKey(projectId),
    queryFn: () => listMeshes(projectId),
  });
}

/** Load the last-saved merge plan, used to pre-fill the dialog when reopened. */
export function useMergePlanQuery(projectId: string) {
  return useQuery<MergePlan | null>({
    queryKey: mergePlanQueryKey(projectId),
    queryFn: () => getMergePlan(projectId),
  });
}

/** Import a polyMesh (folder/.zip) or a .cgns/.msh file, then refresh the list cache. */
export function useImportMesh(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    ImportMeshResponse,
    Error,
    { kind: 'folder'; files: File[] } | { kind: 'zip'; file: File } | { kind: 'file'; file: File }
  >({
    mutationFn: (input) =>
      input.kind === 'folder'
        ? importMeshFolder(projectId, input.files)
        : input.kind === 'zip'
          ? importMeshZip(projectId, input.file)
          : importMeshFile(projectId, input.file),
    onSuccess: (result) => {
      queryClient.setQueryData(meshesQueryKey(projectId), result.meshes);
    },
  });
}

/** Delete a mesh source, then write the refreshed list into the cache. */
export function useDeleteMesh(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteMeshResponse, Error, { meshId: string }>({
    mutationFn: ({ meshId }) => deleteMesh(projectId, meshId),
    onSuccess: (result) => {
      queryClient.setQueryData(meshesQueryKey(projectId), result.meshes);
    },
  });
}

/**
 * Run the merge. On success the case mesh changed, so refresh the case tree and
 * drop stale file-content caches. The mutation resolves even when the pipeline
 * itself failed (result.success === false) - only validation errors reject - so
 * callers inspect result.success, not just onError.
 */
export function useRunMerge(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MergeRunResult, Error, MergePlan>({
    mutationFn: (plan) => runMerge(projectId, plan),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
        queryClient.removeQueries({ queryKey: [...caseFilesQueryKey(projectId), 'content'] });
      }
    },
  });
}
