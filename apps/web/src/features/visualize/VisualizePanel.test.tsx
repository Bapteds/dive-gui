import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MeshManifest, MeshSource } from '@/lib/api/types';

/**
 * VisualizePanel tests.
 *
 * jsdom has no WebGL, so the real MeshViewer detects it, skips building the
 * three.js scene, and renders only the left panel (patch table, edit/auto-patch
 * controls, backup bar). That is exactly what these tests exercise:
 *  - the picker switches the viewer TARGET, firing the per-source hooks with the
 *    chosen meshId,
 *  - the backup bar is case-only (hidden for a library source),
 *  - Edit posts the source batch-edit (C4) and Auto-patch uses the source hook.
 *
 * The APIs are mocked; the real panel + viewer + dialog logic runs.
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
import { VisualizePanel } from './VisualizePanel';

const source: MeshSource = {
  id: 'src1',
  name: 'inducer',
  createdAt: '2026-06-30T08:00:00.000Z',
  patches: [{ name: 'srcInlet', type: 'patch', nFaces: 10 }],
};

const caseManifest: MeshManifest = {
  patches: [{ name: 'caseInlet', type: 'patch', nFaces: 40 }],
  generatedAt: '2026-07-01T08:00:00.000Z',
};
const sourceManifest: MeshManifest = {
  patches: [{ name: 'srcInlet', type: 'patch', nFaces: 10 }],
  generatedAt: '2026-07-01T08:01:00.000Z',
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <VisualizePanel projectId="p1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Switch the picker to the library source and wait for its patch list to load. */
async function switchToSource() {
  fireEvent.change(await screen.findByLabelText('Mesh'), { target: { value: 'src1' } });
  expect(await screen.findByText('srcInlet')).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  // A case mesh AND a library source, so the picker offers a choice.
  vi.mocked(projectsApi.getCaseFiles).mockResolvedValue([
    { path: 'constant/polyMesh/boundary', type: 'file', size: 10 },
  ]);
  vi.mocked(meshesApi.listMeshes).mockResolvedValue([source]);
  vi.mocked(projectsApi.getMeshManifest).mockResolvedValue(caseManifest);
  vi.mocked(projectsApi.getMeshBackup).mockResolvedValue(null);
  vi.mocked(meshesApi.getMeshSourceManifest).mockResolvedValue(sourceManifest);
  vi.mocked(meshesApi.getMeshSourceEdges).mockResolvedValue(null);
  vi.mocked(meshesApi.editMeshSourcePatches).mockResolvedValue({
    mesh: source,
    meshes: [source],
  });
  vi.mocked(meshesApi.autoPatchMeshSource).mockResolvedValue({
    result: { success: true, command: 'autoPatch 45 -overwrite', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 },
    mesh: source,
    meshes: [source],
  });
});

describe('VisualizePanel', () => {
  it('defaults to the case mesh and shows the backup bar', async () => {
    renderPanel();
    // The case patch table loads (default target = case), and backup is case-only.
    expect(await screen.findByText('caseInlet')).toBeInTheDocument();
    expect(projectsApi.getMeshManifest).toHaveBeenCalledWith('p1');
    expect(screen.getByRole('button', { name: /save backup/i })).toBeInTheDocument();
  });

  it('switches the target to a source, firing the source hooks with its meshId', async () => {
    renderPanel();
    await screen.findByText('caseInlet');

    await switchToSource();

    expect(meshesApi.getMeshSourceManifest).toHaveBeenCalledWith('p1', 'src1');
  });

  it('hides the backup bar for a library source', async () => {
    renderPanel();
    await screen.findByText('caseInlet');
    // Case: backup bar present.
    expect(screen.getByRole('button', { name: /save backup/i })).toBeInTheDocument();

    await switchToSource();

    // Source: no backup slot, so no backup controls.
    expect(screen.queryByRole('button', { name: /save backup/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore from backup/i })).not.toBeInTheDocument();
  });

  it('Edit on a source posts the batch edit (C4) with the source meshId', async () => {
    renderPanel();
    await screen.findByText('caseInlet');
    await switchToSource();

    fireEvent.click(screen.getByRole('button', { name: /edit names/i }));

    const nameField = await screen.findByLabelText('New name for srcInlet');
    fireEvent.change(nameField, { target: { value: 'srcInletX' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(meshesApi.editMeshSourcePatches).toHaveBeenCalledWith('p1', 'src1', [
        { from: 'srcInlet', to: 'srcInletX', type: 'patch' },
      ]),
    );
    // The case edit path must NOT be used for a source.
    expect(projectsApi.editMeshPatches).not.toHaveBeenCalled();
  });

  it('Auto-patch on a source uses the source auto-patch hook', async () => {
    renderPanel();
    await screen.findByText('caseInlet');
    await switchToSource();

    fireEvent.click(screen.getByRole('button', { name: /auto-patch/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /run autopatch/i }));

    await waitFor(() =>
      expect(meshesApi.autoPatchMeshSource).toHaveBeenCalledWith('p1', 'src1', 45),
    );
    expect(projectsApi.autoPatchMesh).not.toHaveBeenCalled();
  });
});
