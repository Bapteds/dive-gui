// Pure unit tests for the solver-log monitor parser (pressure drop, criterion
// progress, vortex metrics). The sample imitates an ESI v2406 simpleFoam log with
// the pressureLossMonitors / SimplePDropConvergence / convergenceControl /
// diveVortexMetrics function objects (the exact surfaceFieldValue wording is to
// validate on the server; the parser is tolerant).
import { describe, expect, it } from 'vitest';
import { parseMonitors } from '../src/lib/monitorParser';

const SIMPLE_LOG = `Starting time loop

Time = 1

smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 0.01, No Iterations 3
GAMG:  Solving for p, Initial residual = 0.5, Final residual = 0.001, No Iterations 12
ExecutionTime = 1 s  ClockTime = 1 s

pressure pTotal write:
surfaceFieldValue inlet_p0_flux write:
    total faces   = 120
    total area    = 0.5
    weightedAverage(inlet) of pTotal = 25000
    weightedAverage(inlet) of p = 20

surfaceFieldValue outlet_p0_flux write:
    total faces   = 80
    total area    = 0.4
    weightedAverage(outlet) of pTotal = 5000
    weightedAverage(outlet) of p = 1

surfaceFieldValue inlet_flux write:
    sum(inlet) of phi = -0.25

SimplePDropConvergence: filling window 1/100, dp0 = 20000 Pa

Time = 2

GAMG:  Solving for p, Initial residual = 0.4, Final residual = 0.001, No Iterations 12
surfaceFieldValue inlet_p0_flux write:
    weightedAverage(inlet) of pTotal = 24000
surfaceFieldValue outlet_p0_flux write:
    weightedAverage(outlet) of pTotal = 4500
garbage line = = with pTotal = nan-ish
SimplePDropConvergence: dp0 = 19500 Pa, mean = 19800 Pa, dev = 1.51515 %, consecutive = 34/100
diveVortexMetrics: time=2 qVolume=0.125 maskedQVolume=0.0625 omegaRms=41.5 coreVolume=0.1 coreCells=1234
diveVortexMetrics: time=2 qVolume=0.126 maskedQVolume=0.0626 omegaRms=41.6 coreVolume=0.1 coreCells=1235
End
`;

const ROBUST_LOG = `Time = 199
surfaceFieldValue inlet_p0_flux write:
    weightedAverage(inlet) of pTotal = 1100
surfaceFieldValue outlet_p0_flux write:
    weightedAverage(outlet) of pTotal = 100

Time = 200
surfaceFieldValue inlet_p0_flux write:
    weightedAverage(inlet) of pTotal = 1101
surfaceFieldValue outlet_p0_flux write:
    weightedAverage(outlet) of pTotal = 100
convergenceControl @ 200:  drift=12.5 Pa  trend=40 Pa  maxRes=0.0008  [mean:y slope:n res:y]  pass 1/2
`;

describe('parseMonitors', () => {
  it('pairs the inlet / outlet total pressures into one Dp0 per iteration', () => {
    const { pressureDrop } = parseMonitors(SIMPLE_LOG);
    expect(pressureDrop).toEqual([
      { time: 1, dp0: 20000 },
      { time: 2, dp0: 19500 },
    ]);
  });

  it('reads the latest SimplePDropConvergence progress', () => {
    const { criterion } = parseMonitors(SIMPLE_LOG);
    expect(criterion).toEqual({
      method: 'simplePDrop',
      consecutive: 34,
      required: 100,
      devPct: 1.51515,
      mean: 19800,
      filling: null,
    });
  });

  it('reports the window filling state before the first check', () => {
    const { criterion } = parseMonitors(
      'Time = 1\nSimplePDropConvergence: filling window 7/100, dp0 = 20000 Pa\n',
    );
    expect(criterion).toMatchObject({
      method: 'simplePDrop',
      consecutive: 0,
      required: null,
      filling: { filled: 7, size: 100 },
    });
  });

  it('reads the latest convergenceControl check with its gates', () => {
    const { criterion, pressureDrop } = parseMonitors(ROBUST_LOG);
    expect(criterion).toEqual({
      method: 'robust',
      time: 200,
      drift: 12.5,
      trend: 40,
      maxRes: 0.0008,
      passes: 1,
      required: 2,
      gates: { mean: true, slope: false, res: true },
    });
    expect(pressureDrop).toEqual([
      { time: 199, dp0: 1000 },
      { time: 200, dp0: 1001 },
    ]);
  });

  it('reads the vortex metrics, keeping the last line per time', () => {
    const { vortex } = parseMonitors(SIMPLE_LOG);
    expect(vortex).toEqual([
      {
        time: 2,
        qVolume: 0.126,
        maskedQVolume: 0.0626,
        omegaRms: 41.6,
        coreVolume: 0.1,
        coreCells: 1235,
      },
    ]);
  });

  it('falls back on the SimplePDropConvergence dp0 when the monitor lines are not recognised', () => {
    const log = `Time = 1
SimplePDropConvergence: filling window 1/100, dp0 = 20000 Pa
Time = 2
SimplePDropConvergence: dp0 = 19500 Pa, mean = 19800 Pa, dev = 1.5 %, consecutive = 0/100
`;
    expect(parseMonitors(log).pressureDrop).toEqual([
      { time: 1, dp0: 20000 },
      { time: 2, dp0: 19500 },
    ]);
  });

  it('returns empty monitors for a plain residual log or garbage', () => {
    expect(parseMonitors('Time = 1\nGAMG:  Solving for p, Initial residual = 0.5\n')).toEqual({
      pressureDrop: [],
      criterion: null,
      vortex: [],
    });
    expect(parseMonitors('random\n\u0000 bytes = = =\ndiveVortexMetrics: time=x\n')).toEqual({
      pressureDrop: [],
      criterion: null,
      vortex: [],
    });
  });

  it('downsamples a long pressure-drop series to the point cap', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 9000; i += 1) {
      lines.push(`Time = ${i}`);
      lines.push('surfaceFieldValue inlet_p0_flux write:');
      lines.push(`    weightedAverage(inlet) of pTotal = ${1000 + i}`);
      lines.push('surfaceFieldValue outlet_p0_flux write:');
      lines.push('    weightedAverage(outlet) of pTotal = 0');
    }
    const { pressureDrop } = parseMonitors(lines.join('\n'));
    expect(pressureDrop.length).toBeLessThanOrEqual(4000);
    expect(pressureDrop[pressureDrop.length - 1]).toEqual({ time: 9000, dp0: 10000 });
  });
});
