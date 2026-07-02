// Dashboard aggregate: live server metrics + the viewer's solver runs.
//
// One cheap call the Home page polls: the machine's CPU/RAM (via node:os), the
// runs currently executing across every project the viewer can see, a short
// recent-runs list, and per-status counts (for the outcome donut). All run data
// is visibility-scoped exactly like listProjects (owner / collaborator / super-admin).
import os from 'node:os';
import type { Prisma } from '@prisma/client';
import { ACTIVE_RUN_STATUSES, RUN_STATUSES, type RunStatus } from '@dive/shared';
import { prisma } from '../../lib/prisma';
import type { Viewer } from '../projects/projects.service';

/** Live metrics of the machine running the API. */
export interface ServerMetrics {
  /** Whole-machine CPU usage, 0-100 (sampled over a short window). */
  cpuPercent: number;
  /** Number of logical CPU cores. */
  cores: number;
  /** Used physical memory in bytes (total minus free). */
  memUsedBytes: number;
  /** Total physical memory in bytes. */
  memTotalBytes: number;
  /** 1-minute load average (0 on platforms without it, e.g. Windows). */
  loadAvg1: number;
  /** Machine uptime in seconds. */
  uptimeSec: number;
}

/** A run surfaced on the dashboard, with its project's title. */
export interface DashboardRun {
  runId: string;
  projectId: string;
  projectTitle: string;
  solver: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** The dashboard payload the Home page renders. */
export interface DashboardData {
  metrics: ServerMetrics;
  /** Runs currently queued or running, newest first. */
  activeRuns: DashboardRun[];
  /** The most recent runs (any status), newest first. */
  recentRuns: DashboardRun[];
  /** Count of runs per terminal/active status, across visible projects. */
  runCounts: Record<RunStatus, number>;
}

/** Sum idle + total CPU ticks across all cores. */
function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/** Instantaneous whole-machine CPU usage, sampled over ~150ms (stateless). */
async function sampleCpuPercent(): Promise<number> {
  const before = cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = cpuSnapshot();
  const idle = after.idle - before.idle;
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100)));
}

/** Static (non-CPU) machine metrics. */
function readStaticMetrics(): Omit<ServerMetrics, 'cpuPercent'> {
  const memTotalBytes = os.totalmem();
  return {
    cores: os.cpus().length,
    memUsedBytes: memTotalBytes - os.freemem(),
    memTotalBytes,
    loadAvg1: os.loadavg()[0] ?? 0,
    uptimeSec: Math.round(os.uptime()),
  };
}

/** The project-visibility filter, applied to a run via its `project` relation. */
function projectVisibilityWhere(viewer: Viewer): Prisma.ProjectWhereInput {
  return viewer.role === 'SUPER_ADMIN'
    ? {}
    : { OR: [{ ownerId: viewer.id }, { collaborators: { some: { id: viewer.id } } }] };
}

const RUN_INCLUDE = { project: { select: { title: true } } } satisfies Prisma.RunInclude;
type RunWithProject = Prisma.RunGetPayload<{ include: typeof RUN_INCLUDE }>;

function toDashboardRun(run: RunWithProject): DashboardRun {
  return {
    runId: run.id,
    projectId: run.projectId,
    projectTitle: run.project.title,
    solver: run.solver,
    status: run.status as RunStatus,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
  };
}

/** Build the dashboard payload for `viewer`. */
export async function getDashboard(viewer: Viewer): Promise<DashboardData> {
  const project = projectVisibilityWhere(viewer);

  const [cpuPercent, activeRuns, recentRuns, grouped] = await Promise.all([
    sampleCpuPercent(),
    prisma.run.findMany({
      where: { status: { in: [...ACTIVE_RUN_STATUSES] }, project },
      include: RUN_INCLUDE,
      orderBy: { startedAt: 'desc' },
      take: 12,
    }),
    prisma.run.findMany({
      where: { project },
      include: RUN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.run.groupBy({ by: ['status'], where: { project }, _count: true }),
  ]);

  const runCounts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
    RunStatus,
    number
  >;
  for (const row of grouped) {
    if ((RUN_STATUSES as readonly string[]).includes(row.status)) {
      runCounts[row.status as RunStatus] = row._count;
    }
  }

  return {
    metrics: { cpuPercent, ...readStaticMetrics() },
    activeRuns: activeRuns.map(toDashboardRun),
    recentRuns: recentRuns.map(toDashboardRun),
    runCounts,
  };
}
