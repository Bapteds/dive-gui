import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ApplyBoundaryConditionsResult } from '@dive/shared';
import type { MeshManifest } from '@/lib/api/types';

/**
 * BoundaryConditionDialog tests.
 *
 * The manifest query and the apply mutation are mocked so the real step logic
 * runs: a single-mode type (Turbine) skips the driving step, patches auto-fill
 * from their names, and Apply posts the assembled request. A multi-mode type
 * (Pipe) shows the driving step.
 */

vi.mock('@/lib/api/boundary', () => ({ applyBoundaryConditions: vi.fn() }));
vi.mock('@/lib/api/projects', () => ({ getMeshManifest: vi.fn() }));

import * as boundaryApi from '@/lib/api/boundary';
import * as projectsApi from '@/lib/api/projects';
import { BoundaryConditionDialog } from './BoundaryConditionDialog';

const manifest: MeshManifest = {
  patches: [
    { name: 'inlet', type: 'patch', nFaces: 10 },
    { name: 'outlet', type: 'patch', nFaces: 10 },
    { name: 'shroud', type: 'wall', nFaces: 40 },
  ],
  generatedAt: '2026-07-06T00:00:00.000Z',
};

const applied: ApplyBoundaryConditionsResult = {
  success: true,
  applied: {
    objectType: 'turbine',
    mode: 'pressure',
    inlet: 'inlet',
    outlet: 'outlet',
    walls: ['shroud'],
    fields: ['0/U', '0/p'],
    p0: 490.5,
  },
  notes: [],
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BoundaryConditionDialog projectId="p1" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.getMeshManifest).mockResolvedValue(manifest);
  vi.mocked(boundaryApi.applyBoundaryConditions).mockResolvedValue(applied);
});

describe('BoundaryConditionDialog', () => {
  it('applies a turbine pressure preset (type -> patches -> rotor -> values -> apply)', async () => {
    renderDialog();

    // Step 1: object type (turbine is first). It has a single mode, so Continue
    // skips the driving step straight to patches.
    const typeRadios = await screen.findAllByRole('radio');
    fireEvent.click(typeRadios[0]);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: assign patches. Wait for the manifest to load and auto-fill the
    // inlet / outlet from the names (Continue enables once both are set).
    expect(await screen.findByText('Assign the boundary patches')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3b (turbine only): the rotor. Default Frozen Rotor + cell zone "rotor"
    // + axis (0 0 1); a positive speed enables Continue. 600 rpm -> omega ~62.83.
    expect(await screen.findByText('Rotor model')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/rotational speed/i), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 4: the operating point. Enter the head, then apply.
    expect(await screen.findByText('Operating point')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/net head/i), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /apply boundary conditions/i }));

    await waitFor(() =>
      expect(boundaryApi.applyBoundaryConditions).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          objectType: 'turbine',
          mode: 'pressure',
          inlet: 'inlet',
          outlet: 'outlet',
          walls: ['shroud'],
          values: expect.objectContaining({ head: 50 }),
          rotor: expect.objectContaining({
            mode: 'frozenRotor',
            cellZone: 'rotor',
            axis: [0, 0, 1],
            origin: [0, 0, 0],
            nonRotatingPatches: [],
          }),
        }),
        null,
      ),
    );
    // omega is converted from rpm to rad/s: 600 * pi / 30 ~= 62.83.
    const [, request] = vi.mocked(boundaryApi.applyBoundaryConditions).mock.calls[0];
    expect(request.rotor?.omega).toBeCloseTo((600 * Math.PI) / 30, 3);
    expect(await screen.findByText('Boundary conditions applied')).toBeInTheDocument();
  });

  it('shows the driving-mode step for a pipe (two modes)', async () => {
    renderDialog();

    // Pipe is the second type; it has two modes, so the driving step appears.
    const typeRadios = await screen.findAllByRole('radio');
    fireEvent.click(typeRadios[1]);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('How is the flow driven?')).toBeInTheDocument();
    expect(screen.getByText('Pressure-driven')).toBeInTheDocument();
    expect(screen.getByText('Flow-rate-driven')).toBeInTheDocument();
  });
});
