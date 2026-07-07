import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, MonitorX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { ApiError } from '@/lib/api/client';
import type { MeshPatch } from '@/lib/api/types';
import { MeshScene } from '@/features/visualize/MeshViewer';
import { PatchTable } from '@/features/visualize/PatchTable';
import {
  meshingEdgesKey,
  meshingGeometryKey,
  meshingManifestKey,
  useMeshingEdgesQuery,
  useMeshingGeometryQuery,
  useMeshingManifestQuery,
} from './useMeshing';

/**
 * MeshResultViewer - the 3D preview of a session's snappyHexMesh result. Reuses
 * the exported MeshScene from the Visualize tab (data-in / callbacks-out) so the
 * heavy three.js scene is shared, not duplicated. The manifest query builds the
 * render on demand server-side; geometry + edges are gated on it. Boundary
 * patches (walls + the background domain) are listed alongside the canvas.
 */

/** Detect WebGL support once. */
function detectWebgl(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function MeshResultViewer({ sessionId }: { sessionId: string }) {
  const webglAvailable = useMemo(detectWebgl, []);
  const [selected, setSelected] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const manifest = useMeshingManifestQuery(sessionId);
  const patches = manifest.data?.patches ?? [];
  const hasPatches = patches.length > 0;

  const viewerEnabled = manifest.isSuccess && hasPatches && webglAvailable;
  const geometry = useMeshingGeometryQuery(sessionId, viewerEnabled);
  const edges = useMeshingEdgesQuery(sessionId, viewerEnabled);

  const rebuild = () => {
    setSelected(null);
    queryClient.removeQueries({ queryKey: meshingManifestKey(sessionId) });
    queryClient.removeQueries({ queryKey: meshingGeometryKey(sessionId) });
    queryClient.removeQueries({ queryKey: meshingEdgesKey(sessionId) });
  };

  return (
    <section
      aria-label="Result mesh preview"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm lg:grid lg:grid-cols-[minmax(200px,16rem)_1fr]"
    >
      <div className="flex min-h-0 min-w-0 flex-col gap-3 border-b border-border p-4 sm:p-5 lg:border-b-0 lg:border-r">
        <h3 className="shrink-0 text-sm font-semibold text-text">
          Boundary patches
          {hasPatches && (
            <span className="ml-1.5 font-normal tabular-nums text-text-secondary">
              ({patches.length})
            </span>
          )}
        </h3>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {manifest.isPending ? (
            <p className="text-sm text-text-secondary">Building the preview…</p>
          ) : manifest.isError ? (
            <p className="text-sm text-text-secondary">Could not load the patch list.</p>
          ) : !hasPatches ? (
            <p className="text-sm text-text-secondary">No boundary patches in this mesh.</p>
          ) : (
            <PatchTable patches={patches} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </div>

      <div className="relative min-h-[45vh] lg:min-h-0">
        <CanvasArea
          webglAvailable={webglAvailable}
          manifestPending={manifest.isPending}
          manifestError={manifest.isError ? manifest.error : null}
          hasPatches={hasPatches}
          geometry={geometry}
          edges={edges}
          patches={patches}
          selected={selected}
          onSelect={setSelected}
          onRebuild={rebuild}
        />
      </div>
    </section>
  );
}

/** Right-hand stage: gates WebGL -> building -> failed -> empty -> loading -> render. */
function CanvasArea({
  webglAvailable,
  manifestPending,
  manifestError,
  hasPatches,
  geometry,
  edges,
  patches,
  selected,
  onSelect,
  onRebuild,
}: {
  webglAvailable: boolean;
  manifestPending: boolean;
  manifestError: unknown;
  hasPatches: boolean;
  geometry: ReturnType<typeof useMeshingGeometryQuery>;
  edges: ReturnType<typeof useMeshingEdgesQuery>;
  patches: MeshPatch[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onRebuild: () => void;
}) {
  if (!webglAvailable) {
    return (
      <StageMessage
        icon={<MonitorX className="size-6 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
        title="3D rendering isn't available"
        body="Your browser doesn't support WebGL, so the mesh can't be shown here."
      />
    );
  }
  if (manifestPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Building 3D preview"
        body="Extracting the boundary patches. This runs once and is cached afterwards."
      />
    );
  }
  if (manifestError) {
    return (
      <StageError
        message="Could not build the 3D preview."
        detail={manifestError instanceof ApiError ? manifestError.message : null}
        onRetry={onRebuild}
      />
    );
  }
  if (!hasPatches) {
    return (
      <StageMessage
        icon={<Diamond size={22} className="text-primary" />}
        title="Nothing to display"
        body="No boundary patches were found in this mesh."
      />
    );
  }
  if (geometry.isPending || edges.isPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Loading geometry"
        body="Preparing the 3D surfaces."
      />
    );
  }
  if (geometry.isError || !geometry.data) {
    return (
      <StageError
        message="Could not load the 3D geometry."
        detail={geometry.error instanceof ApiError ? geometry.error.message : null}
        onRetry={onRebuild}
      />
    );
  }

  return (
    <MeshScene
      geometry={geometry.data}
      edges={edges.data ?? null}
      patches={patches}
      selected={selected}
      onSelect={onSelect}
      onRebuild={onRebuild}
      rebuilding={false}
    />
  );
}

function StageMessage({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role="status"
      aria-live="polite"
    >
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">{icon}</span>
      <div className="flex max-w-xs flex-col gap-1">
        <p className="text-base font-semibold text-text">{title}</p>
        <p className="text-sm text-text-secondary">{body}</p>
      </div>
    </div>
  );
}

function StageError({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex size-full items-center justify-center px-6 py-12">
      <div
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-danger/40 bg-danger-tint px-5 py-6 text-center"
      >
        <AlertTriangle className="size-6 text-danger" strokeWidth={1.75} aria-hidden="true" />
        <p className="text-base font-semibold text-text">{message}</p>
        {detail && (
          <details className="w-full text-left">
            <summary className="cursor-pointer text-sm text-text-secondary">Technical details</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-3 text-xs text-text-secondary">
              {detail}
            </pre>
          </details>
        )}
        <Button type="button" onClick={onRetry} className="mt-1">
          Try again
        </Button>
      </div>
    </div>
  );
}

export default MeshResultViewer;
