import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  MinusCircle,
  TriangleAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { Diamond } from '@/components/brand/Diamond';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  CaseProfile,
  ExportArtifact,
  ExportArtifacts,
  ExportStep,
  ExportStepId,
  ExportValidation,
} from '@/lib/api/types';
import { downloadArtifact, useExportStatusQuery, useRunExport } from './useExport';

/**
 * ExportTab - the "Export" tab body: turn a SOLVED OpenFOAM case into a CGNS file
 * for Ansys CFD-Post (File -> Load Results), without Fluent.
 *
 * A single primary action ("Export to CGNS") runs the server-side 4-step pipeline
 * (inspect -> convert -> validate -> cfdpost). The result is shown as a per-step
 * report, the inspected case profile, a validation table, the downloadable
 * artifacts (out.cgns + the CFD-Post session/memo/report), and the load caveats
 * that bite first (kinematic pressure, empty surfaces, transient).
 */

const STEP_META: Array<{ id: ExportStepId; label: string; tool: string }> = [
  { id: 'inspect', label: 'Inspect case', tool: 'foamDictionary · checkMesh' },
  { id: 'convert', label: 'Convert to CGNS', tool: 'pvbatch' },
  { id: 'validate', label: 'Validate the CGNS', tool: 'python3 · vtk' },
  { id: 'cfdpost', label: 'CFD-Post session', tool: 'session.cse' },
];

const ARTIFACTS: Array<{ key: ExportArtifact; label: string }> = [
  { key: 'cgns', label: 'CGNS (transient)' },
  { key: 'session', label: 'CFD-Post session' },
  { key: 'memo', label: 'Load memo' },
  { key: 'report', label: 'Report' },
];

export function ExportTab({ projectId }: { projectId: string }) {
  const status = useExportStatusQuery(projectId);
  const run = useRunExport(projectId);

  // The live run (this session) takes precedence; otherwise the persisted status.
  const result = run.data;
  const profile = result?.profile ?? status.data?.profile ?? null;
  const validation = result?.validation ?? status.data?.validation ?? null;
  const artifacts = result?.artifacts ?? status.data?.artifacts ?? null;
  const steps = result?.steps ?? null;
  const notes = result?.notes ?? [];

  const handleRun = () => {
    run.mutate(undefined, {
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'Could not run the export.'),
    });
  };

  const hasAnything = !!steps || !!profile || (artifacts?.cgns ?? false);

  return (
    <section
      aria-label="Export to CFD-Post"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Export to CFD-Post (CGNS)</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Convert the solved OpenFOAM results to a CGNS file Ansys CFD-Post can load, no Fluent
            needed.
          </p>
        </div>
        <Button type="button" onClick={handleRun} loading={run.isPending} className="shrink-0">
          <Upload strokeWidth={1.75} aria-hidden="true" />
          {artifacts?.cgns ? 'Re-export' : 'Export to CGNS'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 sm:p-5">
        {run.isPending && !steps ? (
          <RunningState />
        ) : !hasAnything ? (
          <NoExportYet />
        ) : (
          <div className="flex flex-col gap-6">
            {steps && <PipelineReport steps={steps} />}

            {notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-text-secondary">
                {notes.map((note) => (
                  <li key={note} className="flex items-start gap-1.5">
                    <Diamond className="mt-0.5 size-3 shrink-0 text-neutral" aria-hidden="true" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {profile && <ProfileCard profile={profile} />}
            {validation && <ValidationCard validation={validation} />}
            {artifacts && <Downloads projectId={projectId} artifacts={artifacts} />}
            {profile && <CfdPostMemo profile={profile} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** The running placeholder while the pipeline executes server-side. */
function RunningState() {
  return (
    <div className="grid place-items-center gap-3 py-16 text-center" role="status" aria-live="polite">
      <Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-text">Exporting to CGNS…</p>
        <p className="mt-1 text-xs text-text-secondary">
          Inspecting the case, running pvbatch, then validating. This can take a while on a large mesh.
        </p>
      </div>
    </div>
  );
}

/** The empty state before any export has run. */
function NoExportYet() {
  return (
    <EmptyState
      variant="inline"
      className="py-16"
      title="No export yet"
      description="Run a solver first, then export the solved results to a CGNS file for CFD-Post. The export reads the latest solved time and never modifies the case."
    />
  );
}

/** The 4-step pipeline report (status rail + collapsible logs). */
function PipelineReport({ steps }: { steps: ExportStep[] }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return (
    <ol className="flex flex-col">
      {STEP_META.map((meta, index) => (
        <StepRow
          key={meta.id}
          ordinal={index + 1}
          label={meta.label}
          tool={meta.tool}
          step={byId.get(meta.id)}
          last={index === STEP_META.length - 1}
        />
      ))}
    </ol>
  );
}

type StepStatus = ExportStep['status'] | 'pending';

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
  step: ExportStep | undefined;
  last: boolean;
}) {
  const status: StepStatus = step?.status ?? 'pending';
  const hasLog = !!step && (step.stdout.trim().length > 0 || step.stderr.trim().length > 0);
  const defaultOpen = status === 'failed';

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-sm border text-xs font-semibold tabular-nums',
            status === 'success' && 'border-success/40 bg-success-tint text-success',
            status === 'warning' && 'border-accent/40 bg-accent-tint text-cta-hover',
            status === 'failed' && 'border-danger/40 bg-danger-tint text-danger',
            (status === 'skipped' || status === 'pending') &&
              'border-border bg-bg text-text-secondary',
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
function StatusChip({ status }: { status: StepStatus }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
        OK
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-cta-hover">
        <TriangleAlert className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Caveat
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
function LogDisclosure({ step, defaultOpen }: { step: ExportStep; defaultOpen: boolean }) {
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
            <p className="mb-1.5 font-mono text-xs text-text-secondary" translate="no">
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

/** The inspected case profile as a compact definition grid. */
function ProfileCard({ profile }: { profile: CaseProfile }) {
  const rows: Array<[string, string]> = [
    ['Solver', `${profile.solver} (${profile.steady ? 'steady' : 'transient'})`],
    ['Pressure', profile.incompressible ? 'kinematic (incompressible)' : 'Pa (compressible)'],
    ['Latest time', profile.latestTime ?? 'None'],
    ['Turbulence', profile.turbulenceModel],
    ['Fields', profile.fields.join(', ') || 'None'],
    ['Patches', profile.patches.join(', ') || 'None'],
  ];
  return (
    <div className="rounded-md border border-border bg-bg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Case profile
      </h3>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-xs text-text-secondary">{label}</dt>
            <dd className="break-words font-mono text-xs text-text">{value}</dd>
          </div>
        ))}
        {profile.emptyPatches.length > 0 && (
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs text-text-secondary">Empty patches (excluded)</dt>
            <dd className="break-words font-mono text-xs text-text">
              {profile.emptyPatches.join(', ')}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** The conversion-fidelity validation table + overall verdict. */
function ValidationCard({ validation }: { validation: ExportValidation }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Validation
        </h3>
        {validation.status === 'pass' ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
            PASS
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
            <XCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
            FAIL
          </span>
        )}
      </div>
      <div className="divide-y divide-border">
        {validation.checks.map((check) => (
          <div key={check.name} className="grid grid-cols-[1fr_auto] gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-sm text-text">{check.name}</p>
              <p className="break-words font-mono text-xs text-text-secondary" translate="no">
                {check.reference !== '-' && <span>ref: {check.reference} · </span>}
                cgns: {check.cgns}
              </p>
            </div>
            <Verdict verdict={check.verdict} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A pass / fail / info verdict pill. */
function Verdict({ verdict }: { verdict: 'pass' | 'fail' | 'info' }) {
  if (verdict === 'pass') {
    return <span className="self-center text-xs font-medium text-success">pass</span>;
  }
  if (verdict === 'fail') {
    return <span className="self-center text-xs font-medium text-danger">fail</span>;
  }
  return <span className="self-center text-xs font-medium text-text-secondary">info</span>;
}

/** Download buttons for the produced artifacts. */
function Downloads({ projectId, artifacts }: { projectId: string; artifacts: ExportArtifacts }) {
  const available: Record<ExportArtifact, boolean> = {
    cgns: artifacts.cgns,
    session: artifacts.session,
    memo: artifacts.memo,
    report: artifacts.report,
  };
  const [busy, setBusy] = useState<ExportArtifact | null>(null);

  const onDownload = async (artifact: ExportArtifact) => {
    setBusy(artifact);
    try {
      await downloadArtifact(projectId, artifact);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not download that file.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Downloads
      </h3>
      <div className="flex flex-wrap gap-2">
        {ARTIFACTS.filter((a) => available[a.key]).map((a) => (
          <Button
            key={a.key}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onDownload(a.key)}
            loading={busy === a.key}
          >
            <Download strokeWidth={1.75} aria-hidden="true" />
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** The CFD-Post load caveats (derived from the profile), with the key reminders. */
function CfdPostMemo({ profile }: { profile: CaseProfile }) {
  const points: string[] = [
    'Load with File > Load Results (never "Load Case").',
    'out.cgns is a single transient CGNS with all time steps: use the CFD-Post time bar (Timestep Selector) to play the evolution.',
    profile.incompressible
      ? `Pressure is kinematic (p/rho): the solver ${profile.solver} is incompressible, so CFD-Post pressures are divided by density. Multiply by density for Pa - not a bug.`
      : `Pressure is in Pa (the solver ${profile.solver} is compressible).`,
  ];
  if (profile.emptyPatches.length) {
    points.push(`Empty patches were excluded (${profile.emptyPatches.join(', ')}) to avoid "Invalid File / empty surfaces".`);
  }
  return (
    <div className="rounded-md border border-primary/30 bg-primary-tint p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
        <FileText className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Loading in CFD-Post
      </h3>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-1.5 text-xs text-text">
            <Diamond className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden="true" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Format a duration in ms as "640 ms" or "2.3 s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
