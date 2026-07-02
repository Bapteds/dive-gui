import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardData, Project } from '@/lib/api/types';

/**
 * HomePage dashboard tests. The dashboard + projects APIs are mocked, so the real
 * layout logic runs: gauges + running-solver rows with data, and the empty states
 * when there is nothing to show.
 */

vi.mock('@/lib/api/dashboard', () => ({ getDashboard: vi.fn() }));
vi.mock('@/lib/api/projects', () => ({ listProjects: vi.fn() }));
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { fullName: 'Ada Lovelace' } }),
}));

import * as dashboardApi from '@/lib/api/dashboard';
import * as projectsApi from '@/lib/api/projects';
import { HomePage } from './HomePage';

const metrics = {
  cpuPercent: 42,
  cores: 8,
  memUsedBytes: 6 * 1024 ** 3,
  memTotalBytes: 16 * 1024 ** 3,
  loadAvg1: 1.2,
  uptimeSec: 3 * 86400 + 4 * 3600,
};

const zeroCounts = {
  queued: 0,
  running: 0,
  converged: 0,
  completed: 0,
  diverged: 0,
  failed: 0,
  stopped: 0,
};

function project(id: string, title: string): Project {
  return {
    id,
    title,
    owner: { id: 'u1', fullName: 'Ada Lovelace', email: 'ada@x.test' },
    collaborators: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomePage dashboard', () => {
  it('renders live metrics, a running solver, and recent projects', async () => {
    const data: DashboardData = {
      metrics,
      activeRuns: [
        {
          runId: 'r1',
          projectId: 'p1',
          projectTitle: 'Turbine case',
          solver: 'simpleFoam',
          status: 'running',
          startedAt: new Date(Date.now() - 65_000).toISOString(),
          finishedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      recentRuns: [],
      runCounts: { ...zeroCounts, running: 1, converged: 2, failed: 1 },
    };
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(data);
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project('p1', 'Turbine case')]);

    renderHome();

    expect(await screen.findByText(/Welcome back, Ada/i)).toBeInTheDocument();
    // CPU gauge value + memory + running solver + recent project.
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(await screen.findByText('simpleFoam')).toBeInTheDocument();
    expect(screen.getAllByText('Turbine case').length).toBeGreaterThan(0);
    // The run-outcome donut totals the counts (2 + 1 + 1 = 4).
    expect(screen.getByRole('img', { name: /4 solver runs/i })).toBeInTheDocument();
  });

  it('shows empty states when there are no runs or projects', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue({
      metrics,
      activeRuns: [],
      recentRuns: [],
      runCounts: zeroCounts,
    });
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);

    renderHome();

    expect(await screen.findByText(/no solver running/i)).toBeInTheDocument();
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });
});
