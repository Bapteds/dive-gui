import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RunSummary, RunnableCheck } from '@/lib/api/types';

/**
 * SolverTab tests. The run API is mocked, so the real tab logic runs: the
 * not-runnable gate (offering to generate solver files), the runnable panel with
 * its single Run CTA + empty history, and a populated run with its live status
 * badge + residual chart. No real polling/network.
 */

vi.mock('@/lib/api/projects', () => ({
  getRunnable: vi.fn(),
  scaffoldSolver: vi.fn(),
  listRuns: vi.fn(),
  getRunLog: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/projects';
import { SolverTab } from './SolverTab';

const runnableYes: RunnableCheck = {
  hasMesh: true,
  missingMesh: [],
  missingFiles: [],
  runnable: true,
  solver: 'simpleFoam',
};

const convergedRun: RunSummary = {
  id: 'r1',
  solver: 'simpleFoam',
  status: 'converged',
  exitCode: 0,
  reason: null,
  startedAt: '2026-06-24T10:00:00.000Z',
  finishedAt: '2026-06-24T10:01:00.000Z',
  createdAt: '2026-06-24T10:00:00.000Z',
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SolverTab projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SolverTab', () => {
  it('shows the not-runnable gate, lists missing files, and triggers scaffold', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue({
      hasMesh: true,
      missingMesh: [],
      missingFiles: ['constant/transportProperties', '0/k'],
      runnable: false,
      solver: null,
    });
    vi.mocked(api.scaffoldSolver).mockResolvedValue({
      created: ['0/k'],
      runnable: runnableYes,
      entries: [],
    });

    renderTab();

    expect(await screen.findByText(/not ready to run/i)).toBeInTheDocument();
    expect(screen.getByText('constant/transportProperties')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /make runnable/i }));
    await waitFor(() => expect(api.scaffoldSolver).toHaveBeenCalledWith('p1'));
  });

  it('shows the run config + empty history and starts a run when runnable', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue(runnableYes);
    vi.mocked(api.listRuns).mockResolvedValue([]);
    vi.mocked(api.startRun).mockResolvedValue({ ...convergedRun, status: 'running', exitCode: null });

    renderTab();

    expect(await screen.findByRole('button', { name: /run solver/i })).toBeInTheDocument();
    // History resolves on its own query; wait for the empty state.
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /run solver/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith('p1', undefined));
  });

  it('renders the live status and the residual chart for an existing run', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue(runnableYes);
    vi.mocked(api.listRuns).mockResolvedValue([convergedRun]);
    vi.mocked(api.getRunLog).mockResolvedValue({
      run: convergedRun,
      series: [
        { time: 1, values: { Ux: 0.1, p: 0.2 } },
        { time: 2, values: { Ux: 0.01, p: 0.02 } },
      ],
      logTail: 'Time = 2\nSolving for Ux, Initial residual = 0.01\n',
      logBytes: 48,
    });

    renderTab();

    // The status appears as a badge (live header) and in history; assert present.
    expect(await screen.findAllByText(/converged/i)).not.toHaveLength(0);
    // The converged banner explains the outcome (renders once the run is known).
    expect(await screen.findByText(/met the convergence tolerance/i)).toBeInTheDocument();
    // The chart's screen-reader data table toggle appears once residuals load.
    expect(await screen.findByText(/show residual values/i)).toBeInTheDocument();
  });
});
