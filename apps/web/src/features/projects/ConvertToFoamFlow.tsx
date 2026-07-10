import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileBox,
  FilePlus2,
  Layers,
  Loader2,
  MinusCircle,
  SquarePen,
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
import { NativeSelect } from '@/components/ui/native-select';
import { Diamond } from '@/components/brand/Diamond';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  CgnsFile,
  ConversionResult,
  ConversionStep,
  ConversionStepId,
  ConversionStepStatus,
  Template,
} from '@/lib/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTemplatesQuery } from '@/features/templates/useTemplates';
import {
  useCgnsFilesQuery,
  useConvertToFoam,
  useDeleteCgns,
  useUploadCgns,
} from '@/features/projects/useConversion';

/**
 * ConvertToFoamFlow - the guided "Convert a CGNS mesh" dialog, opened from the
 * Case files card.
 *
 *  0. Sources: add / list / remove the project's CGNS source files. "Continue"
 *     is locked until at least one exists.
 *  1. Picker:  choose the shared template that supplies the case configuration.
 *  2. Confirm: pick which CGNS file (when several), restate the consequence (it
 *     overwrites the case mesh), and run.
 *  3. Run:     while the server runs the three-step pipeline, a running state;
 *     then a per-step report rendered as a numbered pipeline stepper with a
 *     status rail and collapsible logs (the checkMesh log is the payload).
 *
 * It owns its CGNS roster so it can open straight from an empty case, and a
 * successful conversion refreshes the case tree (see useConvertToFoam). Every
 * step shares one width (max-w-2xl) so the box never resizes between steps and
 * the pipeline report / logs have room to breathe.
 */

/** The three pipeline steps in order, with concise labels and the real tool. */
const STEP_META: Array<{ id: ConversionStepId; label: string; tool: string }> = [
  { id: 'cgnsToVtk', label: 'Convert CGNS to VTK', tool: 'python3' },
  { id: 'vtkToFoam', label: 'Build polyMesh', tool: 'vtkUnstructuredToFoam' },
  { id: 'checkMesh', label: 'Check mesh', tool: 'checkMesh' },
];

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Human-readable byte size with one decimal above 1 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** Read and clear a file input, returning the chosen file (or null). */
function takeFile(input: HTMLInputElement | null): File | null {
  if (!input?.files || input.files.length === 0) return null;
  const file = input.files[0];
  input.value = '';
  return file;
}

interface ConvertToFoamFlowProps {
  projectId: string;
  /** Close the whole flow. */
  onClose: () => void;
}

type Step = 'sources' | 'picker' | 'confirm' | 'run';

export function ConvertToFoamFlow({ projectId, onClose }: ConvertToFoamFlowProps) {
  const cgnsQuery = useCgnsFilesQuery(projectId);
  const cgnsFiles = cgnsQuery.data ?? [];
  const [step, setStep] = useState<Step>('sources');
  const [template, setTemplate] = useState<Template | null>(null);
  const [cgnsFile, setCgnsFile] = useState<string>('');
  const [result, setResult] = useState<ConversionResult | null>(null);

  const convert = useConvertToFoam(projectId);
  const running = convert.isPending;

  // Leaving sources for the picker: keep the selected CGNS valid (default to the
  // first, and recover if the previously-selected one was just removed).
  const goToPicker = () => {
    const names = cgnsFiles.map((file) => file.name);
    if (!cgnsFile || !names.includes(cgnsFile)) setCgnsFile(cgnsFiles[0]?.name ?? '');
    setStep('picker');
  };

  const handleRun = async () => {
    if (!template) return;
    setResult(null);
    setStep('run');
    try {
      const res = await convert.mutateAsync({ cgnsFile, templateId: template.id });
      setResult(res);
      if (res.success) {
        toast.success('Mesh converted.');
      } else {
        toast.error('Conversion failed. See the report.');
      }
    } catch (err) {
      // A validation/transport error (unknown template, missing CGNS): go back
      // to confirm so the user can retry; pipeline failures don't land here.
      setStep('confirm');
      toast.error(err instanceof ApiError ? err.message : 'Could not start the conversion.');
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
          query={cgnsQuery}
          onContinue={goToPicker}
          onCancel={onClose}
        />
      )}

      {step === 'picker' && (
        <PickerStep
          onPick={(t) => {
            setTemplate(t);
            setStep('confirm');
          }}
          onBack={() => setStep('sources')}
        />
      )}

      {step === 'confirm' && template && (
        <ConfirmStep
          template={template}
          cgnsFiles={cgnsFiles}
          cgnsFile={cgnsFile}
          onCgnsFileChange={setCgnsFile}
          onBack={() => setStep('picker')}
          onConfirm={() => void handleRun()}
        />
      )}

      {step === 'run' && (
        <RunStep
          projectId={projectId}
          running={running}
          result={result}
          onRetry={() => setStep('confirm')}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 0 - add / list / remove the CGNS sources; "Continue" unlocks with one. */
function SourcesStep({
  projectId,
  query,
  onContinue,
  onCancel,
}: {
  projectId: string;
  query: UseQueryResult<CgnsFile[], Error>;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { data: files, isPending, isError, refetch, isRefetching } = query;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadCgns(projectId);
  const [uploading, setUploading] = useState(false);

  const hasCgns = !!files && files.length > 0;

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const result = await upload.mutateAsync(file);
      toast.success(`Added ${result.file.name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Convert a CGNS mesh</DialogTitle>
        <DialogDescription>
          Add a CGNS mesh, then convert it into this case&rsquo;s OpenFOAM polyMesh. A template
          supplies the rest of the configuration in the next step.
        </DialogDescription>
      </DialogHeader>

      {/* Hidden input, triggered by the visible "Add CGNS file" button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".cgns"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void handleUpload(takeFile(event.currentTarget))}
      />

      {isPending ? (
        <CgnsSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-text">We could not load the CGNS files.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void refetch()}
            loading={isRefetching}
            className="shrink-0"
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {hasCgns ? <CgnsList projectId={projectId} files={files} /> : <EmptyHint />}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => fileInputRef.current?.click()}
            loading={uploading}
          >
            <FilePlus2 strokeWidth={1.75} aria-hidden="true" />
            Add CGNS file
          </Button>
        </div>
      )}

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue} disabled={!hasCgns}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Empty state: a diamond mark and a one-line hint (the header already explains). */
function EmptyHint() {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
        <Diamond size={14} className="text-primary" />
      </span>
      <p className="text-sm text-text-secondary">
        No CGNS mesh added yet. Add a{' '}
        <code className="font-mono text-[0.8125rem] text-text" translate="no">
          .cgns
        </code>{' '}
        file to continue.
      </p>
    </div>
  );
}

/** The project's CGNS sources, each removable. */
function CgnsList({ projectId, files }: { projectId: string; files: CgnsFile[] }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {files.map((file) => (
        <li key={file.name} className="flex items-center gap-3 px-3 py-2.5">
          <FileBox className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-sm text-text"
            translate="no"
            title={file.name}
          >
            {file.name}
          </span>
          <span className="shrink-0 text-xs text-text-secondary tabular-nums">
            {formatBytes(file.size)}
          </span>
          <RemoveCgnsButton projectId={projectId} name={file.name} />
        </li>
      ))}
    </ul>
  );
}

/** Remove a single CGNS source (low-stakes: it is a re-uploadable input file). */
function RemoveCgnsButton({ projectId, name }: { projectId: string; name: string }) {
  const remove = useDeleteCgns(projectId);

  const handleRemove = async () => {
    try {
      await remove.mutateAsync({ name });
      toast.success(`Removed ${name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the file.');
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-text-secondary hover:bg-danger-tint hover:text-danger"
          aria-label={`Remove ${name}`}
          loading={remove.isPending}
          onClick={() => void handleRemove()}
        >
          <Trash2 strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Remove</TooltipContent>
    </Tooltip>
  );
}

/** Loading placeholder for the CGNS list. */
function CgnsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="rounded-md border border-border">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
          >
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-4 w-48" />
          </div>
        ))}
      </div>
      <Skeleton className="h-8 w-32 rounded-sm" />
    </div>
  );
}

/** Step 1 - choose the template that supplies the case configuration. */
function PickerStep({ onPick, onBack }: { onPick: (t: Template) => void; onBack: () => void }) {
  const { user } = useAuth();
  const { data: templates, isPending, isError, refetch, isRefetching } = useTemplatesQuery();

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Choose a template</DialogTitle>
        <DialogDescription>
          The template supplies the case configuration (system, fields). The mesh comes from the CGNS
          conversion. Missing base files are generated if the template omits them.
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-80 overflow-auto rounded-md border border-border">
        {isPending ? (
          <div className="flex items-center justify-center py-10" role="status" aria-live="polite">
            <Loader2 className="size-5 animate-spin text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">Loading templates</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-start gap-2 p-4" role="alert">
            <p className="text-sm text-text">We could not load the templates.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()} loading={isRefetching}>
              Try again
            </Button>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">No templates yet</p>
            <p className="max-w-xs text-sm text-text-secondary">
              Create one from the{' '}
              <Link to="/templates" className="text-primary hover:underline">
                Templates
              </Link>{' '}
              page, then convert.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {templates.map((template) => {
              const author = user?.id === template.owner.id ? 'You' : template.owner.email;
              return (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => onPick(template)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-fast ease-out',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset',
                      'hover:bg-bg',
                    )}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">
                      <Layers className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-text">{template.name}</span>
                      <span className="truncate text-xs text-text-secondary">
                        {template.description ? template.description : `By ${author}`}
                      </span>
                    </span>
                    <ChevronRight className="ml-auto size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 2 - confirm the (mesh-overwriting) conversion. */
function ConfirmStep({
  template,
  cgnsFiles,
  cgnsFile,
  onCgnsFileChange,
  onBack,
  onConfirm,
}: {
  template: Template;
  cgnsFiles: CgnsFile[];
  cgnsFile: string;
  onCgnsFileChange: (name: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Convert to OpenFOAM?</DialogTitle>
        <DialogDescription>
          This builds the case mesh from the CGNS file and overwrites any existing{' '}
          <code className="font-mono text-[0.8125rem]">constant/polyMesh</code>. It cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">CGNS file</dt>
          <dd>
            {cgnsFiles.length === 1 ? (
              <span className="font-mono text-sm text-text" translate="no">
                {cgnsFiles[0].name}
              </span>
            ) : (
              <NativeSelect
                aria-label="CGNS file to convert"
                value={cgnsFile}
                onChange={(event) => onCgnsFileChange(event.currentTarget.value)}
                className="font-mono"
              >
                {cgnsFiles.map((file) => (
                  <option key={file.name} value={file.name}>
                    {file.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Template</dt>
          <dd className="flex items-center gap-2 text-sm text-text">
            <Layers className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            {template.name}
          </dd>
        </div>
      </dl>

      {/* The pipeline preview: the three steps that will run, in order. */}
      <div className="rounded-md border border-border bg-bg/60 px-4 py-3">
        <p className="mb-2 text-xs font-medium text-text-secondary">Pipeline</p>
        <ol className="flex flex-col gap-1.5">
          {STEP_META.map((meta, index) => (
            <li key={meta.id} className="flex items-center gap-2.5 text-sm text-text">
              <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                {index + 1}
              </span>
              <span>{meta.label}</span>
              <code className="font-mono text-xs text-text-secondary" translate="no">
                {meta.tool}
              </code>
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
          Convert to Foam
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 3 - the running state, then the per-step report. */
function RunStep({
  projectId,
  running,
  result,
  onRetry,
  onClose,
}: {
  projectId: string;
  running: boolean;
  result: ConversionResult | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  // Running (request in flight, no report yet): honest, non-live progress.
  if (running || !result) {
    return (
      <DialogContent className="max-w-2xl overscroll-contain">
        <DialogHeader>
          <DialogTitle>Converting</DialogTitle>
          <DialogDescription>
            Running the conversion on the server. Large meshes can take a while.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2" role="status" aria-live="polite">
          <div className="flex items-center gap-3">
            <Loader2 className="size-5 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-sm text-text">Converting the mesh&hellip;</span>
          </div>
          <ol className="flex flex-col gap-2">
            {STEP_META.map((meta) => (
              <li key={meta.id} className="flex items-center gap-2.5 text-sm text-text-secondary">
                <CircleDashed className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span>{meta.label}</span>
                <code className="font-mono text-xs" translate="no">
                  {meta.tool}
                </code>
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
        <DialogTitle>{result.success ? 'Conversion complete' : 'Conversion failed'}</DialogTitle>
        <DialogDescription>
          {result.success
            ? 'The CGNS mesh was converted into the case and checkMesh ran.'
            : 'A step in the pipeline failed. Expand its log for the details.'}
        </DialogDescription>
      </DialogHeader>

      {/* Outcome banner. */}
      {result.success ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-success/40 bg-success-tint px-4 py-3 text-sm text-text"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Mesh converted. The case now has a fresh{' '}
            <code className="font-mono text-[0.8125rem]" translate="no">
              constant/polyMesh
            </code>
            .
          </span>
        </div>
      ) : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-tint px-4 py-3 text-sm text-text"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
          <span>Failed at &ldquo;{failed?.label ?? 'a step'}&rdquo;. The mesh may be incomplete.</span>
        </div>
      )}

      {/* Notes: what the run did beyond the three steps. */}
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

      {/* The pipeline stepper: status rail + per-step logs. */}
      <ol className="flex flex-col">
        {STEP_META.map((meta, index) => {
          const step = result.steps.find((s) => s.id === meta.id);
          return (
            <StepRow
              key={meta.id}
              ordinal={index + 1}
              label={meta.label}
              tool={meta.tool}
              step={step}
              last={index === STEP_META.length - 1}
            />
          );
        })}
      </ol>

      <DialogFooter className="mt-2">
        {!result.success && (
          <Button type="button" variant="ghost" onClick={onRetry}>
            Back
          </Button>
        )}
        {result.success && (
          <Button asChild variant="secondary">
            <Link to={`/projects/${projectId}/edit`}>
              <SquarePen strokeWidth={1.75} aria-hidden="true" />
              Open files
            </Link>
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
function StepRow({
  ordinal,
  label,
  tool,
  step,
  last,
}: {
  ordinal: number;
  label: string;
  tool: string;
  step: ConversionStep | undefined;
  last: boolean;
}) {
  const status: ConversionStepStatus | 'pending' = step?.status ?? 'pending';
  const hasLog = !!step && (step.stdout.trim().length > 0 || step.stderr.trim().length > 0);
  // Open by default where the detail matters: a failure, or the checkMesh report.
  const defaultOpen = status === 'failed' || (status === 'success' && step?.id === 'checkMesh');

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-sm border text-xs font-semibold tabular-nums',
            status === 'success' && 'border-success/40 bg-success-tint text-success',
            status === 'failed' && 'border-danger/40 bg-danger-tint text-danger',
            (status === 'skipped' || status === 'pending') && 'border-border bg-bg text-text-secondary',
          )}
        >
          {ordinal}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className={cn('flex min-w-0 flex-1 flex-col gap-2', last ? 'pb-1' : 'pb-4')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-text">{label}</p>
          <code className="font-mono text-xs text-text-secondary" translate="no">
            {tool}
          </code>
          <StatusChip status={status} />
          {step && (
            <span className="ml-auto flex items-center gap-3 text-xs text-text-secondary tabular-nums">
              {step.exitCode !== null && <span>exit {step.exitCode}</span>}
              {step.durationMs > 0 && <span>{formatDuration(step.durationMs)}</span>}
            </span>
          )}
        </div>
        {hasLog && step && <LogDisclosure step={step} defaultOpen={defaultOpen} />}
      </div>
    </li>
  );
}

/** Small status chip: icon + word + color (never color alone). */
function StatusChip({ status }: { status: ConversionStepStatus | 'pending' }) {
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
  if (status === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
        <MinusCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Skipped
      </span>
    );
  }
  return null;
}

/** A collapsible monospace log (stdout then stderr) for a step. */
function LogDisclosure({ step, defaultOpen }: { step: ConversionStep; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasOut = step.stdout.trim().length > 0;
  const hasErr = step.stderr.trim().length > 0;

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
            <p className="mb-1.5 font-mono text-[0.7rem] text-text-secondary" translate="no">
              $ {step.command}
            </p>
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

/** Format a duration in ms as "640 ms" or "2.3 s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
