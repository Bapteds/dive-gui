import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  copyMeshingSession,
  createMeshingSession,
  deleteMeshingSession,
  deleteStl,
  getMeshingEdges,
  getMeshingGeometry,
  getMeshingLog,
  getMeshingManifest,
  getMeshingSession,
  listMeshingSessions,
  renameMeshingSession,
  runSnappy,
  saveMeshingConfig,
  stopMeshing,
  transferChamberToMeshing,
  uploadStl,
} from '@/lib/api/meshing';
import { isMeshingRunActive } from '@/lib/api/types';
import type {
  CopySessionBody,
  FromChamberBody,
  MeshManifest,
  MeshingConfig,
  MeshingEngine,
  MeshingLogPayload,
  MeshingRunState,
  MeshingSession,
  MeshingSessionSummary,
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

/** Poll cadence while a mesh run is active (matches the solver's live log). */
const RUN_POLL_MS = 1200;

export const meshingSessionsKey = ['meshing'] as const;
export const meshingSessionKey = (id: string) => ['meshing', id] as const;
export const meshingRunLogKey = (id: string) => ['meshing', id, 'run', 'log'] as const;
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

/** Create a session (with its engine), then refresh the list. */
export function useCreateMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, engine }: { name: string; engine: MeshingEngine }) =>
      createMeshingSession(name, engine),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Copy a session's setup into a new session, then refresh the list. */
export function useCopyMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, CopySessionBody>({
    mutationFn: (body) => copyMeshingSession(body),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(session.id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Import a chamber build into a meshing session, then refresh the list. */
export function useTransferChamberToMeshing() {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, FromChamberBody>({
    mutationFn: (body) => transferChamberToMeshing(body),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(session.id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/** Rename a session (display name only); update the detail + list caches. */
export function useRenameMeshingSession() {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, { id: string; name: string }>({
    mutationFn: ({ id, name }) => renameMeshingSession(id, name),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(session.id), session);
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
 * START a mesh run (background job). Resolves as soon as the run is queued with the
 * refreshed session (now 'running') and the running status; the live output is then
 * polled by useMeshingRunLog. Rejects on 409 MESH_IN_PROGRESS if one is active.
 */
export function useStartMeshing(id: string) {
  const queryClient = useQueryClient();
  return useMutation<{ session: MeshingSession; status: MeshingRunState }, Error, MeshingConfig>({
    mutationFn: (config) => runSnappy(id, config),
    onSuccess: ({ session }) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
      // Reset any stale log payload so the panel starts clean for the new run.
      void queryClient.invalidateQueries({ queryKey: meshingRunLogKey(id) });
    },
  });
}

/**
 * Poll the live log + lifecycle status of a session's run. Polls at a steady
 * cadence while the run is active (the payload's own status drives it), then stops
 * once terminal. Enabled only when a run exists/executes to keep an idle tab quiet.
 */
export function useMeshingRunLog(id: string, enabled: boolean) {
  return useQuery<MeshingLogPayload>({
    queryKey: meshingRunLogKey(id),
    queryFn: () => getMeshingLog(id),
    enabled,
    refetchInterval: (query) => {
      // Keep polling until we have SEEN a terminal status; on a failed fetch the
      // data stays undefined, so treat unknown-or-active as "keep polling".
      const status = query.state.data?.status;
      if (status && !isMeshingRunActive(status)) return false;
      return RUN_POLL_MS;
    },
  });
}

/**
 * Stop the running mesh. Resolves with the refreshed session; the log poll then
 * reports the run 'stopped'. Refreshes the session + list caches.
 */
export function useStopMeshing(id: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, void>({
    mutationFn: () => stopMeshing(id),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
      void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    },
  });
}

/**
 * Called by the page when a run reaches a terminal status: refresh the session
 * (hasMesh / lastRun changed) and drop the result-mesh render caches so the viewer
 * rebuilds from the new polyMesh. Idempotent — safe to call once per transition.
 */
export function useOnMeshingRunSettled(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: meshingSessionKey(id) });
    void queryClient.invalidateQueries({ queryKey: meshingSessionsKey });
    queryClient.removeQueries({ queryKey: meshingManifestKey(id) });
    queryClient.removeQueries({ queryKey: meshingGeometryKey(id) });
    queryClient.removeQueries({ queryKey: meshingEdgesKey(id) });
  };
}

/**
 * Autosave the edited config (persist without running). Updates the session cache
 * so `savedConfig` stays current, without disturbing the form (it seeds on mount).
 * Failures are swallowed by the caller's debounce — a lost autosave is non-fatal.
 */
export function useSaveMeshingConfig(id: string) {
  const queryClient = useQueryClient();
  return useMutation<MeshingSession, Error, MeshingConfig>({
    mutationFn: (config) => saveMeshingConfig(id, config),
    onSuccess: (session) => {
      queryClient.setQueryData(meshingSessionKey(id), session);
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
