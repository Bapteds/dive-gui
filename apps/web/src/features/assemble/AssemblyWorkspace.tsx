import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, History, Loader2, PackagePlus, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getMeshSourceGeometry } from '@/lib/api/meshes';
import { getMeshGeometry } from '@/lib/api/projects';
import type { MeshSource, PartTransform } from '@/lib/api/types';
import { MERGE_BASE_CASE } from '@/lib/api/types';
import { useMergePlanQuery, useMeshesQuery } from '@/features/projects/useMeshes';
import { useCaseFilesQuery } from '@/features/projects/useCaseFiles';
import {
  caseMeshGeometryQueryKey,
  meshSourceGeometryQueryKey,
  useCaseMeshManifestQuery,
} from './useAssembly';
import {
  AssemblyViewer,
  AssemblyViewerError,
  type GizmoMode,
  type PlacedViewerPart,
} from './AssemblyViewer';
import { PartsRail, type BaseSource } from './PartsRail';
import { PlacementPanel } from './PlacementPanel';
import { AssemblyMergeDialog, type InterfaceDraft } from './AssemblyMergeDialog';
import { eulerDegFromQuat, quatFromEulerDeg, type HitTarget } from './placement';

/**
 * AssemblyWorkspace - the full-height "Assemble" tab: a three-pane workspace that
 * generalises single-part import/visualise/merge into a multi-part assembly.
 *
 *   Parts rail (left)  - the library as a roster: import / auto-patch / rename,
 *                        base first, the rest selectable. The base can be the
 *                        project's EXISTING case mesh or the first library part.
 *   Live canvas (center) - the base + every added part at its imported position +
 *                        the active orange ghost, with an optional 6-DOF gizmo.
 *   Placement panel (right) - couple the active part's mating patch to a base
 *                        patch (this does NOT move it), and, only if it is
 *                        misaligned, opt in to reposition it.
 *
 * PLACEMENT IS OPTIONAL. Parts carry real world coordinates from their import, so
 * they stay where they were imported by default; coupling + merging never require
 * moving a part. The couple pair (an interface) is tracked independently of any
 * transform, and a transform is only committed when the user explicitly
 * repositions a part. All placement math is raw-coordinate (see placement.ts).
 */

const FIVE_MINUTES = 5 * 60 * 1000;

/** The identity transform: a part left at its imported position. */
function identityTransform(meshId: string): PartTransform {
  return { meshId, translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
}

/** True when a transform leaves the part at its imported position (no move). */
function isIdentityTransform(transform: PartTransform): boolean {
  const [tx, ty, tz] = transform.translation;
  const [rx, ry, rz, rw] = transform.rotation;
  return tx === 0 && ty === 0 && tz === 0 && rx === 0 && ry === 0 && rz === 0 && rw === 1;
}

/**
 * A per-part draft. `matingPatch` + `target` define the couple (an interface) and
 * never move the part. `reposition` is the explicit opt-in to move it; `transform`
 * is the 6-DOF placement, kept at identity until the user repositions.
 */
interface Draft {
  matingPatch: string | null;
  target: HitTarget | null;
  reposition: boolean;
  transform: PartTransform;
}
const defaultDraft = (meshId: string): Draft => ({
  matingPatch: null,
  target: null,
  reposition: false,
  transform: identityTransform(meshId),
});

/** The base body's geometry + load state, unified across case / library bases. */
interface BaseStatus {
  data?: ArrayBuffer;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function AssemblyWorkspace({ projectId }: { projectId: string }) {
  const meshesQuery = useMeshesQuery(projectId);
  const planQuery = useMergePlanQuery(projectId);
  const caseFilesQuery = useCaseFilesQuery(projectId);
  const meshes = useMemo(() => meshesQuery.data ?? [], [meshesQuery.data]);
  const meshById = useMemo(() => new Map(meshes.map((m) => [m.id, m] as const)), [meshes]);

  // Whether the project already has a case mesh that could be the assembly base.
  const hasCaseMesh = useMemo(
    () => !!caseFilesQuery.data?.some((entry) => entry.path.startsWith('constant/polyMesh/')),
    [caseFilesQuery.data],
  );

  // ---- base source: the project case mesh, or the first library part ----
  const [baseSource, setBaseSource] = useState<BaseSource>('library');
  const baseInitRef = useRef(false);
  useEffect(() => {
    if (baseInitRef.current) return;
    if (meshesQuery.isPending || planQuery.isPending || caseFilesQuery.isPending) return;
    baseInitRef.current = true;
    const planOrder0 = planQuery.data?.order?.[0];
    if (planOrder0 === MERGE_BASE_CASE && hasCaseMesh) setBaseSource('case');
    else if (planOrder0) setBaseSource('library');
    else setBaseSource(hasCaseMesh ? 'case' : 'library');
  }, [
    meshesQuery.isPending,
    planQuery.isPending,
    caseFilesQuery.isPending,
    planQuery.data,
    hasCaseMesh,
  ]);
  // If the case mesh is not (or no longer) available, the base is a library part.
  useEffect(() => {
    if (!hasCaseMesh && baseSource === 'case') setBaseSource('library');
  }, [hasCaseMesh, baseSource]);

  const caseBaseSelected = baseSource === 'case' && hasCaseMesh;
  const caseManifest = useCaseMeshManifestQuery(projectId, caseBaseSelected);

  // The synthetic base entry for the project case mesh: a MeshSource whose patches
  // come from the case manifest, pinned at identity and never moved / committed.
  const caseBase = useMemo<MeshSource | null>(
    () =>
      caseBaseSelected
        ? {
            id: MERGE_BASE_CASE,
            name: 'Project case mesh',
            patches: caseManifest.data?.patches ?? [],
            createdAt: '',
          }
        : null,
    [caseBaseSelected, caseManifest.data],
  );

  // ---- library order (index 0 = base only when there is no case base) ----
  const [order, setOrder] = useState<string[]>([]);
  const ready = !meshesQuery.isPending && !planQuery.isPending;
  const initRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const ids = meshes.map((m) => m.id);
    if (!initRef.current) {
      initRef.current = true;
      // The saved plan may lead with the case sentinel; it is not a library id,
      // so this filter drops it and keeps only the library order.
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

  const libraryOrdered = useMemo(
    () => order.map((id) => meshById.get(id)).filter((m): m is MeshSource => !!m),
    [order, meshById],
  );
  // The full assembly order: the case base (when chosen) leads, then the library.
  const orderedMeshes = useMemo(
    () => (caseBase ? [caseBase, ...libraryOrdered] : libraryOrdered),
    [caseBase, libraryOrdered],
  );
  const base = orderedMeshes[0] ?? null;
  // The base is the project case mesh (pinned at identity, never movable).
  const basePinned = base?.id === MERGE_BASE_CASE;

  // ---- placement state ----
  const [activePartId, setActivePartId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [alignSuggestion, setAlignSuggestion] = useState<PartTransform | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [viewerError, setViewerError] = useState(false);

  // Drop drafts for parts that were removed, and never keep the base active.
  useEffect(() => {
    const ids = new Set(orderedMeshes.map((m) => m.id));
    if (activePartId && (!ids.has(activePartId) || activePartId === base?.id)) {
      setActivePartId(null);
    }
    setDrafts((prev) => {
      const next: Record<string, Draft> = {};
      let changed = false;
      for (const [id, draft] of Object.entries(prev)) {
        if (ids.has(id) && id !== base?.id) next[id] = draft;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [orderedMeshes, activePartId, base?.id]);

  // A stale align suggestion from the previous part can never be applied.
  useEffect(() => {
    setAlignSuggestion(null);
  }, [activePartId]);

  const activePart = activePartId ? (meshById.get(activePartId) ?? null) : null;
  const activeDraft = activePartId ? (drafts[activePartId] ?? defaultDraft(activePartId)) : null;
  const activeReposition = activeDraft?.reposition ?? false;
  const activeTransform = activeDraft ? activeDraft.transform : identityTransform(activePartId ?? '');
  const activePosition = activeTransform.translation;
  const activeRotationDeg = useMemo(
    () => eulerDegFromQuat(activeTransform.rotation),
    [activeTransform.rotation],
  );
  const isActiveRepositioned = activeReposition && !isIdentityTransform(activeTransform);

  // ---- geometry: load every body on screen (base + all parts at their position) ----
  const neededIds = useMemo(() => orderedMeshes.map((m) => m.id), [orderedMeshes]);

  const geomResults = useQueries({
    queries: neededIds.map((id) => {
      const isCase = id === MERGE_BASE_CASE;
      return {
        queryKey: isCase
          ? caseMeshGeometryQueryKey(projectId)
          : meshSourceGeometryQueryKey(projectId, id),
        // The case geometry endpoint expects the server build to exist, so gate it
        // on the case manifest (which triggers that build) having succeeded.
        queryFn: async () =>
          isCase
            ? (await getMeshGeometry(projectId)).arrayBuffer()
            : (await getMeshSourceGeometry(projectId, id)).arrayBuffer(),
        enabled: isCase ? caseManifest.isSuccess : true,
        retry: false,
        staleTime: FIVE_MINUTES,
        gcTime: FIVE_MINUTES,
      };
    }),
  });
  const geomByMesh = useMemo(() => {
    const map = new Map<string, (typeof geomResults)[number]>();
    neededIds.forEach((id, i) => map.set(id, geomResults[i]));
    return map;
  }, [neededIds, geomResults]);

  // The base body's status, unified: a library base is a plain source-geometry
  // query; the case base folds in the manifest build that gates its geometry.
  const rawBaseGeom = base ? geomByMesh.get(base.id) : undefined;
  const baseStatus = useMemo<BaseStatus | undefined>(() => {
    if (!base) return undefined;
    if (basePinned) {
      return {
        data: rawBaseGeom?.data,
        isPending: caseManifest.isPending || (caseManifest.isSuccess && (rawBaseGeom?.isPending ?? true)),
        isError: caseManifest.isError || (rawBaseGeom?.isError ?? false),
        refetch: () => {
          void caseManifest.refetch();
          void rawBaseGeom?.refetch();
        },
      };
    }
    return {
      data: rawBaseGeom?.data,
      isPending: rawBaseGeom?.isPending ?? true,
      isError: rawBaseGeom?.isError ?? false,
      refetch: () => void rawBaseGeom?.refetch(),
    };
  }, [base, basePinned, rawBaseGeom, caseManifest]);

  // Every added part except the one being worked on, at its transform (identity =
  // imported position). This shows the whole pre-aligned assembly.
  const placedParts = useMemo<PlacedViewerPart[]>(() => {
    const list: PlacedViewerPart[] = [];
    for (const mesh of orderedMeshes) {
      if (!base || mesh.id === base.id || mesh.id === activePartId) continue;
      const geometry = geomByMesh.get(mesh.id)?.data;
      if (!geometry) continue;
      const draft = drafts[mesh.id];
      const transform =
        draft?.reposition && !isIdentityTransform(draft.transform)
          ? draft.transform
          : identityTransform(mesh.id);
      list.push({ meshId: mesh.id, name: mesh.name, geometry, transform });
    }
    return list;
  }, [orderedMeshes, base, activePartId, geomByMesh, drafts]);

  const activeGeom = activePartId ? geomByMesh.get(activePartId) : undefined;
  const activeViewerPart =
    activePart && activeGeom?.data
      ? { meshId: activePart.id, name: activePart.name, geometry: activeGeom.data }
      : null;

  // ---- interactions ----
  const patchDraft = (patch: Partial<Draft>) => {
    if (!activePartId) return;
    setDrafts((prev) => ({
      ...prev,
      [activePartId]: { ...(prev[activePartId] ?? defaultDraft(activePartId)), ...patch },
    }));
  };

  const handleSelectPart = (meshId: string) => {
    setViewerError(false);
    setActivePartId(meshId);
  };

  // Picking a base face sets the coupling's base patch; it never moves the part.
  const handlePickBaseFace = (target: HitTarget) => patchDraft({ target });
  const handleMatingPatch = (patch: string) => patchDraft({ matingPatch: patch || null });
  const handleClearCouple = () => patchDraft({ matingPatch: null, target: null });

  const handleRepositionChange = (on: boolean) => {
    if (!activePartId) return;
    // Turning it off returns the part to its imported position (identity).
    patchDraft(on ? { reposition: true } : { reposition: false, transform: identityTransform(activePartId) });
  };

  // The gizmo moved the ghost: adopt its transform (repositioning is now on).
  const handleTransformChange = (transform: PartTransform) =>
    patchDraft({ reposition: true, transform });

  const handlePositionChange = (axis: 0 | 1 | 2, value: number) => {
    if (!activeDraft || !activePartId) return;
    const translation = [...activeDraft.transform.translation] as [number, number, number];
    translation[axis] = Number.isFinite(value) ? value : 0;
    patchDraft({
      reposition: true,
      transform: { meshId: activePartId, translation, rotation: activeDraft.transform.rotation },
    });
  };

  const handleRotationChange = (axis: 0 | 1 | 2, value: number) => {
    if (!activeDraft || !activePartId) return;
    const deg = eulerDegFromQuat(activeDraft.transform.rotation);
    deg[axis] = Number.isFinite(value) ? value : 0;
    patchDraft({
      reposition: true,
      transform: {
        meshId: activePartId,
        translation: activeDraft.transform.translation,
        rotation: quatFromEulerDeg(deg),
      },
    });
  };

  const handleAlignToFace = () => {
    if (!alignSuggestion || !activePartId) return;
    patchDraft({ reposition: true, transform: { ...alignSuggestion, meshId: activePartId } });
  };

  // Reset the position but keep the reposition editor open for another attempt.
  const handleResetPosition = () => {
    if (!activePartId) return;
    patchDraft({ transform: identityTransform(activePartId) });
  };

  // Reorder within the LIBRARY order. `index` is the display index; when the case
  // base is pinned at display index 0 it shifts the library index by one.
  const moveMesh = (index: number, direction: -1 | 1) => {
    const offset = basePinned ? 1 : 0;
    const from = index - offset;
    const to = from + direction;
    setOrder((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  };

  // Every complete couple pair, as a seeded interface for the merge dialog. These
  // are defined WITHOUT any transform: a part can be coupled and merged unmoved.
  const seedInterfaces = useMemo<InterfaceDraft[]>(() => {
    if (!base) return [];
    const out: InterfaceDraft[] = [];
    for (const mesh of orderedMeshes) {
      if (mesh.id === base.id) continue;
      const draft = drafts[mesh.id];
      if (draft?.matingPatch && draft.target?.patchName) {
        out.push({
          aMeshId: mesh.id,
          aPatch: draft.matingPatch,
          bMeshId: base.id,
          bPatch: draft.target.patchName,
          coupling: 'nonConformal',
        });
      }
    }
    return out;
  }, [orderedMeshes, base, drafts]);

  // A transform is sent ONLY for a part the user explicitly repositioned; an
  // unmoved part has no entry and stays at its imported position.
  const transforms = useMemo<PartTransform[]>(() => {
    const out: PartTransform[] = [];
    for (const mesh of orderedMeshes) {
      if (!base || mesh.id === base.id) continue;
      const draft = drafts[mesh.id];
      if (draft?.reposition && !isIdentityTransform(draft.transform)) {
        out.push({
          meshId: mesh.id,
          translation: draft.transform.translation,
          rotation: draft.transform.rotation,
        });
      }
    }
    return out;
  }, [orderedMeshes, base, drafts]);

  const placedIds = useMemo(() => new Set(transforms.map((t) => t.meshId)), [transforms]);
  const coupledCount = seedInterfaces.length;
  const canMerge = orderedMeshes.length >= 2;

  return (
    <section
      aria-label="3D assembly workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm"
    >
      {/* Toolbar: title + counts + the single orange Merge CTA, then the note. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-semibold text-text">Assembly</h2>
            {orderedMeshes.length > 0 && (
              <span className="text-xs text-text-secondary tabular-nums">
                {orderedMeshes.length} part{orderedMeshes.length === 1 ? '' : 's'} &middot;{' '}
                {coupledCount} coupled
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3">
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
        {base && (
          <p className="flex items-start gap-1.5 text-xs text-text-secondary">
            <History className="mt-px size-3.5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span>
              Merging replaces the case mesh; the previous mesh is backed up and restorable from the
              Visualize tab. Parts stay separate (cyclicAMI).
            </span>
          </p>
        )}
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
            basePinned={basePinned}
            baseSource={baseSource}
            onBaseSourceChange={setBaseSource}
            caseBaseAvailable={hasCaseMesh}
            onSelectPart={handleSelectPart}
            onMove={moveMesh}
          />
        </aside>

        <div className="relative min-h-[45vh] border-b border-border lg:min-h-0 lg:border-b-0">
          <CanvasArea
            base={base}
            baseGeometry={baseStatus}
            placed={placedParts}
            active={activeViewerPart}
            activeTransform={activeTransform}
            matingPatch={activeDraft?.matingPatch ?? null}
            target={activeDraft?.target ?? null}
            reposition={activeReposition}
            gizmoMode={gizmoMode}
            viewerError={viewerError}
            onPickBaseFace={handlePickBaseFace}
            onTransformChange={handleTransformChange}
            onAlignTransform={setAlignSuggestion}
            onViewerError={() => setViewerError(true)}
            onRetry={() => {
              setViewerError(false);
              baseStatus?.refetch();
            }}
          />
        </div>

        <aside className="flex min-h-0 flex-col p-4 lg:border-l lg:border-border">
          <PlacementPanel
            activePart={activePart}
            baseName={base?.name ?? null}
            matingPatch={activeDraft?.matingPatch ?? null}
            onMatingPatchChange={handleMatingPatch}
            target={activeDraft?.target ?? null}
            onClearCouple={handleClearCouple}
            reposition={activeReposition}
            onRepositionChange={handleRepositionChange}
            gizmoMode={gizmoMode}
            onGizmoModeChange={setGizmoMode}
            position={activePosition}
            rotationDeg={activeRotationDeg}
            onPositionChange={handlePositionChange}
            onRotationChange={handleRotationChange}
            alignAvailable={!!alignSuggestion}
            onAlignToFace={handleAlignToFace}
            onResetPosition={handleResetPosition}
            isRepositioned={isActiveRepositioned}
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
          seedInterfaces={seedInterfaces}
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
  activeTransform,
  matingPatch,
  target,
  reposition,
  gizmoMode,
  viewerError,
  onPickBaseFace,
  onTransformChange,
  onAlignTransform,
  onViewerError,
  onRetry,
}: {
  base: MeshSource | null;
  baseGeometry: { data?: ArrayBuffer; isPending: boolean; isError: boolean } | undefined;
  placed: PlacedViewerPart[];
  active: { meshId: string; name: string; geometry: ArrayBuffer } | null;
  activeTransform: PartTransform;
  matingPatch: string | null;
  target: HitTarget | null;
  reposition: boolean;
  gizmoMode: GizmoMode;
  viewerError: boolean;
  onPickBaseFace: (target: HitTarget) => void;
  onTransformChange: (transform: PartTransform) => void;
  onAlignTransform: (transform: PartTransform | null) => void;
  onViewerError: () => void;
  onRetry: () => void;
}) {
  if (!base) {
    return (
      <StageMessage
        icon={<PackagePlus className="size-6 text-primary" strokeWidth={1.5} aria-hidden="true" />}
        title="Choose the assembly base"
        body="Pick your project mesh or add the first part on the left. It becomes the base that the others couple onto."
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
      activeTransform={activeTransform}
      matingPatch={matingPatch}
      target={target}
      reposition={reposition}
      gizmoMode={gizmoMode}
      onPickBaseFace={onPickBaseFace}
      onTransformChange={onTransformChange}
      onAlignTransform={onAlignTransform}
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
