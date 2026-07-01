import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppliedAssembly, MergeRunResult, MeshManifest, MeshSource } from '@/lib/api/types';

/**
 * AssemblyManagePanel (Disassemble) tests.
 *
 * The panel reads the applied-assembly record and the library, then lets the user
 * Remove one part (re-apply a REDUCED plan via runMerge) or Undo the whole
 * assembly (restoreMeshBackup). The APIs are mocked so the real hook + panel logic
 * runs; MergeRunReport renders the result with no three.js involved.
 */

vi.mock('@/lib/api/meshes', () => ({
  listMeshes: vi.fn(),
  getMeshPatches: vi.fn(),
  autoPatchMeshSource: vi.fn(),
  renameMeshSourcePatch: vi.fn(),
  editMeshSourcePatches: vi.fn(),
  importMeshFolder: vi.fn(),
  importMeshZip: vi.fn(),
  importMeshFile: vi.fn(),
  deleteMesh: vi.fn(),
  runMerge: vi.fn(),
  getMergePlan: vi.fn(),
  saveMergePlan: vi.fn(),
  getAssembly: vi.fn(),
  getMeshSourceManifest: vi.fn(),
  getMeshSourceGeometry: vi.fn(),
  getMeshSourceEdges: vi.fn(),
}));

vi.mock('@/lib/api/projects', () => ({
  getCaseFiles: vi.fn(),
  getMeshManifest: vi.fn(),
  getMeshGeometry: vi.fn(),
  getMeshEdges: vi.fn(),
  rebuildMesh: vi.fn(),
  renameMeshPatch: vi.fn(),
  setMeshPatchType: vi.fn(),
  autoPatchMesh: vi.fn(),
  editMeshPatches: vi.fn(),
  getMeshBackup: vi.fn(),
  saveMeshBackup: vi.fn(),
  restoreMeshBackup: vi.fn(),
}));

import * as meshesApi from '@/lib/api/meshes';
import * as projectsApi from '@/lib/api/projects';
import { AssemblyManagePanel } from './AssemblyManagePanel';

const rotor: MeshSource = {
  id: 'p2',
  name: 'rotor',
  createdAt: '2026-06-30T08:01:00.000Z',
  patches: [{ name: 'mount', type: 'patch', nFaces: 12 }],
};
const stator: MeshSource = {
  id: 'p3',
  name: 'stator',
  createdAt: '2026-06-30T08:02:00.000Z',
  patches: [{ name: 'foot', type: 'patch', nFaces: 8 }],
};

/** A case-based assembly with two added parts (p2 has a transform, p3 does not). */
const assembly: AppliedAssembly = {
  baseIsCase: true,
  appliedAt: '2026-07-01T09:00:00.000Z',
  plan: {
    order: ['__case__', 'p2', 'p3'],
    interfaces: [
      { aMeshId: 'p2', aPatch: 'mount', bMeshId: '__case__', bPatch: 'caseInlet', coupling: 'nonConformal' },
      { aMeshId: 'p3', aPatch: 'foot', bMeshId: '__case__', bPatch: 'caseOutlet', coupling: 'nonConformal' },
    ],
    transforms: [{ meshId: 'p2', translation: [1, 0, 0], rotation: [0, 0, 0, 1] }],
  },
};

const successResult: MergeRunResult = {
  success: true,
  steps: [
    { kind: 'mergeMeshes', label: 'Combine stator', command: 'mergeMeshes', status: 'success', exitCode: 0, stdout: 'Merged', stderr: '', durationMs: 40 },
    { kind: 'checkMesh', label: 'Check combined mesh', command: 'checkMesh -case .', status: 'success', exitCode: 0, stdout: 'Mesh OK.', stderr: '', durationMs: 20 },
  ],
  notes: ['Combined 2 meshes with mergeMeshes.'],
  boundaryPatches: [{ name: 'foot', type: 'patch', nFaces: 8 }],
  entries: [{ path: 'constant/polyMesh/boundary', type: 'file', size: 10 }],
};

const restoredManifest: MeshManifest = {
  patches: [{ name: 'caseInlet', type: 'patch', nFaces: 40 }],
  generatedAt: '2026-07-01T09:05:00.000Z',
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AssemblyManagePanel projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(meshesApi.getAssembly).mockResolvedValue(assembly);
  vi.mocked(meshesApi.listMeshes).mockResolvedValue([rotor, stator]);
  vi.mocked(meshesApi.runMerge).mockResolvedValue(successResult);
  vi.mocked(projectsApi.restoreMeshBackup).mockResolvedValue(restoredManifest);
});

describe('AssemblyManagePanel', () => {
  it('renders nothing when no assembly is applied', async () => {
    vi.mocked(meshesApi.getAssembly).mockResolvedValue(null);
    const { container } = (() => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <AssemblyManagePanel projectId="p1" />
        </QueryClientProvider>,
      );
    })();
    // Give the (null) query a tick; the panel must stay empty.
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('Remove posts a REDUCED MergePlan to runMerge and renders the report', async () => {
    renderPanel();

    // Both added parts are listed once the record + library resolve.
    const rotorName = await screen.findByText('rotor');
    expect(await screen.findByText('stator')).toBeInTheDocument();

    // Remove the rotor (p2): the reduced plan drops it from the order, its
    // interface, and its transform.
    const rotorRow = rotorName.closest('li');
    if (!rotorRow) throw new Error('rotor row not found');
    fireEvent.click(within(rotorRow).getByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
        order: ['__case__', 'p3'],
        interfaces: [
          { aMeshId: 'p3', aPatch: 'foot', bMeshId: '__case__', bPatch: 'caseOutlet', coupling: 'nonConformal' },
        ],
        transforms: [],
      }),
    );

    // The shared run report renders the result inline (checkMesh log is open).
    expect(await screen.findByText('Mesh OK.')).toBeInTheDocument();
  });

  it('Undo assembly confirms, then calls restoreMeshBackup', async () => {
    renderPanel();

    // Undo is offered because the base was the project case mesh (a backup exists).
    fireEvent.click(await screen.findByRole('button', { name: /undo assembly/i }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /undo assembly/i }));

    await waitFor(() => expect(projectsApi.restoreMeshBackup).toHaveBeenCalledWith('p1'));
  });

  it('hides Undo assembly for a library-only base (no backup)', async () => {
    vi.mocked(meshesApi.getAssembly).mockResolvedValue({
      ...assembly,
      baseIsCase: false,
      plan: { ...assembly.plan, order: ['base', 'p2', 'p3'] },
    });
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([
      { id: 'base', name: 'housing', createdAt: '2026-06-30T08:00:00.000Z', patches: [] },
      rotor,
      stator,
    ]);
    renderPanel();

    // The added parts still show, but there is no undo-all for a library base.
    expect(await screen.findByText('rotor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo assembly/i })).not.toBeInTheDocument();
  });
});
