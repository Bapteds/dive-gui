import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Project } from '@/lib/api/types';
import { ApiError } from '@/lib/api/client';

/**
 * SendToProjectDialog tests (WS-F). The projects API is mocked so the real dialog
 * logic runs: the project list comes from the visible-projects query, `case` is
 * the default target, the library target requires a non-blank name, the exact
 * body is sent, success navigates to the project's Visualize tab, and each API
 * error code maps to an inline message.
 */

vi.mock('@/lib/api/projects', () => ({
  listProjects: vi.fn(),
  importMeshFromMeshing: vi.fn(),
  restoreMeshBackup: vi.fn(),
}));

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateSpy,
}));

import * as projectsApi from '@/lib/api/projects';
import { SendToProjectDialog } from './SendToProjectDialog';

const owner = { id: 'u1', email: 'a@b.test', fullName: 'Ana Weber' };
const PROJECTS = [
  { id: 'p-runner', title: 'Runner study', owner, collaborators: [], createdAt: '', updatedAt: '' },
  { id: 'p-volute', title: 'Volute', owner, collaborators: [], createdAt: '', updatedAt: '' },
] as unknown as Project[];

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SendToProjectDialog
          sessionId="chamber-3f2a"
          sessionName="Chamber v3"
          open
          onOpenChange={onOpenChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onOpenChange;
}

async function pickProject(id = 'p-volute') {
  const select = await screen.findByLabelText('Project');
  await screen.findByRole('option', { name: 'Volute' });
  fireEvent.change(select, { target: { value: id } });
}

const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send to project' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.listProjects).mockResolvedValue(PROJECTS);
  vi.mocked(projectsApi.importMeshFromMeshing).mockResolvedValue({
    target: 'case',
    entries: [],
    notes: [],
  });
});

describe('SendToProjectDialog', () => {
  it('lists the visible projects and defaults to the case target', async () => {
    renderDialog();
    expect(await screen.findByRole('option', { name: 'Runner study' })).toBeInTheDocument();
    expect(screen.getByLabelText('Case mesh')).toBeChecked();
    expect(screen.getByText(/Replaces the project's case mesh/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Part name')).not.toBeInTheDocument();
  });

  it('sends the case body and lands on the Visualize tab', async () => {
    const onOpenChange = renderDialog();
    await pickProject();
    send();
    await waitFor(() =>
      expect(projectsApi.importMeshFromMeshing).toHaveBeenCalledWith('p-volute', {
        sessionId: 'chamber-3f2a',
        target: 'case',
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p-volute?view=visualize');
  });

  it('asks for a project before sending', async () => {
    renderDialog();
    await screen.findByRole('option', { name: 'Volute' });
    send();
    expect(await screen.findByText('Choose a project.')).toBeInTheDocument();
    expect(projectsApi.importMeshFromMeshing).not.toHaveBeenCalled();
  });

  it('library target: prefills the name, refuses a blank one, sends it trimmed', async () => {
    vi.mocked(projectsApi.importMeshFromMeshing).mockResolvedValue({
      target: 'library',
      meshes: [],
      notes: [],
    });
    renderDialog();
    await pickProject();
    fireEvent.click(screen.getByLabelText('Mesh library part'));
    const name = screen.getByLabelText('Part name');
    expect(name).toHaveValue('Chamber v3');
    expect(screen.queryByText(/Replaces the project's case mesh/)).not.toBeInTheDocument();

    fireEvent.change(name, { target: { value: '   ' } });
    send();
    expect(await screen.findByText('Enter a name for the library part.')).toBeInTheDocument();
    expect(projectsApi.importMeshFromMeshing).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: '  Chamber v3 fine  ' } });
    send();
    await waitFor(() =>
      expect(projectsApi.importMeshFromMeshing).toHaveBeenCalledWith('p-volute', {
        sessionId: 'chamber-3f2a',
        target: 'library',
        name: 'Chamber v3 fine',
      }),
    );
  });

  it.each([
    ['MESHING_NOT_MESHED', 409, /no mesh yet/i],
    ['MESH_IN_PROGRESS', 409, /mesh run is in progress/i],
    ['RUN_IN_PROGRESS', 409, /solver run is active/i],
    ['NOT_FOUND', 404, /no longer available/i],
  ] as const)('maps %s to an inline message and stays open', async (code, status, text) => {
    vi.mocked(projectsApi.importMeshFromMeshing).mockRejectedValue(
      new ApiError(code, 'server message', status),
    );
    const onOpenChange = renderDialog();
    await pickProject();
    send();
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('teaches the next step when no project is visible', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText('No project yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Projects' })).toHaveAttribute('href', '/projects');
  });
});
