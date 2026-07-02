import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Cpu, FolderOpen, Loader2, MemoryStick, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProjectsQuery } from '@/features/projects/useProjects';
import type { DashboardRun } from '@/lib/api/types';
import { useDashboardQuery } from '@/features/dashboard/useDashboard';
import { RadialGauge, RunOutcomesDonut, Sparkline, StatTile } from '@/features/dashboard/DashboardCharts';

/**
 * HomePage - the workspace dashboard. Pinned to the viewport (AppShell) so it does
 * not scroll: a fixed grid of live server metrics (CPU / RAM), the running solvers,
 * the run-outcome donut, and the recent projects, each panel scrolling internally.
 * Server metrics + running solvers poll every few seconds (useDashboardQuery).
 */
export function HomePage() {
  const { user } = useAuth();
  const firstName = user?.fullName.trim().split(/\s+/)[0];

  const dashboard = useDashboardQuery();
  const projects = useProjectsQuery();
  const data = dashboard.data;

  // Keep a short client-side history of CPU samples for the sparkline.
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  useEffect(() => {
    if (data) setCpuHistory((history) => [...history, data.metrics.cpuPercent].slice(-40));
  }, [dashboard.dataUpdatedAt, data]);

  const memPercent = data
    ? Math.round((data.metrics.memUsedBytes / Math.max(1, data.metrics.memTotalBytes)) * 100)
    : 0;
  const totalRuns = useMemo(
    () => (data ? Object.values(data.runCounts).reduce((sum, count) => sum + count, 0) : 0),
    [data],
  );
  const recentProjects = (projects.data ?? []).slice(0, 6);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
          <p className="text-sm text-text-secondary">
            {firstName ? `Welcome back, ${firstName}.` : 'Welcome back.'} Live server and solver
            activity.
          </p>
        </div>
        {dashboard.isError && (
          <Button variant="secondary" size="sm" onClick={() => void dashboard.refetch()}>
            <RotateCcw strokeWidth={1.75} aria-hidden="true" />
            Retry metrics
          </Button>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-[auto_minmax(0,1fr)]">
        {/* CPU */}
        <Card title="Server CPU" icon={<Cpu className="size-4" strokeWidth={1.75} aria-hidden="true" />}>
          {data ? (
            <div className="flex flex-col items-center gap-2">
              <RadialGauge
                value={data.metrics.cpuPercent}
                caption={`${data.metrics.cores} cores${
                  data.metrics.loadAvg1 > 0 ? ` · load ${data.metrics.loadAvg1.toFixed(2)}` : ''
                }`}
              />
              <Sparkline values={cpuHistory} />
            </div>
          ) : (
            <GaugeSkeleton pending={dashboard.isPending} />
          )}
        </Card>

        {/* Memory */}
        <Card
          title="Server memory"
          icon={<MemoryStick className="size-4" strokeWidth={1.75} aria-hidden="true" />}
        >
          {data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <RadialGauge
                value={memPercent}
                caption={`${formatBytes(data.metrics.memUsedBytes)} / ${formatBytes(
                  data.metrics.memTotalBytes,
                )}`}
              />
            </div>
          ) : (
            <GaugeSkeleton pending={dashboard.isPending} />
          )}
        </Card>

        {/* Run outcomes donut */}
        <Card
          title="Run outcomes"
          icon={<Activity className="size-4" strokeWidth={1.75} aria-hidden="true" />}
        >
          {data ? (
            <div className="flex h-full items-center">
              <RunOutcomesDonut counts={data.runCounts} />
            </div>
          ) : (
            <GaugeSkeleton pending={dashboard.isPending} />
          )}
        </Card>

        {/* At a glance */}
        <Card title="At a glance">
          <div className="grid h-full grid-cols-2 gap-2">
            <StatTile
              label="Running"
              value={data ? String(data.activeRuns.length) : '-'}
              hint="solvers"
            />
            <StatTile label="Total runs" value={data ? String(totalRuns) : '-'} />
            <StatTile
              label="Projects"
              value={projects.data ? String(projects.data.length) : '-'}
            />
            <StatTile
              label="Uptime"
              value={data ? formatUptime(data.metrics.uptimeSec) : '-'}
              hint="server"
            />
          </div>
        </Card>

        {/* Running solvers */}
        <Card
          title="Running solvers"
          icon={<Loader2 className="size-4 text-primary" strokeWidth={1.75} aria-hidden="true" />}
          badge={data && data.activeRuns.length > 0 ? String(data.activeRuns.length) : undefined}
          className="min-h-0 lg:col-span-2 lg:row-start-2"
          bodyClassName="min-h-0 flex-1 overflow-auto overscroll-contain"
        >
          {data && data.activeRuns.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {data.activeRuns.map((run) => (
                <RunRow key={run.runId} run={run} live />
              ))}
            </ul>
          ) : (
            <PanelEmpty
              icon={<Cpu className="size-5 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
              title="No solver running"
              body="Start a run from a project's Solver tab and it appears here live."
            />
          )}
        </Card>

        {/* Recent projects */}
        <Card
          title="Recent projects"
          icon={<FolderOpen className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          action={
            <Link
              to="/projects"
              className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
            >
              All projects
            </Link>
          }
          className="min-h-0 lg:col-span-2 lg:row-start-2"
          bodyClassName="min-h-0 flex-1 overflow-auto overscroll-contain"
        >
          {projects.isPending ? (
            <ul className="flex flex-col gap-2" aria-hidden="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <li key={index} className="h-12 animate-pulse rounded-md bg-bg" />
              ))}
            </ul>
          ) : recentProjects.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {recentProjects.map((project) => (
                <li key={project.id}>
                  <Link
                    to={`/projects/${project.id}`}
                    className="group flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 transition-colors duration-fast ease-out hover:border-border-strong hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-text">{project.title}</span>
                      <span className="text-xs text-text-secondary">
                        Created {relativeTime(project.createdAt)}
                      </span>
                    </span>
                    <ArrowRight
                      className="size-4 shrink-0 text-text-secondary transition-transform duration-fast ease-out group-hover:translate-x-0.5"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <PanelEmpty
              icon={<Diamond size={18} className="text-primary" />}
              title="No projects yet"
              body="Create a project to import a mesh, set up a solver, and run it."
            />
          )}
        </Card>
      </div>
    </div>
  );
}

/** A dashboard card: header (icon + title + optional badge/action) and a body. */
function Card({
  title,
  icon,
  badge,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon?: React.ReactNode;
  badge?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn('flex flex-col rounded-md border border-border bg-surface p-4 shadow-sm', className)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-text-secondary">
          {icon}
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {badge && (
            <span className="rounded-sm bg-primary-tint px-1.5 py-0.5 text-xs font-medium text-primary tabular-nums">
              {badge}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className={cn('flex flex-1 items-center justify-center', bodyClassName)}>{children}</div>
    </section>
  );
}

/** One run row (running solvers list): project, solver, elapsed, link to the project. */
function RunRow({ run, live }: { run: DashboardRun; live?: boolean }) {
  return (
    <li>
      <Link
        to={`/projects/${run.projectId}`}
        className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 transition-colors duration-fast ease-out hover:border-border-strong hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {live && (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-text">{run.projectTitle}</span>
            <span className="font-mono text-xs text-text-secondary" translate="no">
              {run.solver}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          {run.startedAt ? elapsed(run.startedAt) : run.status}
        </span>
      </Link>
    </li>
  );
}

/** A centered empty state inside a panel. */
function PanelEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="grid size-10 place-items-center rounded-md bg-primary-tint">{icon}</span>
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="max-w-xs text-xs text-text-secondary">{body}</p>
    </div>
  );
}

/** A pulsing circle placeholder while a gauge loads (or a dash if metrics failed). */
function GaugeSkeleton({ pending }: { pending: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      {pending ? (
        <div className="size-28 animate-pulse rounded-full bg-bg" />
      ) : (
        <span className="text-sm text-text-secondary">Unavailable</span>
      )}
    </div>
  );
}

// ---- formatting helpers ----

/** Bytes to a compact GB/MB string. */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Seconds to a compact uptime like "3d 4h", "4h 12m", or "12m". */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Elapsed wall-clock since an ISO start, as mm:ss (or h:mm:ss past an hour). */
function elapsed(startedAtIso: string): string {
  const ms = Date.now() - new Date(startedAtIso).getTime();
  const total = Math.max(0, Math.floor(ms / 1000));
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
