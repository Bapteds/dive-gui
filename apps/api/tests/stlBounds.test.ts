// Unit tests for the pure-TS STL bounding-box parser (ASCII + binary), the one
// piece of the meshing pipeline that runs with no OpenFOAM toolchain.
import { describe, expect, it } from 'vitest';
import { parseStlBounds, unionBounds } from '../src/lib/stlBounds';

/** Build a minimal binary STL from a list of triangles (each = 3 xyz vertices). */
function binaryStl(triangles: number[][][]): Buffer {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.writeUInt32LE(triangles.length, 80);
  triangles.forEach((tri, i) => {
    const base = 84 + i * 50 + 12; // skip the 12-byte normal
    tri.forEach((vertex, v) => {
      const off = base + v * 12;
      buf.writeFloatLE(vertex[0], off);
      buf.writeFloatLE(vertex[1], off + 4);
      buf.writeFloatLE(vertex[2], off + 8);
    });
  });
  return buf;
}

const ASCII_STL = `solid cube
facet normal 0 0 0
  outer loop
    vertex 0 0 0
    vertex 2 0 0
    vertex 0 3 0
  endloop
endfacet
facet normal 0 0 0
  outer loop
    vertex 0 0 -1
    vertex 2 0 0
    vertex 0 3 4
  endloop
endfacet
endsolid cube
`;

describe('parseStlBounds', () => {
  it('reads the bounding box of a binary STL', () => {
    const stl = binaryStl([
      [
        [0, 0, 0],
        [1, 5, 0],
        [-2, 0, 3],
      ],
    ]);
    const result = parseStlBounds(stl);
    expect(result.valid).toBe(true);
    expect(result.triangleCount).toBe(1);
    expect(result.min).toEqual([-2, 0, 0]);
    expect(result.max).toEqual([1, 5, 3]);
  });

  it('reads a binary STL that has trailing padding (M17)', () => {
    // Some exporters pad the file past 84 + n*50; the exact-size test rejected it
    // and it fell through to the ASCII path, yielding 0 triangles.
    const exact = binaryStl([
      [
        [0, 0, 0],
        [1, 5, 0],
        [-2, 0, 3],
      ],
    ]);
    const padded = Buffer.concat([exact, Buffer.alloc(128)]); // 128 padding bytes
    const result = parseStlBounds(padded);
    expect(result.valid).toBe(true);
    expect(result.triangleCount).toBe(1);
    expect(result.min).toEqual([-2, 0, 0]);
    expect(result.max).toEqual([1, 5, 3]);
  });

  it('reads the bounding box of an ASCII STL', () => {
    const result = parseStlBounds(Buffer.from(ASCII_STL, 'utf8'));
    expect(result.valid).toBe(true);
    expect(result.triangleCount).toBe(2);
    expect(result.min).toEqual([0, 0, -1]);
    expect(result.max).toEqual([2, 3, 4]);
  });

  it('does not misdetect an ASCII STL whose length coincidentally is large', () => {
    // A binary file is detected ONLY by the exact 84 + n*50 size match; ASCII text
    // never satisfies it, so this parses via the ASCII path.
    const result = parseStlBounds(Buffer.from(ASCII_STL, 'utf8'));
    expect(result.triangleCount).toBe(2);
  });

  it('returns invalid for an empty / unparseable buffer', () => {
    const result = parseStlBounds(Buffer.from('not an stl', 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.triangleCount).toBe(0);
  });
});

describe('unionBounds', () => {
  it('combines several boxes component-wise', () => {
    const box = unionBounds([
      { min: [0, 0, 0], max: [1, 1, 1] },
      { min: [-1, 2, 0], max: [0, 5, 3] },
    ]);
    expect(box).toEqual({ min: [-1, 0, 0], max: [1, 5, 3] });
  });

  it('returns null for an empty list', () => {
    expect(unionBounds([])).toBeNull();
  });
});
