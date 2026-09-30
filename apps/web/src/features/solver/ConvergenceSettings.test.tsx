import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_CFD_CRITERIA, type CfdCriteriaResponse } from '@dive/shared';

/**
 * ConvergenceSettings tests: the collapsible "Convergence criteria" section of
 * the solver configuration panel (method, settings, patches, vortex metrics,
 * Save criteria), with the criteria API mocked.
 */

vi.mock('@/lib/api/projects', () => ({
  getCriteria: vi.fn(),
  saveCriteria: vi.fn(),
}));

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '@/lib/api/projects';
import { ConvergenceSettings } from './ConvergenceSettings';

const response: CfdCriteriaResponse = {
  criteria: structuredClone(DEFAULT_CFD_CRITERIA),
  patches: ['inlet', 'outlet', 'walls'],
  applicable: true,
  installed: false,
};

function renderSettings(active = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConvergenceSettings projectId="p1" active={active} />
    </QueryClientProvider>,
  );
}

async function expand() {
  await userEvent.click(await screen.findByRole('button', { name: /convergence criteria/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCriteria).mockResolvedValue(structuredClone(response));
  vi.mocked(api.saveCriteria).mockImplementation(async (_id, criteria) => ({
    criteria,
    installed: true,
  }));
});

describe('ConvergenceSettings', () => {
  it('is collapsed by default and summarises the current method', async () => {
    renderSettings();
    const toggle = await screen.findByRole('button', { name: /convergence criteria/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByText(/pressure drop, simple/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save criteria/i })).not.toBeInTheDocument();
  });

  it('shows the simple criterion fields with the tool defaults', async () => {
    renderSettings();
    await expand();
    expect(screen.getByRole('radio', { name: /pressure drop, simple/i })).toBeChecked();
    expect(screen.getByLabelText(/trailing window/i)).toHaveValue(100);
    expect(screen.getByLabelText(/deviation band/i)).toHaveValue(3);
    expect(screen.getByLabelText(/consecutive iterations/i)).toHaveValue(100);
    expect(screen.getByLabelText(/inlet patch/i)).toHaveValue('inlet');
    expect(screen.getByLabelText(/outlet patch/i)).toHaveValue('outlet');
  });

  it('switches to the robust fields and shows the residual floor help', async () => {
    renderSettings();
    await expand();
    await userEvent.click(screen.getByRole('radio', { name: /pressure drop, robust/i }));
    expect(screen.getByLabelText(/check window/i)).toHaveValue(100);
    expect(screen.getByLabelText(/mean tolerance/i)).toHaveValue(50);
    expect(screen.getByLabelText(/consecutive checks/i)).toHaveValue(2);
    expect(screen.getByLabelText(/residual gate/i)).toHaveValue(0.001);
    expect(screen.getByText(/just above your case's residual floor/i)).toBeInTheDocument();
  });

  it('saves the edited criteria (percent converted back to a fraction)', async () => {
    renderSettings();
    await expand();
    const band = screen.getByLabelText(/deviation band/i);
    await userEvent.clear(band);
    await userEvent.type(band, '2');
    const qThreshold = screen.getByLabelText(/q threshold/i);
    await userEvent.clear(qThreshold);
    await userEvent.type(qThreshold, '20');
    await userEvent.selectOptions(screen.getByLabelText(/outlet patch/i), 'walls');
    await userEvent.click(screen.getByRole('button', { name: /save criteria/i }));

    await waitFor(() => expect(api.saveCriteria).toHaveBeenCalledTimes(1));
    const [id, sent] = vi.mocked(api.saveCriteria).mock.calls[0];
    expect(id).toBe('p1');
    expect(sent.convergence.simplePDrop.devTol).toBeCloseTo(0.02);
    expect(sent.convergence.outletPatch).toBe('walls');
    expect(sent.vortex.qThreshold).toBe(20);
  });

  it('blocks the save on an invalid value and says why', async () => {
    renderSettings();
    await expand();
    const window = screen.getByLabelText(/trailing window/i);
    await userEvent.clear(window);
    await userEvent.type(window, '1');
    await userEvent.click(screen.getByRole('button', { name: /save criteria/i }));
    expect(await screen.findByText(/at least 2/i)).toBeInTheDocument();
    expect(api.saveCriteria).not.toHaveBeenCalled();
  });

  it('hides the vortex fields when vortex metrics are off', async () => {
    renderSettings();
    await expand();
    expect(screen.getByLabelText(/q threshold/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /track vortex metrics/i }));
    expect(screen.queryByLabelText(/q threshold/i)).not.toBeInTheDocument();
  });

  it('explains when the solver is not steady incompressible', async () => {
    vi.mocked(api.getCriteria).mockResolvedValue({ ...structuredClone(response), applicable: false });
    renderSettings();
    await expand();
    expect(
      screen.getByText('Convergence criteria apply to steady incompressible solvers (simpleFoam).'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save criteria/i })).not.toBeInTheDocument();
  });

  it('locks every control while a run is active', async () => {
    renderSettings(true);
    await expand();
    expect(screen.getByRole('radio', { name: /pressure drop, robust/i })).toBeDisabled();
    expect(screen.getByLabelText(/trailing window/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save criteria/i })).toBeDisabled();
  });
});
