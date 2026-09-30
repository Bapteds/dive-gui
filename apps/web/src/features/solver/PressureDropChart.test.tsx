import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_CFD_CRITERIA, type PressureDropSample } from '@dive/shared';
import { PressureDropChart } from './PressureDropChart';

const convergence = DEFAULT_CFD_CRITERIA.convergence;

const samples: PressureDropSample[] = [
  { time: 1, dp0: 19900 },
  { time: 2, dp0: 19800 },
  { time: 3, dp0: 19700 },
];

describe('PressureDropChart', () => {
  it('shows a teaching empty state before any sample', () => {
    render(<PressureDropChart samples={[]} criterion={null} convergence={convergence} />);
    expect(screen.getByText(/no pressure drop yet/i)).toBeInTheDocument();
  });

  it('shows the latest pressure drop in Pa and as a head in m', () => {
    render(<PressureDropChart samples={samples} criterion={null} convergence={convergence} />);
    expect(screen.getByText('19700 Pa')).toBeInTheDocument();
    // H = dp0 / (rho g) = 19700 / (1000 * 9.81)
    expect(screen.getByText('2.008 m')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /pressure drop by iteration/i })).toBeInTheDocument();
  });

  it('reports the simple criterion progress', () => {
    render(
      <PressureDropChart
        samples={samples}
        criterion={{
          method: 'simplePDrop',
          consecutive: 34,
          required: 100,
          devPct: 1.2,
          mean: 19800,
          filling: null,
        }}
        convergence={convergence}
      />,
    );
    expect(screen.getByText('34 / 100 consecutive iterations within ±3 %')).toBeInTheDocument();
  });

  it('reports the window filling state', () => {
    render(
      <PressureDropChart
        samples={samples}
        criterion={{
          method: 'simplePDrop',
          consecutive: 0,
          required: null,
          devPct: null,
          mean: null,
          filling: { filled: 3, size: 100 },
        }}
        convergence={convergence}
      />,
    );
    expect(screen.getByText('Filling the averaging window: 3 / 100 iterations')).toBeInTheDocument();
  });

  it('reports the robust criterion check', () => {
    render(
      <PressureDropChart
        samples={samples}
        criterion={{
          method: 'robust',
          time: 200,
          drift: 12.5,
          trend: 40,
          maxRes: 0.0008,
          passes: 1,
          required: 2,
          gates: { mean: true, slope: false, res: true },
        }}
        convergence={{ ...convergence, method: 'robust' }}
      />,
    );
    expect(
      screen.getByText('Check 1 / 2: drift 12.5 Pa, trend 40 Pa, max residual 8.0e-4'),
    ).toBeInTheDocument();
  });

  it('zooms on the last 500 iterations', async () => {
    const long = Array.from({ length: 800 }, (_, i) => ({ time: i + 1, dp0: 20000 - i }));
    render(<PressureDropChart samples={long} criterion={null} convergence={convergence} />);
    expect(screen.getByRole('img', { name: /iterations 1 to 800/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /last 500 iterations/i }));
    expect(screen.getByRole('img', { name: /iterations 301 to 800/i })).toBeInTheDocument();
  });

  it('offers the values as a table', () => {
    render(<PressureDropChart samples={samples} criterion={null} convergence={convergence} />);
    expect(screen.getByText(/show pressure drop values/i)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});
