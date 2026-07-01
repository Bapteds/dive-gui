import { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
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
import { Diamond } from '@/components/brand/Diamond';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  MergeRunResult,
  MergeStep,
  MergeStepKind,
  MeshSource,
  PartTransform,
  StitchPair,
} from '@/lib/api/types';
import { useRunMerge } from '@/features/projects/useMeshes';

/**
 * AssemblyMergeDialog - the final "merge into one geometry" flow for the Assemble
 * tab. It opens from the single orange Merge CTA once at least one part has been
 * positioned, walks the (optional) connections, confirms, then runs the same
 * server pipeline as the "Merge meshes" flow - but carrying `transforms`, so each
 * positioned part is staged at its placement before mergeMeshes runs.
 *
 * The connections / confirm / per-step report follow the "Merge meshes" flow's
 * patterns (ConnectionsStep / RunStep), reused here rather than shared to keep the
 * two flows independently owned.
 */

/** A stitch pair under construction (fields fill in as the user picks). */
interface StitchDraft {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
}

const EMPTY_DRAFT: StitchDraft = { aMeshId: '', aPatch: '', bMeshId: '', bPatch: '' };

const isComplete = (d: StitchDraft) => !!(d.aMeshId && d.aPatch && d.bMeshId && d.bPatch);
const isBlank = (d: StitchDraft) => !d.aMeshId && !d.aPatch && !d.bMeshId && !d.bPatch;

const SELECT_CLASS =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

type Step = 'connections' | 'confirm' | 'run';

export interface AssemblyMergeDialogProps {
  projectId: string;
  /** Sources in assembly order (index 0 = base). */
  orderedMeshes: MeshSource[];
  /** The committed placement of each positioned added part. */
  transforms: PartTransform[];
  /** A pre-seeded connection (the last placed part's mating patch <-> base face). */
  seedStitch?: StitchDraft | null;
  onClose: () => void;
}

export function AssemblyMergeDialog({
  projectId,
  orderedMeshes,
  transforms,
  seedStitch,
  onClose,
}: AssemblyMergeDialogProps) {
  const meshById = useMemo(
    () => new Map(orderedMeshes.map((m) => [m.id, m] as const)),
    [orderedMeshes],
  );
  const [step, setStep] = useState<Step>('connections');
  const [stitches, setStitches] = useState<StitchDraft[]>(() =>
    seedStitch && isComplete(seedStitch) ? [seedStitch] : [],
  );
  const [result, setResult] = useState<MergeRunResult | null>(null);

  const merge = useRunMerge(projectId);
  const running = merge.isPending;

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

  const handleRun = async () => {
    setResult(null);
    setStep('run');
    try {
      const res = await merge.mutateAsync({
        order: orderedMeshes.map((m) => m.id),
        stitches: completeStitches,
        transforms,
      });
      setResult(res);
      if (res.success) toast.success('Assembly merged.');
      else toast.error('Merge failed. See the report.');
    } catch (err) {
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
      {step === 'connections' && (
        <ConnectionsStep
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          stitches={stitches}
          onChange={setStitches}
          onCancel={onClose}
          onContinue={() => setStep('confirm')}
        />
      )}
      {step === 'confirm' && (
        <ConfirmStep
          orderedMeshes={orderedMeshes}
          stitches={completeStitches}
          transformCount={transforms.length}
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

/** Step 1 - the (optional) stitch-pair editor, pre-seeded with the obvious pair. */
function ConnectionsStep({
  orderedMeshes,
  meshById,
  stitches,
  onChange,
  onCancel,
  onContinue,
}: {
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  stitches: StitchDraft[];
  onChange: (next: StitchDraft[]) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const update = (index: number, patch: Partial<StitchDraft>) =>
    onChange(stitches.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const add = () => onChange([...stitches, { ...EMPTY_DRAFT }]);
  const remove = (index: number) => onChange(stitches.filter((_, i) => i !== index));
  const hasPartial = stitches.some((s) => !isBlank(s) && !isComplete(s));

  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Connect the parts</DialogTitle>
        <DialogDescription>
          Fuse a patch of one part to a coincident patch of another (e.g. the part you positioned
          against the base face it mounts on). Each pair becomes one internal interface. Leave this
          empty to combine the parts without connecting them.
        </DialogDescription>
      </DialogHeader>

      {stitches.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
            <Diamond size={14} className="text-primary" />
          </span>
          <p className="text-sm text-text-secondary">
            No connections yet. The parts will be combined side by side. Add one to fuse a shared
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
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue} disabled={hasPartial}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One row of the stitch editor: part A.patch <diamond> part B.patch. */
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
      {partial && <p className="mt-2 text-xs text-danger">Pick a part and a patch on both sides.</p>}
    </li>
  );
}

/** One side of a stitch pair: a part select and a patch select. */
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
  const meshFieldId = `astitch-${rowIndex}-${side}-mesh`;
  const patchFieldId = `astitch-${rowIndex}-${side}-patch`;
  const patches = meshId ? (meshById.get(meshId)?.patches ?? []) : [];

  return (
    <div className="grid flex-1 grid-cols-2 gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={meshFieldId} className="text-xs font-medium text-text-secondary">
          Part {label}
        </label>
        <select
          id={meshFieldId}
          value={meshId}
          onChange={(event) => onMeshChange(event.currentTarget.value)}
          className={SELECT_CLASS}
        >
          <option value="">Select part</option>
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

/** Step 2 - confirm the (mesh-overwriting) merge and preview the pipeline. */
function ConfirmStep({
  orderedMeshes,
  stitches,
  transformCount,
  meshById,
  plannedSteps,
  onBack,
  onConfirm,
}: {
  orderedMeshes: MeshSource[];
  stitches: StitchPair[];
  transformCount: number;
  meshById: Map<string, MeshSource>;
  plannedSteps: PlannedStep[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Merge the assembly?</DialogTitle>
        <DialogDescription>
          This positions each part, combines them, and overwrites any existing{' '}
          <code className="font-mono text-[0.8125rem]" translate="no">
            constant/polyMesh
          </code>
          . It cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Parts ({orderedMeshes.length})</dt>
          <dd>
            <ol className="flex flex-col gap-1">
              {orderedMeshes.map((mesh, index) => (
                <li key={mesh.id} className="flex items-center gap-2 text-sm text-text">
                  <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{mesh.name}</span>
                  {index === 0 && <span className="shrink-0 text-xs text-text-secondary">(base)</span>}
                </li>
              ))}
            </ol>
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Positioned parts</dt>
          <dd className="text-sm text-text-secondary">
            {transformCount === 0
              ? 'None - parts are combined at their imported coordinates.'
              : `${transformCount} part${transformCount === 1 ? '' : 's'} staged at their placement before merging.`}
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Connections ({stitches.length})</dt>
          <dd>
            {stitches.length === 0 ? (
              <p className="text-sm text-text-secondary">
                None - the parts are combined without being connected.
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
        {/* The single orange CTA of the assembly flow. */}
        <Button type="button" onClick={onConfirm}>
          <Workflow strokeWidth={1.75} aria-hidden="true" />
          Merge assembly
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 3 - the running state, then the per-step report. */
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
            <span className="text-sm text-text">Merging the assembly&hellip;</span>
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
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>{result.success ? 'Assembly merged' : 'Merge failed'}</DialogTitle>
        <DialogDescription>
          {result.success
            ? 'The parts were positioned, combined into the case, and checkMesh ran.'
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

/** A previewed pipeline step (label + optional tool). */
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

/** Format a duration in ms as "640 ms" or "2.3 s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export type { StitchDraft };
export default AssemblyMergeDialog;
