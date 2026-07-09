import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { CaseEntry, CaseVerification } from '@/lib/api/types';

/**
 * CaseFilesSection tests.
 *
 * Covers the three states a user moves through: the empty import prompt, the
 * imported tree (with sizes and toolbar), and the verify -> "generate missing
 * files" overlay. The projects API module is mocked so no network is involved;
 * the real React Query wiring drives the component.
 */

vi.mock('@/lib/api/projects', () => ({
  getCaseFiles: vi.fn(),
  getCaseFileContent: vi.fn(),
  importCaseFolder: vi.fn(),
  importCaseZip: vi.fn(),
  verifyCase: vi.fn(),
  scaffoldCase: vi.fn(),
  downloadCase: vi.fn(),
  resetCase: vi.fn(),
}));

import * as api from '@/lib/api/projects';
import { CaseFilesSection } from './CaseFilesSection';

const tree: CaseEntry[] = [
  { path: 'constant', type: 'directory', size: 0 },
  { path: 'constant/polyMesh', type: 'directory', size: 0 },
  { path: 'constant/polyMesh/points', type: 'file', size: 2048 },
  { path: 'constant/polyMesh/boundary', type: 'file', size: 512 },
];

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CaseFilesSection projectId="p1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CaseFilesSection', () => {
  it('shows the empty state with both import actions when no files exist', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue([]);
    renderSection();

    expect(await screen.findByText('No case files yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import \.zip/i })).toBeInTheDocument();
  });

  it('renders the imported tree with file sizes and the toolbar', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
    renderSection();

    expect(await screen.findByText('points')).toBeInTheDocument();
    expect(screen.getByText('boundary')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify case/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /topoSet/i })).toBeInTheDocument();
  });

  it('resets the case after confirmation', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
    vi.mocked(api.resetCase).mockResolvedValue([]);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(api.resetCase).toHaveBeenCalledWith('p1'));
  });

  it('opens the set-up flow with the minimal + template choices when base files are missing', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
    const verification: CaseVerification = {
      hasMesh: true,
      missingMesh: [],
      presentBase: [],
      missingBase: ['system/controlDict', '0/U'],
      complete: false,
      canScaffold: true,
    };
    vi.mocked(api.verifyCase).mockResolvedValue(verification);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: /verify case/i }));

    expect(await screen.findByText('Set up the case files')).toBeInTheDocument();
    expect(screen.getByText('system/controlDict')).toBeInTheDocument();
    expect(screen.getByText('0/U')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add minimal base files/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use a saved template/i })).toBeInTheDocument();
  });

  it('adds the built-in minimal base files from the set-up flow', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
    const verification: CaseVerification = {
      hasMesh: true,
      missingMesh: [],
      presentBase: [],
      missingBase: ['system/controlDict'],
      complete: false,
      canScaffold: true,
    };
    vi.mocked(api.verifyCase).mockResolvedValue(verification);
    vi.mocked(api.scaffoldCase).mockResolvedValue({
      created: ['system/controlDict'],
      verification: { ...verification, missingBase: [], complete: true, canScaffold: false },
      entries: tree,
    });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: /verify case/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add minimal base files/i }));

    await waitFor(() => expect(api.scaffoldCase).toHaveBeenCalledWith('p1'));
  });

  it('exposes Files and Summary tabs, with Files active by default', async () => {
    vi.mocked(api.getCaseFiles).mockResolvedValue(tree);
    renderSection();

    expect(await screen.findByRole('tab', { name: /files/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /summary/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('summarises readable dictionary files in the Summary tab and skips the mesh', async () => {
    const treeWithDict: CaseEntry[] = [
      { path: 'system', type: 'directory', size: 0 },
      { path: 'system/controlDict', type: 'file', size: 800 },
      { path: 'constant/polyMesh/points', type: 'file', size: 2048 },
    ];
    vi.mocked(api.getCaseFiles).mockResolvedValue(treeWithDict);
    vi.mocked(api.getCaseFileContent).mockResolvedValue({
      path: 'system/controlDict',
      size: 800,
      content: 'FoamFile { class dictionary; object controlDict; }\napplication foamRun;\nendTime 500;\n',
    });
    renderSection();

    await userEvent.click(await screen.findByRole('tab', { name: /summary/i }));

    // The readable dictionary is fetched and its entries are rendered.
    expect(await screen.findByText('application')).toBeInTheDocument();
    expect(screen.getByText('foamRun')).toBeInTheDocument();
    expect(screen.getByText('endTime')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('controlDict')).toBeInTheDocument();

    // The mesh file is never opened for the summary.
    expect(api.getCaseFileContent).toHaveBeenCalledWith('p1', 'system/controlDict');
    expect(api.getCaseFileContent).not.toHaveBeenCalledWith('p1', 'constant/polyMesh/points');
  });
});
