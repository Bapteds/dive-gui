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
  syncBoundaries: vi.fn(),
  listRuns: vi.fn(),
  getRunLog: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  // The Easy solver-config form reads/writes the solver files.
  getCaseFileContent: vi.fn(),
  saveCaseFileContent: vi.fn(),
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
  scaffoldable: true,
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
  // Default case-file content for the Easy solver-config form (per-path values are
  // read by dictionary path; a missing path just renders an empty control).
  vi.mocked(api.getCaseFileContent).mockResolvedValue({
    path: 'system/controlDict',
    content: 'FoamFile { object controlDict; }\napplication simpleFoam;\nendTime 1000;\nwriteInterval 100;\n',
    size: 20,
  });
  vi.mocked(api.saveCaseFileContent).mockResolvedValue(undefined);
});

describe('SolverTab', () => {
  it('walks the setup wizard (solver -> turbulence -> generate) and scaffolds + syncs', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue({
      hasMesh: true,
      missingMesh: [],
      missingFiles: ['constant/transportProperties', '0/k'],
      runnable: false,
      solver: null,
      scaffoldable: false,
    });
    vi.mocked(api.scaffoldSolver).mockResolvedValue({
      created: ['0/k'],
      runnable: runnableYes,
      entries: [],
    });
    vi.mocked(api.syncBoundaries).mockResolvedValue({ updated: ['0/U'], entries: [] });

    renderTab();

    // Step 1 (solver) opens; advance to step 2 (turbulence) and generate.
    expect(await screen.findByText(/set up the solver/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(await screen.findByRole('button', { name: /generate solver setup/i }));
    // Defaults: steady simpleFoam + kOmegaSST.
    await waitFor(() =>
      expect(api.scaffoldSolver).toHaveBeenCalledWith('p1', 'simpleFoam', 'kOmegaSST'),
    );
    // The "apply boundary" checkbox is on by default, so boundaries are synced too.
    await waitFor(() => expect(api.syncBoundaries).toHaveBeenCalledWith('p1'));
  });

  it('scaffolds the solver + turbulence model chosen across the two wizard steps', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue({
      hasMesh: true,
      missingMesh: [],
      missingFiles: ['0/k'],
      runnable: false,
      solver: null,
      scaffoldable: false,
    });
    vi.mocked(api.scaffoldSolver).mockResolvedValue({
      created: ['0/k'],
      runnable: runnableYes,
      entries: [],
    });
    vi.mocked(api.syncBoundaries).mockResolvedValue({ updated: [], entries: [] });

    renderTab();

    // Step 1: pick the transient incompressible (pimpleFoam) archetype, then Next.
    await userEvent.click(await screen.findByRole('radio', { name: /transient, incompressible/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    // Step 2: pick a specific turbulence model (unique matcher), then generate.
    await userEvent.click(await screen.findByRole('radio', { name: /realizable/i }));
    await userEvent.click(screen.getByRole('button', { name: /generate solver setup/i }));
    await waitFor(() =>
      expect(api.scaffoldSolver).toHaveBeenCalledWith('p1', 'pimpleFoam', 'realizableKE'),
    );
  });

  it('shows the run config + empty history and starts a run when runnable', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue(runnableYes);
    vi.mocked(api.listRuns).mockResolvedValue([]);
    vi.mocked(api.startRun).mockResolvedValue({ ...convergedRun, status: 'running', exitCode: null });

    renderTab();

    expect(await screen.findByRole('button', { name: /run solver/i })).toBeInTheDocument();
    // The Easy solver-config panel renders with the curated parameters.
    expect(await screen.findByText('Solver configuration')).toBeInTheDocument();
    expect(await screen.findByText('Turbulence model')).toBeInTheDocument();
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
