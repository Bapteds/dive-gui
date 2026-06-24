import { describe, expect, it } from 'vitest';
import { foamEasyModeAvailable, matchFoamFileDef } from './foamForm';

const CONTROL_DICT = `FoamFile { class dictionary; object controlDict; }
application simpleFoam;
writeFormat binary;
`;

const FIELD_U = `FoamFile { class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
boundaryField { inlet { type noSlip; } }
`;

// polyMesh/boundary is a list format, not a key/value dictionary.
const BOUNDARY_LIST = `FoamFile { class polyBoundaryMesh; object boundary; }
1
(
    inlet { type patch; nFaces 10; startFace 100; }
)
`;

describe('matchFoamFileDef', () => {
  it('matches a file by its FoamFile object', () => {
    expect(matchFoamFileDef(CONTROL_DICT)?.object).toBe('controlDict');
  });

  it('matches a 0/ field by object (narrowed by class)', () => {
    const def = matchFoamFileDef(FIELD_U);
    expect(def?.object).toBe('U');
    expect(def?.boundaryFieldTypes).toContain('noSlip');
  });

  it('returns undefined for an unknown / non-FOAM file', () => {
    expect(matchFoamFileDef('just some text')).toBeUndefined();
    expect(matchFoamFileDef(BOUNDARY_LIST)).toBeUndefined();
  });
});

describe('foamEasyModeAvailable', () => {
  it('is available for a recognised file', () => {
    expect(foamEasyModeAvailable(CONTROL_DICT)).toBe(true);
    expect(foamEasyModeAvailable(FIELD_U)).toBe(true);
  });

  it('is unavailable for a list-format file with no key/value entries', () => {
    expect(foamEasyModeAvailable(BOUNDARY_LIST)).toBe(false);
  });
});
