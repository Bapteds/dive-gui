import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FREE_SURFACE_DEFAULTS, type FreeSurfaceJob, type FreeSurfaceOverview } from '@dive/shared';

/**
 * FreeSurfaceTab tests (WS-I spec §10). The API module is mocked: the tab's own
 * logic runs (readiness list, Start gating, iterations control, progress
 * stepper, results table + chart table alternative). No real polling/network.
 */

vi.mock('@/lib/api/projects', () => ({
  getFreeSurface: vi.fn(),
  startFreeSurface: vi.fn(),
  getFreeSurfaceJob: vi.fn(),
  stopFreeSurfaceJob: vi.fn(),
  deleteFreeSurfaceJob: vi.fn(),
  downloadFreeSurfaceFile: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/projects';
import { FreeSurfaceTab } from './FreeSurfaceTab';

function overview(
  partial: Partial<FreeSurfaceOverview['checks']> = {},
  jobs: FreeSurfaceJob[] = [],
): FreeSurfaceOverview {
  return {
    checks: {
      items: [
        { id: 'lidPatch', status: 'ok', message: 'Lid patch atmosphere is flat at z = 1.000 m.' },
        {
          id: 'lidBc',
          status: 'warning',
          message: 'The lid is not slip (U: noSlip). The kit assumes a slip rigid lid.',
        },
        { id: 'inletPatch', status: 'ok', message: 'Inlet patch inlet.' },
        { id: 'parentRun', status: 'ok', message: 'Parent run converged.' },
        { id: 'sourceSession', status: 'ok', message: 'Source session Chamber mesh (cfMesh).' },
        { id: 'solver', status: 'ok', message: 'simpleFoam (steady, incompressible).' },
      ],
      ready: true,
      patches: [
        { name: 'inlet', type: 'patch', nFaces: 10, flat: false, z: 0.5 },
        { name: 'atmosphere', type: 'patch', nFaces: 40, flat: true, z: 1 },
        { name: 'walls', type: 'wall', nFaces: 90, flat: false, z: 0.4 },
      ],
      lidPatch: 'atmosphere',
      inletPatch: 'inlet',
      sourceSessionId: 'chamber-mesh',
      sessions: [{ id: 'chamber-mesh', name: 'Chamber mesh', engine: 'cfmesh' }],
      zLid: 1,
      solver: 'simpleFoam',
      parentRun: { id: 'r0', status: 'converged', cores: 4 },
      ...partial,
    },
    defaults: FREE_SURFACE_DEFAULTS,
    origin: {
      sessionId: 'chamber-mesh',
      sessionName: 'Chamber mesh',
      engine: 'cfmesh',
      chamberHash: null,
      at: '2026-09-30T10:00:00.000Z',
    },
    jobs,
  };
}

function job(partial: Partial<FreeSurfaceJob>): FreeSurfaceJob {
  return {
    id: 'fs-1',
    status: 'running',
    stage: 'solving',
    iteration: 1,
    settings: {
      ...FREE_SURFACE_DEFAULTS,
      lidPatch: 'atmosphere',
      inletPatch: 'inlet',
      sourceSessionId: 'chamber-mesh',
    },
    zLid: 1,
    parentRunId: 'r0',
    cores: 4,
    surfaces: [
      {
        index: 0,
        zsMeanMm: -20,
        zsMinMm: -35,
        zsMaxMm: -2,
        residualRmsMm: 30,
        residualMaxMm: 60,
        lidFaces: 40,
        dp0Pa: null,
      },
    ],
    iterations: [
      {
        index: 1,
        sessionId: 'chamber-mesh-lid1',
        sessionName: 'Chamber mesh-lid1',
        runId: 'r1',
        fit: null,
        meshCells: null,
        files: [],
      },
    ],
    notes: [],
    reason: null,
    failedStage: null,
    stopRequested: false,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:05:00.000Z',
    finishedAt: null,
    ...partial,
  };
}

function renderTab(onOpenSolver = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FreeSurfaceTab projectId="p1" onOpenSolver={onOpenSolver} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FreeSurfaceTab', () => {
  it('renders the readiness checks and the measured Z_lid', async () => {
    vi.mocked(api.getFreeSurface).mockResolvedValue(overview());
    renderTab();
    expect(await screen.findByText(/The lid is not slip/)).toBeInTheDocument();
    expect(screen.getByText('Parent run converged.')).toBeInTheDocument();
    expect(screen.getByText(/1\.000 m/, { selector: '[data-testid="z-lid"]' })).toBeInTheDocument();
    // Only flat patches are offered as the lid.
    const lidSelect = screen.getByLabelText('Lid patch') as HTMLSelectElement;
    expect(Array.from(lidSelect.options).map((o) => o.value)).toEqual(['atmosphere']);
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('disables Start when the mesh has no flat top patch', async () => {
    const message =
      'This mesh has no flat top patch. The free surface needs a rigid-lid run whose top is its own patch (e.g. `atmosphere`); meshes whose top is part of `walls` cannot use this tool.';
    vi.mocked(api.getFreeSurface).mockResolvedValue(
      overview({
        items: [{ id: 'lidPatch', status: 'blocking', message }],
        ready: false,
        patches: [{ name: 'walls', type: 'wall', nFaces: 90, flat: false, z: 0.4 }],
        lidPatch: null,
      }),
    );
    renderTab();
    expect(await screen.findByText(/This mesh has no flat top patch/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('starts with the chosen iteration count', async () => {
    vi.mocked(api.getFreeSurface).mockResolvedValue(overview());
    vi.mocked(api.startFreeSurface).mockResolvedValue(job({}));
    renderTab();
    const group = await screen.findByRole('radiogroup', { name: 'Iterations' });
    expect(within(group).getByRole('radio', { name: '1' })).toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: '2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startFreeSurface).toHaveBeenCalled());
    expect(vi.mocked(api.startFreeSurface).mock.calls[0][1]).toMatchObject({
      lidPatch: 'atmosphere',
      inletPatch: 'inlet',
      sourceSessionId: 'chamber-mesh',
      iterations: 2,
      tolRmsMm: 3,
    });
  });

  it('shows the progress of a running job and stops it', async () => {
    const running = job({});
    vi.mocked(api.getFreeSurface).mockResolvedValue(overview({}, [running]));
    vi.mocked(api.getFreeSurfaceJob).mockResolvedValue(running);
    vi.mocked(api.stopFreeSurfaceJob).mockResolvedValue({ ...running, stopRequested: true });
    const onOpenSolver = vi.fn();
    renderTab(onOpenSolver);
    const progress = await screen.findByRole('region', { name: 'Progress' });
    expect(within(progress).getByText('Iteration 1 of 1')).toBeInTheDocument();
    const current = within(progress).getByText('Solve');
    expect(current.closest('[aria-current="step"]')).not.toBeNull();
    // Start is replaced while a job runs.
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    await userEvent.click(within(progress).getByRole('button', { name: 'Open the Solver tab' }));
    expect(onOpenSolver).toHaveBeenCalled();
    await userEvent.click(within(progress).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stopFreeSurfaceJob).toHaveBeenCalledWith('p1', 'fs-1'));
  });

  it('renders the results table and the residual chart table', async () => {
    const done = job({
      status: 'completed',
      stage: null,
      reason: 'Iterations done: the lid residual RMS is 5.0 mm (tolerance 3.0 mm).',
      finishedAt: '2026-09-30T11:00:00.000Z',
      surfaces: [
        {
          index: 0,
          zsMeanMm: -20,
          zsMinMm: -35,
          zsMaxMm: -2,
          residualRmsMm: 30,
          residualMaxMm: 60,
          lidFaces: 40,
          dp0Pa: null,
        },
        {
          index: 1,
          zsMeanMm: -21,
          zsMinMm: -36,
          zsMaxMm: -3,
          residualRmsMm: 5,
          residualMaxMm: 9,
          lidFaces: 44,
          dp0Pa: 2842,
        },
      ],
      iterations: [
        {
          index: 1,
          sessionId: 'chamber-mesh-lid1',
          sessionName: 'Chamber mesh-lid1',
          runId: 'r1',
          fit: {
            lidFaces: 120,
            lidZMinMm: -35,
            lidZMaxMm: -2,
            clampedLidPoints: 3,
            upstandFacets: 4,
            cutSolids: 0,
            openEdges: 0,
            baseOpenEdges: 0,
          },
          meshCells: 48213,
          files: ['domain_lidIter1.stl'],
        },
      ],
    });
    vi.mocked(api.getFreeSurface).mockResolvedValue(overview({}, [done]));
    vi.mocked(api.getFreeSurfaceJob).mockResolvedValue(done);
    renderTab();
    const table = await screen.findByRole('table', { name: 'Results per iteration' });
    const rows = within(table).getAllByRole('row');
    // Header + parent + iteration 1.
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('Parent')).toBeInTheDocument();
    expect(within(rows[1]).getByText('30.0')).toBeInTheDocument();
    expect(within(rows[2]).getByText('5.0')).toBeInTheDocument();
    expect(within(rows[2]).getByText('48,213')).toBeInTheDocument();
    expect(within(rows[2]).getByText('2842')).toBeInTheDocument();
    expect(screen.getByText(/the lid residual RMS is 5\.0 mm/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download fitted STL/ })).toBeInTheDocument();
    // The chart has a table alternative.
    expect(screen.getByText('Show residual values')).toBeInTheDocument();
  });
});
