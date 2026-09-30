import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChamberSaveSummary, PublicStudy, StudySetup } from '@dive/shared';

/**
 * StudyCreateForm tests (WS-H spec §9, adapted to §0): the live search-space
 * preview (band around the base FINAL, table Min / Max, 50 mm grid), the
 * weights validation, the Pareto mode and the create request body. The API
 * module is mocked.
 */

vi.mock('@/lib/api/studies', () => ({
  createStudy: vi.fn(),
  updateStudy: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/studies';
import { StudyCreateForm } from './StudyCreateForm';

const SETUP: StudySetup = {
  origin: null,
  originInput: null,
  sessions: [{ id: 'chamber-ref', name: 'Chamber reference', engine: 'cfmesh' }],
  defaultSessionId: null,
  criteriaApplicable: true,
  defaultCores: 4,
  runningStudy: null,
};

function save(partial: Partial<ChamberSaveSummary> = {}): ChamberSaveSummary {
  return {
    id: 'save-1',
    name: 'Kaplan 1450',
    snapshot: { x1: 1450, x2: 7.85, x3: 8 },
    owner: { id: 'u1', fullName: 'Lena Hoffmann' },
    createdAt: '2026-09-30T08:00:00.000Z',
    updatedAt: '2026-09-30T08:00:00.000Z',
    ...partial,
  };
}

function renderForm(saves: ChamberSaveSummary[] = [save()], onDone = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StudyCreateForm
        projectId="p1"
        setup={SETUP}
        saves={saves}
        onDone={onDone}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudyCreateForm', () => {
  it('previews the band around the base value on the 50 mm grid', async () => {
    const user = userEvent.setup();
    renderForm();
    const width = screen.getByRole('checkbox', { name: 'B Kammer' });
    await user.click(width);
    expect(screen.getByTestId('range-width')).toHaveTextContent('4050 to 4850 mm');
    expect(screen.getByTestId('base-width')).toHaveTextContent('4450');

    const band = screen.getByLabelText('Band for B Kammer (±%)');
    await user.clear(band);
    await user.type(band, '20');
    expect(screen.getByTestId('range-width')).toHaveTextContent('3600 to 5300 mm');
  });

  it('shows a tighter table Max as the range limit', async () => {
    const user = userEvent.setup();
    renderForm([save({ snapshot: { x1: 1450, x2: 7.85, x3: 8, constraints: { width: { max: 4500 } } } })]);
    await user.click(screen.getByRole('checkbox', { name: 'B Kammer' }));
    expect(screen.getByTestId('range-width')).toHaveTextContent('4050 to 4500 mm');
    expect(screen.getByTestId('range-width')).toHaveTextContent(/table limit/i);
  });

  it('refuses weights that are both zero', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText(/Study name/), 'Width sweep');
    await user.click(screen.getByRole('checkbox', { name: 'B Kammer' }));
    const head = screen.getByLabelText('Head loss weight');
    const vortex = screen.getByLabelText('Vortex weight');
    await user.clear(head);
    await user.type(head, '0');
    await user.clear(vortex);
    await user.type(vortex, '0');
    await user.click(screen.getByRole('button', { name: 'Create study' }));
    expect(await screen.findByText('At least one weight must be above 0.')).toBeInTheDocument();
    expect(api.createStudy).not.toHaveBeenCalled();
  });

  it('hides the weights in Pareto mode', async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.getByLabelText('Head loss weight')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pareto front' }));
    expect(screen.queryByLabelText('Head loss weight')).not.toBeInTheDocument();
  });

  it('creates the study with the picked settings', async () => {
    const user = userEvent.setup();
    const created = { id: 's1', name: 'Width sweep' } as PublicStudy;
    vi.mocked(api.createStudy).mockResolvedValue(created);
    const { onDone } = renderForm();
    await user.type(screen.getByLabelText(/Study name/), 'Width sweep');
    await user.click(screen.getByRole('checkbox', { name: 'B Kammer' }));
    await user.click(screen.getByRole('checkbox', { name: 'HLE' }));
    await user.click(screen.getByRole('button', { name: 'Create study' }));
    await waitFor(() => expect(api.createStudy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createStudy).mock.calls[0]).toEqual([
      'p1',
      expect.objectContaining({
        name: 'Width sweep',
        base: { kind: 'save', saveId: 'save-1' },
        keys: ['width', 'hMiddle'],
        bandPct: 10,
        weights: { headLoss: 0.5, vortex: 0.5 },
        mode: 'weighted',
        vortexMetric: 'maskedQVolume',
        meshingSourceId: 'chamber-ref',
        maxEvaluations: 30,
        cores: 4,
      }),
    ]);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(created));
  });
});
