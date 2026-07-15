// Unit tests for the sweep objective helpers (lib/objective): idempotent
// functionObject injection into controlDict, surfaceFieldValue .dat parsing, and the
// pressure-drop -> Pa/head-loss conversion. Pure text/number code — no HTTP / OpenFOAM.
import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  injectObjectiveFunctions,
  parseSurfaceFieldValueDat,
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
});

describe('parseSurfaceFieldValueDat', () => {
  it('returns the last data row value, skipping # comment lines', () => {
    const dat = `# Region type : patch inlet
# Time          weightedAverage(divePTot)
0               12.5
1               11.2
2               10.8
`;
    expect(parseSurfaceFieldValueDat(dat)).toBeCloseTo(10.8, 10);
  });

  it('returns null when there are no data rows', () => {
    expect(parseSurfaceFieldValueDat('# only a header\n')).toBeNull();
    expect(parseSurfaceFieldValueDat('')).toBeNull();
  });
});

describe('computeMetrics', () => {
  it('converts the kinematic total-pressure drop to Pa and head loss', () => {
    const m = computeMetrics(10, 4, 1000); // dpKin = 6
    expect(m.pressureDropPa).toBeCloseTo(6000, 6); // 6 * 1000
    expect(m.headLossM).toBeCloseTo(6 / 9.81, 10);
  });

  it('uses the magnitude of the drop (sign-convention robust)', () => {
    const m = computeMetrics(4, 10, 1000); // outlet higher -> still a 6 magnitude
    expect(m.pressureDropPa).toBeCloseTo(6000, 6);
  });
});
