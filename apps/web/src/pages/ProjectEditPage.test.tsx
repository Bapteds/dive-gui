import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { CaseEntry, CaseFileContent, Project } from '@/lib/api/types';

/**
 * ProjectEditPage tests.
 *
 * The CodeMirror wrapper is mocked to a plain textarea (CodeMirror is heavy and
 * flaky under jsdom) and the projects API is mocked, so the real page logic is
 * exercised: the file list renders, selecting a file loads its content, and
 * editing then Save calls the save endpoint. A data router is required because
 * the page's unsaved-changes guard uses useBlocker.
 */

vi.mock('@/features/projects/CaseFileEditor', () => ({
  CaseFileEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('@/lib/api/projects', () => ({
  getProject: vi.fn(),
  getCaseFiles: vi.fn(),
  getCaseFileContent: vi.fn(),
  saveCaseFileContent: vi.fn(),
}));

import * as api from '@/lib/api/projects';
import { ProjectEditPage } from './ProjectEditPage';

const project: Project = {
  id: 'p1',
  title: 'Rotor stage study',
  owner: { id: 'u1', fullName: 'Mara Henning', email: 'mara@dive-turbinen.de' },
  collaborators: [],
  createdAt: '2026-06-20T08:00:00.000Z',
  updatedAt: '2026-06-20T08:00:00.000Z',
};

const tree: CaseEntry[] = [
  { path: 'system', type: 'directory', size: 0 },
  { path: 'system/controlDict', type: 'file', size: 64 },
  { path: '0', type: 'directory', size: 0 },
  { path: '0/U', type: 'file', size: 48 },
];

const controlDict: CaseFileContent = {
  path: 'system/controlDict',
  content: 'application foamRun;',
  size: 20,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/projects/:id/edit', element: <ProjectEditPage /> }],
    { initialEntries: ['/projects/p1/edit'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProject).mockResolvedValue(project);
  vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
  vi.mocked(api.getCaseFileContent).mockResolvedValue(controlDict);
  vi.mocked(api.saveCaseFileContent).mockResolvedValue(undefined);
});

describe('ProjectEditPage', () => {
  it('renders the file list and an empty editor until a file is chosen', async () => {
    renderPage();
    expect(await screen.findByText('Rotor stage study')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /controlDict/i })).toBeInTheDocument();
    expect(screen.getByText('Select a file to edit')).toBeInTheDocument();
  });

  it('loads a file into the editor when selected', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /controlDict/i }));

    const editor = await screen.findByLabelText('editor');
    await waitFor(() => expect(editor).toHaveValue('application foamRun;'));
    expect(api.getCaseFileContent).toHaveBeenCalledWith('p1', 'system/controlDict');
  });

  it('auto-saves edited content (debounced, no Save button)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /controlDict/i }));

    const editor = await screen.findByLabelText('editor');
    await waitFor(() => expect(editor).toHaveValue('application foamRun;'));

    fireEvent.change(editor, { target: { value: 'application simpleFoam;' } });

    // No Save button: the debounced autosave persists the change on its own.
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    await waitFor(
      () =>
        expect(api.saveCaseFileContent).toHaveBeenCalledWith(
          'p1',
          'system/controlDict',
          'application simpleFoam;',
        ),
      { timeout: 2000 },
    );
  });
});
