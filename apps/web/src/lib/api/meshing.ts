import { ApiError, apiClient } from './client';
import type {
  CopySessionBody,
  FromChamberBody,
  MeshManifest,
  MeshManifestResponse,
  MeshingConfig,
  MeshingEngine,
  MeshingLogPayload,
  MeshingLogResponse,
  MeshingRunState,
  MeshingSession,
  MeshingSessionResponse,
  MeshingSessionSummary,
  MeshingSessionsResponse,
  RunSnappyResponse,
} from './types';

/**
 * meshing.ts - standalone Meshing endpoints (STL -> snappyHexMesh -> polyMesh).
 * Typed wrappers around `/meshing/*` (authenticated; sessions are shared across
 * the team). Mirrors the shape of lib/api/meshes.ts.
 */

/** List every meshing session (summaries, newest first). */
export async function listMeshingSessions(): Promise<MeshingSessionSummary[]> {
  const data = await apiClient.get<MeshingSessionsResponse>('/meshing');
  return data.sessions;
}

/** Create a new session with its (fixed) engine. */
export async function createMeshingSession(
  name: string,
  engine: MeshingEngine,
): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>('/meshing', { name, engine });
  return data.session;
}

/** Duplicate a session's engine + config + surfaces into a new session. */
export async function copyMeshingSession(body: CopySessionBody): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>('/meshing/copy', body);
  return data.session;
}

/** Import a built chamber's patch surfaces into a meshing session (new/existing/copyFrom). */
export async function transferChamberToMeshing(body: FromChamberBody): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>('/meshing/from-chamber', body);
  return data.session;
}

/** Get one session's full detail. */
export async function getMeshingSession(id: string): Promise<MeshingSession> {
  const data = await apiClient.get<MeshingSessionResponse>(`/meshing/${id}`);
  return data.session;
}

/** Rename a session (display name only; id/engine unchanged). */
export async function renameMeshingSession(id: string, name: string): Promise<MeshingSession> {
  const data = await apiClient.patch<MeshingSessionResponse>(`/meshing/${id}`, { name });
  return data.session;
}

/** Delete a session. */
export async function deleteMeshingSession(id: string): Promise<void> {
  await apiClient.delete(`/meshing/${id}`);
}

/** Upload one or more surfaces (STL, or FMS for cfMesh) into a session. */
export async function uploadStl(id: string, files: File[]): Promise<MeshingSession> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  const data = await apiClient.postForm<MeshingSessionResponse>(`/meshing/${id}/stl`, form);
  return data.session;
}

/** Remove one STL surface from a session. */
export async function deleteStl(id: string, name: string): Promise<MeshingSession> {
  const data = await apiClient.delete<MeshingSessionResponse>(
    `/meshing/${id}/stl?name=${encodeURIComponent(name)}`,
  );
  return data.session;
}

/** Fetch a raw STL as an ArrayBuffer for the client-side viewer. */
export async function getStlBuffer(id: string, name: string): Promise<ArrayBuffer> {
  const blob = await apiClient.getBlob(`/meshing/${id}/stl?name=${encodeURIComponent(name)}`);
  return blob.arrayBuffer();
}

/**
 * START a mesh run as a background job. Resolves immediately with the refreshed
 * session and the just-started 'running' status; the live output + terminal state
 * are then polled via getMeshingLog. Access / missing-STL / already-running
 * problems reject as ApiError (409 MESH_IN_PROGRESS when one is active).
 */
export async function runSnappy(
  id: string,
  config: MeshingConfig,
): Promise<{ session: MeshingSession; status: MeshingRunState }> {
  return apiClient.post<RunSnappyResponse>(`/meshing/${id}/run`, config);
}

/** Poll the live log + lifecycle status of a session's current/last run. */
export async function getMeshingLog(id: string): Promise<MeshingLogPayload> {
  const data = await apiClient.get<MeshingLogResponse>(`/meshing/${id}/run/log`);
  return data.log;
}

/** Request a stop of the running mesh; resolves with the refreshed session. */
export async function stopMeshing(id: string): Promise<MeshingSession> {
  const data = await apiClient.post<MeshingSessionResponse>(`/meshing/${id}/run/stop`, {});
  return data.session;
}

/**
 * Autosave the edited config (persist without running). Returns the refreshed
 * session so `savedConfig` in the cache stays current.
 */
export async function saveMeshingConfig(id: string, config: MeshingConfig): Promise<MeshingSession> {
  const data = await apiClient.put<MeshingSessionResponse>(`/meshing/${id}/config`, config);
  return data.session;
}

/** Fetch the result-mesh patch manifest (builds the render on first call). */
export async function getMeshingManifest(id: string): Promise<MeshManifest> {
  const data = await apiClient.get<MeshManifestResponse>(`/meshing/${id}/mesh/manifest`);
  return data.manifest;
}

/** Fetch the result-mesh rendered geometry (a GLB) as an ArrayBuffer. */
export async function getMeshingGeometry(id: string): Promise<ArrayBuffer> {
  const blob = await apiClient.getBlob(`/meshing/${id}/mesh/geometry`);
  return blob.arrayBuffer();
}

/** Fetch the result-mesh cell-edge buffer, or null when this render has none (204/404). */
export async function getMeshingEdges(id: string): Promise<ArrayBuffer | null> {
  try {
    const blob = await apiClient.getBlob(`/meshing/${id}/mesh/edges`);
    if (blob.size === 0) return null;
    return await blob.arrayBuffer();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Fetch the whole session case as a .zip Blob (for download). */
export async function getSessionZip(id: string): Promise<Blob> {
  return apiClient.getBlob(`/meshing/${id}/download`);
}
