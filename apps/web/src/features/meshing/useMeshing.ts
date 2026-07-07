import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMeshingSession,
  deleteMeshingSession,
  deleteStl,
  getMeshingEdges,
  getMeshingGeometry,
  getMeshingManifest,
  getMeshingSession,
  listMeshingSessions,
  runSnappy,
  uploadStl,
} from '@/lib/api/meshing';
import type {
  MeshImportConversion,
  MeshManifest,
  MeshingSession,
  MeshingSessionSummary,
  SnappyConfig,
} from '@/lib/api/types';

/**
 * useMeshing - React Query hooks for the standalone Meshing feature.
 *
 * The session list and each session detail have their own key. Mutations refresh
 * the affected session (and the list where the summary changes). The result-mesh
 * viewer mirrors the Visualize hooks: the manifest query builds the render on
 * first fetch, geometry/edges are gated on it, and a run drops those caches so
 * the viewer rebuilds from the new polyMesh.
 */

const FIVE_MINUTES = 5 * 60 * 1000;

export const meshingSessionsKey = ['meshing'] as const;
export const meshingSessionKey = (id: string) => ['meshing', id] as const;
export const meshingManifestKey = (id: string) => ['meshing', id, 'mesh', 'manifest'] as const;
export const meshingGeometryKey = (id: string) => ['meshing', id, 'mesh', 'glb'] as const;
export const meshingEdgesKey = (id: string) => ['meshing', id, 'mesh', 'edges'] as const;

/** List all sessions (newest first). */
export function useMeshingSessions() {
  return useQuery<MeshingSessionSummary[]>({
    queryKey: meshingSessionsKey,
    queryFn: listMeshingSessions,
  });
}

/** Load one session's full detail. */
export function useMeshingSession(id: string) {
  return useQuery<MeshingSession>({
    queryKey: meshingSessionKey(id),
    queryFn: () => getMeshingSession(id),
  });
}

/** Create a session, then refresh the list. */
export function useCreateMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createMeshingSession(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Delete a session, then refresh the list. */
export function useDeleteMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMeshingSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Upload STL surfaces to a session; update the detail + list. */
export function useUploadStl(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => uploadStl(id, files),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Remove one STL from a session; update the detail + list. */
export function useDeleteStl(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteStl(id, name),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/**
 * Run the snappy pipeline. Resolves with the report even on a tool failure
 * (result.success === false); a successful run invalidates the result-mesh
 * render so the viewer rebuilds. Always refreshes the session (last-run record).
 */
export function useRunSnappy(id: string) {
  const queryClient = useQueryClient();
  return useMutation<{ session: MeshingSession; result: MeshImportConversion }, Error, SnappyConfig>({
    mutationFn: (config) => runSnappy(id, config),
    onSuccess: ({ session, result }) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
      if (result.success) {
        queryClient.removeQueries({ queryKey: meshingManifestKey(id) });
        queryClient.removeQueries({ queryKey: meshingGeometryKey(id) });
        queryClient.removeQueries({ queryKey: meshingEdgesKey(id) });
      }
    },
  });
}

/** Result-mesh manifest (builds the render on first fetch). */
export function useMeshingManifestQuery(id: string, enabled = true) {
  return useQuery<MeshManifest>({
    queryKey: meshingManifestKey(id),
    queryFn: () => getMeshingManifest(id),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** Result-mesh geometry (GLB), gated on the manifest having built. */
export function useMeshingGeometryQuery(id: string, enabled: boolean) {
  return useQuery<ArrayBuffer>({
    queryKey: meshingGeometryKey(id),
    queryFn: () => getMeshingGeometry(id),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** Result-mesh cell-edge buffer (or null when the render has none). */
export function useMeshingEdgesQuery(id: string, enabled: boolean) {
  return useQuery<ArrayBuffer | null>({
    queryKey: meshingEdgesKey(id),
    queryFn: () => getMeshingEdges(id),
    enabled,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}
