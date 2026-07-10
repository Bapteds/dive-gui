import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { cn } from '@/lib/utils';
import type { MergeRunResult, MergeStep, MergeStepKind, MeshInterface, MeshSource } from '@/lib/api/types';

/**
 * MergeRunReport - the shared "what the merge pipeline did" report, extracted from
 * AssemblyMergeDialog so both the merge dialog (as a dialog step) and the
 * Disassemble manage panel (as an inline panel) render the exact same running
 * state and per-step result.
 *
 *  - `MergeRunReport`  the dialog-free body: a spinner + planned-step list while
 *                      running, then the success/failure banner, notes, resulting
 *                      patches, and the per-step stepper. Used by the manage panel.
 *  - `RunStep`         wraps `MergeRunReport` in the merge dialog's chrome
 *                      (title / description / footer). Used by the merge dialog.
 *  - `buildPipelinePreview` / `PlannedStep`  the ordered step preview shared by
 *                      the dialog's confirm step and both report loading states.
 */

/** A previewed pipeline step (label + optional tool). */
export interface PlannedStep {
  label: string;
  tool?: string;
}

/** Build the ordered pipeline preview from the plan (matches the server's steps). */
export function buildPipelinePreview(
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

/** Format a duration in ms as "640 ms" or "2.3 s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The dialog-free run report: the running state (spinner + planned steps) until a
 * result arrives, then the outcome banner, notes, resulting patches, and stepper.
 */
export function MergeRunReport({
  running,
  result,
  plannedSteps,
}: {
  running: boolean;
  result: MergeRunResult | null;
  plannedSteps: PlannedStep[];
}) {
  if (running || !result) {
    return (
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
    );
  }

  const failed = result.steps.find((s) => s.status === 'failed');

  return (
    <div className="flex flex-col gap-4">
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
    </div>
  );
}

/** The merge dialog's run step: the run report wrapped in the dialog chrome. */
export function RunStep({
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
  const pending = running || !result;
  const title = pending ? 'Merging' : result.success ? 'Assembly merged' : 'Merge failed';
  const description = pending
    ? 'Running the merge on the server. Large meshes can take a while.'
    : result.success
      ? 'The parts were positioned, coupled into the case, and checkMesh ran.'
      : 'A step in the pipeline failed. Expand its log for the details.';

  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <MergeRunReport running={running} result={result} plannedSteps={plannedSteps} />

      {result && !running && (
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
      )}
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

export default MergeRunReport;
