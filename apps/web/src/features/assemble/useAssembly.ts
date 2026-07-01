import { useQuery } from '@tanstack/react-query';
import {
  getMeshSourceEdges,
  getMeshSourceGeometry,
  getMeshSourceManifest,
} from '@/lib/api/meshes';
import type { MeshManifest } from '@/lib/api/types';

/**
 * useAssembly - React Query hooks for the per-source 3D preview used by the
 * "Assemble" tab. Each library source (the base part and every added part) has
 * its own manifest / geometry / edges, built on demand by the server and cached
 * there; these are stable until the source's polyMesh changes, so they use a
 * generous staleTime and never refetch on tab toggles.
 *
 * The library + merge hooks themselves (list, import, auto-patch, rename, run
 * merge, plan) are reused verbatim from `useMeshes.ts` - this module only adds
 * the source-viz queries the canvas needs.
 */

const FIVE_MINUTES = 5 * 60 * 1000;

/** Query key for a single library source's patch manifest. */
export const meshSourceManifestQueryKey = (projectId: string, meshId: string) =>
  ['projects', projectId, 'meshSource', meshId, 'manifest'] as const;

/** Query key for a single library source's rendered geometry (GLB). */
export const meshSourceGeometryQueryKey = (projectId: string, meshId: string) =>
  ['projects', projectId, 'meshSource', meshId, 'glb'] as const;

/** Query key for a single library source's cell-edge buffer. */
export const meshSourceEdgesQueryKey = (projectId: string, meshId: string) =>
  ['projects', projectId, 'meshSource', meshId, 'edges'] as const;

/**
 * Load a source's patch manifest. The first call builds the render on the server,
 * so treat `isPending` as "building the preview". Retries are disabled: a build
 * failure or an unknown source is a definitive state, not a transient error.
 */
export function useMeshSourceManifestQuery(
  projectId: string,
  meshId: string | null,
  enabled = true,
) {
  return useQuery<MeshManifest>({
    queryKey: meshSourceManifestQueryKey(projectId, meshId ?? ''),
    queryFn: () => getMeshSourceManifest(projectId, meshId as string),
    enabled: enabled && !!meshId,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/**
 * Load a source's GLB geometry as an ArrayBuffer for three.js. Enabled only once
 * the geometry is actually needed (the part is in the scene), and never refetched
 * while cached.
 */
export function useMeshSourceGeometryQuery(
  projectId: string,
  meshId: string | null,
  enabled: boolean,
) {
  return useQuery<ArrayBuffer>({
    queryKey: meshSourceGeometryQueryKey(projectId, meshId ?? ''),
    queryFn: async () => {
      const blob = await getMeshSourceGeometry(projectId, meshId as string);
      return blob.arrayBuffer();
    },
    enabled: enabled && !!meshId,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/**
 * Load a source's cell-edge buffer as an ArrayBuffer (or null when the render has
 * none). Enabled alongside the geometry; the viewer uses it for the true mesh
 * grid and otherwise falls back to a client-side overlay.
 */
export function useMeshSourceEdgesQuery(
  projectId: string,
  meshId: string | null,
  enabled: boolean,
) {
  return useQuery<ArrayBuffer | null>({
    queryKey: meshSourceEdgesQueryKey(projectId, meshId ?? ''),
    queryFn: () => getMeshSourceEdges(projectId, meshId as string),
    enabled: enabled && !!meshId,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}
