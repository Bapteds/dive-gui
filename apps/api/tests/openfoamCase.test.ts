// Unit tests for the OpenFOAM case helpers: boundary parsing, base-file
// rendering, and upload-path normalization. No HTTP / DB involved.
import { describe, expect, it } from 'vitest';
import {
  BASE_FILE_PATHS,
  collapseBoundaryToSinglePatch,
  fieldBcBody,
  parseBoundaryPatches,
  parseCellZoneNames,
  removeEmptyBoundaryPatches,
  renameCellZone,
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

describe('fieldBcBody (model-aware wall functions)', () => {
  it('gives a wall the k-omega wall functions (with a value entry)', () => {
    expect(fieldBcBody('U', 'wall')).toMatch(/type\s+noSlip;/);
    expect(fieldBcBody('p', 'wall')).toMatch(/type\s+zeroGradient;/);
    expect(fieldBcBody('nut', 'wall', 'kOmegaSST')).toContain('nutkWallFunction');
    expect(fieldBcBody('k', 'wall', 'kOmegaSST')).toContain('kqRWallFunction');
    expect(fieldBcBody('omega', 'wall', 'kOmegaSST')).toContain('omegaWallFunction');
    expect(fieldBcBody('nut', 'wall', 'kOmegaSST')).toMatch(/value\s+\$internalField/);
  });

  it('is model-aware: k-epsilon uses epsilon, never an omega wall function', () => {
    expect(fieldBcBody('epsilon', 'wall', 'kEpsilon')).toContain('epsilonWallFunction');
    // omega is not a k-epsilon field -> generic, no wall function.
    expect(fieldBcBody('omega', 'wall', 'kEpsilon')).toMatch(/type\s+zeroGradient;/);
    expect(fieldBcBody('omega', 'wall', 'kEpsilon')).not.toContain('WallFunction');
  });

  it('uses a Spalding wall function for nut when the model has no k (Spalart-Allmaras)', () => {
    expect(fieldBcBody('nut', 'wall', 'SpalartAllmaras')).toContain('nutUSpaldingWallFunction');
  });

  it('mirrors a constraint type and leaves plain patches / model-less walls generic', () => {
    expect(fieldBcBody('k', 'symmetry')).toMatch(/type\s+symmetry;/);
    expect(fieldBcBody('k', 'patch', 'kOmegaSST')).toMatch(/type\s+zeroGradient;/);
    // Without a model we do not guess a wall function.
    expect(fieldBcBody('nut', 'wall')).toMatch(/type\s+zeroGradient;/);
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

describe('parseCellZoneNames / renameCellZone', () => {
  const CELLZONES = `/*------------------------------*- C++ -*----------------------------------*\\
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       regIOobject;
    location    "constant/polyMesh";
    object      cellZones;
}
// * * * //
2
(
domain0
{
    type        cellZone;
    cellLabels  List<label>
3(0 1 2);
}
rotor
{
    type        cellZone;
    cellLabels  List<label>
2(3 4);
}
)
`;

  it('lists the cellZone names in file order (skipping the FoamFile header)', () => {
    expect(parseCellZoneNames(CELLZONES)).toEqual(['domain0', 'rotor']);
  });

  it('returns [] for a file with no cellZones', () => {
    expect(parseCellZoneNames('FoamFile { object cellZones; }\n0\n(\n)\n')).toEqual([]);
  });

  it('renames a zone header without touching its body or the other zones', () => {
    const out = renameCellZone(CELLZONES, 'domain0', 'casing');
    expect(parseCellZoneNames(out)).toEqual(['casing', 'rotor']);
    expect(out).toMatch(/type\s+cellZone;/); // body intact
    expect(out).not.toMatch(/\bdomain0\b/); // old header gone
  });
});
