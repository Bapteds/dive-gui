import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MergeRunResult, MeshSource } from '@/lib/api/types';
import type { AssemblyViewerProps } from './AssemblyViewer';

/**
 * AssemblyWorkspace tests.
 *
 * jsdom has no WebGL, so the three.js AssemblyViewer is mocked to a stub that
 * exposes the two callbacks the real canvas fires: `onPickBaseFace` (the user
 * clicked a base face) and `onPreviewTransform` (the live-computed placement).
 * The meshes API is mocked so the real workspace logic runs. The test drives a
 * full placement and asserts the `runMerge` payload carries the expected
 * `transforms`, and that the per-step report renders.
 *
 * The math itself (that this `(q, t)` == the server result) is proven separately
 * and exactly in `placement.test.ts`.
 */

// A stub viewer: buttons drive the pick + preview callbacks the canvas would fire.
vi.mock('./AssemblyViewer', () => ({
  AssemblyViewer: (props: AssemblyViewerProps) => (
    <div data-testid="assembly-viewer">
      <span>active:{props.active?.meshId ?? 'none'}</span>
      <button
        type="button"
        onClick={() =>
          props.onPickBaseFace({ patchName: 'baseTop', point: [0, 0, 5], normal: [0, 0, 1] })
        }
      >
        mock pick face
      </button>
      <button
        type="button"
        onClick={() =>
          props.onPreviewTransform({
            meshId: props.active?.meshId ?? '',
            rotation: [0, 0, 0, 1],
            translation: [1, 2, 3],
          })
        }
      >
        mock emit preview
      </button>
    </div>
  ),
  AssemblyViewerError: () => <div>viewer error</div>,
}));

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
  getMeshSourceManifest: vi.fn(),
  getMeshSourceGeometry: vi.fn(),
  getMeshSourceEdges: vi.fn(),
}));

import * as meshesApi from '@/lib/api/meshes';
import { AssemblyWorkspace } from './AssemblyWorkspace';

const base: MeshSource = {
  id: 'base',
  name: 'housing',
  createdAt: '2026-06-30T08:00:00.000Z',
  patches: [{ name: 'baseTop', type: 'patch', nFaces: 24 }],
};
const rotor: MeshSource = {
  id: 'p2',
  name: 'rotor',
  createdAt: '2026-06-30T08:01:00.000Z',
  patches: [
    { name: 'mount', type: 'patch', nFaces: 12 },
    { name: 'blades', type: 'wall', nFaces: 300 },
  ],
};

const successResult: MergeRunResult = {
  success: true,
  steps: [
    { kind: 'prepare', label: 'Prepare housing', command: '', status: 'success', exitCode: null, stdout: 'staged', stderr: '', durationMs: 0 },
    { kind: 'prepare', label: 'Prepare rotor', command: '', status: 'success', exitCode: null, stdout: 'Transformed + staged', stderr: '', durationMs: 0 },
    { kind: 'mergeMeshes', label: 'Combine rotor', command: 'mergeMeshes . rotor -addCases', status: 'success', exitCode: 0, stdout: 'Merged', stderr: '', durationMs: 40 },
    { kind: 'stitchMesh', label: 'Stitch rotor.mount ↔ housing.baseTop', command: 'stitchMesh ...', status: 'success', exitCode: 0, stdout: 'Stitched', stderr: '', durationMs: 30 },
    { kind: 'cleanup', label: 'Clean up empty patches', command: '', status: 'success', exitCode: null, stdout: 'Removed 2 empty patch(es).', stderr: '', durationMs: 0 },
    { kind: 'checkMesh', label: 'Check combined mesh', command: 'checkMesh -case .', status: 'success', exitCode: 0, stdout: 'Mesh OK.', stderr: '', durationMs: 20 },
  ],
  notes: ['Transformed 1 part before merging.'],
  boundaryPatches: [{ name: 'm2_blades', type: 'wall', nFaces: 300 }],
  entries: [{ path: 'constant/polyMesh/boundary', type: 'file', size: 10 }],
};

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AssemblyWorkspace projectId="p1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Find the selectable part-row button (it carries aria-pressed). */
function partSelectButton(name: RegExp): HTMLElement {
  const button = screen
    .getAllByRole('button', { name })
    .find((el) => el.hasAttribute('aria-pressed'));
  if (!button) throw new Error('part select button not found');
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(meshesApi.listMeshes).mockResolvedValue([base, rotor]);
  vi.mocked(meshesApi.getMergePlan).mockResolvedValue(null);
  vi.mocked(meshesApi.runMerge).mockResolvedValue(successResult);
  // The viewer is mocked, but the workspace still loads each body's geometry.
  vi.mocked(meshesApi.getMeshSourceGeometry).mockResolvedValue({
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Blob);
});

describe('AssemblyWorkspace', () => {
  it('gates the Merge CTA until there is a part beyond the base', async () => {
    vi.mocked(meshesApi.listMeshes).mockResolvedValue([base]);
    renderWorkspace();

    expect(await screen.findByText('housing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();
  });

  it('places a part and merges with the expected transforms payload', async () => {
    renderWorkspace();

    // The library + the base canvas are ready.
    expect(await screen.findByText('rotor')).toBeInTheDocument();
    expect(await screen.findByTestId('assembly-viewer')).toBeInTheDocument();

    // Select the added part; its geometry loads and it becomes the active ghost.
    fireEvent.click(partSelectButton(/rotor/i));
    expect(await screen.findByText('active:p2')).toBeInTheDocument();

    // Choose the mating patch, pick a base face, and let the viewer emit the
    // live-computed placement (the mock stands in for the real math).
    fireEvent.change(screen.getByLabelText(/mating patch/i), { target: { value: 'mount' } });
    fireEvent.click(screen.getByRole('button', { name: /mock pick face/i }));
    fireEvent.click(screen.getByRole('button', { name: /mock emit preview/i }));

    // Confirm the placement.
    const confirm = screen.getByRole('button', { name: /confirm placement/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    // Merge: connections (pre-seeded) -> confirm -> report. Each step swaps the
    // dialog content, so re-query globally (and wait out the content transition).
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(await screen.findByText('Connect the parts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Merge the assembly?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /merge assembly/i }));

    expect(await screen.findByText('Assembly merged')).toBeInTheDocument();
    expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
      order: ['base', 'p2'],
      stitches: [{ aMeshId: 'p2', aPatch: 'mount', bMeshId: 'base', bPatch: 'baseTop' }],
      transforms: [{ meshId: 'p2', rotation: [0, 0, 0, 1], translation: [1, 2, 3] }],
    });
    // The checkMesh log is expanded by default, so its output is visible.
    await waitFor(() => expect(screen.getByText('Mesh OK.')).toBeInTheDocument());
  });
});
