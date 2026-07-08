// Unit tests for boundary-patch discovery (FMS header + ASCII STL solid names).
import { describe, expect, it } from 'vitest';
import { parseFmsPatchNames, parseStlSolidNames } from '../src/lib/meshPatches';

describe('parseFmsPatchNames', () => {
  it('reads the patch names from an FMS header (name type pairs)', () => {
    const fms = Buffer.from(
      `3
(
    inlet    patch
    outlet   patch
    walls    wall
)

12
(
`,
      'utf8',
    );
    expect(parseFmsPatchNames(fms)).toEqual(['inlet', 'outlet', 'walls']);
  });

  it('returns [] when there is no patch block', () => {
    expect(parseFmsPatchNames(Buffer.from('not an fms', 'utf8'))).toEqual([]);
  });
});

describe('parseStlSolidNames', () => {
  it('reads every solid name from a multi-solid ASCII STL', () => {
    const stl = Buffer.from(
      `solid rotor
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid rotor
solid stator
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid stator
`,
      'utf8',
    );
    expect(parseStlSolidNames(stl)).toEqual(['rotor', 'stator']);
  });

  it('returns [] for a binary STL (no solid names)', () => {
    const buf = Buffer.alloc(84 + 50);
    buf.writeUInt32LE(1, 80);
    expect(parseStlSolidNames(buf)).toEqual([]);
  });
});
