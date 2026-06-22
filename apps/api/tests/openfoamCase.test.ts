// Unit tests for the OpenFOAM case helpers: boundary parsing, base-file
// rendering, and upload-path normalization. No HTTP / DB involved.
import { describe, expect, it } from 'vitest';
import {
  BASE_FILE_PATHS,
  parseBoundaryPatches,
  renderBaseFile,
} from '../src/lib/openfoamCase';
import { normalizeCasePaths } from '../src/lib/caseStorage';

const BOUNDARY = `/*--------------------------------*- C++ -*----------------------------------*\\
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    location    "constant/polyMesh";
    object      boundary;
}
// * * * //
3
(
    inlet
    {
        type            patch;
        nFaces          80;
        startFace       4500;
    }
    outlet
    {
        type            patch;
        nFaces          80;
        startFace       4580;
    }
    walls
    {
        type            wall;
        nFaces          200;
        startFace       4660;
    }
)
`;

describe('parseBoundaryPatches', () => {
  it('extracts patch names and ignores the FoamFile header', () => {
    expect(parseBoundaryPatches(BOUNDARY)).toEqual(['inlet', 'outlet', 'walls']);
  });

  it('returns an empty list for content with no patches', () => {
    expect(parseBoundaryPatches('FoamFile { object boundary; }\n0\n(\n)\n')).toEqual([]);
  });

  it('de-duplicates repeated names while preserving order', () => {
    const content = 'inlet\n{ type patch; }\ninlet\n{ type patch; }\noutlet\n{ type patch; }';
    expect(parseBoundaryPatches(content)).toEqual(['inlet', 'outlet']);
  });
});

describe('renderBaseFile', () => {
  it('renders a controlDict dictionary', () => {
    const content = renderBaseFile('system/controlDict', []);
    expect(content).toContain('object      controlDict;');
    expect(content).toContain('application');
  });

  it('renders 0/U as a volVectorField with one boundary entry per patch', () => {
    const content = renderBaseFile('0/U', ['inlet', 'outlet', 'walls']);
    expect(content).toContain('class       volVectorField;');
    expect(content).toContain('internalField   uniform (0 0 0);');
    expect(content).toContain('inlet');
    expect(content).toContain('outlet');
    expect(content).toContain('walls');
  });

  it('renders 0/p with an editable placeholder when no patches are known', () => {
    const content = renderBaseFile('0/p', []);
    expect(content).toContain('class       volScalarField;');
    expect(content).toContain('No mesh patches detected');
  });

  it('covers every declared base file path', () => {
    for (const path of BASE_FILE_PATHS) {
      expect(renderBaseFile(path, ['inlet']).length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeCasePaths', () => {
  it('nests a bare polyMesh folder under constant/', () => {
    expect(normalizeCasePaths(['polyMesh/points', 'polyMesh/boundary'])).toEqual([
      'constant/polyMesh/points',
      'constant/polyMesh/boundary',
    ]);
  });

  it('strips a wrapping case folder', () => {
    expect(
      normalizeCasePaths(['myCase/system/controlDict', 'myCase/constant/polyMesh/points']),
    ).toEqual(['system/controlDict', 'constant/polyMesh/points']);
  });

  it('keeps already case-relative paths unchanged', () => {
    expect(normalizeCasePaths(['system/controlDict', '0/U'])).toEqual([
      'system/controlDict',
      '0/U',
    ]);
  });

  it('strips a wrapper and then nests the inner polyMesh under constant/', () => {
    expect(normalizeCasePaths(['mesh/polyMesh/points', 'mesh/polyMesh/faces'])).toEqual([
      'constant/polyMesh/points',
      'constant/polyMesh/faces',
    ]);
  });

  it('rejects path traversal', () => {
    expect(() => normalizeCasePaths(['../evil'])).toThrow();
    expect(() => normalizeCasePaths(['a/../../evil'])).toThrow();
  });
});
