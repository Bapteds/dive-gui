// Unit tests for the snappy dictionary renderers + domain computation (pure).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SNAPPY_CONFIG, type SnappyConfig } from '@dive/shared';
import {
  computeDomain,
  regionNameFor,
  renderBlockMeshDict,
  renderSnappyHexMeshDict,
  renderSurfaceFeatureExtractDict,
} from '../src/lib/snappyDicts';

const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

function config(overrides: Partial<SnappyConfig> = {}): SnappyConfig {
  return { ...DEFAULT_SNAPPY_CONFIG, ...overrides };
}

describe('computeDomain', () => {
  it('pads the box and derives the cell counts from the base cell size', () => {
    const domain = computeDomain(BOUNDS, config({ baseCellSize: 1, marginFactor: 0.1 }));
    // diagonal = sqrt(300) ~= 17.32; pad = 1.732 -> box spans -1.732 .. 11.732 (13.46)
    expect(domain.boxMin[0]).toBeCloseTo(-1.732, 2);
    expect(domain.boxMax[0]).toBeCloseTo(11.732, 2);
    // ~13.46 / 1 -> 13 cells per axis.
    expect(domain.counts[0]).toBe(13);
  });

  it('places the keep-point at the bbox centre for an internal domain', () => {
    const domain = computeDomain(BOUNDS, config({ domainType: 'internal' }));
    expect(domain.locationInMesh).toEqual([5, 5, 5]);
  });

  it('places the keep-point in a box corner (outside the surface) for external', () => {
    const domain = computeDomain(BOUNDS, config({ domainType: 'external' }));
    // Strictly less than the STL min on every axis -> outside the geometry.
    expect(domain.locationInMesh[0]).toBeLessThan(BOUNDS.min[0]);
    expect(domain.locationInMesh[1]).toBeLessThan(BOUNDS.min[1]);
    expect(domain.locationInMesh[2]).toBeLessThan(BOUNDS.min[2]);
  });

  it('honours an explicit keep-point over the derived one', () => {
    const domain = computeDomain(BOUNDS, config({ locationInMesh: [1, 2, 3] }));
    expect(domain.locationInMesh).toEqual([1, 2, 3]);
  });
});

describe('regionNameFor', () => {
  it('strips the extension and non-word characters', () => {
    expect(regionNameFor('rotor.stl')).toBe('rotor');
    expect(regionNameFor('draft tube-1.STL')).toBe('draft_tube_1');
  });
});

describe('dict renderers', () => {
  const domain = computeDomain(BOUNDS, config({ baseCellSize: 2 }));

  it('renders a blockMeshDict with the padded box vertices and counts', () => {
    const dict = renderBlockMeshDict(domain);
    expect(dict).toContain('object      blockMeshDict;');
    expect(dict).toContain('hex (0 1 2 3 4 5 6 7)');
    expect(dict).toContain('domainBoundary');
  });

  it('renders one feature-extraction block per STL', () => {
    const dict = renderSurfaceFeatureExtractDict(['rotor.stl', 'stator.stl']);
    expect(dict).toContain('rotor.stl');
    expect(dict).toContain('stator.stl');
    expect(dict).toContain('extractFromSurface');
  });

  it('renders a snappyHexMeshDict wiring each region, feature, and location', () => {
    const dict = renderSnappyHexMeshDict(['rotor.stl'], domain, config({ featureLevel: 3 }));
    expect(dict).toContain('type triSurfaceMesh; name rotor;');
    expect(dict).toContain('file "rotor.eMesh"; level 3;');
    expect(dict).toContain('locationInMesh');
    expect(dict).toContain('addLayers       false;');
  });

  it('references the eMesh by the STL stem verbatim (hyphens preserved)', () => {
    // The feature file basename is the stem the extractor wrote, so a hyphenated
    // name must be referenced with its hyphen even though the region is sanitized.
    const dict = renderSnappyHexMeshDict(['draft-tube.stl'], domain, config());
    expect(dict).toContain('name draft_tube;');
    expect(dict).toContain('file "draft-tube.eMesh"');
  });

  it('enables layers when requested', () => {
    const dict = renderSnappyHexMeshDict(
      ['rotor.stl'],
      domain,
      config({ addLayers: { enabled: true, nLayers: 4 } }),
    );
    expect(dict).toContain('addLayers       true;');
    expect(dict).toContain('nSurfaceLayers 4;');
  });
});
