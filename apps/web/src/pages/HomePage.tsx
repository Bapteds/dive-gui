import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Cpu,
  Eye,
  FolderOpen,
  Layers,
  Loader2,
  MemoryStick,
  Minus,
  Plus,
  Square,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { stopRun } from '@/lib/api/projects';
import type { DashboardProject, DashboardRun } from '@/lib/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { useDashboardQuery, dashboardQueryKey } from '@/features/dashboard/useDashboard';
import { Sparkline, DistributionBar, Donut } from '@/features/dashboard/DashboardCharts';
import {
  RUN_STATUS_COLOR,
  RUN_STATUS_PILL,
  TONE,
  usageColor,
} from '@/features/dashboard/dashboardColors';

/**
 * HomePage - the workspace "command center" dashboard (imported design). Pinned to
 * the viewport (AppShell) so it does not scroll: a KPI strip (CPU / memory / active
 * solvers / total runs with live trend sparklines), the running-solver list, the
 * run-outcome donut, and the recent-project grid. Server metrics + running solvers
 * poll every few seconds. Colours use brand tokens; the app's own font throughout.
 */
export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const firstName = user?.fullName.trim().split(/\s+/)[0];

  const dashboard = useDashboardQuery();
  const data = dashboard.data;

  // Short client-side history of CPU + memory samples for the trend sparklines.
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  useEffect(() => {
    if (!data) return;
    const mem = Math.round((data.metrics.memUsedBytes / Math.max(1, data.metrics.memTotalBytes)) * 100);
    setCpuHistory((history) => [...history, data.metrics.cpuPercent].slice(-40));
    setMemHistory((history) => [...history, mem].slice(-40));
  }, [dashboard.dataUpdatedAt, data]);

  const stop = useMutation({
    mutationFn: ({ projectId, runId }: { projectId: string; runId: string }) =>
      stopRun(projectId, runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardQueryKey }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not stop the run.'),
  });

  const memPercent = data
    ? Math.round((data.metrics.memUsedBytes / Math.max(1, data.metrics.memTotalBytes)) * 100)
    : 0;
  const cpuDelta = lastDelta(cpuHistory);
  const memDelta = lastDelta(memHistory);
  const cpuColor = usageColor(data?.metrics.cpuPercent ?? 0);
  const memColor = usageColor(memPercent);

  const outcomes = useMemo(() => {
    const c = data?.runCounts;
    const converged = (c?.converged ?? 0) + (c?.completed ?? 0);
    const diverged = (c?.diverged ?? 0) + (c?.failed ?? 0);
    const other = (c?.stopped ?? 0) + (c?.queued ?? 0) + (c?.running ?? 0);
    const terminal = converged + diverged + (c?.stopped ?? 0);
    return {
      converged,
      diverged,
      other,
      total: converged + diverged + other,
      successRate: terminal > 0 ? Math.round((converged / terminal) * 100) : 0,
    };
  }, [data]);

  const activeRuns = data?.activeRuns ?? [];
  const cores = data?.metrics.cores ?? 0;
  const activePct = cores > 0 ? Math.min(100, (activeRuns.length / cores) * 100) : 0;
  const distribution = [
    { value: outcomes.converged, color: TONE.success },
    { value: outcomes.diverged, color: TONE.accent },
    { value: outcomes.other, color: TONE.neutral },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-tint px-2 py-0.5 text-xs font-semibold text-success">
              <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
              Live
            </span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {firstName ? `Welcome back, ${firstName}.` : 'Welcome back.'} Live server and solver
            activity across your workspace.
          </p>
        </div>
        <Button variant="primary" onClick={() => navigate('/projects')}>
          <Plus strokeWidth={1.9} aria-hidden="true" />
          New project
        </Button>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          icon={<Cpu className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          label="CPU load"
          tone={cpuColor}
          delta={cpuDelta}
        >
          {data ? (
            <>
              <MetricNumber value={String(data.metrics.cpuPercent)} suffix="%" />
              <Sparkline values={cpuHistory} color={cpuColor} />
              <KpiFoot>
                {cores} cores · load {data.metrics.loadAvg1.toFixed(2)}
              </KpiFoot>
            </>
          ) : (
            <KpiSkeleton />
          )}
        </KpiCard>

        <KpiCard
          icon={<MemoryStick className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          label="Memory"
          tone={memColor}
          delta={memDelta}
        >
          {data ? (
            <>
              <MetricNumber value={String(memPercent)} suffix="%" />
              <Sparkline values={memHistory} color={memColor} />
              <KpiFoot>
                <span className="font-mono text-text-secondary">
                  {formatBytes(data.metrics.memUsedBytes)}
                </span>{' '}
                / {formatBytes(data.metrics.memTotalBytes)}
              </KpiFoot>
            </>
          ) : (
            <KpiSkeleton />
          )}
        </KpiCard>

        <KpiCard
          icon={<Activity className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          label="Active solvers"
          tone={TONE.success}
        >
          {data ? (
            <>
              <MetricNumber value={String(activeRuns.length)} />
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${activePct}%`, background: TONE.success }}
                />
              </div>
              <KpiFoot>
                <span className="font-mono text-text-secondary">{activeRuns.length}</span> of {cores}{' '}
                cores in use
              </KpiFoot>
            </>
          ) : (
            <KpiSkeleton />
          )}
        </KpiCard>

        <KpiCard
          icon={<Layers className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          label="Total runs"
          tone={TONE.primary}
        >
          {data ? (
            <>
              <MetricNumber value={String(outcomes.total)} />
              <DistributionBar segments={distribution} className="mt-1.5 h-2" />
              <KpiFoot>
                success <span className="font-mono text-success">{outcomes.successRate}%</span>
              </KpiFoot>
            </>
          ) : (
            <KpiSkeleton />
          )}
        </KpiCard>
      </div>

      {/* main grid: running solvers + run outcomes */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1.9fr_1fr]">
        <RunningSolversPanel
          runs={activeRuns}
          queued={data?.runCounts.queued ?? 0}
          pending={!data}
          onStop={(run) => stop.mutate({ projectId: run.projectId, runId: run.runId })}
          stopPending={stop.isPending}
        />
        <RunOutcomesPanel
          total={outcomes.total}
          converged={outcomes.converged}
          diverged={outcomes.diverged}
          other={outcomes.other}
          successRate={outcomes.successRate}
          distribution={distribution}
        />
      </div>

      {/* recent projects */}
      <RecentProjectsPanel projects={data?.recentProjects ?? []} pending={!data} />
    </div>
  );
}

/* ------------------------------- KPI pieces ------------------------------- */

function KpiCard({
  icon,
  label,
  tone,
  delta,
  children,
}: {
  icon: ReactNode;
  label: string;
  tone: string;
  delta?: number | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <span style={{ color: tone }} className="flex">
            {icon}
          </span>
          {label}
        </span>
        {delta !== undefined && <DeltaPill delta={delta} />}
      </div>
      {children}
    </div>
  );
}

function MetricNumber({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <div className="mt-1.5 font-mono text-3xl font-semibold text-text tabular-nums">
      {value}
      {suffix && <span className="ml-0.5 text-base font-medium text-text-secondary">{suffix}</span>}
    </div>
  );
}

function KpiFoot({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs text-text-secondary">{children}</p>;
}

function KpiSkeleton() {
  return (
    <div className="mt-1.5 flex flex-col gap-2" aria-hidden="true">
      <div className="h-8 w-16 animate-pulse rounded bg-bg" />
      <div className="h-[34px] w-full animate-pulse rounded bg-bg" />
      <div className="h-3 w-24 animate-pulse rounded bg-bg" />
    </div>
  );
}

/** A small rise/fall pill for the trend since the last poll (percentage points). */
function DeltaPill({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) return null;
  const Icon = delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-bg px-1.5 py-0.5 font-mono text-[11px] font-semibold text-text-secondary tabular-nums">
      <Icon className="size-3" strokeWidth={2} aria-hidden="true" />
      {Math.abs(delta)}
    </span>
  );
}

/* --------------------------- Running solvers ----------------------------- */

function RunningSolversPanel({
  runs,
  queued,
  pending,
  onStop,
  stopPending,
}: {
  runs: DashboardRun[];
  queued: number;
  pending: boolean;
  onStop: (run: DashboardRun) => void;
  stopPending: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5">
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-primary-tint text-primary">
            <Loader2 className="size-4" strokeWidth={1.9} aria-hidden="true" />
          </span>
          <h2 className="text-sm font-semibold text-text">Running solvers</h2>
          {runs.length > 0 && (
            <span className="rounded-full bg-primary-tint px-2 py-0.5 font-mono text-xs font-semibold text-primary tabular-nums">
              {runs.length} live
            </span>
          )}
        </div>
      </header>

      {pending ? (
        <ul className="flex flex-col gap-2" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <li key={index} className="h-14 animate-pulse rounded-md bg-bg" />
          ))}
        </ul>
      ) : runs.length > 0 ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            <span>Solver</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-auto overscroll-contain">
            {runs.map((run) => (
              <RunRow key={run.runId} run={run} onStop={() => onStop(run)} stopPending={stopPending} />
            ))}
          </ul>
        </>
      ) : (
        <PanelEmpty
          icon={<Cpu className="size-5 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
          title="No solver running"
          body="Start a run from a project's Solver tab and it appears here live."
        />
      )}

      <footer className="mt-auto flex items-center justify-between gap-2 pt-3">
        <span className="text-xs text-text-secondary">
          {queued > 0 ? (
            <>
              Queued: <span className="font-mono text-text">{queued}</span> waiting for cores
            </>
          ) : (
            'No runs queued'
          )}
        </span>
      </footer>
    </section>
  );
}

function RunRow({
  run,
  onStop,
  stopPending,
}: {
  run: DashboardRun;
  onStop: () => void;
  stopPending: boolean;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: RUN_STATUS_COLOR[run.status] }}
            aria-hidden="true"
          />
          <Link
            to={`/projects/${run.projectId}`}
            className="truncate rounded-sm text-sm font-medium text-text transition-colors duration-fast hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
          >
            {run.projectTitle}
          </Link>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-4">
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[11px] font-semibold capitalize',
              RUN_STATUS_PILL[run.status],
            )}
          >
            {run.status}
          </span>
          <span className="font-mono text-xs text-text-secondary" translate="no">
            {run.solver}
          </span>
          {run.startedAt && (
            <span className="text-xs text-text-secondary tabular-nums">· {elapsed(run.startedAt)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Link
          to={`/projects/${run.projectId}`}
          aria-label={`View ${run.projectTitle}`}
          className="grid size-8 place-items-center rounded-md border border-border bg-surface text-text-secondary transition-colors duration-fast hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
        >
          <Eye className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={onStop}
          disabled={stopPending}
          aria-label={`Stop ${run.projectTitle}`}
          className="grid size-8 place-items-center rounded-md border border-accent-tint bg-accent-tint text-accent-hover transition-colors duration-fast hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 disabled:opacity-50"
        >
          <Square className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/* ----------------------------- Run outcomes ------------------------------ */

function RunOutcomesPanel({
  total,
  converged,
  diverged,
  other,
  successRate,
  distribution,
}: {
  total: number;
  converged: number;
  diverged: number;
  other: number;
  successRate: number;
  distribution: { value: number; color: string }[];
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Run outcomes</h2>
        <span className="text-xs text-text-secondary">last {total} runs</span>
      </header>

      {total === 0 ? (
        <PanelEmpty
          icon={<Diamond size={18} className="text-primary" />}
          title="No runs yet"
          body="Outcomes appear here once you run a solver."
        />
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <Donut segments={distribution} />
            <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
              <LegendRow color={TONE.success} label="Converged" value={converged} />
              <LegendRow color={TONE.accent} label="Diverged / failed" value={diverged} />
              <LegendRow color={TONE.neutral} label="Stopped / other" value={other} />
            </ul>
          </div>
          <div className="mt-auto pt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Distribution
            </div>
            <DistributionBar segments={distribution} label="Run outcome distribution" />
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm text-text-secondary">Success rate</span>
              <span className="font-mono text-base font-semibold text-success tabular-nums">
                {successRate}%
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden="true" />
      <span className="flex-1 truncate text-sm text-text-secondary">{label}</span>
      <span className="font-mono text-sm font-semibold text-text tabular-nums">{value}</span>
    </li>
  );
}

/* --------------------------- Recent projects ----------------------------- */

function RecentProjectsPanel({ projects, pending }: { projects: DashboardProject[]; pending: boolean }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-sm sm:p-5">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-bg text-text-secondary">
            <FolderOpen className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <h2 className="text-sm font-semibold text-text">Recent projects</h2>
        </div>
        <Link
          to="/projects"
          className="rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
        >
          All projects
        </Link>
      </header>

      {pending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-[92px] animate-pulse rounded-md bg-bg" />
          ))}
        </div>
      ) : projects.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <PanelEmpty
          icon={<Diamond size={18} className="text-primary" />}
          title="No projects yet"
          body="Create a project to import a mesh, set up a solver, and run it."
        />
      )}
    </section>
  );
}

function ProjectCard({ project }: { project: DashboardProject }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group flex flex-col gap-2.5 rounded-md border border-border bg-bg/40 p-3.5 transition-colors duration-fast ease-out hover:border-primary/40 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-text">{project.title}</span>
        <ArrowRight
          className="size-4 shrink-0 text-text-secondary transition-transform duration-fast ease-out group-hover:translate-x-0.5"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <span className="text-xs text-text-secondary">
        <span className="font-mono tabular-nums">{project.runCount}</span> runs ·{' '}
        {relativeTime(project.createdAt)}
      </span>
      <DistributionBar
        className="h-1.5"
        segments={[
          { value: project.converged, color: TONE.success },
          { value: project.diverged, color: TONE.accent },
          { value: project.other, color: TONE.neutral },
        ]}
      />
    </Link>
  );
}

/* ------------------------------- shared ---------------------------------- */

function PanelEmpty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <span className="grid size-10 place-items-center rounded-md bg-primary-tint">{icon}</span>
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="max-w-xs text-xs text-text-secondary">{body}</p>
    </div>
  );
}

/* ------------------------------ helpers ---------------------------------- */

/** The change between the last two samples (percentage points), or null. */
function lastDelta(history: number[]): number | null {
  if (history.length < 2) return null;
  return history[history.length - 1] - history[history.length - 2];
}

/** Bytes to a compact GB/MB string. */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Elapsed wall-clock since an ISO start, as mm:ss (or h:mm:ss past an hour). */
function elapsed(startedAtIso: string): string {
  const total = Math.max(0, Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A short relative time like "just now", "5m ago", "3h ago", "2d ago". */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
