import { useMemo, useState } from 'react';
import { AlertTriangle, Box, Loader2, MonitorX } from 'lucide-react';
import { Diamond } from '@/components/brand/Diamond';
import { ApiError } from '@/lib/api/client';
import type { MeshPatch } from '@/lib/api/types';
import { MeshScene } from '@/features/visualize/MeshViewer';
import { PatchTable } from '@/features/visualize/PatchTable';
import {
  useChamberEdgesQuery,
  useChamberGeometryQuery,
  useChamberManifestQuery,
} from './useChamber';

/**
 * ChamberViewer - the 3D preview of a built chamber, colored by OpenFOAM patch
 * (inlet / outlet / cylinder_walls / walls). Reuses the exported MeshScene +
 * PatchTable from the Visualize tab (data-in / callbacks-out), exactly like the
 * meshing result viewer. Driven by a build `hash`; before the first build it
 * shows a friendly prompt.
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

export function ChamberViewer({ hash }: { hash: string | null }) {
  const webglAvailable = useMemo(detectWebgl, []);
  const [selected, setSelected] = useState<string | null>(null);

  const manifest = useChamberManifestQuery(hash);
  const patches = manifest.data?.patches ?? [];
  const hasPatches = patches.length > 0;

  const viewerEnabled = manifest.isSuccess && hasPatches && webglAvailable;
  const geometry = useChamberGeometryQuery(hash, viewerEnabled);
  const edges = useChamberEdgesQuery(hash, viewerEnabled);

  return (
    <section
      aria-label="Chamber preview"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm lg:grid lg:grid-cols-[minmax(200px,15rem)_1fr]"
    >
      <div className="flex min-h-0 min-w-0 flex-col gap-3 border-b border-border p-4 sm:p-5 lg:border-b-0 lg:border-r">
        <h3 className="shrink-0 text-sm font-semibold text-text">
          Patches
          {hasPatches && (
            <span className="ml-1.5 font-normal tabular-nums text-text-secondary">
              ({patches.length})
            </span>
          )}
        </h3>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hash === null ? (
            <p className="text-sm text-text-secondary">Generate a chamber to see its patches.</p>
          ) : manifest.isPending ? (
            <p className="text-sm text-text-secondary">Building the preview…</p>
          ) : manifest.isError ? (
            <p className="text-sm text-text-secondary">Could not load the patch list.</p>
          ) : !hasPatches ? (
            <p className="text-sm text-text-secondary">No patches in this build.</p>
          ) : (
            <PatchTable patches={patches} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </div>

      <div className="relative min-h-[45vh] lg:min-h-0">
        <CanvasArea
          hash={hash}
          webglAvailable={webglAvailable}
          manifestPending={manifest.isPending}
          manifestError={manifest.isError ? manifest.error : null}
          hasPatches={hasPatches}
          geometry={geometry}
          edges={edges}
          patches={patches}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
    </section>
  );
}

/** Right-hand stage: idle -> WebGL -> building -> failed -> empty -> loading -> render. */
function CanvasArea({
  hash,
  webglAvailable,
  manifestPending,
  manifestError,
  hasPatches,
  geometry,
  edges,
  patches,
  selected,
  onSelect,
}: {
  hash: string | null;
  webglAvailable: boolean;
  manifestPending: boolean;
  manifestError: unknown;
  hasPatches: boolean;
  geometry: ReturnType<typeof useChamberGeometryQuery>;
  edges: ReturnType<typeof useChamberEdgesQuery>;
  patches: MeshPatch[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  if (hash === null) {
    return (
      <StageMessage
        icon={<Box className="size-6 text-primary" strokeWidth={1.5} aria-hidden="true" />}
        title="No chamber yet"
        body="Enter X1, X2, X3 and a length, then Generate to see the 3D chamber here."
      />
    );
  }
  if (!webglAvailable) {
    return (
      <StageMessage
        icon={<MonitorX className="size-6 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
        title="3D rendering isn't available"
        body="Your browser doesn't support WebGL, so the chamber can't be shown here."
      />
    );
  }
  if (manifestPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Loading preview"
        body="Fetching the built chamber."
      />
    );
  }
  if (manifestError) {
    return (
      <StageError
        message="Could not load the 3D preview."
        detail={manifestError instanceof ApiError ? manifestError.message : null}
      />
    );
  }
  if (!hasPatches) {
    return (
      <StageMessage
        icon={<Diamond size={22} className="text-primary" />}
        title="Nothing to display"
        body="No patches were produced for this build."
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
      onRebuild={() => onSelect(null)}
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

function StageError({ message, detail }: { message: string; detail: string | null }) {
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
      </div>
    </div>
  );
}

export default ChamberViewer;
