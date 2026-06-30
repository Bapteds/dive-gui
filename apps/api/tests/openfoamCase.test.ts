// Unit tests for the OpenFOAM case helpers: boundary parsing, base-file
// rendering, and upload-path normalization. No HTTP / DB involved.
import { describe, expect, it } from 'vitest';
import {
  BASE_FILE_PATHS,
  collapseBoundaryToSinglePatch,
  parseBoundaryPatches,
  removeEmptyBoundaryPatches,
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

describe('collapseBoundaryToSinglePatch', () => {
  it('merges every patch into one covering all boundary faces', () => {
    const collapsed = collapseBoundaryToSinglePatch(BOUNDARY);
    expect(parseBoundaryPatches(collapsed)).toEqual(['defaultFaces']);
    // nFaces = 80 + 80 + 200; startFace = min(4500, 4580, 4660).
    expect(collapsed).toMatch(/nFaces\s+360/);
    expect(collapsed).toMatch(/startFace\s+4500/);
    expect(collapsed).toContain('class       polyBoundaryMesh'); // FoamFile header kept
  });

  it('returns the content unchanged when there are no patch face ranges', () => {
    const empty = 'FoamFile { object boundary; }\n0\n(\n)\n';
    expect(collapseBoundaryToSinglePatch(empty)).toBe(empty);
  });
});

describe('removeEmptyBoundaryPatches', () => {
  const WITH_EMPTY = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    defaultFaces { type patch; nFaces 0; startFace 100; }
    auto0 { type patch; nFaces 12; startFace 100; }
    auto1 { type wall; nFaces 20; startFace 112; }
)
`;

  it('drops zero-face patches and renumbers the count', () => {
    const cleaned = removeEmptyBoundaryPatches(WITH_EMPTY);
    expect(parseBoundaryPatches(cleaned)).toEqual(['auto0', 'auto1']);
    expect(cleaned).not.toMatch(/defaultFaces\s*\{/);
    expect(cleaned).toMatch(/\n2\n\(/); // count updated to 2
  });

  it('returns the content unchanged when no patch is empty', () => {
    expect(removeEmptyBoundaryPatches(BOUNDARY)).toBe(BOUNDARY);
  });

  it('keeps a populated hyphenated patch and drops the empty one (Fluent zone names)', () => {
    const withHyphens = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    wall-1 { type wall; nFaces 30; startFace 100; }
    iface-2 { type patch; nFaces 0; startFace 130; }
    outlet { type patch; nFaces 8; startFace 130; }
)
`;
    const cleaned = removeEmptyBoundaryPatches(withHyphens);
    expect(cleaned).toMatch(/wall-1\s*\{/); // the hyphenated populated patch survives
    expect(cleaned).toMatch(/outlet\s*\{/);
    expect(cleaned).not.toMatch(/iface-2\s*\{/); // the empty one is dropped
    expect(cleaned).toMatch(/\n2\n\(/); // count updated to 2
  });
});

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
