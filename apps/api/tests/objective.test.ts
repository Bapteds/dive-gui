// Unit tests for the sweep objective helpers (lib/objective): idempotent
// functionObject injection into controlDict, surfaceFieldValue .dat parsing, and the
// pressure-drop -> Pa/head-loss conversion. Pure text/number code — no HTTP / OpenFOAM.
import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  injectObjectiveFunctions,
  parseSurfaceFieldValueDat,
  removeObjectiveFunctions,
} from '../src/lib/objective';

const CONTROLDICT_NO_FUNCTIONS = `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}
application     simpleFoam;
endTime         2000;
writeInterval   50;

// ************************************************************************* //
`;

const CONTROLDICT_WITH_FUNCTIONS = `FoamFile
{
    class       dictionary;
    object      controlDict;
}
application     simpleFoam;

functions
{
    solverInfo
    {
        type            solverInfo;
        libs            (utilityFunctionObjects);
        fields          (U p);
    }
}
// ************************************************************************* //
`;

describe('injectObjectiveFunctions', () => {
  it('adds a functions{} block when the dict has none, keyed to the patches', () => {
    const out = injectObjectiveFunctions(CONTROLDICT_NO_FUNCTIONS, 'inletA', 'outletB');
    expect(out).toMatch(/functions\s*\{/);
    expect(out).toContain('surfaceFieldValue');
    expect(out).toContain('weightedAverage');
    expect(out).toContain('name        inletA;');
    expect(out).toContain('name        outletB;');
    // the pressure FO precedes the probes (so its field exists when they execute)
    expect(out.indexOf('type    pressure;')).toBeLessThan(out.indexOf('diveObjInlet'));
  });

  it('inserts into an existing functions{} without dropping the case FOs', () => {
    const out = injectObjectiveFunctions(CONTROLDICT_WITH_FUNCTIONS, 'in', 'out');
    expect(out).toContain('solverInfo'); // existing FO preserved
    expect(out).toContain('diveObjInlet');
    expect(out).toContain('name        in;');
  });

  it('is idempotent — re-injecting replaces the marked region (no duplication)', () => {
    const once = injectObjectiveFunctions(CONTROLDICT_WITH_FUNCTIONS, 'in', 'out');
    const twice = injectObjectiveFunctions(once, 'in2', 'out2');
    expect(twice.match(/dive-optimisation objective \(auto-generated\)/g)).toHaveLength(1);
    expect(twice).toContain('name        in2;');
    expect(twice).not.toContain('name        in;'); // old patch names gone
    expect(twice).toContain('solverInfo'); // still preserved
  });

  it('omits the auto-stop control by default, includes it when asked', () => {
    const plain = injectObjectiveFunctions(CONTROLDICT_WITH_FUNCTIONS, 'in', 'out');
    expect(plain).not.toContain('runTimeControl');
    const withStop = injectObjectiveFunctions(CONTROLDICT_WITH_FUNCTIONS, 'in', 'out', true);
    expect(withStop).toContain('diveAutoStop');
    expect(withStop).toContain('type            runTimeControl');
    expect(withStop).toContain('functionObject  diveObjInlet');
    expect(withStop).toContain('functionObject  diveObjOutlet');
    // Inside the marked region, so removeObjectiveFunctions strips it too.
    const cleaned = removeObjectiveFunctions(withStop);
    expect(cleaned).not.toContain('runTimeControl');
    // And re-injecting WITHOUT the flag drops it (idempotent replace).
    const downgraded = injectObjectiveFunctions(withStop, 'in', 'out', false);
    expect(downgraded).not.toContain('runTimeControl');
  });
});

describe('parseSurfaceFieldValueDat', () => {
  it('returns the full (time, value) series, skipping # comment lines', () => {
    const dat = `# Region type : patch inlet
# Time          weightedAverage(divePTot)
0               12.5
1               11.2
2               10.8
`;
    expect(parseSurfaceFieldValueDat(dat)).toEqual([
      { time: 0, value: 12.5 },
      { time: 1, value: 11.2 },
      { time: 2, value: 10.8 },
    ]);
  });

  it('returns [] when there are no data rows', () => {
    expect(parseSurfaceFieldValueDat('# only a header\n')).toEqual([]);
    expect(parseSurfaceFieldValueDat('')).toEqual([]);
  });
});

/** Build a (time, value) series from plain numbers, times 1..n. */
const series = (...values: number[]) => values.map((value, i) => ({ time: i + 1, value }));

describe('computeMetrics', () => {
  it('converts the kinematic total-pressure drop to Pa and head loss', () => {
    const m = computeMetrics(series(10), series(4), 1000); // dpKin = 6
    expect(m?.pressureDropPa).toBeCloseTo(6000, 6); // 6 * 1000
    expect(m?.headLossM).toBeCloseTo(6 / 9.81, 10);
  });

  it('uses the magnitude of the drop (sign-convention robust)', () => {
    const m = computeMetrics(series(4), series(10), 1000); // outlet higher -> still 6
    expect(m?.pressureDropPa).toBeCloseTo(6000, 6);
  });

  it('tail-averages an OSCILLATING drop instead of reading the last row', () => {
    // Drop oscillates 4 <-> 8 around a true mean of 6. The last row alone would read
    // 8 (a 33% error); the tail mean recovers 6 with an honest sigma of 2.
    const inlet = series(14, 8, 14, 8, 14, 8, 14, 8);
    const outlet = series(6, 4, 6, 4, 6, 4, 6, 4); // drop: 8,4,8,4,...
    const m = computeMetrics(inlet, outlet, 1000);
    expect(m?.pressureDropPa).toBeCloseTo(6000, 6);
    expect(m?.pressureDropStdPa).toBeCloseTo(2000, 6);
    expect(m?.averagedIterations).toBe(4); // the last half of 8 joined rows
  });

  it('is unchanged on a converged run (constant tail: mean == last value, sigma 0)', () => {
    const inlet = series(12, 11, 10, 10, 10, 10);
    const outlet = series(5, 4.5, 4, 4, 4, 4);
    const m = computeMetrics(inlet, outlet, 1000);
    expect(m?.pressureDropPa).toBeCloseTo(6000, 6);
    expect(m?.pressureDropStdPa).toBeCloseTo(0, 10);
  });

  it('joins rows on the time key (unmatched rows are dropped)', () => {
    const inlet = [
      { time: 1, value: 10 },
      { time: 2, value: 10 },
      { time: 3, value: 10 },
    ];
    const outlet = [
      { time: 2, value: 4 },
      { time: 3, value: 4 },
    ]; // no outlet row at t=1
    const m = computeMetrics(inlet, outlet, 1000);
    expect(m?.pressureDropPa).toBeCloseTo(6000, 6);
    expect(m?.averagedIterations).toBe(1); // 2 joined rows -> tail = last 1
  });

  it('returns null when the series never overlap (patch mismatch)', () => {
    expect(computeMetrics(series(10), [], 1000)).toBeNull();
    expect(computeMetrics([], series(4), 1000)).toBeNull();
  });
});
