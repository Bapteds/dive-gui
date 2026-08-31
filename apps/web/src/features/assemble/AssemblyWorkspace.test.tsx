import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CaseEntry, MergeRunResult, MeshManifest, MeshSource } from '@/lib/api/types';
import type { AssemblyViewerProps } from './AssemblyViewer';

/**
 * AssemblyWorkspace tests.
 *
 * jsdom has no WebGL, so the three.js AssemblyViewer is mocked to a stub that
 * exposes the two callbacks the real canvas fires: `onPickBaseFace` (the user
 * clicked a base face, which sets the coupling's base patch and never moves the
 * part) and `onTransformChange` (the gizmo repositioned the active ghost). The
 * meshes + projects APIs are mocked so the real workspace logic runs.
 *
 * The tests prove the KEY behaviour: a part can be COUPLED and merged with NO
 * transform (it stays at its imported position), a part the user repositions
 * produces a `transforms` entry, the coupling value is `'nonConformal'`, and the
 * project case mesh as base sends `order[0] === '__case__'`.
 *
 * The math itself (that this `(q, t)` == the server result) is proven separately
 * and exactly in `placement.test.ts`.
 */

// A stub viewer: buttons drive the pick + gizmo callbacks the canvas would fire.
vi.mock('./AssemblyViewer', () => ({
  AssemblyViewer: (props: AssemblyViewerProps) => (
    <div data-testid="assembly-viewer">
      <span>active:{props.active?.meshId ?? 'none'}</span>
      <span>reposition:{String(props.reposition)}</span>
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
          props.onTransformChange({
            meshId: props.active?.meshId ?? '',
            rotation: [0, 0, 0, 1],
            translation: [1, 2, 3],
          })
        }
      >
        mock move part
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

// The case-mesh base path reads the case tree (for detection), the case manifest
// (for the base patches) and the case geometry (for the base body).
vi.mock('@/lib/api/projects', () => ({
  getCaseFiles: vi.fn(),
  getMeshManifest: vi.fn(),
  getMeshGeometry: vi.fn(),
}));

import * as meshesApi from '@/lib/api/meshes';
import * as projectsApi from '@/lib/api/projects';
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

const caseManifest: MeshManifest = {
  patches: [{ name: 'caseInlet', type: 'patch', nFaces: 40 }],
  generatedAt: '2026-07-01T08:00:00.000Z',
};

const caseTree: CaseEntry[] = [{ path: 'constant/polyMesh/boundary', type: 'file', size: 10 }];

const successResult: MergeRunResult = {
  success: true,
  steps: [
    { kind: 'prepare', label: 'Prepare housing', command: '', status: 'success', exitCode: null, stdout: 'staged', stderr: '', durationMs: 0 },
    { kind: 'prepare', label: 'Prepare rotor', command: '', status: 'success', exitCode: null, stdout: 'staged', stderr: '', durationMs: 0 },
    { kind: 'mergeMeshes', label: 'Combine rotor', command: 'mergeMeshes . rotor -overwrite', status: 'success', exitCode: 0, stdout: 'Merged', stderr: '', durationMs: 40 },
    { kind: 'nonConformalCouple', label: 'Couple rotor.mount ↔ housing.baseTop', command: 'cyclicAMI retype', status: 'success', exitCode: 0, stdout: 'Coupled', stderr: '', durationMs: 30 },
    { kind: 'cleanup', label: 'Clean up empty patches', command: '', status: 'skipped', exitCode: null, stdout: 'Skipped', stderr: '', durationMs: 0 },
    { kind: 'checkMesh', label: 'Check combined mesh', command: 'checkMesh -case .', status: 'success', exitCode: 0, stdout: 'Mesh OK.', stderr: '', durationMs: 20 },
  ],
  notes: ['Combined 2 meshes with mergeMeshes.'],
  boundaryPatches: [{ name: 'blades', type: 'wall', nFaces: 300 }],
  cellZones: ['housing', 'rotor'],
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

/** Drive selecting the rotor and coupling it to the base (no reposition). */
async function selectAndCoupleRotor() {
  fireEvent.click(partSelectButton(/rotor/i));
  expect(await screen.findByText('active:p2')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/mating patch/i), { target: { value: 'mount' } });
  fireEvent.click(screen.getByRole('button', { name: /mock pick face/i }));
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
  // Default: no case mesh, so the base is a library part (the existing behaviour).
  vi.mocked(projectsApi.getCaseFiles).mockResolvedValue([]);
  vi.mocked(projectsApi.getMeshManifest).mockResolvedValue(caseManifest);
  vi.mocked(projectsApi.getMeshGeometry).mockResolvedValue({
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

  it('surfaces the non-destructive note near the Merge CTA', async () => {
    renderWorkspace();
    expect(await screen.findByText('rotor')).toBeInTheDocument();
    expect(
      screen.getByText(/the previous mesh is backed up and restorable from the visualize tab/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/parts stay separate \(cyclicami\)/i)).toBeInTheDocument();
  });

  it('couples a part and merges with NO transform (the part stays at its imported position)', async () => {
    renderWorkspace();

    // The library + the base canvas are ready.
    expect(await screen.findByText('rotor')).toBeInTheDocument();
    expect(await screen.findByTestId('assembly-viewer')).toBeInTheDocument();

    // Select the added part, choose the mating patch, and pick a base face. This
    // defines the couple WITHOUT moving the part (no confirm, no reposition).
    await selectAndCoupleRotor();

    // Straight to Merge: interfaces (pre-seeded) -> confirm -> report.
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(await screen.findByText('Couple the parts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Merge the assembly?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /merge assembly/i }));

    expect(await screen.findByText('Assembly merged')).toBeInTheDocument();
    expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
      order: ['base', 'p2'],
      interfaces: [
        { aMeshId: 'p2', aPatch: 'mount', bMeshId: 'base', bPatch: 'baseTop', coupling: 'nonConformal' },
      ],
      // No transform: the part was never repositioned, so it stays as imported.
      transforms: [],
    });
    await waitFor(() => expect(screen.getByText('Mesh OK.')).toBeInTheDocument());
  });

  it('adds a transforms entry only for a part the user repositions', async () => {
    renderWorkspace();

    expect(await screen.findByText('rotor')).toBeInTheDocument();
    await selectAndCoupleRotor();

    // Opt in to repositioning: the 6-DOF numeric fields appear.
    fireEvent.click(screen.getByRole('switch', { name: /reposition this part/i }));
    expect(await screen.findByLabelText(/position x in m/i)).toBeInTheDocument();

    // The gizmo moves the ghost (the mock stands in for a real drag).
    fireEvent.click(screen.getByRole('button', { name: /mock move part/i }));

    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(await screen.findByText('Couple the parts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('Merge the assembly?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /merge assembly/i }));

    expect(await screen.findByText('Assembly merged')).toBeInTheDocument();
    expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
      order: ['base', 'p2'],
      interfaces: [
        { aMeshId: 'p2', aPatch: 'mount', bMeshId: 'base', bPatch: 'baseTop', coupling: 'nonConformal' },
      ],
      transforms: [{ meshId: 'p2', rotation: [0, 0, 0, 1], translation: [1, 2, 3] }],
    });
  });

  it('switches the coupling to a conformal stitch in the payload (still no transform)', async () => {
    renderWorkspace();

    expect(await screen.findByText('rotor')).toBeInTheDocument();
    await selectAndCoupleRotor();

    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(await screen.findByText('Couple the parts')).toBeInTheDocument();

    // Flip the seeded interface from non-conformal to a conformal stitch.
    fireEvent.click(screen.getByRole('radio', { name: /conformal stitch/i }));

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('Merge the assembly?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /merge assembly/i }));

    expect(await screen.findByText('Assembly merged')).toBeInTheDocument();
    expect(meshesApi.runMerge).toHaveBeenCalledWith('p1', {
      order: ['base', 'p2'],
      interfaces: [
        { aMeshId: 'p2', aPatch: 'mount', bMeshId: 'base', bPatch: 'baseTop', coupling: 'stitch' },
      ],
      transforms: [],
    });
  });

  it('uses the project case mesh as the base (order[0] = __case__), unmoved', async () => {
    vi.mocked(projectsApi.getCaseFiles).mockResolvedValue(caseTree);
    renderWorkspace();

    // With a case mesh present the base defaults to it: the pinned base row shows
    // the project mesh, and every library source becomes an added part.
    expect(await screen.findByText('Project case mesh')).toBeInTheDocument();
    expect(await screen.findByText('rotor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(await screen.findByText('Couple the parts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Merge the assembly?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /merge assembly/i }));

    expect(await screen.findByText('Assembly merged')).toBeInTheDocument();
    const call = vi.mocked(meshesApi.runMerge).mock.calls[0]?.[1];
    expect(call?.order).toEqual(['__case__', 'base', 'p2']);
    // The case base is never given a transform (it is pinned at identity).
    expect(call?.transforms).toEqual([]);
  });
});
