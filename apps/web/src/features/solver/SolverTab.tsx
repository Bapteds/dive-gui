import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Square, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { ResidualSample, RunStatus, RunSummary } from '@/lib/api/types';
import { ResidualChart } from './ResidualChart';
import { SolverSetupWizard } from './SolverSetupWizard';
import { SolverConfigPanel } from './SolverConfigPanel';
import { RunHistory } from './RunHistory';
import { RunLog } from './RunLog';
import { RunStatusBadge } from './RunStatusBadge';
import { runStatusMeta } from './runStatusMeta';
import {
  isRunActive,
  useRunLogQuery,
  useRunnableQuery,
  useRunsQuery,
  useStartRun,
  useStopRun,
} from './useRuns';

/**
 * SolverTab - launch an OpenFOAM solver run and watch it converge live.
 *
 * States: loading, load error, not-runnable gate (offers "Make runnable"), and
 * the runnable panel (run config + a single orange Run CTA, the live run with
 * its residual chart + streaming log + a danger Stop, and the run history).
 * Live updates come from polling the run log while a run is active (useRuns).
 */
export function SolverTab({ projectId }: { projectId: string }) {
  const runnable = useRunnableQuery(projectId);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Open the setup wizard the first time we learn the case is not runnable. Derived
  // synchronously during render (not in an effect) so the wizard is present on the
  // same commit. After that it is user-controlled: Done closes it, Reconfigure
  // reopens it, so it stays through all three steps even once generating (mid-flow)
  // makes the case runnable.
  const inited = useRef(false);
  if (!runnable.isPending && !inited.current) {
    inited.current = true;
    if (runnable.data && !runnable.data.runnable) setWizardOpen(true);
  }

  if (runnable.isPending) return <SolverSkeleton />;

  if (runnable.isError) {
    return (
      <div role="alert" className="rounded-md border border-danger/30 bg-danger-tint p-5">
        <p className="text-sm font-medium text-danger">We could not load the solver status.</p>
        <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => void runnable.refetch()}
          loading={runnable.isFetching}
        >
          <RotateCcw strokeWidth={1.75} aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  if (wizardOpen) {
    return (
      <SolverSetupWizard
        projectId={projectId}
        initialSolver={runnable.data.solver}
        missingFiles={runnable.data.missingFiles}
        onDone={() => setWizardOpen(false)}
      />
    );
  }

  if (!runnable.data.runnable) {
    return (
      <NotRunnableGate
        missingFiles={runnable.data.missingFiles}
        onConfigure={() => setWizardOpen(true)}
      />
    );
  }

  return (
    <RunnablePanel
      projectId={projectId}
      solver={runnable.data.solver}
      scaffoldable={runnable.data.scaffoldable}
      maxCores={runnable.data.maxCores}
      onReconfigure={() => setWizardOpen(true)}
    />
  );
}

/** Shown when the case is not runnable and the wizard is closed: offer to configure. */
function NotRunnableGate({
  missingFiles,
  onConfigure,
}: {
  missingFiles: string[];
  onConfigure: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-6 shadow-sm">
      <h2 className="text-base font-semibold text-text">This case is not runnable yet</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Set up the solver to generate the files it needs, then run it.
      </p>
      {missingFiles.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-text-secondary">Missing files</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {missingFiles.map((path) => (
              <li
                key={path}
                className="rounded-sm bg-bg px-1.5 py-0.5 font-mono text-xs text-text-secondary"
                translate="no"
              >
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="primary" className="mt-4" onClick={onConfigure}>
        <Wrench strokeWidth={1.75} aria-hidden="true" />
        Configure the solver
      </Button>
    </div>
  );
}

/** Loading skeleton matching the panel shape. */
function SolverSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-border bg-surface p-5 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading the solver status</span>
      <div className="h-10 w-48 animate-pulse rounded-sm bg-bg" />
      <div className="h-56 animate-pulse rounded-md bg-bg" />
      <div className="h-24 animate-pulse rounded-md bg-bg" />
    </div>
  );
}

/** The runnable panel: config + live run + history, with live polling. */
function RunnablePanel({
  projectId,
  solver,
  scaffoldable,
  maxCores,
  onReconfigure,
}: {
  projectId: string;
  solver: string | null;
  scaffoldable: boolean;
  maxCores: number;
  onReconfigure: () => void;
}) {
  const runs = useRunsQuery(projectId);
  const currentRun = runs.data?.[0] ?? null;
  const logQuery = useRunLogQuery(projectId, currentRun?.id ?? null);

  // The log payload carries the freshest status; fall back to the list entry.
  const liveRun = logQuery.data?.run ?? currentRun;
  const active = isRunActive(liveRun?.status);
  const series = logQuery.data?.series ?? [];
  const logTail = logQuery.data?.logTail ?? '';

  const startRun = useStartRun(projectId);
  const stopRun = useStopRun(projectId);

  const handleRun = async (cores: number) => {
    try {
      await startRun.mutateAsync({ cores });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const handleStop = async () => {
    if (!currentRun) return;
    try {
      await stopRun.mutateAsync(currentRun.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1 lg:overflow-auto lg:overscroll-contain">
      <SolverConfigPanel
        projectId={projectId}
        solver={solver}
        scaffoldable={scaffoldable}
        active={active}
        maxCores={maxCores}
        runLabel={currentRun ? 'Run again' : 'Run solver'}
        runPending={startRun.isPending}
        onRun={(cores) => void handleRun(cores)}
        onReconfigure={onReconfigure}
      />

      <LiveRun
        run={liveRun}
        active={active}
        series={series}
        logTail={logTail}
        stopPending={stopRun.isPending}
        onStop={() => void handleStop()}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text">History</h2>
        {runs.isPending ? (
          <div className="h-16 animate-pulse rounded-md bg-bg" />
        ) : (
          <RunHistory runs={runs.data ?? []} />
        )}
      </section>
    </div>
  );
}

/** The live (or last) run: status header, terminal banner, chart, log. */
function LiveRun({
  run,
  active,
  series,
  logTail,
  stopPending,
  onStop,
}: {
  run: RunSummary | null;
  active: boolean;
  series: ResidualSample[];
  logTail: string;
  stopPending: boolean;
  onStop: () => void;
}) {
  const lastIteration = series.length > 0 ? series[series.length - 1].time : null;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {run ? (
            <span role="status" aria-live="polite">
              <RunStatusBadge status={run.status} />
            </span>
          ) : (
            <span className="text-sm font-medium text-text">Ready to run</span>
          )}
          {run && <Elapsed startedAt={run.startedAt} finishedAt={run.finishedAt} active={active} />}
          {lastIteration !== null && (
            <span className="text-sm text-text-secondary tabular-nums">
              iteration {lastIteration}
            </span>
          )}
        </div>
        {active && (
          <Button
            variant="secondary"
            className="border-danger text-danger hover:border-danger hover:bg-danger-tint sm:shrink-0"
            loading={stopPending}
            onClick={onStop}
          >
            <Square strokeWidth={1.75} aria-hidden="true" />
            Stop run
          </Button>
        )}
      </div>

      {run && !active && <RunBanner status={run.status} reason={run.reason} />}

      {run ? (
        <ResidualChart samples={series} />
      ) : (
        <p className="text-sm text-text-secondary">
          Residuals will appear here as the solver iterates.
        </p>
      )}

      {run && <RunLog text={logTail} live={active} />}
    </div>
  );
}

/** A terminal-state banner: icon + a human message (color + icon + word). */
function RunBanner({ status, reason }: { status: RunStatus; reason: string | null }) {
  const defaults: Record<RunStatus, string> = {
    queued: 'Queued.',
    running: 'Running.',
    converged: 'Run converged. The residuals met the convergence tolerance.',
    completed: 'Reached endTime without meeting the convergence tolerance.',
    diverged: 'Residuals diverged. The solution did not converge.',
    failed: 'Run failed. See the log for the error.',
    stopped: 'Run stopped.',
  };
  const meta = runStatusMeta[status];
  const Icon = meta.icon;
  const message = reason ?? defaults[status];

  return (
    <div
      role={status === 'failed' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-md border p-3 ${meta.badgeClass}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

/** Elapsed wall-clock for a run; ticks every second while active. */
function Elapsed({
  startedAt,
  finishedAt,
  active,
}: {
  startedAt: string | null;
  finishedAt: string | null;
  active: boolean;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!startedAt) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();

  return (
    <span className="text-sm text-text-secondary tabular-nums">
      <span className="sr-only">Elapsed </span>
      {formatClock(ms)}
    </span>
  );
}

/** Format a millisecond duration as mm:ss (or h:mm:ss past an hour). */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
