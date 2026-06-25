import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  autoPatchMesh,
  editMeshPatches,
  getMeshBackup,
  getMeshEdges,
  getMeshGeometry,
  getMeshManifest,
  rebuildMesh,
  renameMeshPatch,
  restoreMeshBackup,
  saveMeshBackup,
  setMeshPatchType,
} from '@/lib/api/projects';
import type {
  AutoPatchResult,
  MeshBackupInfo,
  MeshManifest,
  MeshPatchEdit,
  MeshPatchType,
} from '@/lib/api/types';

/**
 * useMesh - React Query hooks for the 3D mesh viewer ("Visualize" tab).
 *
 * The manifest query is the entry point: requesting it triggers the server-side
 * build (extract boundary patches -> GLB + manifest) on first load, so its
 * pending state is the "Building 3D preview" state. The geometry query fetches
 * the GLB as an ArrayBuffer (for GLTFLoader.parse) and is gated on the manifest
 * having succeeded, so geometry is never requested before the build exists.
 *
 * Both artifacts are cached server-side and stable until the mesh changes, so
 * the queries use a generous staleTime and do not refetch on tab toggles.
 */

const FIVE_MINUTES = 5 * 60 * 1000;

/** Query key for a project's mesh manifest. */
export const meshManifestQueryKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'manifest'] as const;

/** Query key for a project's mesh geometry (GLB). */
export const meshGeometryQueryKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'glb'] as const;

/** Query key for a project's cell-edge buffer. */
export const meshEdgesQueryKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'edges'] as const;

/** Query key for a project's mesh-backup slot status. */
export const meshBackupQueryKey = (projectId: string) =>
  ['projects', projectId, 'mesh', 'backup'] as const;

/**
 * Load the patch manifest. The first call builds the render on the server, so
 * treat `isPending` as "building the preview". Retries are disabled: a 409
 * NO_MESH or a 502 build failure is a definitive state, not a transient error.
 */
export function useMeshManifestQuery(projectId: string, enabled = true) {
  return useQuery<MeshManifest>({
    queryKey: meshManifestQueryKey(projectId),
    queryFn: () => getMeshManifest(projectId),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/**
 * Load the GLB geometry as an ArrayBuffer for three.js. Enabled only once the
 * manifest has built (so the geometry exists), and never refetched while cached.
 */
export function useMeshGeometryQuery(projectId: string, enabled: boolean) {
  return useQuery<ArrayBuffer>({
    queryKey: meshGeometryQueryKey(projectId),
    queryFn: async () => {
      const blob = await getMeshGeometry(projectId);
      return blob.arrayBuffer();
    },
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/**
 * Load the cell-edge buffer as an ArrayBuffer (or null when the render has none).
 * Enabled alongside the geometry; the viewer uses it for the true mesh grid and
 * otherwise falls back to a client-side overlay.
 */
export function useMeshEdgesQuery(projectId: string, enabled: boolean) {
  return useQuery<ArrayBuffer | null>({
    queryKey: meshEdgesQueryKey(projectId),
    queryFn: () => getMeshEdges(projectId),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** Force a rebuild of the render, then refresh the manifest, geometry, and edges. */
export function useRebuildMesh(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshManifest>({
    mutationFn: () => rebuildMesh(projectId),
    onSuccess: (manifest) => {
      queryClient.setQueryData(meshManifestQueryKey(projectId), manifest);
      // The geometry + edges changed too; drop them so the viewer refetches.
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
    },
  });
}

/**
 * Rename a boundary patch. The boundary file changes, so the cached render is
 * stale: drop both queries so the manifest refetch rebuilds the GLB + manifest
 * with the new name, and the geometry (gated on the manifest) then refetches the
 * fresh GLB in order (no stale-GLB race).
 */
export function useRenamePatch(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ patches: string[] }, Error, { from: string; to: string }>({
    mutationFn: ({ from, to }) => renameMeshPatch(projectId, from, to),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      // The patch name lives in constant/polyMesh/boundary, a case file, so keep
      // the case tree / summary in sync too.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
    },
  });
}

/**
 * Set a boundary patch's geometric type. The boundary file and the 0/ field
 * boundaryFields change server-side, so drop the cached render (rebuilt on the
 * next manifest fetch with the new types) and refresh the case tree (the 0/
 * files changed).
 */
export function useSetPatchType(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ patches: string[] }, Error, { patch: string; type: MeshPatchType }>({
    mutationFn: ({ patch, type }) => setMeshPatchType(projectId, patch, type),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
    },
  });
}

/**
 * Run autoPatch on the mesh. The mutation resolves even when the tool itself
 * fails (`result.success === false`) so the dialog can show the logs; only
 * access / missing-mesh errors reject. On a successful run the boundary changed,
 * so the cached render is stale: drop the manifest, geometry and edge queries so
 * the viewer rebuilds with the new patches, and refresh the case tree (the
 * boundary is a case file, and base files may have been scaffolded to run the
 * utility). A failed run leaves the mesh untouched, so nothing is dropped.
 */
export function useAutoPatch(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<AutoPatchResult, Error, number>({
    mutationFn: (featureAngle) => autoPatchMesh(projectId, featureAngle),
    onSuccess: (result) => {
      if (!result.success) return;
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      // The first edit captures the original backup server-side; refresh status.
      void queryClient.invalidateQueries({ queryKey: meshBackupQueryKey(projectId) });
    },
  });
}

/**
 * Apply a batch of patch name/type edits (the "edit names & types" overlay). The
 * boundary file and 0/ fields change server-side, so drop the cached render
 * (rebuilt on the next manifest fetch) and refresh the case tree + backup status
 * (the first edit captures the original).
 */
export function useEditPatches(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ patches: string[] }, Error, MeshPatchEdit[]>({
    mutationFn: (edits) => editMeshPatches(projectId, edits),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: meshManifestQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      void queryClient.invalidateQueries({ queryKey: meshBackupQueryKey(projectId) });
    },
  });
}

/**
 * Status of the project's single mesh-backup slot (null when none taken yet).
 * Retries are disabled: an absent backup is a definitive state, not an error.
 */
export function useMeshBackupQuery(projectId: string, enabled = true) {
  return useQuery<MeshBackupInfo | null>({
    queryKey: meshBackupQueryKey(projectId),
    queryFn: () => getMeshBackup(projectId),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** Overwrite the backup slot with the current case; refresh the backup status. */
export function useSaveBackup(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshBackupInfo>({
    mutationFn: () => saveMeshBackup(projectId),
    onSuccess: (backup) => {
      queryClient.setQueryData(meshBackupQueryKey(projectId), backup);
    },
  });
}

/**
 * Restore the case (mesh + 0/ fields) from the backup slot. The whole case
 * changed, so drop the cached render (rebuilt on the next manifest fetch) and
 * refresh the case tree; the manifest comes back fresh from the restore.
 */
export function useRestoreBackup(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshManifest>({
    mutationFn: () => restoreMeshBackup(projectId),
    onSuccess: (manifest) => {
      queryClient.setQueryData(meshManifestQueryKey(projectId), manifest);
      queryClient.removeQueries({ queryKey: meshGeometryQueryKey(projectId) });
      queryClient.removeQueries({ queryKey: meshEdgesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
    },
  });
}
