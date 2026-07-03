import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
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
  // The Easy solver-config form + step-3 file editor read/write the case files.
  getCaseFiles: vi.fn(),
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
  maxCores: 8,
};

const convergedRun: RunSummary = {
  id: 'r1',
  solver: 'simpleFoam',
  cores: 1,
  status: 'converged',
  exitCode: 0,
  reason: null,
  startedAt: '2026-06-24T10:00:00.000Z',
  finishedAt: '2026-06-24T10:01:00.000Z',
  createdAt: '2026-06-24T10:00:00.000Z',
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A data router so the step-3 file editor's useBlocker (unsaved-changes guard) works.
  const router = createMemoryRouter([{ path: '/', element: <SolverTab projectId="p1" /> }]);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCaseFiles).mockResolvedValue([]);
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
      maxCores: 8,
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
    await userEvent.click(await screen.findByRole('button', { name: /generate and continue/i }));
    // Defaults: steady simpleFoam + kOmegaSST.
    await waitFor(() =>
      expect(api.scaffoldSolver).toHaveBeenCalledWith('p1', 'simpleFoam', 'kOmegaSST'),
    );
    // The "apply boundary" checkbox is on by default, so boundaries are synced too.
    await waitFor(() => expect(api.syncBoundaries).toHaveBeenCalledWith('p1'));
    // Step 3: the case-file editor overlay opens.
    expect(await screen.findByText(/edit case files/i)).toBeInTheDocument();
  });

  it('scaffolds the solver + turbulence model chosen across the two wizard steps', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue({
      hasMesh: true,
      missingMesh: [],
      missingFiles: ['0/k'],
      runnable: false,
      solver: null,
      scaffoldable: false,
      maxCores: 8,
    });
    vi.mocked(api.scaffoldSolver).mockResolvedValue({
      created: ['0/k'],
      runnable: runnableYes,
      entries: [],
    });
    vi.mocked(api.syncBoundaries).mockResolvedValue({ updated: [], entries: [] });

    renderTab();

    // Step 1: open the solver overlay and pick pimpleFoam (URANS is unique to it).
    await userEvent.click(await screen.findByRole('button', { name: /browse all solvers/i }));
    await userEvent.click(await screen.findByRole('button', { name: /URANS/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    // Step 2: pick a specific turbulence model (unique matcher), then generate.
    await userEvent.click(await screen.findByRole('radio', { name: /realizable/i }));
    await userEvent.click(screen.getByRole('button', { name: /generate and continue/i }));
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
    // Default cores = 1 (serial); the client omits an explicit solver.
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith('p1', { cores: 1 }));
  });

  it('starts a parallel run with the chosen core count', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue(runnableYes); // maxCores: 8
    vi.mocked(api.listRuns).mockResolvedValue([]);
    vi.mocked(api.startRun).mockResolvedValue({ ...convergedRun, status: 'running', exitCode: null });

    renderTab();

    const cores = await screen.findByLabelText(/number of cores/i);
    fireEvent.change(cores, { target: { value: '4' } });
    await userEvent.click(screen.getByRole('button', { name: /run solver/i }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith('p1', { cores: 4 }));
  });

  it('applies a turbulence model through the scaffold from the config panel', async () => {
    vi.mocked(api.getRunnable).mockResolvedValue(runnableYes);
    vi.mocked(api.listRuns).mockResolvedValue([]);
    vi.mocked(api.scaffoldSolver).mockResolvedValue({
      created: [],
      runnable: runnableYes,
      entries: [],
    });

    renderTab();

    // The turbulence control is a select of all models; changing it re-scaffolds
    // (writes the RAS/LES/laminar block + the 0/ fields), not a raw RASModel splice.
    const select = await screen.findByLabelText('Turbulence model');
    await userEvent.selectOptions(select, 'kEpsilon');
    await waitFor(() =>
      expect(api.scaffoldSolver).toHaveBeenCalledWith('p1', 'simpleFoam', 'kEpsilon'),
    );
    expect(api.saveCaseFileContent).not.toHaveBeenCalled();
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
