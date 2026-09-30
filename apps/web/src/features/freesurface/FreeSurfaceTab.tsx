import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Download,
  Image as ImageIcon,
  Loader2,
  Play,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  FREE_SURFACE_ITERATION_COUNTS,
  isFreeSurfaceJobActive,
  type FreeSurfaceCheck,
  type FreeSurfaceIterationCount,
  type FreeSurfaceJob,
  type FreeSurfaceJobStatus,
  type FreeSurfaceNumericSettings,
  type FreeSurfaceOverview,
} from '@dive/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/ErrorState';
import { EmptyState } from '@/components/common/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { downloadFreeSurfaceFile, type FreeSurfaceSelection } from '@/lib/api/projects';
import {
  useDeleteFreeSurface,
  useFreeSurfaceJobQuery,
  useFreeSurfaceQuery,
  useStartFreeSurface,
  useStopFreeSurface,
} from './useFreeSurface';
import { ResidualPerIterationChart } from './ResidualPerIterationChart';

/**
 * FreeSurfaceTab - the project's "Free surface" tab (WS-I, spec
 * 2026-09-30-free-surface-tool-design). From a converged rigid-lid run, the
 * server iterates the lid shape by remeshing (surface estimate, lid fit, mesh,
 * case, solve). This tab shows the readiness checks, the selection and the kit
 * settings with ONE Start CTA, the live progress of a running job (Stop), and
 * the results per iteration with a residual chart.
 *
 * Visual contract: brain/design/design-system.md sections 2, 4 and 6 (hairline
 * panels, one orange CTA in the setup zone, icon + text states, tokens only).
 */

interface FreeSurfaceTabProps {
  projectId: string;
  /** Switch the project page to the Solver tab (live residuals of the current solve). */
  onOpenSolver?: () => void;
}

/** The six steps of an iteration, in order, with the server stage they map to. */
const STEPS = [
  { stage: 'exporting', label: 'Export' },
  { stage: 'surface', label: 'Surface' },
  { stage: 'fitting', label: 'Fit' },
  { stage: 'meshing', label: 'Mesh' },
  { stage: 'transferring', label: 'Case' },
  { stage: 'solving', label: 'Solve' },
] as const;

const STATUS_META: Record<
  FreeSurfaceJobStatus,
  {
    label: string;
    variant: 'neutral' | 'primary' | 'success' | 'danger';
    icon: typeof CheckCircle2;
  }
> = {
  running: { label: 'Running', variant: 'primary', icon: Loader2 },
  converged: { label: 'Converged', variant: 'success', icon: CheckCircle2 },
  completed: { label: 'Completed', variant: 'neutral', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'danger', icon: XCircle },
  stopped: { label: 'Stopped', variant: 'neutral', icon: CircleSlash },
  interrupted: { label: 'Interrupted', variant: 'danger', icon: AlertTriangle },
};

/** Render `code` spans for the backtick-quoted names of a server message. */
function richText(message: string): ReactNode {
  return message.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded-xs bg-bg px-1 text-[0.95em]" translate="no">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso: string) => DATE_FORMAT.format(new Date(iso));
const fmtMm = (v: number | null | undefined) =>
  v === null || v === undefined ? '-' : v.toFixed(1);
const fmtInt = (v: number | null | undefined) =>
  v === null || v === undefined ? '-' : v.toLocaleString('en-US');

/** Numeric kit settings held as strings while being edited. */
interface SettingsDraft {
  iterations: FreeSurfaceIterationCount;
  tolRmsMm: string;
  smooth: string;
  tmin: string;
  sub: string;
  steiner: string;
  clear: string;
  cut: boolean;
  axisX: string;
  axisY: string;
  rings: string;
  datumY: string;
}

function draftFrom(defaults: FreeSurfaceNumericSettings): SettingsDraft {
  return {
    iterations: defaults.iterations,
    tolRmsMm: String(defaults.tolRmsMm),
    smooth: String(defaults.smooth),
    tmin: String(defaults.tmin),
    sub: String(defaults.sub),
    steiner: String(defaults.steiner),
    clear: String(defaults.clear),
    cut: defaults.cut,
    axisX: defaults.axis ? String(defaults.axis[0]) : '',
    axisY: defaults.axis ? String(defaults.axis[1]) : '',
    rings: defaults.rings.map(([a, b]) => `${a}:${b}`).join(', '),
    datumY: defaults.datumY === null ? '' : String(defaults.datumY),
  };
}

/** Parse the draft; returns the settings or a field -> message map. */
function parseDraft(
  d: SettingsDraft,
):
  | { settings: FreeSurfaceNumericSettings; errors: null }
  | { settings: null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const positive = (key: keyof SettingsDraft, max: number): number => {
    const n = Number(d[key]);
    if (!(String(d[key]).trim() !== '' && Number.isFinite(n) && n > 0 && n <= max)) {
      errors[key] = `Enter a number greater than 0 and at most ${max}.`;
    }
    return n;
  };
  const nonNegative = (key: keyof SettingsDraft): number => {
    const n = Number(d[key]);
    if (!(String(d[key]).trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 10)) {
      errors[key] = 'Enter a number from 0 to 10.';
    }
    return n;
  };
  const tolRmsMm = positive('tolRmsMm', 1000);
  const smooth = nonNegative('smooth');
  const tmin = nonNegative('tmin');
  const sub = positive('sub', 10);
  const steiner = positive('steiner', 10);
  const clear = nonNegative('clear');
  let axis: [number, number] | null = null;
  if (d.axisX.trim() || d.axisY.trim()) {
    const x = Number(d.axisX);
    const y = Number(d.axisY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !d.axisX.trim() || !d.axisY.trim()) {
      errors.axis = 'Enter both axis coordinates, or leave both empty.';
    } else axis = [x, y];
  }
  const rings: Array<[number, number]> = [];
  for (const part of d.rings
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [a, b] = part.split(':').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) {
      errors.rings =
        'Write rings as r0:r1 pairs in metres, separated by commas (r1 greater than r0).';
      break;
    }
    rings.push([a, b]);
  }
  let datumY: number | null = null;
  if (d.datumY.trim()) {
    datumY = Number(d.datumY);
    if (!Number.isFinite(datumY)) errors.datumY = 'Enter a number or leave empty.';
  }
  if (Object.keys(errors).length) return { settings: null, errors };
  return {
    settings: {
      iterations: d.iterations,
      tolRmsMm,
      smooth,
      tmin,
      sub,
      steiner,
      clear,
      cut: d.cut,
      axis,
      rings,
      datumY,
    },
    errors: null,
  };
}

/** A router Link when rendered inside a router, else a plain anchor. */
function AppLink({ to, children }: { to: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  const className =
    'rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2';
  return inRouter ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <a href={to} className={className}>
      {children}
    </a>
  );
}

/** Save a blob under a file name (anchor download). */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function FreeSurfaceTab({ projectId, onOpenSolver }: FreeSurfaceTabProps) {
  const [selection, setSelection] = useState<FreeSurfaceSelection>({});
  const overview = useFreeSurfaceQuery(projectId, selection);
  const data = overview.data;

  const jobs = data?.jobs ?? [];
  const runningJob = jobs.find((job) => isFreeSurfaceJobActive(job.status)) ?? null;
  const [pickedJobId, setPickedJobId] = useState<string | null>(null);
  const shownJobId = runningJob?.id ?? pickedJobId ?? jobs[0]?.id ?? null;
  const jobQuery = useFreeSurfaceJobQuery(projectId, shownJobId);
  const shownJob = jobQuery.data ?? jobs.find((job) => job.id === shownJobId) ?? null;
  const active = !!shownJob && isFreeSurfaceJobActive(shownJob.status);

  // When a job ends, the case (mesh, runs) changed: refresh the views that show it.
  const queryClient = useQueryClient();
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'runs'] });
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'runnable'] });
      void overview.refetch();
    }
    wasActive.current = active;
  }, [active, overview, projectId, queryClient]);

  if (overview.isPending) return <FreeSurfaceSkeleton />;
  if (overview.isError || !data) {
    return (
      <ErrorState
        title="We could not load the free-surface tool."
        onRetry={() => void overview.refetch()}
        retrying={overview.isFetching}
      />
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-[-0.01em] text-text">Free surface</h2>
        <p className="max-w-[75ch] text-sm text-text-secondary">
          Estimates the water surface from the rigid-lid run, fits the lid to it and remeshes, until
          the lid residual meets the tolerance.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <SetupPanel
          projectId={projectId}
          overview={data}
          selection={selection}
          onSelection={setSelection}
          locked={!!runningJob || active}
          onStarted={(job) => setPickedJobId(job.id)}
        />
        <div className="flex min-w-0 flex-col gap-6">
          {shownJob && active && (
            <ProgressPanel projectId={projectId} job={shownJob} onOpenSolver={onOpenSolver} />
          )}
          {shownJob ? (
            <ResultsPanel
              projectId={projectId}
              job={shownJob}
              onDeleted={() => setPickedJobId(null)}
            />
          ) : (
            <section className="rounded-md border border-border bg-surface">
              <EmptyState
                variant="inline"
                title="No free-surface run yet"
                description="Check the setup, then start: the results of each iteration appear here."
              />
            </section>
          )}
          {jobs.length > 1 && (
            <JobHistory
              jobs={jobs}
              shownId={shownJob?.id ?? null}
              onPick={setPickedJobId}
              locked={!!runningJob}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup: checks, selection, settings, Start
// ---------------------------------------------------------------------------

function CheckRow({ check }: { check: FreeSurfaceCheck }) {
  const meta =
    check.status === 'ok'
      ? { icon: CheckCircle2, className: 'text-success', word: 'OK' }
      : check.status === 'warning'
        ? { icon: AlertTriangle, className: 'text-accent-strong', word: 'Warning' }
        : { icon: XCircle, className: 'text-danger', word: 'Blocking' };
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-2.5 py-2 text-sm">
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', meta.className)}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="sr-only">{meta.word}: </span>
      <p
        className={cn(
          'min-w-0 break-words',
          check.status === 'ok' ? 'text-text-secondary' : 'text-text',
        )}
      >
        {richText(check.message)}
      </p>
    </li>
  );
}

function SetupPanel({
  projectId,
  overview,
  selection,
  onSelection,
  locked,
  onStarted,
}: {
  projectId: string;
  overview: FreeSurfaceOverview;
  selection: FreeSurfaceSelection;
  onSelection: (next: FreeSurfaceSelection) => void;
  locked: boolean;
  onStarted: (job: FreeSurfaceJob) => void;
}) {
  const { checks, defaults } = overview;
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(defaults));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [startError, setStartError] = useState<string | null>(null);
  const start = useStartFreeSurface(projectId);

  const flatPatches = checks.patches.filter((p) => p.flat && p.nFaces > 0);
  const inletPatches = checks.patches.filter((p) => p.type === 'patch');
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const onStart = () => {
    setStartError(null);
    const parsed = parseDraft(draft);
    if (!parsed.settings) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    if (!checks.lidPatch || !checks.inletPatch || !checks.sourceSessionId) return;
    start.mutate(
      {
        lidPatch: checks.lidPatch,
        inletPatch: checks.inletPatch,
        sourceSessionId: checks.sourceSessionId,
        ...parsed.settings,
      },
      {
        onSuccess: (job) => {
          toast.success('Free-surface job started.');
          onStarted(job);
        },
        onError: (err) => setStartError(err.message),
      },
    );
  };

  const numberField = (key: keyof SettingsDraft, label: string, helper?: string) => (
    <Field label={label} helperText={helper} error={errors[key]}>
      <Input
        type="number"
        name={key}
        inputMode="decimal"
        step="any"
        autoComplete="off"
        value={String(draft[key])}
        onChange={(e) => set(key, e.target.value as never)}
        disabled={locked}
      />
    </Field>
  );

  return (
    <section
      aria-labelledby="fs-setup-title"
      className="flex flex-col rounded-md border border-border bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h3 id="fs-setup-title" className="text-base font-semibold text-text">
          Setup
        </h3>
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        <ul className="flex flex-col divide-y divide-border" aria-label="Readiness checks">
          {checks.items.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {flatPatches.length > 0 && (
            <Field label="Lid patch" helperText="Flat top patches only.">
              <NativeSelect
                value={checks.lidPatch ?? ''}
                onChange={(e) =>
                  onSelection({ ...selection, lidPatch: e.target.value || undefined })
                }
                disabled={locked}
              >
                {!checks.lidPatch && (
                  <option value="" disabled>
                    Pick the lid
                  </option>
                )}
                {flatPatches.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} (z = {p.z?.toFixed(3)} m)
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Inlet patch">
            <NativeSelect
              value={checks.inletPatch ?? ''}
              onChange={(e) =>
                onSelection({ ...selection, inletPatch: e.target.value || undefined })
              }
              disabled={locked || inletPatches.length === 0}
            >
              {!checks.inletPatch && <option value="">Pick the inlet</option>}
              {inletPatches.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label="Source meshing session"
            className="sm:col-span-2"
            helperText={
              overview.origin && overview.origin.sessionId === checks.sourceSessionId
                ? 'Recorded when the mesh was sent to this project.'
                : 'The session whose surfaces produced this mesh.'
            }
          >
            <NativeSelect
              value={checks.sourceSessionId ?? ''}
              onChange={(e) =>
                onSelection({ ...selection, sessionId: e.target.value || undefined })
              }
              disabled={locked}
            >
              {!checks.sourceSessionId && <option value="">Pick a session</option>}
              {checks.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'})
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <p className="text-sm text-text-secondary">
          Measured lid height Z_lid:{' '}
          <span data-testid="z-lid" className="font-medium tabular-nums text-text">
            {checks.zLid === null ? '-' : `${checks.zLid.toFixed(3)} m`}
          </span>
        </p>

        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text" id="fs-iterations-label">
              Iterations
            </span>
            <SegmentedRadioGroup
              name={`fs-iterations-${projectId}`}
              ariaLabel="Iterations"
              value={String(draft.iterations)}
              onChange={(v) => set('iterations', Number(v) as FreeSurfaceIterationCount)}
              options={FREE_SURFACE_ITERATION_COUNTS.map((n) => ({
                value: String(n),
                label: String(n),
              }))}
              disabled={locked}
            />
            <p className="text-xs text-text-secondary">
              Each iteration remeshes and re-solves: about one mesh + one solve.
            </p>
          </div>
          {numberField(
            'tolRmsMm',
            'Tolerance (residual RMS, mm)',
            'Stops early once the lid residual RMS is below it.',
          )}

          <details className="group rounded-md border border-border">
            <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
              Advanced
            </summary>
            <div className="grid grid-cols-1 gap-4 border-t border-border px-3 py-4 sm:grid-cols-2">
              {numberField('smooth', 'Smoothing radius (m)')}
              {numberField('tmin', 'Minimum water over tops (m)')}
              {numberField('sub', 'Lid edge length (m)')}
              {numberField('steiner', 'Interior point spacing (m)')}
              {numberField('clear', 'Boundary clearance (m)')}
              {numberField(
                'datumY',
                'Level datum y (m)',
                'Optional: mean surface over y below it.',
              )}
              {numberField('axisX', 'Machine axis x (m)', 'Optional, for ring statistics.')}
              {numberField('axisY', 'Machine axis y (m)')}
              <Field
                label="Rings (m)"
                className="sm:col-span-2"
                helperText="Optional: r0:r1 pairs separated by commas."
                error={errors.rings ?? errors.axis}
              >
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.rings}
                  onChange={(e) => set('rings', e.target.value)}
                  disabled={locked}
                />
              </Field>
              <label className="flex items-start gap-2 text-sm text-text sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded-xs accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                  checked={draft.cut}
                  onChange={(e) => set('cut', e.target.checked)}
                  disabled={locked}
                />
                <span>
                  Cut solids that poke through the lid
                  <span className="block text-xs text-text-secondary">
                    Vertical walls only; turn off to leave them to the mesher.
                  </span>
                </span>
              </label>
            </div>
          </details>
        </div>

        {startError && (
          <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
            <XCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{startError}</span>
          </p>
        )}
        {locked ? (
          <p className="text-sm text-text-secondary">
            A free-surface job is running on this project.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={onStart}
              disabled={!checks.ready}
              loading={start.isPending}
            >
              <Play strokeWidth={1.75} aria-hidden="true" />
              Start
            </Button>
            {!checks.ready && (
              <span className="text-xs text-text-secondary">
                Resolve the blocking checks to start.
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function ProgressPanel({
  projectId,
  job,
  onOpenSolver,
}: {
  projectId: string;
  job: FreeSurfaceJob;
  onOpenSolver?: () => void;
}) {
  const stop = useStopFreeSurface(projectId);
  const n = job.settings.iterations;
  const isCheck = (job.stage === 'exporting' || job.stage === 'surface') && job.iteration >= 1;
  const iteration =
    job.stage === 'exporting' || job.stage === 'surface' ? job.iteration + 1 : job.iteration;
  const current = STEPS.findIndex((s) => s.stage === job.stage);
  const steps = isCheck ? STEPS.slice(0, 2) : STEPS;
  const it = job.iterations.find((x) => x.index === (isCheck ? job.iteration : iteration));

  return (
    <section
      aria-labelledby="fs-progress-title"
      className="rounded-md border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-col">
          <h3 id="fs-progress-title" className="text-base font-semibold text-text">
            Progress
          </h3>
          <p className="text-sm text-text-secondary" aria-live="polite">
            {isCheck
              ? `Residual check after iteration ${job.iteration}`
              : `Iteration ${Math.max(1, iteration)} of ${n}`}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => stop.mutate(job.id)}
          disabled={job.stopRequested}
          loading={stop.isPending}
          className="border-danger text-danger hover:bg-danger-tint"
        >
          <Square strokeWidth={1.75} aria-hidden="true" />
          {job.stopRequested ? 'Stopping…' : 'Stop'}
        </Button>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {steps.map((step, i) => {
            const state = i < current ? 'done' : i === current ? 'current' : 'todo';
            return (
              <li
                key={step.stage}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm border px-2 py-1.5 text-xs font-medium',
                  state === 'current' && 'border-primary bg-primary-tint text-primary',
                  state === 'done' && 'border-border text-text',
                  state === 'todo' && 'border-border text-text-secondary',
                )}
              >
                {state === 'done' ? (
                  <CheckCircle2
                    className="size-3.5 shrink-0 text-success"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                ) : state === 'current' ? (
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="size-1.5 shrink-0 rotate-45 bg-neutral" aria-hidden="true" />
                )}
                <span>{step.label}</span>
                <span className="sr-only">
                  {state === 'done'
                    ? ' (done)'
                    : state === 'current'
                      ? ' (in progress)'
                      : ' (to do)'}
                </span>
              </li>
            );
          })}
        </ol>
        {(it?.sessionId || (job.stage === 'solving' && onOpenSolver)) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {it?.sessionId && (
              <span className="text-text-secondary">
                Meshing session:{' '}
                <AppLink to={`/meshing/${it.sessionId}`}>{it.sessionName ?? it.sessionId}</AppLink>
              </span>
            )}
            {job.stage === 'solving' && onOpenSolver && (
              <Button type="button" variant="ghost" size="sm" onClick={onOpenSolver}>
                Open the Solver tab
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: FreeSurfaceJobStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon
        className={cn(
          'size-3.5',
          status === 'running' && 'animate-spin motion-reduce:animate-none',
        )}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      {meta.label}
    </Badge>
  );
}

function ResultsPanel({
  projectId,
  job,
  onDeleted,
}: {
  projectId: string;
  job: FreeSurfaceJob;
  onDeleted: () => void;
}) {
  const remove = useDeleteFreeSurface(projectId);
  const running = isFreeSurfaceJobActive(job.status);
  const rows = useMemo(
    () =>
      job.surfaces.map((surface) => ({
        surface,
        iteration:
          surface.index >= 1
            ? (job.iterations.find((it) => it.index === surface.index) ?? null)
            : null,
      })),
    [job],
  );
  const download = async (name: string) => {
    try {
      saveBlob(await downloadFreeSurfaceFile(projectId, job.id, name), name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The download failed.');
    }
  };
  const th = 'px-3 py-2 text-left text-xs font-medium text-text-secondary';
  const td = 'px-3 py-2 text-right tabular-nums text-text';

  return (
    <section
      aria-labelledby="fs-results-title"
      className="rounded-md border border-border bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="fs-results-title" className="text-base font-semibold text-text">
              Results
            </h3>
            <StatusBadge status={job.status} />
          </div>
          <p className="text-xs text-text-secondary">
            Started {fmtDate(job.createdAt)}, lid {job.settings.lidPatch} at Z_lid{' '}
            {job.zLid.toFixed(3)} m, tolerance {job.settings.tolRmsMm.toFixed(1)} mm
          </p>
        </div>
        {!running && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Delete this result">
                <Trash2 strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this free-surface result?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its fitted STLs and figures are removed. The meshing sessions and the project case
                  stay as they are.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-danger hover:bg-danger-hover"
                  onClick={() => remove.mutate(job.id, { onSuccess: onDeleted })}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="flex flex-col gap-5 px-5 py-4">
        {job.reason && (
          <p
            role={job.status === 'failed' || job.status === 'interrupted' ? 'alert' : undefined}
            className={cn(
              'text-sm',
              job.status === 'failed' || job.status === 'interrupted' ? 'text-danger' : 'text-text',
            )}
          >
            {job.failedStage && <span className="font-medium">Failed at {job.failedStage}: </span>}
            {richText(job.reason)}
          </p>
        )}
        {job.notes.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-text-secondary">
            {job.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-text-secondary">The first surface estimate is on its way.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table aria-label="Results per iteration" className="w-full min-w-[820px] text-sm">
              <thead className="bg-bg">
                <tr>
                  <th scope="col" className={th}>
                    Iteration
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    z_s mean (mm)
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    z_s min (mm)
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Residual RMS (mm)
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Residual max (mm)
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Clamped points
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Upstands
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Mesh cells
                  </th>
                  <th scope="col" className={cn(th, 'text-right')}>
                    Δp₀ (Pa)
                  </th>
                  <th scope="col" className={th}>
                    Files
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ surface, iteration }) => (
                  <tr key={surface.index}>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-text">
                      {surface.index === 0 ? 'Parent' : surface.index}
                    </th>
                    <td className={td}>{fmtMm(surface.zsMeanMm)}</td>
                    <td className={td}>{fmtMm(surface.zsMinMm)}</td>
                    <td className={cn(td, 'font-medium')}>{fmtMm(surface.residualRmsMm)}</td>
                    <td className={td}>{fmtMm(surface.residualMaxMm)}</td>
                    <td className={td}>{fmtInt(iteration?.fit?.clampedLidPoints)}</td>
                    <td className={td}>{fmtInt(iteration?.fit?.upstandFacets)}</td>
                    <td className={td}>{fmtInt(iteration?.meshCells)}</td>
                    <td className={td}>
                      {surface.dp0Pa === null ? '-' : Math.round(surface.dp0Pa)}
                    </td>
                    <td className="px-3 py-2">
                      {iteration?.files.includes(`domain_lidIter${iteration.index}.stl`) ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-label={`Download fitted STL, iteration ${iteration.index}`}
                          onClick={() => void download(`domain_lidIter${iteration.index}.stl`)}
                        >
                          <Download strokeWidth={1.75} aria-hidden="true" />
                          STL
                        </Button>
                      ) : (
                        <span className="text-text-secondary">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {job.surfaces.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-text">Lid residual per iteration</h4>
            <ResidualPerIterationChart surfaces={job.surfaces} tolRmsMm={job.settings.tolRmsMm} />
          </div>
        )}

        {job.iterations.some((it) => it.files.some((f) => f.endsWith('.png'))) && (
          <IterationFigures projectId={projectId} job={job} />
        )}
      </div>
    </section>
  );
}

/** The fit check and post figures, loaded only when the user opens them. */
function IterationFigures({ projectId, job }: { projectId: string; job: FreeSurfaceJob }) {
  const [open, setOpen] = useState(false);
  const names = job.iterations.flatMap((it) => it.files.filter((f) => f.endsWith('.png')));
  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ImageIcon strokeWidth={1.75} aria-hidden="true" />
        {open ? 'Hide figures' : `Show figures (${names.length})`}
      </Button>
      {open && (
        <div className="flex flex-col gap-4">
          {names.map((name) => (
            <Figure key={name} projectId={projectId} jobId={job.id} name={name} />
          ))}
        </div>
      )}
    </div>
  );
}

function Figure({ projectId, jobId, name }: { projectId: string; jobId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    downloadFreeSurfaceFile(projectId, jobId, name)
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, jobId, name]);
  const k = name.match(/\d+/)?.[0];
  const caption = name.startsWith('domain_')
    ? `Fit check of iteration ${k}: fitted lid height and triangulation`
    : `Iteration ${k}: mesh lid, new surface estimate and residual`;
  return (
    <figure className="flex flex-col gap-1.5">
      {url ? (
        <img
          src={url}
          alt={caption}
          loading="lazy"
          className="h-auto w-full rounded-sm border border-border"
        />
      ) : failed ? (
        <p className="text-sm text-danger">The figure {name} could not be loaded.</p>
      ) : (
        <Skeleton className="aspect-[2/1] w-full" />
      )}
      <figcaption className="text-xs text-text-secondary">{caption}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// History + skeleton
// ---------------------------------------------------------------------------

function JobHistory({
  jobs,
  shownId,
  onPick,
  locked,
}: {
  jobs: FreeSurfaceJob[];
  shownId: string | null;
  onPick: (id: string) => void;
  locked: boolean;
}) {
  return (
    <section
      aria-labelledby="fs-history-title"
      className="rounded-md border border-border bg-surface"
    >
      <h3
        id="fs-history-title"
        className="border-b border-border px-5 py-3 text-sm font-semibold text-text"
      >
        Previous runs
      </h3>
      <ul className="divide-y divide-border">
        {jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => onPick(job.id)}
              disabled={locked}
              aria-current={job.id === shownId ? 'true' : undefined}
              className={cn(
                'flex w-full flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-left text-sm transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60',
                job.id === shownId && 'bg-primary-tint',
              )}
            >
              <span className="tabular-nums text-text">{fmtDate(job.createdAt)}</span>
              <span className="flex items-center gap-3 text-xs text-text-secondary">
                {job.surfaces.length > 0 &&
                  `${job.surfaces[job.surfaces.length - 1].residualRmsMm.toFixed(1)} mm`}
                <StatusBadge status={job.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FreeSurfaceSkeleton() {
  return (
    <div
      className="flex w-full flex-col gap-6"
      role="status"
      aria-label="Loading the free-surface tool"
    >
      <Skeleton className="h-7 w-40" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
          <Skeleton className="mt-2 h-10 w-24" />
        </div>
        <Skeleton className="h-64 w-full rounded-md" />
      </div>
    </div>
  );
}
