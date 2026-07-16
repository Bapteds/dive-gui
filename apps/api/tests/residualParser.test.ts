// Pure unit tests for the OpenFOAM residual parser — no HTTP, no filesystem.
import { describe, expect, it } from 'vitest';
import { downsampleResiduals, parseResiduals } from '../src/lib/residualParser';

const TWO_ITERATIONS = `/*--------- banner ---------*/
Starting time loop

Time = 1

smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 0.01, No Iterations 3
smoothSolver:  Solving for Uy, Initial residual = 0.9, Final residual = 0.01, No Iterations 3
GAMG:  Solving for p, Initial residual = 0.5, Final residual = 0.001, No Iterations 12
smoothSolver:  Solving for k, Initial residual = 0.3, Final residual = 0.001, No Iterations 2
smoothSolver:  Solving for omega, Initial residual = 0.2, Final residual = 0.001, No Iterations 2
time step continuity errors : sum local = 1e-9, global = 1e-19
ExecutionTime = 1 s

Time = 2

smoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 0.001, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.05, Final residual = 1e-5, No Iterations 8
`;

describe('parseResiduals', () => {
  it('keys one record per Time and captures each field Initial residual', () => {
    const { samples } = parseResiduals(TWO_ITERATIONS);
    expect(samples).toHaveLength(2);
    expect(samples[0].time).toBe(1);
    expect(samples[0].values).toMatchObject({ Ux: 1, Uy: 0.9, p: 0.5, k: 0.3, omega: 0.2 });
    expect(samples[1].time).toBe(2);
    expect(samples[1].values).toMatchObject({ Ux: 0.1, p: 0.05 });
  });

  it('ignores banners, continuity lines and ExecutionTime noise', () => {
    const { samples } = parseResiduals(TWO_ITERATIONS);
    // Only the residual fields land in values — no "ExecutionTime", "sum", etc.
    expect(Object.keys(samples[0].values).sort()).toEqual(['Ux', 'Uy', 'k', 'omega', 'p']);
  });

  it('detects the steady convergence banner', () => {
    const log = `${TWO_ITERATIONS}\nSIMPLE solution converged in 327 iterations\n`;
    const parsed = parseResiduals(log);
    expect(parsed.converged).toBe(true);
    expect(parsed.diverged).toBe(false);
  });

  it('flags divergence on a nan/inf residual and does not record it', () => {
    const log = `Time = 5\nGAMG:  Solving for p, Initial residual = nan, Final residual = nan\n`;
    const parsed = parseResiduals(log);
    expect(parsed.diverged).toBe(true);
    expect(parsed.samples).toHaveLength(0); // no finite value to record
  });

  it('flags inf residuals (any case, signed, or inside a vector) as divergence', () => {
    for (const token of ['inf', '-inf', 'Inf', '(nan', '(nan nan nan)']) {
      const log = `Time = 5\nGAMG:  Solving for p, Initial residual = ${token}\n`;
      expect(parseResiduals(log).diverged, token).toBe(true);
    }
  });

  it('does NOT diverge when an early non-finite residual clears and the run finishes', () => {
    // A field that starts uniform can print a 0/0 normalised residual on the first
    // iteration and then read finite forever after. That run finished fine: a sticky
    // "saw nan once" flag is what reported a healthy run as "diverged".
    const log = [
      'Time = 1',
      'GAMG:  Solving for p, Initial residual = nan, Final residual = nan, No Iterations 0',
      'Time = 2',
      'GAMG:  Solving for p, Initial residual = 0.02, Final residual = 1e-7, No Iterations 4',
      'Time = 3',
      'GAMG:  Solving for p, Initial residual = 0.001, Final residual = 1e-8, No Iterations 3',
      'End',
    ].join('\n');
    const parsed = parseResiduals(log);
    expect(parsed.diverged).toBe(false);
    expect(parsed.nonFiniteSeen).toBe(true); // still reported, just not fatal
    expect(parsed.samples).toHaveLength(2); // the nan iteration has nothing to chart
  });

  it('DOES diverge when the residuals go non-finite and never recover', () => {
    const log = [
      'Time = 1',
      'GAMG:  Solving for p, Initial residual = 0.5, Final residual = 1e-5, No Iterations 2',
      'Time = 2',
      'GAMG:  Solving for p, Initial residual = nan, Final residual = nan, No Iterations 0',
      'Time = 3',
      'GAMG:  Solving for p, Initial residual = nan, Final residual = nan, No Iterations 0',
    ].join('\n');
    const parsed = parseResiduals(log);
    expect(parsed.diverged).toBe(true);
    expect(parsed.nonFiniteSeen).toBe(true);
  });

  it('does NOT diverge when a run reaches its iteration cap with finite residuals', () => {
    // A steady run that hits endTime prints normal residuals then just stops —
    // no convergence banner, no nan/inf. It must read as finite, not diverged.
    const log = `${TWO_ITERATIONS}\nEnd\n`;
    const parsed = parseResiduals(log);
    expect(parsed.diverged).toBe(false);
    expect(parsed.converged).toBe(false);
  });

  it('records a vector residual (leading "(") without flagging divergence', () => {
    // Some fields on ESI OpenFOAM print U as a vector: "(0.012 0.008 0.005)".
    // The captured "(0.012" must be read as a finite component, never diverged.
    const log = `Time = 3\nsmoothSolver:  Solving for U, Initial residual = (0.012 0.008 0.005), Final residual = (1e-4 1e-4 1e-4)\n`;
    const parsed = parseResiduals(log);
    expect(parsed.diverged).toBe(false);
    expect(parsed.samples[0].values.U).toBeCloseTo(0.012);
  });

  it('flags a FOAM fatal error / floating point exception', () => {
    expect(parseResiduals('Foo\nFloating point exception\n').foamError).toBe(true);
    expect(parseResiduals('--> FOAM FATAL ERROR\n').foamError).toBe(true);
    expect(parseResiduals(TWO_ITERATIONS).foamError).toBe(false);
  });

  it('returns empty for input with no residual blocks', () => {
    const parsed = parseResiduals('hello\nworld\n');
    expect(parsed.samples).toHaveLength(0);
    expect(parsed.lastTime).toBeNull();
  });
});

describe('downsampleResiduals', () => {
  it('leaves a short series untouched', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ time: i, values: { p: 1 / (i + 1) } }));
    expect(downsampleResiduals(samples, 4000)).toHaveLength(10);
  });

  it('caps a long series and keeps the most recent points', () => {
    const samples = Array.from({ length: 10000 }, (_, i) => ({ time: i, values: { p: 1 } }));
    const out = downsampleResiduals(samples, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    // The very last iteration survives (dense tail).
    expect(out[out.length - 1].time).toBe(9999);
  });
});
