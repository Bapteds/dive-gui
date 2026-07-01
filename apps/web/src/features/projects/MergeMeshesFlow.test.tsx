import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MergeRunResult, MeshSource } from '@/lib/api/types';

/**
 * MergeMeshesFlow tests.
 *
 * The meshes API is mocked so the real component logic runs: the sources step
 * keeps "Continue" locked until a mesh exists, the connections step blocks a
 * half-filled pair, and the full flow (sources -> connections -> confirm -> run)
 * sends the stitch plan and renders the per-step report.
 */

vi.mock('@/lib/api/meshes', () => ({
  listMeshes: vi.fn(),
  getMeshPatches: vi.fn(),
  importMeshFolder: vi.fn(),
  importMeshZip: vi.fn(),
  importMeshFile: vi.fn(),
  deleteMesh: vi.fn(),
  autoPatchMeshSource: vi.fn(),
  renameMeshSourcePatch: vi.fn(),
  runMerge: vi.fn(),
  getMergePlan: vi.fn(),
  saveMergePlan: vi.fn(),
}));

import * as meshesApi from '@/lib/api/meshes';
import { MergeMeshesFlow } from './MergeMeshesFlow';

const meshA: MeshSource = {
  id: 'm1',
  name: 'inlet-part',
  createdAt: '2026-06-30T08:00:00.000Z',
  patches: [
    { name: 'inlet', type: 'patch', nFaces: 10 },
    { name: 'ifaceA', type: 'patch', nFaces: 20 },
  ],
};
const meshB: MeshSource = {
  id: 'm2',
  name: 'outlet-part',
  createdAt: '2026-06-30T08:01:00.000Z',
  patches: [
    { name: 'ifaceB', type: 'patch', nFaces: 20 },
    { name: 'outlet', type: 'patch', nFaces: 10 },
  ],
};

const successResult: MergeRunResult = {
  success: true,
  steps: [
    { kind: 'prepare', label: 'Prepare inlet-part', command: '', status: 'success', exitCode: null, stdout: 'Patches prefixed with m1_', stderr: '', durationMs: 0 },
    { kind: 'prepare', label: 'Prepare outlet-part', command: '', status: 'success', exitCode: null, stdout: 'Patches prefixed with m2_', stderr: '', durationMs: 0 },
    { kind: 'mergeMeshes', label: 'Combine outlet-part', command: 'mergeMeshes /a /b -overwrite', status: 'success', exitCode: 0, stdout: 'Merged', stderr: '', durationMs: 50 },
    { kind: 'stitchMesh', label: 'Stitch m1_ifaceA ↔ m2_ifaceB', command: 'stitchMesh m1_ifaceA m2_ifaceB -overwrite -partial -case .', status: 'success', exitCode: 0, stdout: 'Stitched', stderr: '', durationMs: 40 },
    { kind: 'cleanup', label: 'Clean up empty patches', command: '', status: 'success', exitCode: null, stdout: 'Removed 2 empty patch(es).', stderr: '', durationMs: 0 },
    { kind: 'checkMesh', label: 'Check combined mesh', command: 'checkMesh -case .', status: 'success', exitCode: 0, stdout: 'Mesh OK.', stderr: '', durationMs: 30 },
  ],
  notes: ['Combined 2 meshes with mergeMeshes.', 'Stitched 1 interface(s).'],
  boundaryPatches: [
    { name: 'm1_inlet', type: 'patch', nFaces: 10 },
    { name: 'm2_outlet', type: 'patch', nFaces: 10 },
  ],
  entries: [{ path: 'constant/polyMesh/boundary', type: 'file', size: 10 }],
};

function renderFlow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MergeMeshesFlow projectId="p1" onClose={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(meshesApi.getMergePlan).mockResolvedValue(null);
  vi.mocked(meshesApi.runMerge).mockResolvedValue(successResult);
});

describe('MergeMeshesFlow', () => {
  it('keeps "Continue" locked until a mesh is imported', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([]);
    renderFlow();

    expect(await screen.findByRole('button', { name: /import folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('blocks Continue on a half-filled connection', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([meshA, meshB]);
    renderFlow();

    expect(await screen.findByText('inlet-part')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Couple the meshes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add an interface/i }));
    fireEvent.change(screen.getByLabelText('Mesh A'), { target: { value: 'm1' } });

    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(screen.getByText(/finish or remove the incomplete interface/i)).toBeInTheDocument();
  });

  it('runs sources -> connections -> confirm -> report with the stitch plan', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([meshA, meshB]);
    renderFlow();

    // Step 1: sources. Wait for the library, then advance.
    expect(await screen.findByText('inlet-part')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2: interfaces. Add one and fill both sides (coupling defaults to NCC).
    expect(await screen.findByText('Couple the meshes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add an interface/i }));
    fireEvent.change(screen.getByLabelText('Mesh A'), { target: { value: 'm1' } });
    fireEvent.change(screen.getAllByLabelText('Patch')[0], { target: { value: 'ifaceA' } });
    fireEvent.change(screen.getByLabelText('Mesh B'), { target: { value: 'm2' } });
    fireEvent.change(screen.getAllByLabelText('Patch')[1], { target: { value: 'ifaceB' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: confirm.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge into the case mesh?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /merge meshes/i }));

    // Step 4: the report.
    expect(await screen.findByText('Merge complete')).toBeInTheDocument();
    expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
      order: ['m1', 'm2'],
      interfaces: [
        { aMeshId: 'm1', aPatch: 'ifaceA', bMeshId: 'm2', bPatch: 'ifaceB', coupling: 'nonConformal' },
      ],
    });
    // The checkMesh log is expanded by default, so its output is visible.
    await waitFor(() => expect(screen.getByText('Mesh OK.')).toBeInTheDocument());
  });

  it('shows the conversion report when a .cgns/.msh import fails', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([]);
    vi.mocked(meshesApi.importMeshFile).mockResolvedValue({
      meshes: [],
      conversion: {
        success: false,
        steps: [
          {
            tool: 'python3',
            label: 'Convert CGNS to VTK',
            command: 'python3 CgnsToVtk.py rotor.cgns rotor.vtk',
            status: 'failed',
            exitCode: 1,
            stdout: '',
            stderr: 'KO: CGNS read failed',
            durationMs: 5,
          },
        ],
      },
    });
    renderFlow();

    await screen.findByRole('button', { name: /import \.cgns \/ \.msh/i });
    const input = document.querySelector('input[accept=".cgns,.msh"]') as HTMLInputElement;
    const file = new File(['cgns-bytes'], 'rotor.cgns', { type: 'application/octet-stream' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Mesh conversion failed')).toBeInTheDocument();
    // The failed step's log is expanded by default, so its stderr is visible.
    await waitFor(() => expect(screen.getByText('KO: CGNS read failed')).toBeInTheDocument());
    expect(meshesApi.importMeshFile).toHaveBeenCalledWith('p1', file, undefined);
  });

  it('sends the typed name with a .cgns/.msh import', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([]);
    vi.mocked(meshesApi.importMeshFile).mockResolvedValue({
      mesh: { id: 'rotor', name: 'rotor', createdAt: '2026-06-30T08:00:00.000Z', patches: [] },
      meshes: [],
    });
    renderFlow();

    await screen.findByRole('button', { name: /import \.cgns \/ \.msh/i });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rotor' } });
    const input = document.querySelector('input[accept=".cgns,.msh"]') as HTMLInputElement;
    const file = new File(['cgns-bytes'], 'wheel.cgns', { type: 'application/octet-stream' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(meshesApi.importMeshFile).toHaveBeenCalledWith('p1', file, 'rotor'));
  });

  it('splits and renames a library mesh patch from its row', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([meshA, meshB]);
    vi.mocked(meshesApi.autoPatchMeshSource).mockResolvedValue({
      result: { success: true, command: 'autoPatch 30 -overwrite', exitCode: 0, stdout: '', stderr: '', durationMs: 5 },
      mesh: { ...meshA, patches: [{ name: 'auto0', type: 'patch', nFaces: 12 }] },
      meshes: [meshA, meshB],
    });
    vi.mocked(meshesApi.renameMeshSourcePatch).mockResolvedValue({
      mesh: { ...meshA, patches: [{ name: 'interface', type: 'patch', nFaces: 20 }] },
      meshes: [meshA, meshB],
    });
    renderFlow();

    // Expand the first mesh's patch editor (the "N patches" toggle).
    expect(await screen.findByText('inlet-part')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /\d+ patch/i })[0]);

    // Split by feature angle.
    fireEvent.click(screen.getByRole('button', { name: /split patches/i }));
    await waitFor(() => expect(meshesApi.autoPatchMeshSource).toHaveBeenCalledWith('p1', 'm1', 30));

    // Rename a patch inline (Enter submits).
    const input = screen.getByLabelText('Rename patch ifaceA');
    fireEvent.change(input, { target: { value: 'interface' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(meshesApi.renameMeshSourcePatch).toHaveBeenCalledWith('p1', 'm1', 'ifaceA', 'interface'),
    );
  });
});
