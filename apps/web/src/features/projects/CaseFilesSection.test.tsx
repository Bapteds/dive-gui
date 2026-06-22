import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  importCaseFolder: vi.fn(),
  importCaseZip: vi.fn(),
  verifyCase: vi.fn(),
  scaffoldCase: vi.fn(),
  downloadCase: vi.fn(),
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
      <CaseFilesSection projectId="p1" />
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
  });

  it('opens the generate-files overlay when verification reports missing base files', async () => {
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

    expect(await screen.findByText('Generate the missing base files?')).toBeInTheDocument();
    expect(screen.getByText('system/controlDict')).toBeInTheDocument();
    expect(screen.getByText('0/U')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create files/i })).toBeInTheDocument();
  });
});
