import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Pause,
  PauseCircle,
  Pencil,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  chamberInputWithExact,
  type EvaluationStatus,
  type PublicStudy,
  type StudyDetail,
  type StudyEvaluation,
  type StudyStatus,
} from '@dive/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { downloadStudyCsv } from '@/lib/api/studies';
import { formatValue } from '@/features/solver/chartUtils';
import { ObjectiveChart, ParetoChart } from './StudyCharts';
import { VORTEX_METRIC_LABEL, vortexOf } from './studyFormat';
import { isStudyActive, useDeleteStudy, useStudyControl } from './useStudies';

/**
 * StudyPanel - one optimisation study in the Optimisation tab (WS-H): status and
 * owner-only controls (one orange CTA: Start or Resume), the stage of the
 * evaluation in progress, the best design ("Open in Chamber"), the evaluations
 * table and the two charts with their table alternatives. Other project members
 * get the same page read-only.
 *
 * Visual contract: brain/design/design-system.md sections 2, 4 and 6 (hairline
 * panel, status as icon + text, tokens only, destructive action confirmed).
 */

interface StudyPanelProps {
  projectId: string;
  detail: StudyDetail;
  onEdit: () => void;
  onDeleted: () => void;
  /** Switch the project page to the Solver tab (live residuals of the current solve). */
  onOpenSolver?: () => void;
}

const STAGES = [
  { status: 'building', label: 'Build' },
  { status: 'meshing', label: 'Mesh' },
  { status: 'transferring', label: 'Transfer' },
  { status: 'configuring', label: 'Configure' },
  { status: 'solving', label: 'Solve' },
] as const;

const STUDY_STATUS: Record<
  StudyStatus,
  {
    label: string;
    variant: 'neutral' | 'primary' | 'success' | 'danger';
    icon: typeof CheckCircle2;
  }
> = {
  draft: { label: 'Draft', variant: 'neutral', icon: Pencil },
  running: { label: 'Running', variant: 'primary', icon: Loader2 },
  pausing: { label: 'Pausing', variant: 'primary', icon: Loader2 },
  paused: { label: 'Paused', variant: 'neutral', icon: PauseCircle },
  completed: { label: 'Completed', variant: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'danger', icon: XCircle },
};

const EVALUATION_LABEL: Record<EvaluationStatus, string> = {
  pending: 'Pending',
  building: 'Building',
  meshing: 'Meshing',
  transferring: 'Transferring',
  configuring: 'Configuring',
  solving: 'Solving',
  done: 'Done',
  infeasible: 'Infeasible',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function StudyStatusBadge({ status }: { status: StudyStatus }) {
  const meta = STUDY_STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon
        className={cn(
          'size-3.5',
          isStudyActive(status) && 'animate-spin motion-reduce:animate-none',
        )}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      {meta.label}
    </Badge>
  );
}

function EvaluationBadge({ status }: { status: EvaluationStatus }) {
  const variant =
    status === 'done'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'infeasible' || status === 'interrupted' || status === 'pending'
          ? 'neutral'
          : 'primary';
  return <Badge variant={variant}>{EVALUATION_LABEL[status]}</Badge>;
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

const linkClass =
  'rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2';

export function StudyPanel({
  projectId,
  detail,
  onEdit,
  onDeleted,
  onOpenSolver,
}: StudyPanelProps) {
  const { study, evaluations, best, paretoFront } = detail;
  const control = useStudyControl(projectId);
  const remove = useDeleteStudy(projectId);
  const navigate = useNavigate();
  const active = isStudyActive(study.status);
  const current =
    study.currentIndex !== null
      ? evaluations.find((e) => e.index === study.currentIndex)
      : undefined;
  const metric = VORTEX_METRIC_LABEL[study.vortexMetric];
  const bestEvaluation = best !== null ? evaluations.find((e) => e.index === best) : undefined;

  const act = (action: 'start' | 'stop' | 'resume') =>
    control.mutate(
      { studyId: study.id, action },
      {
        onSuccess: () =>
          toast.success(
            action === 'stop'
              ? 'Pausing the study: the current stage is being stopped.'
              : 'Study running. Its evaluations appear below.',
          ),
        onError: (err) => toast.error(err.message),
      },
    );

  const exportCsv = async () => {
    try {
      saveBlob(
        await downloadStudyCsv(projectId, study.id),
        `${study.name.replace(/[^\w-]+/g, '-') || 'study'}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The export failed.');
    }
  };

  const openInChamber = (e: StudyEvaluation) => {
    const input =
      e.index === 0 ? study.baseInput : chamberInputWithExact(study.baseInput, e.designParams);
    navigate('/chamber', { state: { chamberInput: input } });
  };

  return (
    <section
      aria-labelledby="study-title"
      className="flex min-w-0 flex-col rounded-md border border-border bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="study-title" className="break-words text-base font-semibold text-text">
              {study.name}
            </h3>
            <StudyStatusBadge status={study.status} />
          </div>
          <p className="text-sm text-text-secondary">
            Base: {study.baseLabel}. {study.mode === 'weighted' ? 'Weighted sum' : 'Pareto front'}{' '}
            of head loss and {metric.name}. {study.counted} of {study.maxEvaluations} evaluations
            counted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {evaluations.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void exportCsv()}>
              <Download strokeWidth={1.75} aria-hidden="true" />
              Export CSV
            </Button>
          )}
          {study.canControl && study.status === 'draft' && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={onEdit}>
                <Pencil strokeWidth={1.75} aria-hidden="true" />
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                loading={control.isPending}
                onClick={() => act('start')}
              >
                <Play strokeWidth={1.75} aria-hidden="true" />
                Start
              </Button>
            </>
          )}
          {study.canControl && active && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={study.status === 'pausing'}
              loading={control.isPending}
              onClick={() => act('stop')}
            >
              <Pause strokeWidth={1.75} aria-hidden="true" />
              {study.status === 'pausing' ? 'Pausing…' : 'Pause'}
            </Button>
          )}
          {study.canControl && study.status === 'paused' && (
            <Button
              type="button"
              size="sm"
              loading={control.isPending}
              onClick={() => act('resume')}
            >
              <Play strokeWidth={1.75} aria-hidden="true" />
              Resume
            </Button>
          )}
          {study.canControl && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Delete study">
                  <Trash2 strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete the study “{study.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {active ? 'The study is paused first. ' : ''}Its evaluations, archived metrics
                    and remaining meshing sessions are removed. The project case keeps its current
                    mesh.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      remove.mutate(study.id, {
                        onSuccess: () => {
                          toast.success('Study deleted.');
                          onDeleted();
                        },
                        onError: (err) => toast.error(err.message),
                      })
                    }
                  >
                    Delete study
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <StudySummary study={study} evaluations={evaluations} best={best} front={paretoFront} />

      <div className="flex flex-col gap-6 px-5 py-5">
        {!study.canControl && (
          <p className="text-sm text-text-secondary">
            Only the study owner or a super-admin can edit, run or delete this study (owner:{' '}
            {study.owner.fullName}).
          </p>
        )}
        {study.reason && (
          <p
            className={cn(
              'flex items-start gap-2 text-sm',
              study.status === 'failed' ? 'text-danger' : 'text-text',
            )}
            role={study.status === 'failed' ? 'alert' : undefined}
          >
            {study.status === 'failed' && (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            )}
            {study.reason}
          </p>
        )}

        {active && <Progress study={study} current={current} onOpenSolver={onOpenSolver} />}

        {bestEvaluation && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium text-text">
                Best design: #{bestEvaluation.index}
                {bestEvaluation.objective !== null &&
                  `, objective ${bestEvaluation.objective.toFixed(3)}`}
              </span>
              <span className="tabular-nums text-text-secondary">
                {study.paramSpace
                  .map(
                    (r) =>
                      `${r.label} ${Math.round(bestEvaluation.designParams[r.key] ?? r.base)} mm`,
                  )
                  .join(', ')}
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => openInChamber(bestEvaluation)}
            >
              Open in Chamber
            </Button>
          </div>
        )}

        {evaluations.some((e) => e.status === 'done') && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {study.mode === 'weighted' && (
              <ChartPanel title="Objective per evaluation">
                <ObjectiveChart evaluations={evaluations} best={best} />
              </ChartPanel>
            )}
            <ChartPanel
              title={`Head loss and ${metric.name}`}
              className={study.mode === 'weighted' ? undefined : 'xl:col-span-2'}
            >
              <ParetoChart
                evaluations={evaluations}
                front={paretoFront}
                metric={study.vortexMetric}
              />
            </ChartPanel>
          </div>
        )}

        {evaluations.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No evaluation yet.{' '}
            {study.status === 'draft'
              ? 'Start the study: the baseline (the unmodified base design) is evaluated first.'
              : ''}
          </p>
        ) : (
          <EvaluationsTable study={study} evaluations={evaluations} best={best} />
        )}

        <SearchSpace study={study} />
      </div>
    </section>
  );
}

function Progress({
  study,
  current,
  onOpenSolver,
}: {
  study: PublicStudy;
  current: StudyEvaluation | undefined;
  onOpenSolver?: () => void;
}) {
  const currentStage = STAGES.findIndex((s) => s.status === current?.status);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
      <p className="text-sm font-medium text-text">
        {current
          ? `Evaluation #${current.index}${current.index === 0 ? ' (baseline)' : ''}`
          : study.status === 'pausing'
            ? 'Pausing'
            : 'Choosing the next design'}
      </p>
      <ol aria-label="Evaluation stages" className="flex flex-wrap gap-2">
        {STAGES.map((stage, i) => {
          const state =
            currentStage < 0
              ? 'todo'
              : i < currentStage
                ? 'done'
                : i === currentStage
                  ? 'current'
                  : 'todo';
          return (
            <li
              key={stage.status}
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
              <span>{stage.label}</span>
              <span className="sr-only">
                {state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ' (to do)'}
              </span>
            </li>
          );
        })}
      </ol>
      {(current?.meshingSessionId || (current?.status === 'solving' && onOpenSolver)) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          {current?.meshingSessionId && current.sessionAvailable && (
            <span className="text-text-secondary">
              Meshing session:{' '}
              <Link to={`/meshing/${current.meshingSessionId}`} className={linkClass}>
                {current.meshingSessionName ?? current.meshingSessionId}
              </Link>
            </span>
          )}
          {current?.status === 'solving' && onOpenSolver && (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenSolver}>
              <Activity strokeWidth={1.75} aria-hidden="true" />
              Open Solver tab
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-text-secondary">
        The project is locked while the study runs: manual runs and case changes wait for a pause.
      </p>
    </div>
  );
}

function SearchSpace({ study }: { study: PublicStudy }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-sm font-medium text-text">Search space</h4>
      <ul className="flex flex-wrap gap-2 text-xs tabular-nums">
        {study.paramSpace.map((r) => (
          <li key={r.key} className="rounded-sm border border-border px-2 py-1 text-text">
            {r.label}: {Math.round(r.min)} to {Math.round(r.max)} mm
            <span className="text-text-secondary">
              {' '}
              (base {Math.round(r.base)}, ±{r.bandPct} %
              {r.source === 'table' ? ', table limit' : ''})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvaluationsTable({
  study,
  evaluations,
  best,
}: {
  study: PublicStudy;
  evaluations: StudyEvaluation[];
  best: number | null;
}) {
  const metric = VORTEX_METRIC_LABEL[study.vortexMetric];
  const th =
    'whitespace-nowrap px-3 py-2 text-left align-bottom text-xs font-medium text-text-secondary';
  const td = 'px-3 py-2 text-right tabular-nums text-text';
  const cell = (v: number | null) => (v === null ? '-' : formatValue(v));
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table aria-label="Evaluations" className="w-full min-w-[680px] text-sm">
        <thead className="bg-bg">
          <tr>
            <th scope="col" className={th}>
              #
            </th>
            <th scope="col" className={th}>
              Status
            </th>
            {study.paramSpace.map((r) => (
              <th key={r.key} scope="col" className={cn(th, 'text-right')}>
                <HeaderLabel label={r.label} unit="mm" />
              </th>
            ))}
            <th scope="col" className={cn(th, 'text-right')}>
              <HeaderLabel label="Head loss" unit="m" />
            </th>
            <th scope="col" className={cn(th, 'text-right')}>
              <HeaderLabel label={metric.name} unit={metric.unit} />
            </th>
            {study.mode === 'weighted' && (
              <th scope="col" className={cn(th, 'text-right')}>
                Objective
              </th>
            )}
            <th scope="col" className={th}>
              Notes
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {evaluations.map((e) => {
            const notes: ReactNode[] = [];
            if (e.index === 0) notes.push('Baseline');
            if (e.index === best) notes.push('Best');
            if (e.budgetHit) notes.push('Time budget reached (counted)');
            if (e.refusalReason) notes.push(e.refusalReason);
            notes.push(...e.warnings.filter((w) => w.startsWith('duplicate of')));
            return (
              <tr key={e.index} className={cn(e.index === best && 'bg-primary-tint')}>
                <th scope="row" className="px-3 py-2 text-left font-medium tabular-nums text-text">
                  {e.index}
                </th>
                <td className="whitespace-nowrap px-3 py-2">
                  <EvaluationBadge status={e.status} />
                </td>
                {study.paramSpace.map((r) => (
                  <td key={r.key} className={td}>
                    {e.designParams[r.key] !== undefined
                      ? Math.round(e.designParams[r.key] as number)
                      : '-'}
                  </td>
                ))}
                <td className={td}>{cell(e.headLoss)}</td>
                <td className={td}>{cell(vortexOf(e, study.vortexMetric))}</td>
                {study.mode === 'weighted' && (
                  <td className={cn(td, 'font-medium')}>
                    {e.objective === null ? '-' : e.objective.toFixed(3)}
                  </td>
                )}
                <td className="min-w-[9rem] px-3 py-2 text-xs text-text-secondary">
                  {notes.length ? (
                    <span className="line-clamp-2" title={notes.join('. ')}>
                      {notes.join('. ')}
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Two-line table header: the quantity, then its unit (every header keeps the same shape). */
function HeaderLabel({ label, unit }: { label: string; unit: string }) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span>{label}</span>
      <span className="font-normal">{unit}</span>
    </span>
  );
}

/** A chart and its title in a hairline frame (the pair sits side by side on wide screens). */
function ChartPanel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn('flex min-w-0 flex-col gap-3 rounded-md border border-border p-4', className)}
    >
      <h4 className="text-sm font-medium text-text">{title}</h4>
      {children}
    </section>
  );
}

/** Relative change against the baseline, "-6.7 %" style (null without a baseline). */
function deltaPct(value: number | null, base: number | null): string | null {
  if (value === null || base === null || base === 0) return null;
  const pct = ((value - base) / Math.abs(base)) * 100;
  if (Math.abs(pct) < 0.05) return '0.0 %';
  return `${pct > 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)} %`;
}

/**
 * The study at a glance: budget used, best objective (or the Pareto front size),
 * and the lowest head loss and vortex metric reached, each against the baseline
 * (#0). A definition list on hairlines, not stat cards (brain/design/product.md).
 */
function StudySummary({
  study,
  evaluations,
  best,
  front,
}: {
  study: PublicStudy;
  evaluations: StudyEvaluation[];
  best: number | null;
  front: number[];
}) {
  const metric = VORTEX_METRIC_LABEL[study.vortexMetric];
  const done = evaluations.filter((e) => e.status === 'done');
  const baseline = done.find((e) => e.index === 0);
  const lowest = (pick: (e: StudyEvaluation) => number | null) =>
    done.reduce<{ value: number; index: number } | null>((acc, e) => {
      const v = pick(e);
      return v !== null && (acc === null || v < acc.value) ? { value: v, index: e.index } : acc;
    }, null);
  const headLoss = lowest((e) => e.headLoss);
  const vortex = lowest((e) => vortexOf(e, study.vortexMetric));
  const bestObjective =
    best !== null ? (evaluations.find((e) => e.index === best)?.objective ?? null) : null;
  const vsBaseline = (index: number, value: number, base: number | null | undefined) => {
    if (index === 0) return ', the baseline';
    const d = deltaPct(value, base ?? null);
    return d ? `, ${d} vs baseline` : '';
  };

  const items: { label: string; value: string; note: string | null }[] = [
    {
      label: 'Evaluations',
      value: `${study.counted} / ${study.maxEvaluations}`,
      note: `${done.length} with results`,
    },
    study.mode === 'weighted'
      ? {
          label: 'Best objective',
          value: bestObjective !== null ? bestObjective.toFixed(3) : '-',
          note: best !== null ? `#${best}, baseline = 1` : 'After the baseline',
        }
      : { label: 'Pareto front', value: String(front.length), note: 'Non-dominated designs' },
    {
      label: 'Lowest head loss',
      value: headLoss ? `${formatValue(headLoss.value)} m` : '-',
      note: headLoss
        ? `#${headLoss.index}${vsBaseline(headLoss.index, headLoss.value, baseline?.headLoss)}`
        : null,
    },
    {
      label: `Lowest ${metric.name}`,
      value: vortex ? `${formatValue(vortex.value)} ${metric.unit}` : '-',
      note: vortex
        ? `#${vortex.index}${vsBaseline(vortex.index, vortex.value, baseline ? vortexOf(baseline, study.vortexMetric) : null)}`
        : null,
    },
  ];

  return (
    <dl
      aria-label="Study summary"
      className="grid grid-cols-2 border-b border-border xl:grid-cols-4"
    >
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn(
            'flex min-w-0 flex-col gap-0.5 px-5 py-3',
            i % 2 === 1 && 'border-l border-border',
            i >= 2 && 'border-t border-border xl:border-t-0',
            i === 2 && 'xl:border-l',
          )}
        >
          <dt className="text-xs text-text-secondary">{item.label}</dt>
          <dd className="text-base font-semibold tabular-nums text-text">{item.value}</dd>
          {item.note && <dd className="text-xs tabular-nums text-text-secondary">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}
