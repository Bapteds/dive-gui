import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  Combine,
  FileArchive,
  FileCog,
  FolderUp,
  Link2,
  Loader2,
  MinusCircle,
  Plus,
  Scissors,
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
import { NativeSelect } from '@/components/ui/native-select';
import { Diamond } from '@/components/brand/Diamond';
import { SegmentedRadioGroup, type SegmentedOption } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  ImportStep,
  InterfaceCoupling,
  MergeRunResult,
  MergeStep,
  MergeStepKind,
  MeshInterface,
  MeshPatch,
  MeshSource,
} from '@/lib/api/types';
import {
  useAutoPatchMeshSource,
  useDeleteMesh,
  useImportMesh,
  useMergePlanQuery,
  useMeshesQuery,
  useRenameMeshSourcePatch,
  useRunMerge,
} from '@/features/projects/useMeshes';
import { ImportReport } from '@/features/projects/ImportReport';

/**
 * MergeMeshesFlow - the guided "Merge meshes" dialog, opened from the Case files
 * card. Combines several imported polyMesh sources into the case's single
 * constant/polyMesh, coupling chosen patch pairs (non-conformal by default, or a
 * conformal stitch).
 *
 *  1. Sources:     the per-project mesh LIBRARY - import (folder / .zip), order
 *     (the first is the master), and remove sources. Continue unlocks with one.
 *  2. Interfaces:  the interface editor - connect mesh A's patch to mesh B's
 *     patch (e.g. one part's outlet against the next part's inlet), each with a
 *     coupling. Optional: with none, the meshes are combined side by side.
 *  3. Confirm:     restate that it overwrites the case mesh, and preview the
 *     pipeline that will run (prepare -> mergeMeshes -> couple/stitch -> cleanup
 *     -> checkMesh).
 *  4. Run:         while the server runs the pipeline, a running state; then a
 *     per-step report with a status rail and collapsible logs.
 *
 * Mirrors ConvertToFoamFlow: it owns its source roster (so it opens straight
 * from an empty project) and a successful merge refreshes the case tree.
 */

type Step = 'sources' | 'connections' | 'confirm' | 'run';

/** An interface under construction (fields fill in as the user picks). */
interface InterfaceDraft {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
  coupling: InterfaceCoupling;
}

/** The default coupling for a new interface: v12-native non-conformal. */
const DEFAULT_COUPLING: InterfaceCoupling = 'nonConformal';

const EMPTY_DRAFT: InterfaceDraft = {
  aMeshId: '',
  aPatch: '',
  bMeshId: '',
  bPatch: '',
  coupling: DEFAULT_COUPLING,
};

/** Every side chosen - the interface can be coupled. */
function isComplete(draft: InterfaceDraft): boolean {
  return !!(draft.aMeshId && draft.aPatch && draft.bMeshId && draft.bPatch);
}

/** No side chosen - an untouched row, ignored on run. */
function isBlank(draft: InterfaceDraft): boolean {
  return !draft.aMeshId && !draft.aPatch && !draft.bMeshId && !draft.bPatch;
}

/** The two coupling options, with copy + icon, shared by every interface row. */
const COUPLING_OPTIONS: SegmentedOption<InterfaceCoupling>[] = [
  { value: 'nonConformal', label: 'Non-conformal', icon: Link2 },
  { value: 'stitch', label: 'Conformal stitch', icon: Combine },
];

/** One-line consequence of each coupling, shown under the selector. */
const COUPLING_HELP: Record<InterfaceCoupling, string> = {
  nonConformal:
    'Keeps both meshes separate. Flow interpolates across the interface (nonConformalCouple).',
  stitch:
    'Fuses the two patches into one internal interface (stitchMesh). The meshes become a single combined mesh.',
};

/** Short chip label for a coupling, used in the confirm summary. */
const COUPLING_CHIP: Record<InterfaceCoupling, string> = {
  nonConformal: 'Non-conformal',
  stitch: 'Stitch',
};

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
  const [interfaces, setInterfaces] = useState<InterfaceDraft[]>([]);
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
      // Prefer the new `interfaces`; fall back to a legacy `stitches` plan
      // (interpreted as conformal stitches) so old saved drafts still pre-fill.
      const planInterfaces: MeshInterface[] =
        planQuery.data?.interfaces ??
        (planQuery.data?.stitches ?? []).map((s) => ({ ...s, coupling: 'stitch' as const }));
      setInterfaces(
        planInterfaces
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
          .map((s) => ({
            aMeshId: s.aMeshId,
            aPatch: s.aPatch,
            bMeshId: s.bMeshId,
            bPatch: s.bPatch,
            coupling: s.coupling,
          })),
      );
      return;
    }
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const appended = ids.filter((id) => !kept.includes(id));
      return kept.length === prev.length && appended.length === 0 ? prev : [...kept, ...appended];
    });
    setInterfaces((prev) => {
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
  const completeInterfaces = useMemo<MeshInterface[]>(
    () =>
      interfaces.filter(isComplete).map((s) => ({
        aMeshId: s.aMeshId,
        aPatch: s.aPatch,
        bMeshId: s.bMeshId,
        bPatch: s.bPatch,
        coupling: s.coupling,
      })),
    [interfaces],
  );
  const plannedSteps = useMemo(
    () => buildPipelinePreview(orderedMeshes, completeInterfaces, meshById),
    [orderedMeshes, completeInterfaces, meshById],
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
        interfaces: completeInterfaces,
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
          interfaces={interfaces}
          onChange={setInterfaces}
          onBack={() => setStep('sources')}
          onContinue={() => setStep('confirm')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmStep
          orderedMeshes={orderedMeshes}
          interfaces={completeInterfaces}
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
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const handleRemove = async () => {
    try {
      await remove.mutateAsync({ meshId: mesh.id });
      toast.success(`Removed ${mesh.name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the mesh.');
    }
  };

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2.5">
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
              <span className="shrink-0 rounded-sm bg-primary-tint px-1.5 py-0.5 text-xs font-medium text-primary">
                Base
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={panelId}
            className="-ml-0.5 flex w-fit items-center gap-1 rounded-sm px-0.5 text-xs text-text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <ChevronDown
              className={cn('size-3 transition-transform', open && 'rotate-180')}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="tabular-nums">
              {mesh.patches.length} patch{mesh.patches.length === 1 ? '' : 'es'}
            </span>
          </button>
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
      </div>

      {open && (
        <div id={panelId} className="border-t border-border bg-bg px-3 py-3">
          <PatchEditor projectId={projectId} mesh={mesh} />
        </div>
      )}
    </li>
  );
}

/**
 * Re-patch a library mesh before merging: split its boundary into patches by
 * feature angle (so a single-patch import becomes stitchable), then give each a
 * meaningful name. Operates on the library source, not the case.
 */
function PatchEditor({ projectId, mesh }: { projectId: string; mesh: MeshSource }) {
  const autoPatch = useAutoPatchMeshSource(projectId);
  const [angle, setAngle] = useState('30');
  const [failure, setFailure] = useState<string | null>(null);

  const handleSplit = async () => {
    setFailure(null);
    try {
      const res = await autoPatch.mutateAsync({ meshId: mesh.id, featureAngle: Number(angle) });
      if (!res.result.success) {
        setFailure(res.result.stderr || res.result.stdout || 'autoPatch failed.');
        toast.error('Auto-split failed. See the log below.');
      } else {
        toast.success(`Split into ${res.mesh?.patches.length ?? 0} patch(es).`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Auto-split failed. Please try again.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Split by feature angle (°)"
          helperText="Splits the outer surface into patches at edges sharper than this angle. Use it when an import arrived as a single patch."
        >
          <Input
            type="number"
            inputMode="numeric"
            name="featureAngle"
            min={0}
            max={180}
            value={angle}
            onChange={(event) => setAngle(event.target.value)}
            disabled={autoPatch.isPending}
            autoComplete="off"
            className="w-28"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handleSplit()}
          loading={autoPatch.isPending}
        >
          <Scissors strokeWidth={1.75} aria-hidden="true" />
          Split patches
        </Button>
      </div>

      {failure && (
        <div className="rounded-md border border-danger/40 bg-danger-tint/60 px-3 py-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text">
            <AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
            autoPatch failed
          </p>
          <pre className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
            {failure}
          </pre>
        </div>
      )}

      {mesh.patches.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {mesh.patches.map((patch) => (
            <PatchRenameRow key={patch.name} projectId={projectId} meshId={mesh.id} patch={patch} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-secondary">No patches yet. Split the mesh to create some.</p>
      )}
    </div>
  );
}

/** One patch row: rename it inline (Enter or the button); shows its type + face count. */
function PatchRenameRow({
  projectId,
  meshId,
  patch,
}: {
  projectId: string;
  meshId: string;
  patch: MeshPatch;
}) {
  const rename = useRenameMeshSourcePatch(projectId);
  const [value, setValue] = useState(patch.name);
  const id = useId();
  const next = value.trim();
  const changed = next !== patch.name && next.length > 0;

  const handleRename = async () => {
    if (!changed) return;
    try {
      await rename.mutateAsync({ meshId, from: patch.name, to: next });
      toast.success(`Renamed to ${next}.`);
    } catch (err) {
      setValue(patch.name);
      toast.error(err instanceof ApiError ? err.message : 'Could not rename the patch.');
    }
  };

  return (
    <li className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Rename patch {patch.name}
      </label>
      <Input
        id={id}
        name="patchName"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void handleRename();
        }}
        disabled={rename.isPending}
        spellCheck={false}
        autoComplete="off"
        className="h-8 min-w-0 flex-1 font-mono text-xs"
      />
      <span className="shrink-0 text-xs text-text-secondary tabular-nums">
        {patch.type}, {patch.nFaces}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 shrink-0"
        disabled={!changed}
        loading={rename.isPending}
        onClick={() => void handleRename()}
      >
        Rename
      </Button>
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
        <code className="font-mono text-sm text-text" translate="no">
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

/** Step 2 - the interface editor (the "connect inlet to outlet" surface). */
function ConnectionsStep({
  orderedMeshes,
  meshById,
  interfaces,
  onChange,
  onBack,
  onContinue,
}: {
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  interfaces: InterfaceDraft[];
  onChange: (next: InterfaceDraft[]) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const update = (index: number, patch: Partial<InterfaceDraft>) => {
    onChange(interfaces.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const add = () => onChange([...interfaces, { ...EMPTY_DRAFT }]);
  const remove = (index: number) => onChange(interfaces.filter((_, i) => i !== index));

  // Block continue while a row is half-filled (a blank row is just ignored).
  const hasPartial = interfaces.some((s) => !isBlank(s) && !isComplete(s));

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Couple the meshes</DialogTitle>
        <DialogDescription>
          Connect a patch of one mesh to a coincident patch of another (e.g. a part&rsquo;s outlet
          against the next part&rsquo;s inlet). Non-conformal keeps the meshes separate and
          interpolates the flow across the interface; conformal stitch fuses them into one. Leave
          this empty to combine the meshes without coupling them.
        </DialogDescription>
      </DialogHeader>

      {interfaces.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
            <Diamond size={14} className="text-primary" />
          </span>
          <p className="text-sm text-text-secondary">
            No interfaces yet. The meshes will be combined side by side. Add one to couple a shared
            boundary.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {interfaces.map((draft, index) => (
            <InterfaceRow
              key={index}
              index={index}
              draft={draft}
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
        Add an interface
      </Button>

      <DialogFooter className="mt-2 sm:items-center">
        {hasPartial && (
          <p className="mr-auto text-xs text-danger">Finish or remove the incomplete interface.</p>
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

/** One row of the interface editor: mesh A.patch <diamond> mesh B.patch + coupling. */
function InterfaceRow({
  index,
  draft,
  orderedMeshes,
  meshById,
  onUpdate,
  onRemove,
}: {
  index: number;
  draft: InterfaceDraft;
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  onUpdate: (patch: Partial<InterfaceDraft>) => void;
  onRemove: () => void;
}) {
  const partial = !isBlank(draft) && !isComplete(draft);
  const helpId = useId();

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SidePicker
          rowIndex={index}
          side="a"
          meshId={draft.aMeshId}
          patch={draft.aPatch}
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
          meshId={draft.bMeshId}
          patch={draft.bPatch}
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
              aria-label={`Remove interface ${index + 1}`}
              onClick={onRemove}
            >
              <Trash2 strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove interface</TooltipContent>
        </Tooltip>
      </div>
      {partial && (
        <p className="mt-2 text-xs text-danger">Pick a mesh and a patch on both sides.</p>
      )}

      {/* Coupling: how the two patches are connected (default non-conformal). */}
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs font-medium text-text-secondary">Coupling</span>
          <SegmentedRadioGroup
            name={`merge-coupling-${index}`}
            ariaLabel={`Coupling for interface ${index + 1}`}
            value={draft.coupling}
            onChange={(coupling) => onUpdate({ coupling })}
            options={COUPLING_OPTIONS}
          />
        </div>
        <p id={helpId} className="text-xs text-text-secondary">
          {COUPLING_HELP[draft.coupling]}
        </p>
      </div>
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
        <NativeSelect
          id={meshFieldId}
          value={meshId}
          onChange={(event) => onMeshChange(event.currentTarget.value)}
        >
          <option value="">Select mesh</option>
          {orderedMeshes.map((mesh) => (
            <option key={mesh.id} value={mesh.id}>
              {mesh.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={patchFieldId} className="text-xs font-medium text-text-secondary">
          Patch
        </label>
        <NativeSelect
          id={patchFieldId}
          value={patch}
          disabled={!meshId}
          onChange={(event) => onPatchChange(event.currentTarget.value)}
          className="font-mono"
        >
          <option value="">{meshId ? 'Select patch' : '-'}</option>
          {patches.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.type}, {p.nFaces})
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

/** Step 3 - confirm the (mesh-overwriting) merge and preview the pipeline. */
function ConfirmStep({
  orderedMeshes,
  interfaces,
  meshById,
  plannedSteps,
  onBack,
  onConfirm,
}: {
  orderedMeshes: MeshSource[];
  interfaces: MeshInterface[];
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
          <code className="font-mono text-sm" translate="no">
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
            Interfaces ({interfaces.length})
          </dt>
          <dd>
            {interfaces.length === 0 ? (
              <p className="text-sm text-text-secondary">
                None - the meshes are combined without coupling.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {interfaces.map((iface, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-text">
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(iface.aMeshId)?.name}.{iface.aPatch}
                    </code>
                    <Diamond size={9} className="text-primary" />
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(iface.bMeshId)?.name}.{iface.bPatch}
                    </code>
                    <CouplingChip coupling={iface.coupling} />
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
            <code className="font-mono text-sm" translate="no">
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
              <p className="mb-1.5 font-mono text-xs text-text-secondary" translate="no">
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

/** A small chip naming an interface's coupling (never colour alone). */
function CouplingChip({ coupling }: { coupling: InterfaceCoupling }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium',
        coupling === 'nonConformal'
          ? 'bg-primary-tint text-primary'
          : 'border border-border text-text-secondary',
      )}
    >
      {COUPLING_CHIP[coupling]}
    </span>
  );
}

/** Build the ordered pipeline preview from the plan (matches the server's steps). */
function buildPipelinePreview(
  orderedMeshes: MeshSource[],
  interfaces: MeshInterface[],
  meshById: Map<string, MeshSource>,
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const mesh of orderedMeshes) steps.push({ label: `Prepare ${mesh.name}` });
  for (let i = 1; i < orderedMeshes.length; i += 1) {
    steps.push({ label: `Combine ${orderedMeshes[i].name}`, tool: 'mergeMeshes' });
  }
  for (const iface of interfaces) {
    const a = `${meshById.get(iface.aMeshId)?.name ?? '?'}.${iface.aPatch}`;
    const b = `${meshById.get(iface.bMeshId)?.name ?? '?'}.${iface.bPatch}`;
    if (iface.coupling === 'stitch') {
      steps.push({ label: `Stitch ${a} ↔ ${b}`, tool: 'stitchMesh' });
    } else {
      steps.push({ label: `Couple ${a} ↔ ${b}`, tool: 'nonConformalCouple' });
    }
  }
  steps.push({ label: 'Clean up empty patches' });
  steps.push({ label: 'Check combined mesh', tool: 'checkMesh' });
  return steps;
}

/** OpenFOAM tool name shown for the command-backed step kinds. */
const KIND_TOOL: Partial<Record<MergeStepKind, string>> = {
  mergeMeshes: 'mergeMeshes',
  stitchMesh: 'stitchMesh',
  nonConformalCouple: 'nonConformalCouple',
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
