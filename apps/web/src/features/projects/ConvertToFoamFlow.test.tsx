import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CgnsFile, ConversionResult, Template } from '@/lib/api/types';

/**
 * ConvertToFoamFlow tests.
 *
 * The conversion + templates APIs are mocked so the real component logic runs:
 * the sources step keeps "Continue" locked until a CGNS file exists, and the
 * full flow (sources -> pick template -> confirm -> run) renders the per-step
 * report. useAuth is mocked to avoid needing the auth provider.
 */

vi.mock('@/lib/api/conversion', () => ({
  listCgns: vi.fn(),
  uploadCgns: vi.fn(),
  deleteCgns: vi.fn(),
  convertCgnsToFoam: vi.fn(),
}));

vi.mock('@/lib/api/templates', () => ({
  listTemplates: vi.fn(),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'mara@dive-turbinen.de' } }),
}));

import * as conversionApi from '@/lib/api/conversion';
import * as templatesApi from '@/lib/api/templates';
import { ConvertToFoamFlow } from './ConvertToFoamFlow';

const template: Template = {
  id: 't1',
  name: 'Steady RANS',
  description: null,
  owner: { id: 'u1', fullName: 'Mara Henning', email: 'mara@dive-turbinen.de' },
  createdAt: '2026-06-20T08:00:00.000Z',
  updatedAt: '2026-06-20T08:00:00.000Z',
};

const cgnsFile: CgnsFile = { name: 'rotor.cgns', size: 1310720 };

const successResult: ConversionResult = {
  success: true,
  steps: [
    { id: 'cgnsToVtk', label: 'Convert CGNS to VTK', command: 'python3 CgnsToVtk.py rotor.cgns rotor.vtk', status: 'success', exitCode: 0, stdout: 'OK: VTK written', stderr: '', durationMs: 1200 },
    { id: 'vtkToFoam', label: 'Build polyMesh', command: 'vtkUnstructuredToFoam -case . rotor.vtk', status: 'success', exitCode: 0, stdout: 'Foam mesh written', stderr: '', durationMs: 800 },
    { id: 'checkMesh', label: 'Check mesh', command: 'checkMesh -case .', status: 'success', exitCode: 0, stdout: 'Mesh OK.', stderr: '', durationMs: 500 },
  ],
  notes: ['Applied template "Steady RANS": 3 file(s) added'],
  verification: { hasMesh: true, missingMesh: [], presentBase: [], missingBase: [], complete: true, canScaffold: false },
  entries: [{ path: 'constant/polyMesh/points', type: 'file', size: 10 }],
};

function renderFlow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter>
          <ConvertToFoamFlow projectId="p1" onClose={() => {}} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(templatesApi.listTemplates).mockResolvedValue([template]);
  vi.mocked(conversionApi.convertCgnsToFoam).mockResolvedValue(successResult);
});

describe('ConvertToFoamFlow', () => {
  it('keeps "Continue" locked until a CGNS file exists', async () => {
    vi.mocked(conversionApi.listCgns).mockResolvedValue([]);
    renderFlow();

    // The sources step renders with its upload action, but Continue stays locked.
    expect(await screen.findByRole('button', { name: /add cgns file/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('lists an uploaded CGNS file and unlocks the flow', async () => {
    vi.mocked(conversionApi.listCgns).mockResolvedValue([cgnsFile]);
    renderFlow();

    expect(await screen.findByText('rotor.cgns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('runs the sources -> pick -> confirm -> report flow and shows the checkMesh result', async () => {
    vi.mocked(conversionApi.listCgns).mockResolvedValue([cgnsFile]);
    renderFlow();

    // Step 0: sources. Wait for the roster to load (so Continue is enabled), then go.
    expect(await screen.findByText('rotor.cgns')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 1: pick a template.
    expect(await screen.findByText('Choose a template')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Steady RANS/i }));

    // Step 2: confirm.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Convert to OpenFOAM?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /convert to foam/i }));

    // Step 3: the report.
    expect(await screen.findByText('Conversion complete')).toBeInTheDocument();
    expect(conversionApi.convertCgnsToFoam).toHaveBeenCalledWith('p1', {
      cgnsFile: 'rotor.cgns',
      templateId: 't1',
    });
    // The checkMesh log is expanded by default, so its output is visible.
    await waitFor(() => expect(screen.getByText('Mesh OK.')).toBeInTheDocument());
  });
});
