import { useEffect, useMemo, useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileArchive,
  FileCog,
  FolderUp,
  Loader2,
  MinusCircle,
  Plus,
  Trash2,
  Workflow,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Diamond } from '@/components/brand/Diamond';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  ImportStep,
  MergeRunResult,
  MergeStep,
  MergeStepKind,
  MeshSource,
  StitchPair,
} from '@/lib/api/types';
import {
  useDeleteMesh,
  useImportMesh,
  useMergePlanQuery,
  useMeshesQuery,
  useRunMerge,
} from '@/features/projects/useMeshes';
import { ImportReport } from '@/features/projects/ImportReport';

/**
 * MergeMeshesFlow - the guided "Merge meshes" dialog, opened from the Case files
 * card. Combines several imported polyMesh sources into the case's single
 * constant/polyMesh, conformally fusing chosen patch pairs.
 *
 *  1. Sources:     the per-project mesh LIBRARY - import (folder / .zip), order
 *     (the first is the master), and remove sources. Continue unlocks with one.
 *  2. Connections: the stitch-pair editor - fuse mesh A's patch to mesh B's
 *     patch (e.g. one part's outlet against the next part's inlet). Optional:
 *     with no connections the meshes are combined side by side.
 *  3. Confirm:     restate that it overwrites the case mesh, and preview the
 *     pipeline that will run (prepare -> mergeMeshes -> stitchMesh -> cleanup ->
 *     checkMesh).
 *  4. Run:         while the server runs the pipeline, a running state; then a
 *     per-step report with a status rail and collapsible logs.
 *
 * Mirrors ConvertToFoamFlow: it owns its source roster (so it opens straight
 * from an empty project) and a successful merge refreshes the case tree.
 */

type Step = 'sources' | 'connections' | 'confirm' | 'run';

/** A stitch pair under construction (fields fill in as the user picks). */
interface StitchDraft {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
}

const EMPTY_DRAFT: StitchDraft = { aMeshId: '', aPatch: '', bMeshId: '', bPatch: '' };

/** Every field chosen - the pair can be stitched. */
function isComplete(draft: StitchDraft): boolean {
  return !!(draft.aMeshId && draft.aPatch && draft.bMeshId && draft.bPatch);
}

/** No field chosen - an untouched row, ignored on run. */
function isBlank(draft: StitchDraft): boolean {
  return !draft.aMeshId && !draft.aPatch && !draft.bMeshId && !draft.bPatch;
}

/** Shared styling for the native selects (matches the token form vocabulary). */
const SELECT_CLASS =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

interface MergeMeshesFlowProps {
  projectId: string;
  /** Close the whole flow. */
  onClose: () => void;
}

export function MergeMeshesFlow({ projectId, onClose }: MergeMeshesFlowProps) {
  const meshesQuery = useMeshesQuery(projectId);
  const planQuery = useMergePlanQuery(projectId);
  const meshes = useMemo(() => meshesQuery.data ?? [], [meshesQuery.data]);
  const meshById = useMemo(() => new Map(meshes.map((m) => [m.id, m] as const)), [meshes]);

  const [step, setStep] = useState<Step>('sources');
  const [order, setOrder] = useState<string[]>([]);
  const [stitches, setStitches] = useState<StitchDraft[]>([]);
  const [result, setResult] = useState<MergeRunResult | null>(null);

  const merge = useRunMerge(projectId);
  const running = merge.isPending;

  // Seed order + stitches from the saved plan once both the library and the plan
  // have loaded, then keep them valid as sources are imported / removed.
  const ready = !meshesQuery.isPending && !planQuery.isPending;
  const initRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const ids = meshes.map((m) => m.id);
    if (!initRef.current) {
      initRef.current = true;
      const seed = (planQuery.data?.order ?? []).filter((id) => ids.includes(id));
      setOrder([...seed, ...ids.filter((id) => !seed.includes(id))]);
      setStitches(
        (planQuery.data?.stitches ?? [])
          .filter((s) => {
            const a = meshById.get(s.aMeshId);
            const b = meshById.get(s.bMeshId);
            return (
              !!a &&
              !!b &&
              a.patches.some((p) => p.name === s.aPatch) &&
              b.patches.some((p) => p.name === s.bPatch)
            );
          })
          .map((s) => ({ aMeshId: s.aMeshId, aPatch: s.aPatch, bMeshId: s.bMeshId, bPatch: s.bPatch })),
      );
      return;
    }
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const appended = ids.filter((id) => !kept.includes(id));
      return kept.length === prev.length && appended.length === 0 ? prev : [...kept, ...appended];
    });
    setStitches((prev) => {
      const next = prev.filter(
        (s) => (!s.aMeshId || ids.includes(s.aMeshId)) && (!s.bMeshId || ids.includes(s.bMeshId)),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [ready, meshes, meshById, planQuery.data]);

  const orderedMeshes = useMemo(
    () => order.map((id) => meshById.get(id)).filter((m): m is MeshSource => !!m),
    [order, meshById],
  );
  const completeStitches = useMemo<StitchPair[]>(
    () =>
      stitches.filter(isComplete).map((s) => ({
        aMeshId: s.aMeshId,
        aPatch: s.aPatch,
        bMeshId: s.bMeshId,
        bPatch: s.bPatch,
      })),
    [stitches],
  );
  const plannedSteps = useMemo(
    () => buildPipelinePreview(orderedMeshes, completeStitches, meshById),
    [orderedMeshes, completeStitches, meshById],
  );

  const moveMesh = (index: number, direction: -1 | 1) => {
    setOrder((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleRun = async () => {
    setResult(null);
    setStep('run');
    try {
      const res = await merge.mutateAsync({
        order: orderedMeshes.map((m) => m.id),
        stitches: completeStitches,
      });
      setResult(res);
      if (res.success) {
        toast.success('Meshes merged.');
      } else {
        toast.error('Merge failed. See the report.');
      }
    } catch (err) {
      // A validation error (empty/invalid plan, unknown patch): go back to confirm.
      setStep('confirm');
      toast.error(err instanceof ApiError ? err.message : 'Could not start the merge.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      {step === 'sources' && (
        <SourcesStep
          projectId={projectId}
          query={meshesQuery}
          orderedMeshes={orderedMeshes}
          onMove={moveMesh}
          onContinue={() => setStep('connections')}
          onCancel={onClose}
        />
      )}

      {step === 'connections' && (
        <ConnectionsStep
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          stitches={stitches}
          onChange={setStitches}
          onBack={() => setStep('sources')}
          onContinue={() => setStep('confirm')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmStep
          orderedMeshes={orderedMeshes}
          stitches={completeStitches}
          meshById={meshById}
          plannedSteps={plannedSteps}
          onBack={() => setStep('connections')}
          onConfirm={() => void handleRun()}
        />
      )}

      {step === 'run' && (
        <RunStep
          running={running}
          result={result}
          plannedSteps={plannedSteps}
          onRetry={() => setStep('confirm')}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 1 - the mesh library: import, order, remove. */
function SourcesStep({
  projectId,
  query,
  orderedMeshes,
  onMove,
  onContinue,
  onCancel,
}: {
  projectId: string;
  query: UseQueryResult<MeshSource[], Error>;
  orderedMeshes: MeshSource[];
  onMove: (index: number, direction: -1 | 1) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { isPending, isError, refetch, isRefetching } = query;
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const meshFileInputRef = useRef<HTMLInputElement>(null);
  const importMesh = useImportMesh(projectId);
  const [importingKind, setImportingKind] = useState<'folder' | 'zip' | 'file' | null>(null);
  // The failed conversion of the last .cgns/.msh import (cleared on a new import).
  const [convReport, setConvReport] = useState<ImportStep[] | null>(null);
  // Optional business name for the next import; its slug becomes the source dir.
  const [name, setName] = useState('');

  // The folder picker needs the non-standard webkitdirectory/directory attrs.
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const runImport = async (kind: 'folder' | 'zip' | 'file', files: File[]) => {
    if (files.length === 0) return;
    setImportingKind(kind);
    setConvReport(null);
    const trimmed = name.trim() || undefined;
    try {
      const result =
        kind === 'folder'
          ? await importMesh.mutateAsync({ kind: 'folder', files, name: trimmed })
          : kind === 'zip'
            ? await importMesh.mutateAsync({ kind: 'zip', file: files[0], name: trimmed })
            : await importMesh.mutateAsync({ kind: 'file', file: files[0], name: trimmed });
      if (result.conversion && !result.conversion.success) {
        setConvReport(result.conversion.steps);
        toast.error('Mesh conversion failed. See the report below.');
      } else if (result.mesh) {
        setName('');
        toast.success(`Added ${result.mesh.name}.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed. Please try again.');
    } finally {
      setImportingKind(null);
    }
  };

  const hasMeshes = orderedMeshes.length > 0;

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Merge meshes</DialogTitle>
        <DialogDescription>
          Import the polyMesh of each part, then combine them into one case mesh. The first mesh is
          the base; the others are merged into it, in order.
        </DialogDescription>
      </DialogHeader>

      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('folder', takeFiles(event.currentTarget))}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('zip', takeFiles(event.currentTarget))}
      />
      <input
        ref={meshFileInputRef}
        type="file"
        accept=".cgns,.msh"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('file', takeFiles(event.currentTarget))}
      />

      {isPending ? (
        <MeshSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-text">We could not load the mesh library.</p>
          <Button type="button" variant="secondary" onClick={() => void refetch()} loading={isRefetching} className="shrink-0">
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {hasMeshes ? (
            <ol className="divide-y divide-border rounded-md border border-border">
              {orderedMeshes.map((mesh, index) => (
                <MeshRow
                  key={mesh.id}
                  projectId={projectId}
                  mesh={mesh}
                  position={index + 1}
                  isMaster={index === 0}
                  isFirst={index === 0}
                  isLast={index === orderedMeshes.length - 1}
                  onMoveUp={() => onMove(index, -1)}
                  onMoveDown={() => onMove(index, 1)}
                />
              ))}
            </ol>
          ) : (
            <EmptyHint />
          )}

          <Field
            label="Name"
            helperText="Optional. Used to name and store the mesh you import next, e.g. rotor. Defaults to the file or folder name."
          >
            <Input
              name="meshName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. rotor"
              disabled={importingKind !== null}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              loading={importingKind === 'folder'}
              disabled={importingKind !== null && importingKind !== 'folder'}
            >
              <FolderUp strokeWidth={1.75} aria-hidden="true" />
              Import folder
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => zipInputRef.current?.click()}
              loading={importingKind === 'zip'}
              disabled={importingKind !== null && importingKind !== 'zip'}
            >
              <FileArchive strokeWidth={1.75} aria-hidden="true" />
              Import .zip
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => meshFileInputRef.current?.click()}
              loading={importingKind === 'file'}
              disabled={importingKind !== null && importingKind !== 'file'}
            >
              <FileCog strokeWidth={1.75} aria-hidden="true" />
              Import .cgns / .msh
            </Button>
          </div>

          {convReport && (
            <div className="rounded-md border border-danger/40 bg-danger-tint/60 px-4 py-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
                <AlertCircle className="size-4 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
                Mesh conversion failed
              </p>
              <ImportReport steps={convReport} />
            </div>
          )}
        </div>
      )}

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue} disabled={!hasMeshes}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One mesh source in the library: order controls, name, patch count, remove. */
function MeshRow({
  projectId,
  mesh,
  position,
  isMaster,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  projectId: string;
  mesh: MeshSource;
  position: number;
  isMaster: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const remove = useDeleteMesh(projectId);

  const handleRemove = async () => {
    try {
      await remove.mutateAsync({ meshId: mesh.id });
      toast.success(`Removed ${mesh.name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the mesh.');
    }
  };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-primary-tint text-xs font-semibold tabular-nums text-primary">
        {position}
      </span>
      <Boxes className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-text" title={mesh.name}>
            {mesh.name}
          </span>
          {isMaster && (
            <span className="shrink-0 rounded-sm bg-primary-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary">
              Base
            </span>
          )}
        </span>
        <span className="text-xs text-text-secondary tabular-nums">
          {mesh.patches.length} patch{mesh.patches.length === 1 ? '' : 'es'}
        </span>
      </span>

      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-text-secondary"
          aria-label={`Move ${mesh.name} up`}
          disabled={isFirst}
          onClick={onMoveUp}
        >
          <ArrowUp strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-text-secondary"
          aria-label={`Move ${mesh.name} down`}
          disabled={isLast}
          onClick={onMoveDown}
        >
          <ArrowDown strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-text-secondary hover:bg-danger-tint hover:text-danger"
              aria-label={`Remove ${mesh.name}`}
              loading={remove.isPending}
              onClick={() => void handleRemove()}
            >
              <Trash2 strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove from library</TooltipContent>
        </Tooltip>
      </div>
    </li>
  );
}

/** Empty state: a diamond mark and a one-line hint. */
function EmptyHint() {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
        <Diamond size={14} className="text-primary" />
      </span>
      <p className="text-sm text-text-secondary">
        No meshes imported yet. Import each part as a{' '}
        <code className="font-mono text-[0.8125rem] text-text" translate="no">
          polyMesh
        </code>{' '}
        folder, a .zip, or a .cgns / .msh file to combine them.
      </p>
    </div>
  );
}

/** Loading placeholder for the mesh library. */
function MeshSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="rounded-md border border-border">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
          >
            <Skeleton className="size-8 rounded-sm" />
            <Skeleton className="h-4 w-44" />
          </div>
        ))}
      </div>
      <Skeleton className="h-8 w-56 rounded-sm" />
    </div>
  );
}

/** Step 2 - the stitch-pair editor (the "connect inlet to outlet" surface). */
function ConnectionsStep({
  orderedMeshes,
  meshById,
  stitches,
  onChange,
  onBack,
  onContinue,
}: {
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  stitches: StitchDraft[];
  onChange: (next: StitchDraft[]) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const update = (index: number, patch: Partial<StitchDraft>) => {
    onChange(stitches.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const add = () => onChange([...stitches, { ...EMPTY_DRAFT }]);
  const remove = (index: number) => onChange(stitches.filter((_, i) => i !== index));

  // Block continue while a row is half-filled (a blank row is just ignored).
  const hasPartial = stitches.some((s) => !isBlank(s) && !isComplete(s));

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Connect the meshes</DialogTitle>
        <DialogDescription>
          Fuse a patch of one mesh to a coincident patch of another (e.g. a part&rsquo;s outlet
          against the next part&rsquo;s inlet). Each pair becomes one internal interface. Leave this
          empty to combine the meshes without connecting them.
        </DialogDescription>
      </DialogHeader>

      {stitches.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
            <Diamond size={14} className="text-primary" />
          </span>
          <p className="text-sm text-text-secondary">
            No connections yet. The meshes will be combined side by side. Add one to fuse a shared
            interface.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {stitches.map((stitch, index) => (
            <StitchRow
              key={index}
              index={index}
              stitch={stitch}
              orderedMeshes={orderedMeshes}
              meshById={meshById}
              onUpdate={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}

      <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={add}>
        <Plus strokeWidth={1.75} aria-hidden="true" />
        Add a connection
      </Button>

      <DialogFooter className="mt-2 sm:items-center">
        {hasPartial && (
          <p className="mr-auto text-xs text-danger">Finish or remove the incomplete connection.</p>
        )}
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={hasPartial}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One row of the stitch editor: mesh A.patch <diamond> mesh B.patch. */
function StitchRow({
  index,
  stitch,
  orderedMeshes,
  meshById,
  onUpdate,
  onRemove,
}: {
  index: number;
  stitch: StitchDraft;
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  onUpdate: (patch: Partial<StitchDraft>) => void;
  onRemove: () => void;
}) {
  const partial = !isBlank(stitch) && !isComplete(stitch);

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SidePicker
          rowIndex={index}
          side="a"
          meshId={stitch.aMeshId}
          patch={stitch.aPatch}
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          onMeshChange={(aMeshId) => onUpdate({ aMeshId, aPatch: '' })}
          onPatchChange={(aPatch) => onUpdate({ aPatch })}
        />
        <span className="flex items-center justify-center pb-2 sm:pb-2.5" aria-hidden="true">
          <Diamond size={12} className="text-primary" />
        </span>
        <SidePicker
          rowIndex={index}
          side="b"
          meshId={stitch.bMeshId}
          patch={stitch.bPatch}
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          onMeshChange={(bMeshId) => onUpdate({ bMeshId, bPatch: '' })}
          onPatchChange={(bPatch) => onUpdate({ bPatch })}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 self-end text-text-secondary hover:bg-danger-tint hover:text-danger"
              aria-label={`Remove connection ${index + 1}`}
              onClick={onRemove}
            >
              <Trash2 strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove connection</TooltipContent>
        </Tooltip>
      </div>
      {partial && (
        <p className="mt-2 text-xs text-danger">Pick a mesh and a patch on both sides.</p>
      )}
    </li>
  );
}

/** One side of a stitch pair: a mesh select and a patch select. */
function SidePicker({
  rowIndex,
  side,
  meshId,
  patch,
  orderedMeshes,
  meshById,
  onMeshChange,
  onPatchChange,
}: {
  rowIndex: number;
  side: 'a' | 'b';
  meshId: string;
  patch: string;
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  onMeshChange: (meshId: string) => void;
  onPatchChange: (patch: string) => void;
}) {
  const label = side === 'a' ? 'A' : 'B';
  const meshFieldId = `stitch-${rowIndex}-${side}-mesh`;
  const patchFieldId = `stitch-${rowIndex}-${side}-patch`;
  const patches = meshId ? (meshById.get(meshId)?.patches ?? []) : [];

  return (
    <div className="grid flex-1 grid-cols-2 gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={meshFieldId} className="text-xs font-medium text-text-secondary">
          Mesh {label}
        </label>
        <select
          id={meshFieldId}
          value={meshId}
          onChange={(event) => onMeshChange(event.currentTarget.value)}
          className={SELECT_CLASS}
        >
          <option value="">Select mesh</option>
          {orderedMeshes.map((mesh) => (
            <option key={mesh.id} value={mesh.id}>
              {mesh.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={patchFieldId} className="text-xs font-medium text-text-secondary">
          Patch
        </label>
        <select
          id={patchFieldId}
          value={patch}
          disabled={!meshId}
          onChange={(event) => onPatchChange(event.currentTarget.value)}
          className={cn(SELECT_CLASS, 'font-mono')}
        >
          <option value="">{meshId ? 'Select patch' : '-'}</option>
          {patches.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.type}, {p.nFaces})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Step 3 - confirm the (mesh-overwriting) merge and preview the pipeline. */
function ConfirmStep({
  orderedMeshes,
  stitches,
  meshById,
  plannedSteps,
  onBack,
  onConfirm,
}: {
  orderedMeshes: MeshSource[];
  stitches: StitchPair[];
  meshById: Map<string, MeshSource>;
  plannedSteps: PlannedStep[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Merge into the case mesh?</DialogTitle>
        <DialogDescription>
          This combines the meshes and overwrites any existing{' '}
          <code className="font-mono text-[0.8125rem]" translate="no">
            constant/polyMesh
          </code>
          . It cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">
            Meshes ({orderedMeshes.length})
          </dt>
          <dd>
            <ol className="flex flex-col gap-1">
              {orderedMeshes.map((mesh, index) => (
                <li key={mesh.id} className="flex items-center gap-2 text-sm text-text">
                  <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{mesh.name}</span>
                  {index === 0 && (
                    <span className="shrink-0 text-xs text-text-secondary">(base)</span>
                  )}
                </li>
              ))}
            </ol>
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">
            Connections ({stitches.length})
          </dt>
          <dd>
            {stitches.length === 0 ? (
              <p className="text-sm text-text-secondary">
                None - the meshes are combined without being connected.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {stitches.map((stitch, index) => (
                  <li key={index} className="flex items-center gap-1.5 text-sm text-text">
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(stitch.aMeshId)?.name}.{stitch.aPatch}
                    </code>
                    <Diamond size={9} className="text-primary" />
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(stitch.bMeshId)?.name}.{stitch.bPatch}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {/* The pipeline preview: the steps that will run, in order. */}
      <div className="rounded-md border border-border bg-bg/60 px-4 py-3">
        <p className="mb-2 text-xs font-medium text-text-secondary">Pipeline</p>
        <ol className="flex flex-col gap-1.5">
          {plannedSteps.map((meta, index) => (
            <li key={index} className="flex items-center gap-2.5 text-sm text-text">
              <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                {index + 1}
              </span>
              <span className="min-w-0 truncate">{meta.label}</span>
              {meta.tool && (
                <code className="ml-auto shrink-0 font-mono text-xs text-text-secondary" translate="no">
                  {meta.tool}
                </code>
              )}
            </li>
          ))}
        </ol>
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onConfirm}>
          <Workflow strokeWidth={1.75} aria-hidden="true" />
          Merge meshes
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 4 - the running state, then the per-step report. */
function RunStep({
  running,
  result,
  plannedSteps,
  onRetry,
  onClose,
}: {
  running: boolean;
  result: MergeRunResult | null;
  plannedSteps: PlannedStep[];
  onRetry: () => void;
  onClose: () => void;
}) {
  if (running || !result) {
    return (
      <DialogContent className="max-w-2xl overscroll-contain">
        <DialogHeader>
          <DialogTitle>Merging</DialogTitle>
          <DialogDescription>
            Running the merge on the server. Large meshes can take a while.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2" role="status" aria-live="polite">
          <div className="flex items-center gap-3">
            <Loader2 className="size-5 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-sm text-text">Merging the meshes&hellip;</span>
          </div>
          <ol className="flex flex-col gap-2">
            {plannedSteps.map((meta, index) => (
              <li key={index} className="flex items-center gap-2.5 text-sm text-text-secondary">
                <CircleDashed className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="min-w-0 truncate">{meta.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </DialogContent>
    );
  }

  const failed = result.steps.find((s) => s.status === 'failed');

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>{result.success ? 'Merge complete' : 'Merge failed'}</DialogTitle>
        <DialogDescription>
          {result.success
            ? 'The meshes were combined into the case and checkMesh ran.'
            : 'A step in the pipeline failed. Expand its log for the details.'}
        </DialogDescription>
      </DialogHeader>

      {result.success ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-success/40 bg-success-tint px-4 py-3 text-sm text-text"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Combined mesh written to{' '}
            <code className="font-mono text-[0.8125rem]" translate="no">
              constant/polyMesh
            </code>{' '}
            with {result.boundaryPatches.length} patch
            {result.boundaryPatches.length === 1 ? '' : 'es'}.
          </span>
        </div>
      ) : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-tint px-4 py-3 text-sm text-text"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
          <span>Failed at &ldquo;{failed?.label ?? 'a step'}&rdquo;. The case mesh was not changed.</span>
        </div>
      )}

      {result.notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {result.notes.map((note, index) => (
            <li key={index} className="flex items-start gap-2 text-xs text-text-secondary">
              <Diamond size={8} className="mt-[0.3rem] text-primary" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      {result.success && result.boundaryPatches.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {result.boundaryPatches.map((p) => (
            <span
              key={p.name}
              className="rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-xs text-text"
              translate="no"
            >
              {p.name}
            </span>
          ))}
        </div>
      )}

      {/* The pipeline stepper: status rail + per-step logs. */}
      <ol className="flex flex-col">
        {result.steps.map((step, index) => (
          <MergeStepRow
            key={index}
            ordinal={index + 1}
            step={step}
            last={index === result.steps.length - 1}
          />
        ))}
      </ol>

      <DialogFooter className="mt-2">
        {!result.success && (
          <Button type="button" variant="ghost" onClick={onRetry}>
            Back
          </Button>
        )}
        <Button type="button" variant={result.success ? 'primary' : 'secondary'} onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One row of the pipeline stepper: status node on a rail + content + log. */
function MergeStepRow({ ordinal, step, last }: { ordinal: number; step: MergeStep; last: boolean }) {
  const tool = KIND_TOOL[step.kind];
  const hasLog = step.stdout.trim().length > 0 || step.stderr.trim().length > 0;
  // Open by default where the detail matters: a failure, or the checkMesh report.
  const defaultOpen = step.status === 'failed' || (step.status === 'success' && step.kind === 'checkMesh');

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-sm border text-xs font-semibold tabular-nums',
            step.status === 'success' && 'border-success/40 bg-success-tint text-success',
            step.status === 'failed' && 'border-danger/40 bg-danger-tint text-danger',
            step.status === 'skipped' && 'border-border bg-bg text-text-secondary',
          )}
        >
          {ordinal}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className={cn('flex min-w-0 flex-1 flex-col gap-2', last ? 'pb-1' : 'pb-4')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-text">{step.label}</p>
          {tool && (
            <code className="font-mono text-xs text-text-secondary" translate="no">
              {tool}
            </code>
          )}
          <MergeStatusChip status={step.status} />
          <span className="ml-auto flex items-center gap-3 text-xs text-text-secondary tabular-nums">
            {step.exitCode !== null && <span>exit {step.exitCode}</span>}
            {step.durationMs > 0 && <span>{formatDuration(step.durationMs)}</span>}
          </span>
        </div>
        {hasLog && <MergeLogDisclosure step={step} defaultOpen={defaultOpen} />}
      </div>
    </li>
  );
}

/** Small status chip: icon + word + color (never color alone). */
function MergeStatusChip({ status }: { status: MergeStep['status'] }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
        OK
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
        <XCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
      <MinusCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
      Skipped
    </span>
  );
}

/** A collapsible monospace log (stdout then stderr) for a step. */
function MergeLogDisclosure({ step, defaultOpen }: { step: MergeStep; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasOut = step.stdout.trim().length > 0;
  const hasErr = step.stderr.trim().length > 0;
  const hasCommand = step.command.trim().length > 0;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        {open ? (
          <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
        )}
        {open ? 'Hide log' : 'Show log'}
      </button>
      {open && (
        <div className="border-t border-border">
          <div
            tabIndex={0}
            className="max-h-48 overflow-auto overscroll-contain px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
          >
            {hasCommand && (
              <p className="mb-1.5 font-mono text-[0.7rem] text-text-secondary" translate="no">
                $ {step.command}
              </p>
            )}
            {hasOut && (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text" translate="no">
                {step.stdout}
              </pre>
            )}
            {hasErr && (
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-danger" translate="no">
                {step.stderr}
              </pre>
            )}
            {!hasOut && !hasErr && <p className="text-xs text-text-secondary">No output.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A previewed pipeline step (label + optional tool), shared by Confirm and Run. */
interface PlannedStep {
  label: string;
  tool?: string;
}

/** Build the ordered pipeline preview from the plan (matches the server's steps). */
function buildPipelinePreview(
  orderedMeshes: MeshSource[],
  stitches: StitchPair[],
  meshById: Map<string, MeshSource>,
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const mesh of orderedMeshes) steps.push({ label: `Prepare ${mesh.name}` });
  for (let i = 1; i < orderedMeshes.length; i += 1) {
    steps.push({ label: `Combine ${orderedMeshes[i].name}`, tool: 'mergeMeshes' });
  }
  for (const stitch of stitches) {
    const a = `${meshById.get(stitch.aMeshId)?.name ?? '?'}.${stitch.aPatch}`;
    const b = `${meshById.get(stitch.bMeshId)?.name ?? '?'}.${stitch.bPatch}`;
    steps.push({ label: `Stitch ${a} ↔ ${b}`, tool: 'stitchMesh' });
  }
  steps.push({ label: 'Clean up empty patches' });
  steps.push({ label: 'Check combined mesh', tool: 'checkMesh' });
  return steps;
}

/** OpenFOAM tool name shown for the command-backed step kinds. */
const KIND_TOOL: Partial<Record<MergeStepKind, string>> = {
  mergeMeshes: 'mergeMeshes',
  stitchMesh: 'stitchMesh',
  checkMesh: 'checkMesh',
};

/** Read and clear a file input, returning the chosen files. */
function takeFiles(input: HTMLInputElement | null): File[] {
  if (!input?.files) return [];
  const files = Array.from(input.files);
  input.value = '';
  return files;
}

/** Format a duration in ms as "640 ms" or "2.3 s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
