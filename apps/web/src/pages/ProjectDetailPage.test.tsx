import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CaseEntry, Project } from '@/lib/api/types';

/**
 * ProjectDetailPage tests, focused on the Detail / Visualize tab gating.
 *
 * The 3D viewer (three.js, no WebGL under jsdom) and the case-files section are
 * mocked to stubs, the projects API and the auth context are mocked, so the real
 * page logic is exercised: Visualize is disabled until the case has a polyMesh,
 * enabled once it does, and opening it swaps the detail body for the viewer.
 */

vi.mock('@/features/visualize/MeshViewer', () => ({
  MeshViewer: ({ projectId }: { projectId: string }) => (
    <div data-testid="mesh-viewer">viewer {projectId}</div>
  ),
}));

vi.mock('@/features/projects/CaseFilesSection', () => ({
  CaseFilesSection: () => <div data-testid="case-files">case files</div>,
}));

vi.mock('@/features/solver/SolverTab', () => ({
  SolverTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="solver-tab">solver {projectId}</div>
  ),
}));

vi.mock('@/lib/api/projects', () => ({
  getProject: vi.fn(),
  getCaseFiles: vi.fn(),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'USER' } }),
}));

import * as api from '@/lib/api/projects';
import { ProjectDetailPage } from './ProjectDetailPage';

const project: Project = {
  id: 'p1',
  title: 'Rotor stage study',
  owner: { id: 'u1', fullName: 'Mara Henning', email: 'mara@dive-turbinen.de' },
  collaborators: [],
  createdAt: '2026-06-20T08:00:00.000Z',
  updatedAt: '2026-06-20T08:00:00.000Z',
};

const withMesh: CaseEntry[] = [
  { path: 'constant', type: 'directory', size: 0 },
  { path: 'constant/polyMesh', type: 'directory', size: 0 },
  { path: 'constant/polyMesh/points', type: 'file', size: 4096 },
];

const withoutMesh: CaseEntry[] = [
  { path: 'system', type: 'directory', size: 0 },
  { path: 'system/controlDict', type: 'file', size: 64 },
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/projects/:id', element: <ProjectDetailPage /> }],
    { initialEntries: ['/projects/p1'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProject).mockResolvedValue(project);
});

describe('ProjectDetailPage - Visualize tab gating', () => {
  it('disables the Visualize tab when the case has no polyMesh', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(withoutMesh);
    renderPage();
    expect(await screen.findByText('Rotor stage study')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('tab', { name: /visualize/i })).toBeDisabled());
  });

  it('enables the Visualize tab when the case has a polyMesh', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(withMesh);
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: /visualize/i })).toBeEnabled());
  });

  it('shows the 3D viewer and hides the detail body when Visualize is opened', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(withMesh);
    renderPage();

    // Re-query the trigger: the disabled (tooltip-wrapped) variant is swapped for
    // the enabled one once the case files load, so a captured node would go stale.
    await waitFor(() => expect(screen.getByRole('tab', { name: /visualize/i })).toBeEnabled());
    // userEvent (focus + pointer) so Radix Tabs' automatic activation fires.
    await userEvent.click(screen.getByRole('tab', { name: /visualize/i }));

    expect(await screen.findByTestId('mesh-viewer')).toBeInTheDocument();
    expect(screen.queryByTestId('case-files')).not.toBeInTheDocument();
  });
});

describe('ProjectDetailPage - Solver tab gating', () => {
  it('disables the Solver tab when the case has no polyMesh', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(withoutMesh);
    renderPage();
    expect(await screen.findByText('Rotor stage study')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('tab', { name: /solver/i })).toBeDisabled());
  });

  it('enables the Solver tab and opens it when the case has a polyMesh', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(withMesh);
    renderPage();

    await waitFor(() => expect(screen.getByRole('tab', { name: /solver/i })).toBeEnabled());
    await userEvent.click(screen.getByRole('tab', { name: /solver/i }));

    expect(await screen.findByTestId('solver-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('case-files')).not.toBeInTheDocument();
  });
});
