// Unit tests for the cfMesh meshDict renderer + base-size resolver (pure).
import { describe, expect, it } from 'vitest';
import { DEFAULT_CFMESH_CONFIG, type CfMeshConfig } from '@dive/shared';
import { renderMeshDict, resolveMaxCellSize } from '../src/lib/cfMeshDicts';

const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

function config(overrides: Partial<CfMeshConfig> = {}): CfMeshConfig {
  return { ...DEFAULT_CFMESH_CONFIG, ...overrides };
}

describe('resolveMaxCellSize', () => {
  it('uses the configured size when set', () => {
    expect(resolveMaxCellSize(config({ maxCellSize: 0.5 }), BOUNDS)).toBeCloseTo(0.5, 6);
  });

  it('derives diagonal/40 from the bounds when unset', () => {
    // diagonal of a 10^3 box = sqrt(300) ~= 17.32 -> /40 ~= 0.433.
    expect(resolveMaxCellSize(config({ maxCellSize: null }), BOUNDS)).toBeCloseTo(0.433, 2);
  });

  it('returns null when there is neither a size nor bounds (FMS input)', () => {
    expect(resolveMaxCellSize(config({ maxCellSize: null }), null)).toBeNull();
  });
});

describe('renderMeshDict', () => {
  it('writes the surfaceFile and base size, omitting unset optionals', () => {
    const dict = renderMeshDict(config({ minCellSize: null, boundaryCellSize: null }), '.work/combined.fms', 0.4);
    expect(dict).toContain('surfaceFile ".work/combined.fms";');
    expect(dict).toContain('maxCellSize 0.4;');
    expect(dict).not.toContain('minCellSize');
    expect(dict).not.toContain('boundaryLayers');
  });

  it('writes a renameBoundary block for assigned patch types only', () => {
    const dict = renderMeshDict(
      config({ patchTypes: { inlet: 'patch', walls: 'wall' } }),
      'constant/triSurface/x.fms',
      0.4,
    );
    expect(dict).toContain('renameBoundary');
    expect(dict).toContain('"inlet"');
    expect(dict).toContain('type    patch;');
    expect(dict).toContain('"walls"');
    expect(dict).toContain('type    wall;');
  });

  it('omits renameBoundary when no patch type is assigned', () => {
    const dict = renderMeshDict(config({ patchTypes: {} }), 'x.fms', 0.4);
    expect(dict).not.toContain('renameBoundary');
  });

  it('emits refinement sizes and a boundary-layer block when set', () => {
    const dict = renderMeshDict(
      config({
        minCellSize: 0.05,
        boundaryCellSize: 0.1,
        addLayers: { enabled: true, nLayers: 4, thicknessRatio: 1.3, maxFirstLayerThickness: 0.01 },
      }),
      'constant/triSurface/combined.fms',
      0.4,
    );
    expect(dict).toContain('minCellSize 0.05;');
    expect(dict).toContain('boundaryCellSize 0.1;');
    expect(dict).toContain('boundaryLayers');
    expect(dict).toContain('nLayers 4;');
    expect(dict).toContain('thicknessRatio 1.3;');
    expect(dict).toContain('maxFirstLayerThickness 0.01;');
  });
});
