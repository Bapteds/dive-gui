import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, Loader2, PackagePlus, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getMeshSourceGeometry } from '@/lib/api/meshes';
import type { MeshSource, PartTransform } from '@/lib/api/types';
import { useMergePlanQuery, useMeshesQuery } from '@/features/projects/useMeshes';
import { meshSourceGeometryQueryKey } from './useAssembly';
import { AssemblyViewer, AssemblyViewerError, type PlacedViewerPart } from './AssemblyViewer';
import { PartsRail } from './PartsRail';
import { PlacementPanel } from './PlacementPanel';
import { AssemblyMergeDialog, type StitchDraft } from './AssemblyMergeDialog';
import type { HitTarget } from './placement';

/**
 * AssemblyWorkspace - the full-height "Assemble" tab: a three-pane workspace that
 * generalises single-part import/visualise/merge into a multi-part assembly.
 *
 *   Parts rail (left)  - the library as a roster: import / auto-patch / rename,
 *                        base first, the rest selectable to position.
 *   Live canvas (center) - the base + placed parts + the active orange ghost,
 *                        updated in real time as the user places a part.
 *   Placement panel (right) - pick a base face + a mating patch, roll, offset,
 *                        confirm. One orange "Merge" CTA finishes into one mesh.
 *
 * All placement math is raw-coordinate and lives in the viewer/placement.ts; this
 * component owns the workspace STATE (order, per-part draft, committed transforms)
 * and the geometry loading for every body on screen.
 */

const FIVE_MINUTES = 5 * 60 * 1000;

/** A per-part placement draft (the in-progress inputs before Confirm). */
interface Draft {
  matingPatch: string | null;
  target: HitTarget | null;
  rollDeg: number;
  offset: number;
}
const EMPTY_DRAFT: Draft = { matingPatch: null, target: null, rollDeg: 0, offset: 0 };

export function AssemblyWorkspace({ projectId }: { projectId: string }) {
  const meshesQuery = useMeshesQuery(projectId);
  const planQuery = useMergePlanQuery(projectId);
  const meshes = useMemo(() => meshesQuery.data ?? [], [meshesQuery.data]);
  const meshById = useMemo(() => new Map(meshes.map((m) => [m.id, m] as const)), [meshes]);

  // ---- assembly order (index 0 = base), seeded from the saved plan ----
  const [order, setOrder] = useState<string[]>([]);
  const ready = !meshesQuery.isPending && !planQuery.isPending;
  const initRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const ids = meshes.map((m) => m.id);
    if (!initRef.current) {
      initRef.current = true;
      const seed = (planQuery.data?.order ?? []).filter((id) => ids.includes(id));
      setOrder([...seed, ...ids.filter((id) => !seed.includes(id))]);
      return;
    }
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const appended = ids.filter((id) => !kept.includes(id));
      return kept.length === prev.length && appended.length === 0 ? prev : [...kept, ...appended];
    });
  }, [ready, meshes, planQuery.data]);

  const orderedMeshes = useMemo(
    () => order.map((id) => meshById.get(id)).filter((m): m is MeshSource => !!m),
    [order, meshById],
  );
  const base = orderedMeshes[0] ?? null;

  // ---- placement state ----
  const [activePartId, setActivePartId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [committed, setCommitted] = useState<Record<string, PartTransform>>({});
  const [pending, setPending] = useState<PartTransform | null>(null);
  const [lastSeed, setLastSeed] = useState<StitchDraft | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [viewerError, setViewerError] = useState(false);

  // Drop state for parts that were removed, and never keep the base active.
  useEffect(() => {
    const ids = new Set(orderedMeshes.map((m) => m.id));
    if (activePartId && (!ids.has(activePartId) || activePartId === base?.id)) {
      setActivePartId(null);
    }
    setCommitted((prev) => {
      const next: Record<string, PartTransform> = {};
      let changed = false;
      for (const [id, transform] of Object.entries(prev)) {
        if (ids.has(id) && id !== base?.id) next[id] = transform;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [orderedMeshes, activePartId, base?.id]);

  // Reset the pending (live) transform whenever the active part changes, so a
  // stale placement from the previous part can never be committed.
  useEffect(() => {
    setPending(null);
  }, [activePartId]);

  const activePart = activePartId ? (meshById.get(activePartId) ?? null) : null;
  const activeDraft = (activePartId && drafts[activePartId]) || EMPTY_DRAFT;

  // ---- geometry: load every body currently on screen ----
  const neededIds = useMemo(() => {
    const ids = new Set<string>();
    if (base) ids.add(base.id);
    if (activePartId) ids.add(activePartId);
    for (const id of Object.keys(committed)) ids.add(id);
    return [...ids];
  }, [base, activePartId, committed]);

  const geomResults = useQueries({
    queries: neededIds.map((id) => ({
      queryKey: meshSourceGeometryQueryKey(projectId, id),
      queryFn: async () => (await getMeshSourceGeometry(projectId, id)).arrayBuffer(),
      enabled: true,
      retry: false,
      staleTime: FIVE_MINUTES,
      gcTime: FIVE_MINUTES,
    })),
  });
  const geomByMesh = useMemo(() => {
    const map = new Map<string, (typeof geomResults)[number]>();
    neededIds.forEach((id, i) => map.set(id, geomResults[i]));
    return map;
  }, [neededIds, geomResults]);

  const baseGeom = base ? geomByMesh.get(base.id) : undefined;

  // Placed parts to render opaque (committed, excluding the one being re-placed).
  const placedParts = useMemo<PlacedViewerPart[]>(() => {
    const list: PlacedViewerPart[] = [];
    for (const [meshId, transform] of Object.entries(committed)) {
      if (meshId === activePartId) continue;
      const mesh = meshById.get(meshId);
      const geometry = geomByMesh.get(meshId)?.data;
      if (mesh && geometry) list.push({ meshId, name: mesh.name, geometry, transform });
    }
    return list;
  }, [committed, activePartId, meshById, geomByMesh]);

  const activeGeom = activePartId ? geomByMesh.get(activePartId) : undefined;
  const activeViewerPart =
    activePart && activeGeom?.data
      ? { meshId: activePart.id, name: activePart.name, geometry: activeGeom.data }
      : null;

  // ---- interactions ----
  const patchDraft = (patch: Partial<Draft>) => {
    if (!activePartId) return;
    setDrafts((prev) => ({ ...prev, [activePartId]: { ...(prev[activePartId] ?? EMPTY_DRAFT), ...patch } }));
  };

  const handleSelectPart = (meshId: string) => {
    setViewerError(false);
    setActivePartId(meshId);
  };

  const handlePickBaseFace = (target: HitTarget) => patchDraft({ target });

  const canConfirm = !!pending && pending.meshId === activePartId && !!activeDraft.target && !!activeDraft.matingPatch;

  const handleConfirm = () => {
    if (!activePartId || !pending || pending.meshId !== activePartId) return;
    setCommitted((prev) => ({ ...prev, [activePartId]: { ...pending, meshId: activePartId } }));
    if (base && activeDraft.matingPatch && activeDraft.target) {
      setLastSeed({
        aMeshId: activePartId,
        aPatch: activeDraft.matingPatch,
        bMeshId: base.id,
        bPatch: activeDraft.target.patchName,
      });
    }
    setActivePartId(null); // commit -> the ghost becomes a placed (neutral) part
  };

  const handleClearPlacement = () => {
    if (!activePartId) return;
    setDrafts((prev) => ({ ...prev, [activePartId]: EMPTY_DRAFT }));
    setCommitted((prev) => {
      if (!(activePartId in prev)) return prev;
      const next = { ...prev };
      delete next[activePartId];
      return next;
    });
    setPending(null);
  };

  const moveMesh = (index: number, direction: -1 | 1) => {
    setOrder((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const placedIds = useMemo(() => new Set(Object.keys(committed)), [committed]);
  const positionedCount = placedIds.size;
  const additionalCount = Math.max(0, orderedMeshes.length - 1);
  const unplacedCount = Math.max(0, additionalCount - positionedCount);
  const canMerge = orderedMeshes.length >= 2;

  const transforms = useMemo<PartTransform[]>(
    () =>
      orderedMeshes
        .map((m) => committed[m.id])
        .filter((t): t is PartTransform => !!t),
    [orderedMeshes, committed],
  );

  return (
    <section
      aria-label="3D assembly workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm"
    >
      {/* Toolbar: title + the single orange Merge CTA. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Assembly</h2>
          {orderedMeshes.length > 0 && (
            <span className="text-xs text-text-secondary tabular-nums">
              {orderedMeshes.length} part{orderedMeshes.length === 1 ? '' : 's'} &middot;{' '}
              {positionedCount} positioned
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {canMerge && unplacedCount > 0 && (
            <span className="hidden text-xs text-text-secondary sm:inline">
              {unplacedCount} not positioned
            </span>
          )}
          <Button
            type="button"
            onClick={() => setMergeOpen(true)}
            disabled={!canMerge}
            title={canMerge ? undefined : 'Add at least one part beyond the base to merge.'}
          >
            <Workflow strokeWidth={1.75} aria-hidden="true" />
            Merge
          </Button>
        </div>
      </div>

      {/* Three panes. Stacks on small screens; a strict grid at lg+. */}
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(16rem,20rem)_1fr_minmax(17rem,22rem)]">
        <aside className="flex min-h-0 flex-col border-b border-border p-4 lg:border-b-0 lg:border-r">
          <PartsRail
            projectId={projectId}
            query={meshesQuery}
            orderedMeshes={orderedMeshes}
            activePartId={activePartId}
            placedIds={placedIds}
            onSelectPart={handleSelectPart}
            onMove={moveMesh}
          />
        </aside>

        <div className="relative min-h-[45vh] border-b border-border lg:min-h-0 lg:border-b-0">
          <CanvasArea
            base={base}
            baseGeometry={baseGeom}
            placed={placedParts}
            active={activeViewerPart}
            matingPatch={activeDraft.matingPatch}
            target={activeDraft.target}
            rollRad={(activeDraft.rollDeg * Math.PI) / 180}
            offset={activeDraft.offset}
            viewerError={viewerError}
            onPickBaseFace={handlePickBaseFace}
            onPreviewTransform={setPending}
            onViewerError={() => setViewerError(true)}
            onRetry={() => {
              setViewerError(false);
              void baseGeom?.refetch();
            }}
          />
        </div>

        <aside className="flex min-h-0 flex-col p-4 lg:border-l lg:border-border">
          <PlacementPanel
            activePart={activePart}
            matingPatch={activeDraft.matingPatch}
            onMatingPatchChange={(matingPatch) => patchDraft({ matingPatch: matingPatch || null })}
            target={activeDraft.target}
            rollDeg={activeDraft.rollDeg}
            onRollDegChange={(rollDeg) => patchDraft({ rollDeg })}
            offset={activeDraft.offset}
            onOffsetChange={(offset) => patchDraft({ offset })}
            canConfirm={canConfirm}
            onConfirm={handleConfirm}
            onClear={handleClearPlacement}
            isPlaced={!!activePartId && activePartId in committed}
          />
          {activePartId && activeGeom?.isPending && (
            <p className="mt-3 flex items-center gap-2 text-xs text-text-secondary" role="status">
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              Loading the part&rsquo;s geometry&hellip;
            </p>
          )}
        </aside>
      </div>

      {mergeOpen && (
        <AssemblyMergeDialog
          projectId={projectId}
          orderedMeshes={orderedMeshes}
          transforms={transforms}
          seedStitch={lastSeed}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * The center stage: resolves, in order, no base -> base geometry building ->
 * base geometry failed -> viewer parse failed -> the live viewer.
 */
function CanvasArea({
  base,
  baseGeometry,
  placed,
  active,
  matingPatch,
  target,
  rollRad,
  offset,
  viewerError,
  onPickBaseFace,
  onPreviewTransform,
  onViewerError,
  onRetry,
}: {
  base: MeshSource | null;
  baseGeometry: { data?: ArrayBuffer; isPending: boolean; isError: boolean } | undefined;
  placed: PlacedViewerPart[];
  active: { meshId: string; name: string; geometry: ArrayBuffer } | null;
  matingPatch: string | null;
  target: HitTarget | null;
  rollRad: number;
  offset: number;
  viewerError: boolean;
  onPickBaseFace: (target: HitTarget) => void;
  onPreviewTransform: (transform: PartTransform | null) => void;
  onViewerError: () => void;
  onRetry: () => void;
}) {
  if (!base) {
    return (
      <StageMessage
        icon={<PackagePlus className="size-6 text-primary" strokeWidth={1.5} aria-hidden="true" />}
        title="Import the base part"
        body="Add the first part on the left. It becomes the base that the others mount onto."
      />
    );
  }

  if (viewerError) {
    return <AssemblyViewerError onRetry={onRetry} />;
  }

  if (!baseGeometry || baseGeometry.isPending) {
    return (
      <StageMessage
        icon={<Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />}
        title="Building 3D preview"
        body="Extracting the base geometry. This runs once and is cached afterwards."
      />
    );
  }

  if (baseGeometry.isError || !baseGeometry.data) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-6 py-12">
        <div
          role="alert"
          className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-danger/40 bg-danger-tint px-5 py-6 text-center"
        >
          <AlertTriangle className="size-6 text-danger" strokeWidth={1.75} aria-hidden="true" />
          <p className="text-base font-semibold text-text">Could not load the base geometry.</p>
          <Button type="button" onClick={onRetry} className="mt-1">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AssemblyViewer
      base={{ meshId: base.id, name: base.name, geometry: baseGeometry.data }}
      placed={placed}
      active={active}
      matingPatch={matingPatch}
      target={target}
      rollRad={rollRad}
      offset={offset}
      onPickBaseFace={onPickBaseFace}
      onPreviewTransform={onPreviewTransform}
      onError={onViewerError}
    />
  );
}

/** A centered icon + message filling the stage (loading / empty states). */
function StageMessage({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
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

export default AssemblyWorkspace;
