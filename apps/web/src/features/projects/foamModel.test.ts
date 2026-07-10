import { describe, expect, it } from 'vitest';
import {
  childrenAt,
  findNode,
  getFoamValue,
  insertFoamField,
  parseFoamModel,
  setFoamValue,
} from './foamModel';

const CONTROL_DICT = `/*--------------------------------*- C++ -*----------------------------------*\\
| banner line                                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

application     simpleFoam;
startFrom       latestTime;
endTime         2000;
writeFormat     binary;
`;

const FIELD_U = `FoamFile
{
    class       volVectorField;
    object      U;
}
dimensions      [0 1 -1 0 0 0 0];
internalField   uniform (0 0 0);

boundaryField
{
    inlet
    {
        type            flowRateInletVelocity;
        volumetricFlowRate 14;
        value           uniform (0 0 0);
    }
    outlet
    {
        type            pressureInletOutletVelocity;
        value           uniform (0 0 0);
    }
    wall
    {
        type            noSlip;
    }
}
`;

describe('parseFoamModel + getFoamValue', () => {
  it('reads top-level leaf values', () => {
    const doc = parseFoamModel(CONTROL_DICT);
    expect(getFoamValue(doc, ['application'])).toBe('simpleFoam');
    expect(getFoamValue(doc, ['writeFormat'])).toBe('binary');
    expect(getFoamValue(doc, ['endTime'])).toBe('2000');
  });

  it('reads the FoamFile header', () => {
    const doc = parseFoamModel(CONTROL_DICT);
    expect(getFoamValue(doc, ['FoamFile', 'object'])).toBe('controlDict');
    expect(getFoamValue(doc, ['FoamFile', 'class'])).toBe('dictionary');
  });

  it('reads nested boundaryField patch types and vector values', () => {
    const doc = parseFoamModel(FIELD_U);
    expect(getFoamValue(doc, ['boundaryField', 'inlet', 'type'])).toBe('flowRateInletVelocity');
    expect(getFoamValue(doc, ['boundaryField', 'outlet', 'type'])).toBe(
      'pressureInletOutletVelocity',
    );
    expect(getFoamValue(doc, ['boundaryField', 'wall', 'type'])).toBe('noSlip');
    expect(getFoamValue(doc, ['internalField'])).toBe('uniform (0 0 0)');
  });

  it('lists patch names via childrenAt', () => {
    const doc = parseFoamModel(FIELD_U);
    const patches = childrenAt(doc, ['boundaryField']).map((n) => n.key);
    expect(patches).toEqual(['inlet', 'outlet', 'wall']);
  });

  it('returns null for missing paths or non-leaves', () => {
    const doc = parseFoamModel(CONTROL_DICT);
    expect(getFoamValue(doc, ['nope'])).toBeNull();
    expect(getFoamValue(doc, ['FoamFile'])).toBeNull(); // a dict, not a leaf
  });
});

describe('setFoamValue (surgical, preserves everything else)', () => {
  it('replaces a single top-level value and nothing else', () => {
    const next = setFoamValue(CONTROL_DICT, ['writeFormat'], 'ascii');
    expect(next).not.toBeNull();
    expect(getFoamValue(parseFoamModel(next as string), ['writeFormat'])).toBe('ascii');
    // The banner and every other entry survive verbatim.
    expect(next).toContain('| banner line');
    expect(next).toContain('application     simpleFoam;');
    expect(next).toContain('endTime         2000;');
    // Only one occurrence changed; no stray duplication.
    expect((next as string).match(/writeFormat/g)).toHaveLength(1);
  });

  it('replaces only the targeted patch type, leaving siblings intact', () => {
    const next = setFoamValue(FIELD_U, ['boundaryField', 'inlet', 'type'], 'fixedValue');
    expect(next).not.toBeNull();
    const doc = parseFoamModel(next as string);
    expect(getFoamValue(doc, ['boundaryField', 'inlet', 'type'])).toBe('fixedValue');
    expect(getFoamValue(doc, ['boundaryField', 'outlet', 'type'])).toBe(
      'pressureInletOutletVelocity',
    );
    expect(getFoamValue(doc, ['boundaryField', 'wall', 'type'])).toBe('noSlip');
    // The inlet's other entries are untouched.
    expect(next).toContain('volumetricFlowRate 14;');
  });

  it('rewrites a vector value cleanly', () => {
    const next = setFoamValue(FIELD_U, ['internalField'], 'uniform (1 0 0)');
    expect(getFoamValue(parseFoamModel(next as string), ['internalField'])).toBe('uniform (1 0 0)');
  });

  it('returns null when the path is absent or not a leaf', () => {
    expect(setFoamValue(CONTROL_DICT, ['ghost'], 'x')).toBeNull();
    expect(setFoamValue(CONTROL_DICT, ['FoamFile'], 'x')).toBeNull();
  });
});

describe('insertFoamField', () => {
  it('appends a field into an existing sub-dictionary', () => {
    const next = insertFoamField(FIELD_U, ['boundaryField', 'wall'], 'value', 'uniform (0 0 0)');
    expect(next).not.toBeNull();
    const doc = parseFoamModel(next as string);
    expect(getFoamValue(doc, ['boundaryField', 'wall', 'value'])).toBe('uniform (0 0 0)');
    // Existing type is still there.
    expect(getFoamValue(doc, ['boundaryField', 'wall', 'type'])).toBe('noSlip');
  });

  it('appends a top-level field at the end of the file', () => {
    const next = insertFoamField(CONTROL_DICT, [], 'writeInterval', '50');
    expect(getFoamValue(parseFoamModel(next as string), ['writeInterval'])).toBe('50');
  });
});

describe('findNode', () => {
  it('distinguishes dicts from leaves', () => {
    const doc = parseFoamModel(FIELD_U);
    expect(findNode(doc, ['boundaryField'])?.type).toBe('dict');
    expect(findNode(doc, ['boundaryField', 'inlet', 'type'])?.type).toBe('leaf');
  });
});

describe('line-terminated #include directives (H8)', () => {
  const WITH_INCLUDE = `FoamFile
{
    object controlDict;
}
#include "initialConditions"
application     simpleFoam;
startTime       0;
`;

  it('does not swallow the entry that follows a #include with no semicolon', () => {
    const doc = parseFoamModel(WITH_INCLUDE);
    // The directive is its own node...
    expect(findNode(doc, ['#include'])).not.toBeNull();
    // ...and the neighbour survives intact (previously merged into the #include).
    expect(getFoamValue(doc, ['application'])).toBe('simpleFoam');
    expect(getFoamValue(doc, ['startTime'])).toBe('0');
  });

  it('splices a neighbour value without corrupting the #include line', () => {
    const next = setFoamValue(WITH_INCLUDE, ['application'], 'pimpleFoam');
    expect(next).toContain('#include "initialConditions"');
    expect(next).toContain('application     pimpleFoam;');
  });
});
