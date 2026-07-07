// The solver catalog is generated from SOLVER_LIBRARY: every library solver is
// guided (has a spec), with the incompressible/compressible/supersonic families as
// full templates and the rest as base scaffolds. These lock that contract.
import { describe, expect, it } from 'vitest';
import { SOLVER_CATALOG, SOLVER_LIBRARY, isConfigurableSolver } from '@dive/shared';

const FULL_CATEGORIES = new Set(['incompressible', 'compressible', 'supersonic']);

describe('solver catalog (all solvers guided)', () => {
  it('has a spec for every library solver and marks them configurable', () => {
    for (const info of SOLVER_LIBRARY) {
      expect(SOLVER_CATALOG[info.id], info.id).toBeDefined();
      expect(isConfigurableSolver(info.id), info.id).toBe(true);
    }
  });

  it('keeps foamRun and unknown ids out', () => {
    expect(isConfigurableSolver('foamRun')).toBe(false);
    expect(isConfigurableSolver('notARealSolver')).toBe(false);
  });

  it('tiers full templates by family, everything else as base', () => {
    for (const info of SOLVER_LIBRARY) {
      const spec = SOLVER_CATALOG[info.id];
      expect(spec.tier, info.id).toBe(FULL_CATEGORIES.has(info.category) ? 'full' : 'base');
    }
  });

  it('gives every guided solver a runnable file set and the universal knobs', () => {
    for (const info of SOLVER_LIBRARY) {
      const spec = SOLVER_CATALOG[info.id];
      expect(spec.requiredFiles, info.id).toContain('system/controlDict');
      expect(spec.requiredFiles, info.id).toContain('0/U');
      const keys = spec.easyParams.map((param) => param.key);
      expect(keys, info.id).toContain('endTime');
      expect(keys, info.id).toContain('writeInterval');
      // Transient solvers expose a time step; steady full templates expose convergence.
      if (spec.regime === 'transient') expect(keys, info.id).toContain('deltaT');
    }
  });

  it('exposes physics knobs only on the full incompressible/compressible templates', () => {
    const simpleFoam = SOLVER_CATALOG['simpleFoam'];
    expect(simpleFoam.easyParams.map((p) => p.key)).toContain('nu');
    const rhoSimpleFoam = SOLVER_CATALOG['rhoSimpleFoam'];
    expect(rhoSimpleFoam.easyParams.map((p) => p.key)).toContain('mu');
    // A base-tier flow solver shows turbulence but not the single-fluid nu.
    const interFoam = SOLVER_CATALOG['interFoam'];
    expect(interFoam.tier).toBe('base');
    expect(interFoam.easyParams.map((p) => p.key)).toContain('rasModel');
    expect(interFoam.easyParams.map((p) => p.key)).not.toContain('nu');
  });

  it('offers the SIMPLEC (consistent) toggle only on full steady templates', () => {
    // simpleFoam / rhoSimpleFoam are steady full templates: their SIMPLE block
    // carries `consistent`, so the toggle writes into an existing key.
    const consistent = (id: string) =>
      SOLVER_CATALOG[id].easyParams.some(
        (p) => p.key === 'consistent' && p.file === 'system/fvSolution',
      );
    expect(consistent('simpleFoam')).toBe(true);
    expect(consistent('rhoSimpleFoam')).toBe(true);
    // Not on a transient full template (PIMPLE has no `consistent`)...
    expect(consistent('pimpleFoam')).toBe(false);
    // ...nor on a base-tier flow solver (universal knobs only).
    expect(consistent('interFoam')).toBe(false);
  });
});
