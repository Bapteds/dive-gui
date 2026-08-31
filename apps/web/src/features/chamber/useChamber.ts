import { useMutation, useQuery } from '@tanstack/react-query';
import {
  buildChamber,
  getChamberEdges,
  getChamberGeometry,
  getChamberManifest,
} from '@/lib/api/chamber';
import type { ChamberBuildResponse, ChamberInput, MeshManifest } from '@/lib/api/types';

/**
 * useChamber - React Query hooks for the Chamber Creation feature.
 *
 * A build is keyed by a params hash returned from POST /chamber/build. The
 * manifest/geometry/edges queries then load that build's cached artifacts by
 * hash (mirrors the meshing viewer hooks: retry off, 5-min cache, geometry +
 * edges gated on the manifest + WebGL). Because the build is synchronous, the
 * manifest is already present when its hash exists.
 */

const FIVE_MINUTES = 5 * 60 * 1000;

export const chamberManifestKey = (hash: string) => ['chamber', hash, 'manifest'] as const;
export const chamberGeometryKey = (hash: string) => ['chamber', hash, 'glb'] as const;
export const chamberEdgesKey = (hash: string) => ['chamber', hash, 'edges'] as const;

/** Build (or reuse) the chamber for a set of inputs; resolves with the hash + outputs. */
export function useBuildChamber() {
  return useMutation<ChamberBuildResponse, Error, ChamberInput>({
    mutationFn: (input) => buildChamber(input),
  });
}

/** A build's patch manifest (present once the hash exists). Disabled when hash is null. */
export function useChamberManifestQuery(hash: string | null, enabled = true) {
  return useQuery<MeshManifest>({
    queryKey: chamberManifestKey(hash ?? ''),
    queryFn: () => getChamberManifest(hash as string),
    enabled: enabled && hash !== null,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** A build's geometry (GLB), gated on the manifest + WebGL. */
export function useChamberGeometryQuery(hash: string | null, enabled: boolean) {
  return useQuery<ArrayBuffer>({
    queryKey: chamberGeometryKey(hash ?? ''),
    queryFn: () => getChamberGeometry(hash as string),
    enabled: enabled && hash !== null,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}

/** A build's cell-edge buffer (or null when the render has none). */
export function useChamberEdgesQuery(hash: string | null, enabled: boolean) {
  return useQuery<ArrayBuffer | null>({
    queryKey: chamberEdgesKey(hash ?? ''),
    queryFn: () => getChamberEdges(hash as string),
    enabled: enabled && hash !== null,
    retry: false,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
  });
}
