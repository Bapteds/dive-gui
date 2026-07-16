import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeshQualityResult } from '@/lib/api/types';

/**
 * NotationTab tests. The quality API is mocked, so the real tab logic runs:
 * the empty state before any rating, running the rating and rendering the
 * overall grade + one card per criterion (with flags), and the honest
 * "checkMesh unavailable" state. No real network.
 */

vi.mock('@/lib/api/projects', () => ({
  getMeshQuality: vi.fn(),
  runMeshQuality: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/projects';
import { NotationTab } from './NotationTab';

const rating: MeshQualityResult = {
  available: true,
  ranAt: '2026-07-16T12:00:00.000Z',
  command: 'checkMesh -allGeometry -case /cases/p1',
  meshOk: true,
  failedChecks: 0,
  cells: 120000,
  points: 125000,
  faces: 352400,
  negativeVolumeCells: 0,
  overall: { score: 92, grade: 'A' },
  metrics: [
    { id: 'skewness', value: 0.92, detail: 'max over all faces', score: 100, grade: 'A', flagged: false },
    { id: 'nonOrthogonality', value: 38.2, detail: 'average 11.4°', score: 100, grade: 'A', flagged: false },
    { id: 'minVolume', value: 2.5e-9, detail: '7.5e-1× the mean cell volume', score: 100, grade: 'A', flagged: false },
    { id: 'sizeUniformity', value: 0.62, detail: 'average ratio 0.98', score: 100, grade: 'A', flagged: false },
    { id: 'twisting', value: 0.98, detail: 'average flatness 0.999', score: 100, grade: 'A', flagged: false },
    { id: 'aspectRatio', value: 12.4, detail: 'max cell aspect ratio', score: 95, grade: 'A', flagged: false },
    { id: 'openness', value: 2.2e-16, detail: 'max cell openness', score: 100, grade: 'A', flagged: false },
  ],
  notes: [],
  log: 'Mesh OK.',
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotationTab projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotationTab', () => {
  it('shows the empty state before any rating has run', async () => {
    vi.mocked(api.getMeshQuality).mockResolvedValue(null);
    renderTab();
    expect(await screen.findByText('No rating yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rate the mesh/i })).toBeEnabled();
  });

  it('runs the rating and renders the overall grade + every criterion card', async () => {
    vi.mocked(api.getMeshQuality).mockResolvedValue(null);
    vi.mocked(api.runMeshQuality).mockResolvedValue(rating);
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /rate the mesh/i }));

    await waitFor(() => expect(api.runMeshQuality).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('92 / 100')).toBeInTheDocument();
    expect(screen.getByText('Mesh OK')).toBeInTheDocument();
    expect(screen.getByText('Skewness')).toBeInTheDocument();
    expect(screen.getByText('Non-orthogonality')).toBeInTheDocument();
    expect(screen.getByText('Minimum volume')).toBeInTheDocument();
    expect(screen.getByText('Cell-size uniformity')).toBeInTheDocument();
    expect(screen.getByText('Twisting / folding')).toBeInTheDocument();
    expect(screen.getByText('Aspect ratio')).toBeInTheDocument();
    expect(screen.getByText('Cell openness')).toBeInTheDocument();
    // Mesh size from the overall card.
    expect(screen.getByText('120,000')).toBeInTheDocument();
    // The CTA switches to the re-run label once a rating exists.
    expect(screen.getByRole('button', { name: /re-rate the mesh/i })).toBeInTheDocument();
  });

  it('renders a persisted rating with flags and a forced E on inverted cells', async () => {
    const bad: MeshQualityResult = {
      ...rating,
      meshOk: false,
      failedChecks: 3,
      negativeVolumeCells: 42,
      overall: { score: 0, grade: 'E' },
      metrics: rating.metrics.map((m) =>
        m.id === 'minVolume' ? { ...m, value: null, score: 0, grade: 'E', flagged: true } : m,
      ),
      notes: ['42 negative-volume (inverted) cell(s) — fatal for any solve; the mesh must be rebuilt.'],
    };
    vi.mocked(api.getMeshQuality).mockResolvedValue(bad);
    renderTab();

    expect(await screen.findByText('0 / 100')).toBeInTheDocument();
    expect(screen.getByText(/42 inverted cell/)).toBeInTheDocument();
    expect(screen.getAllByText('Flagged by checkMesh').length).toBeGreaterThan(0);
    expect(screen.getByText(/mesh must be rebuilt/)).toBeInTheDocument();
  });

  it('says so when checkMesh is not installed on the server', async () => {
    vi.mocked(api.getMeshQuality).mockResolvedValue({
      ...rating,
      available: false,
      metrics: [],
      overall: { score: null, grade: null },
      notes: ['checkMesh is not available on this server — no rating could be produced.'],
    });
    renderTab();

    expect(await screen.findByText('checkMesh unavailable')).toBeInTheDocument();
  });
});
