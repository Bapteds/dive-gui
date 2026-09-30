import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VortexMetricsSample } from '@dive/shared';
import { VortexChart } from './VortexChart';

const samples: VortexMetricsSample[] = [
  { time: 50, qVolume: 0.2, maskedQVolume: 0.1, omegaRms: 40, coreVolume: 0.15, coreCells: 40 },
  { time: 100, qVolume: 0.25, maskedQVolume: 0.126, omegaRms: 41.6, coreVolume: 0.16, coreCells: 42 },
];

describe('VortexChart', () => {
  it('shows a teaching empty state before any sample', () => {
    render(<VortexChart samples={[]} canCompute={false} computing={false} onCompute={() => {}} />);
    expect(screen.getByText(/no vortex metrics yet/i)).toBeInTheDocument();
  });

  it('shows the latest masked Q volume and RMS vorticity', () => {
    render(<VortexChart samples={samples} canCompute={false} computing={false} onCompute={() => {}} />);
    expect(screen.getByText('0.126 m³')).toBeInTheDocument();
    expect(screen.getByText('41.6 1/s')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /vortex metrics by iteration/i })).toBeInTheDocument();
  });

  it('offers Compute at latest time on a finished run', async () => {
    const onCompute = vi.fn();
    const { rerender } = render(
      <VortexChart samples={samples} canCompute={false} computing={false} onCompute={onCompute} />,
    );
    expect(screen.queryByRole('button', { name: /compute at latest time/i })).not.toBeInTheDocument();

    rerender(<VortexChart samples={samples} canCompute computing={false} onCompute={onCompute} />);
    await userEvent.click(screen.getByRole('button', { name: /compute at latest time/i }));
    expect(onCompute).toHaveBeenCalledTimes(1);
  });

  it('offers the values as a table', () => {
    render(<VortexChart samples={samples} canCompute={false} computing={false} onCompute={() => {}} />);
    expect(screen.getByText(/show vortex metric values/i)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});
