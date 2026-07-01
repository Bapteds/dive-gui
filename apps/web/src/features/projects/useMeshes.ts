import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  autoPatchMeshSource,
  deleteMesh,
  editMeshSourcePatches,
  getAssembly,
  getMergePlan,
  importMeshFile,
  importMeshFolder,
  importMeshZip,
  listMeshes,
  renameMeshSourcePatch,
  runMerge,
} from '@/lib/api/meshes';
import { restoreMeshBackup } from '@/lib/api/projects';
import type {
  AppliedAssembly,
  AutoPatchMeshSourceResponse,
  DeleteMeshResponse,
  EditMeshSourcePatchesResponse,
  ImportMeshResponse,
  MergePlan,
  MergeRunResult,
  MeshManifest,
  MeshPatchEdit,
  MeshSource,
  RenameMeshSourcePatchResponse,
} from '@/lib/api/types';
import { caseFilesQueryKey } from '@/features/projects/useCaseFiles';
import {
  meshBackupQueryKey,
  meshEdgesQueryKey,
  meshGeometryQueryKey,
  meshManifestQueryKey,
} from '@/features/visualize/useMesh';
import {
  meshSourceEdgesQueryKey,
  meshSourceGeometryQueryKey,
  meshSourceManifestQueryKey,
} from '@/features/assemble/useAssembly';

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

/** Query key for a project's currently-applied assembly record (or null). */
export const assemblyQueryKey = (projectId: string) =>
  ['projects', projectId, 'assembly'] as const;

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
    | { kind: 'folder'; files: File[]; name?: string }
    | { kind: 'zip'; file: File; name?: string }
    | { kind: 'file'; file: File; name?: string }
  >({
    mutationFn: (input) =>
      input.kind === 'folder'
        ? importMeshFolder(projectId, input.files, input.name)
        : input.kind === 'zip'
          ? importMeshZip(projectId, input.file, input.name)
          : importMeshFile(projectId, input.file, input.name),
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

/** Split a library mesh's patches (autoPatch), then refresh the list cache. */
export function useAutoPatchMeshSource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<AutoPatchMeshSourceResponse, Error, { meshId: string; featureAngle: number }>({
    mutationFn: ({ meshId, featureAngle }) => autoPatchMeshSource(projectId, meshId, featureAngle),
    onSuccess: (result) => {
      queryClient.setQueryData(meshesQueryKey(projectId), result.meshes);
    },
  });
}

/** Rename a library mesh patch, then refresh the list cache. */
export function useRenameMeshSourcePatch(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    RenameMeshSourcePatchResponse,
    Error,
    { meshId: string; from: string; to: string }
  >({
    mutationFn: ({ meshId, from, to }) => renameMeshSourcePatch(projectId, meshId, from, to),
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

/**
 * Batch-edit a library source's boundary patches (rename + retype) in one pass
 * (C4). The source boundary changed, so write the refreshed library into the
 * cache and drop that source's cached render (manifest/glb/edges) so the Visualize
 * viewer rebuilds it on the next fetch.
 */
export function useEditMeshSourcePatches(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<EditMeshSourcePatchesResponse, Error, { meshId: string; edits: MeshPatchEdit[] }>({
    mutationFn: ({ meshId, edits }) => editMeshSourcePatches(projectId, meshId, edits),
    onSuccess: (result, { meshId }) => {
      queryClient.setQueryData(meshesQueryKey(projectId), result.meshes);
      queryClient.removeQueries({ queryKey: meshSourceManifestQueryKey(projectId, meshId) });
      queryClient.removeQueries({ queryKey: meshSourceGeometryQueryKey(projectId, meshId) });
      queryClient.removeQueries({ queryKey: meshSourceEdgesQueryKey(projectId, meshId) });
    },
  });
}

/**
 * Read the currently-applied assembly record (C1), or null. Drives the
 * Disassemble panel: which added parts are applied, whether the base is the case
 * (so a pre-merge backup exists and undo-all is offered).
 */
export function useAssemblyQuery(projectId: string) {
  return useQuery<AppliedAssembly | null>({
    queryKey: assemblyQueryKey(projectId),
    queryFn: () => getAssembly(projectId),
  });
}

/**
 * Refresh the outputs common to a re-apply and an undo (everything except the
 * case manifest + case tree, which each caller owns): drop the cached case
 * geometry/edges + stale file-content, and invalidate the library, saved plan,
 * and assembly record so the Disassemble panel and viewers rebuild.
 */
function invalidateAssemblyOutputs(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): void {
  queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
  queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
  queryClient.removeQueries({ queryKey: [...caseFilesQueryKey(projectId), 'content'] });
  void queryClient.invalidateQueries({ queryKey: meshesQueryKey(projectId) });
  void queryClient.invalidateQueries({ queryKey: mergePlanQueryKey(projectId) });
  void queryClient.invalidateQueries({ queryKey: assemblyQueryKey(projectId) });
}

/**
 * Re-apply a REDUCED assembly plan to remove a part: runMerge restores the
 * pre-merge case first (guarded on the assembly record), then rebuilds the case
 * minus the dropped part. Resolves with the report even when the pipeline fails
 * (result.success === false); on success, refresh the case files, the Visualize
 * render, the library, the saved plan, and the assembly record.
 */
export function useReapplyAssembly(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MergeRunResult, Error, MergePlan>({
    mutationFn: (plan) => runMerge(projectId, plan),
    onSuccess: (result) => {
      if (!result.success) return;
      // The combined mesh changed: take the fresh tree, drop the case render so
      // the Visualize viewer rebuilds it on the next fetch.
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      invalidateAssemblyOutputs(queryClient, projectId);
    },
  });
}

/**
 * Undo the whole assembly: restore the case (mesh + 0/ fields) from the pre-merge
 * backup, which the API also uses to clear the assembly record (C3). The restore
 * returns the fresh manifest (kept in cache); refresh the same outputs as a
 * re-apply, plus the case tree and the backup-slot status.
 */
export function useUndoAssembly(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshManifest>({
    mutationFn: () => restoreMeshBackup(projectId),
    onSuccess: (manifest) => {
      queryClient.setQueryData(meshManifestQueryKey(projectId), manifest);
      void queryClient.invalidateQueries({ queryKey: caseFilesQueryKey(projectId) });
      invalidateAssemblyOutputs(queryClient, projectId);
      void queryClient.invalidateQueries({ queryKey: meshBackupQueryKey(projectId) });
    },
  });
}
