// Unit tests for boundary-patch discovery (FMS header + ASCII STL solid names).
import { describe, expect, it } from 'vitest';
import { parseFmsPatches, parseStlSolidNames } from '../src/lib/meshPatches';

describe('parseFmsPatches', () => {
  it('reads the patch names and types from an FMS header', () => {
    const fms = Buffer.from(
      `3
(
    DT_Inlet    empty
    DT_Outlet   empty
    DT_Wall     empty
)

12
(
`,
      'utf8',
    );
    expect(parseFmsPatches(fms)).toEqual([
      { name: 'DT_Inlet', type: 'empty' },
      { name: 'DT_Outlet', type: 'empty' },
      { name: 'DT_Wall', type: 'empty' },
    ]);
  });

  it('returns [] when there is no patch block', () => {
    expect(parseFmsPatches(Buffer.from('not an fms', 'utf8'))).toEqual([]);
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
