import { ApiError, apiClient } from './client';
import type {
  ChamberBuildResponse,
  ChamberInput,
  MeshManifest,
  MeshManifestResponse,
} from './types';

/**
 * chamber.ts - Chamber Creation endpoints (3 inputs -> 12 params -> CadQuery
 * solid -> named patches). Typed wrappers around `/chamber/*` (authenticated;
 * builds are shared across the team, keyed by a params hash). The geometry
 * transport (GLB + manifest + edges) is identical to the mesh viewer's.
 */

/** Artifact kinds the build exports for download. stepMirrored is the
 * z-y-mirrored STEP ("Change rotational direction"), generated server-side on
 * demand at its first download (~10-30 s) and cached with the build after. */
export type ChamberExportKind = 'stl' | 'step' | 'stepMirrored' | 'trisurface';

/** Compute the 12 outputs and build (or reuse) the geometry. Returns the hash + outputs. */
export async function buildChamber(input: ChamberInput): Promise<ChamberBuildResponse> {
  return apiClient.post<ChamberBuildResponse>('/chamber/build', input);
}

/** Fetch a build's patch manifest (already built by POST /build). */
export async function getChamberManifest(hash: string): Promise<MeshManifest> {
  const data = await apiClient.get<MeshManifestResponse>(`/chamber/${hash}/manifest`);
  return data.manifest;
}

/** Fetch the build's rendered geometry (a GLB) as an ArrayBuffer. */
export async function getChamberGeometry(hash: string): Promise<ArrayBuffer> {
  const blob = await apiClient.getBlob(`/chamber/${hash}/geometry`);
  return blob.arrayBuffer();
}

/** Fetch the build's cell-edge buffer, or null when this render has none (204/404). */
export async function getChamberEdges(hash: string): Promise<ArrayBuffer | null> {
  try {
    const blob = await apiClient.getBlob(`/chamber/${hash}/edges`);
    if (blob.size === 0) return null;
    return await blob.arrayBuffer();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Fetch one export artifact (STL / STEP / OpenFOAM triSurface zip) as a Blob. */
export async function getChamberExport(hash: string, kind: ChamberExportKind): Promise<Blob> {
  return apiClient.getBlob(`/chamber/${hash}/export/${kind}`);
}
