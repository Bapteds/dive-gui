// Pure unit tests for the convergence-criteria / vortex-metrics renderers
// (lib/cfdCriteria.ts). The rendered function objects must be the user's files
// (documents/Tools/ConvergenceFunctions) with only the USER INPUTS substituted.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CFD_CRITERIA, type CfdCriteriaSettings } from '@dive/shared';
import {
  DIVE_RESIDUAL_MARKER,
  defaultCfdCriteria,
  disableResidualControl,
  planCriteriaInstall,
  readManagedIncludes,
  renderConvergenceControl,
  renderDiveVortexMetrics,
  renderPressureLossMonitors,
  renderSimplePDropConvergence,
  restoreResidualControl,
  setManagedIncludes,
} from '../src/lib/cfdCriteria';
import { renderSolverFile } from '../src/lib/openfoamCase';

const TOOLS = path.resolve(__dirname, '../../../documents/Tools/ConvergenceFunctions');
const userFile = (name: string) => readFileSync(path.join(TOOLS, name), 'utf8');

/** Deep-cloned defaults with overrides applied to the convergence block. */
function settings(
  convergence: Partial<CfdCriteriaSettings['convergence']> = {},
  vortex: Partial<CfdCriteriaSettings['vortex']> = {},
): CfdCriteriaSettings {
  const base = structuredClone(DEFAULT_CFD_CRITERIA);
  return {
    convergence: { ...base.convergence, ...convergence },
    vortex: { ...base.vortex, ...vortex },
  };
}

/** Replace exactly one occurrence (fails the test if the template drifted). */
function replaceOnce(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  expect(count, `"${from}" occurrences`).toBe(1);
  return text.replace(from, to);
}

describe('function object renderers', () => {
  it('renders the user files byte-identical at the tool defaults', () => {
    const s = settings();
    expect(renderSimplePDropConvergence(s.convergence)).toBe(userFile('SimplePDropConvergence'));
    expect(renderConvergenceControl(s.convergence)).toBe(userFile('convergenceControl'));
    expect(renderPressureLossMonitors(s.convergence)).toBe(userFile('pressureLossMonitors'));
  });

  it('substitutes only the SimplePDropConvergence USER INPUTS', () => {
    const s = settings({
      inletPatch: 'in1',
      outletPatch: 'draftTubeOut',
      simplePDrop: { window: 250, devTol: 0.015, nPass: 60 },
    });
    let expected = userFile('SimplePDropConvergence');
    expected = replaceOnce(expected, 'inletPatch  = "inlet";', 'inletPatch  = "in1";');
    expected = replaceOnce(expected, 'outletPatch = "outlet";', 'outletPatch = "draftTubeOut";');
    expected = replaceOnce(expected, 'window = 100;', 'window = 250;');
    expected = replaceOnce(expected, 'devTol = 0.03;', 'devTol = 0.015;');
    expected = replaceOnce(expected, 'nPass  = 100;', 'nPass  = 60;');
    expect(renderSimplePDropConvergence(s.convergence)).toBe(expected);
  });

  it('substitutes only the convergenceControl USER INPUTS (and rho for the Pa factor)', () => {
    const s = settings({
      inletPatch: 'in1',
      outletPatch: 'out1',
      rho: 998.2,
      robust: { W: 150, tolMean: 25, K: 3, resTol: 2e-3 },
    });
    let expected = userFile('convergenceControl');
    expected = replaceOnce(expected, 'inletPatch  = "inlet";', 'inletPatch  = "in1";');
    expected = replaceOnce(expected, 'outletPatch = "outlet";', 'outletPatch = "out1";');
    expected = replaceOnce(expected, 'W       = 100;', 'W       = 150;');
    expected = replaceOnce(expected, 'tolMean = 50.0;', 'tolMean = 25.0;');
    expected = replaceOnce(expected, 'K       = 2;', 'K       = 3;');
    expected = replaceOnce(expected, 'resTol  = 1e-3;', 'resTol  = 2e-3;');
    expected = replaceOnce(expected, '*1000.0;', '*998.2;');
    expect(renderConvergenceControl(s.convergence)).toBe(expected);
  });

  it('substitutes the patch names and rhoInf in pressureLossMonitors, keeping the object names', () => {
    const s = settings({ inletPatch: 'in1', outletPatch: 'out1', rho: 998.2 });
    const expected = userFile('pressureLossMonitors')
      .replaceAll('name  inlet;', 'name  in1;')
      .replaceAll('name  outlet;', 'name  out1;')
      .replace('rhoInf          1000;', 'rhoInf          998.2;');
    const out = renderPressureLossMonitors(s.convergence);
    expect(out).toBe(expected);
    expect(out).toContain('inlet_p0_flux');
    expect(out).toContain('outlet_p0_flux');
  });

  it('renders diveVortexMetrics with the settings and v2406-safe calls only', () => {
    const out = renderDiveVortexMetrics(
      settings(
        {},
        {
          velocityField: 'Urel',
          qThreshold: 20,
          wallDistance: 0.05,
          qCrit: 2e4,
          vMin: 2e-10,
          interval: 25,
          writeFields: false,
        },
      ).vortex,
    );
    expect(out).toMatch(/^diveVortexMetrics\s*$/m);
    expect(out).toContain('type            coded;');
    expect(out).toContain('executeInterval 25;');
    expect(out).toContain('velocityField = "Urel";');
    expect(out).toContain('qThreshold    = 20.0;');
    expect(out).toContain('wallDistance  = 0.05;');
    expect(out).toContain('qCrit         = 20000.0;');
    expect(out).toContain('vMin          = 2e-10;');
    expect(out).toContain('writeFields   = false;');
    for (const call of ['fvc::grad', 'fvc::curl', 'wallDist::New', '.V()', 'reduce(']) {
      expect(out).toContain(call);
    }
    // The v2606-only volFieldValue cellZone shortcut is not used.
    expect(out).not.toMatch(/volFieldValue|cellZone/);
    expect(out).toContain('diveVortexMetrics: time=');
  });
});

const CONTROL_DICT_NO_FUNCTIONS = renderSolverFile('simpleFoam', 'system/controlDict', []);

const CONTROL_DICT_WITH_FUNCTIONS = `FoamFile { object controlDict; }
application     simpleFoam;
endTime         1000;

functions
{
    yPlus1 { type yPlus; libs (fieldFunctionObjects); }
    #include "pressureLossMonitors"
    #include "userThing"
}

// ************************************************************************* //
`;

describe('setManagedIncludes', () => {
  it('creates a functions block with the includes when missing', () => {
    const out = setManagedIncludes(CONTROL_DICT_NO_FUNCTIONS, [
      'pressureLossMonitors',
      'SimplePDropConvergence',
    ]);
    expect(out).toMatch(/functions\s*\{\s*#include "pressureLossMonitors"\s*#include "SimplePDropConvergence"\s*\}/);
    expect(readManagedIncludes(out)).toEqual(['pressureLossMonitors', 'SimplePDropConvergence']);
    // The rest of the controlDict is untouched.
    expect(out).toContain('application     simpleFoam;');
    expect(out.trimEnd().endsWith('// ************************************************************************* //')).toBe(true);
  });

  it('adds / removes only the managed includes and keeps unrelated entries', () => {
    const out = setManagedIncludes(CONTROL_DICT_WITH_FUNCTIONS, [
      'pressureLossMonitors',
      'convergenceControl',
      'diveVortexMetrics',
    ]);
    expect(out).toContain('yPlus1 { type yPlus; libs (fieldFunctionObjects); }');
    expect(out).toContain('#include "userThing"');
    expect(readManagedIncludes(out)).toEqual([
      'pressureLossMonitors',
      'convergenceControl',
      'diveVortexMetrics',
    ]);
    expect(out.match(/#include "pressureLossMonitors"/g)).toHaveLength(1);

    const removed = setManagedIncludes(out, []);
    expect(readManagedIncludes(removed)).toEqual([]);
    expect(removed).toContain('#include "userThing"');
    expect(removed).toContain('yPlus1');
  });

  it('is idempotent', () => {
    const includes = ['pressureLossMonitors', 'SimplePDropConvergence', 'diveVortexMetrics'];
    for (const base of [CONTROL_DICT_NO_FUNCTIONS, CONTROL_DICT_WITH_FUNCTIONS]) {
      const once = setManagedIncludes(base, includes);
      expect(setManagedIncludes(once, includes)).toBe(once);
    }
  });

  it('leaves a controlDict without functions untouched when nothing is managed', () => {
    expect(setManagedIncludes(CONTROL_DICT_NO_FUNCTIONS, [])).toBe(CONTROL_DICT_NO_FUNCTIONS);
  });
});

describe('residualControl disable / restore', () => {
  const fvSolution = renderSolverFile('simpleFoam', 'system/fvSolution', [], 'kOmegaSST');

  it('comments the block out with the DIVE marker and restores it verbatim', () => {
    expect(fvSolution).toContain('residualControl');
    const disabled = disableResidualControl(fvSolution);
    expect(disabled).toContain(DIVE_RESIDUAL_MARKER);
    // Outside the comment, no residualControl remains.
    const uncommented = disabled.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(uncommented).not.toMatch(/residualControl/);
    // SIMPLE and pRef stay (the runnable gate needs them).
    expect(uncommented).toMatch(/\bSIMPLE\b/);
    expect(uncommented).toMatch(/pRefCell/);

    expect(disableResidualControl(disabled)).toBe(disabled);
    expect(restoreResidualControl(disabled)).toBe(fvSolution);
    expect(restoreResidualControl(fvSolution)).toBe(fvSolution);
  });
});

describe('defaults and install plan', () => {
  it('picks patches named inlet / outlet, else the first two patch-type patches', () => {
    const named = defaultCfdCriteria([
      { name: 'walls', type: 'wall' },
      { name: 'outlet', type: 'patch' },
      { name: 'inlet', type: 'patch' },
    ]);
    expect(named.convergence.inletPatch).toBe('inlet');
    expect(named.convergence.outletPatch).toBe('outlet');
    expect(named.convergence.method).toBe('simplePDrop');

    const firstTwo = defaultCfdCriteria([
      { name: 'walls', type: 'wall' },
      { name: 'in1', type: 'patch' },
      { name: 'out1', type: 'patch' },
    ]);
    expect(firstTwo.convergence.inletPatch).toBe('in1');
    expect(firstTwo.convergence.outletPatch).toBe('out1');

    // Not enough patches: the pressure-drop criteria cannot run, fall back to residuals.
    const none = defaultCfdCriteria([{ name: 'walls', type: 'wall' }]);
    expect(none.convergence.method).toBe('residuals');
  });

  it('plans the files, includes and residualControl action per method', () => {
    const patches = ['inlet', 'outlet', 'walls'];
    const simple = planCriteriaInstall(settings(), patches);
    expect(simple.includes).toEqual([
      'pressureLossMonitors',
      'SimplePDropConvergence',
      'diveVortexMetrics',
    ]);
    expect(simple.residualControl).toBe('restore');
    expect(Object.keys(simple.files).sort()).toEqual([
      'system/SimplePDropConvergence',
      'system/diveVortexMetrics',
      'system/pressureLossMonitors',
    ]);

    const robust = planCriteriaInstall(settings({ method: 'robust' }, { enabled: false }), patches);
    expect(robust.includes).toEqual(['pressureLossMonitors', 'convergenceControl']);
    expect(robust.residualControl).toBe('disable');

    const residuals = planCriteriaInstall(settings({ method: 'residuals' }, { enabled: false }), patches);
    expect(residuals.includes).toEqual([]);

    // Residuals + vortex on: Dp0 is still monitored (plotted) when the patches exist.
    const residualsVortex = planCriteriaInstall(settings({ method: 'residuals' }), patches);
    expect(residualsVortex.includes).toEqual(['pressureLossMonitors', 'diveVortexMetrics']);
    const residualsNoPatches = planCriteriaInstall(settings({ method: 'residuals' }), ['walls']);
    expect(residualsNoPatches.includes).toEqual(['diveVortexMetrics']);
  });

  it('refuses an unknown patch or inlet = outlet for the pressure-drop methods', () => {
    expect(() => planCriteriaInstall(settings({ inletPatch: 'nope' }), ['inlet', 'outlet'])).toThrow(
      /nope/,
    );
    expect(() =>
      planCriteriaInstall(settings({ inletPatch: 'inlet', outletPatch: 'inlet' }), ['inlet', 'outlet']),
    ).toThrow(/differ/);
  });
});
