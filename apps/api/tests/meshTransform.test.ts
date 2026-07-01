// Unit tests for the pure in-process points transform (lib/meshTransform).
//
// This is the SERVER half of the assembly parity proof: the same rotation
// formula three.js uses in the browser, applied to constant/polyMesh/points, so
// the merged geometry matches the live preview bit-for-bit. The canonical
// fixture (a 90° turn about +Z plus a translation) is SHARED with the web
// placement.test.ts — same q, t, p => same R·p + t — to prove parity without a
// running OpenFOAM toolchain. Both ASCII and BINARY FoamFile encodings are
// covered, plus a multi-point case and an identity no-op. No HTTP / DB involved.
import { describe, expect, it } from 'vitest';
import { isIdentityTransform, transformMeshPoints } from '../src/lib/meshTransform';

// --- Canonical parity fixture (shared with the web placement.test.ts) --------
// q = 90° about +Z (x,y,z,w), t = (1,2,3). R·[1,0,0] = [0,1,0], +t = [1,3,3].
const Q90Z: [number, number, number, number] = [0, 0, 0.7071067811865476, 0.7071067811865476];
const T123: [number, number, number] = [1, 2, 3];
const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1];
const ZERO_T: [number, number, number] = [0, 0, 0];

// --- ASCII points helpers ----------------------------------------------------

/** Build a minimal ASCII FoamFile points file with the given vertices. */
function asciiPoints(points: Array<[number, number, number]>): string {
  const body = points.map(([x, y, z]) => `(${x} ${y} ${z})`).join('\n');
  return (
    'FoamFile\n{\n    version     2.0;\n    format      ascii;\n' +
    '    class       vectorField;\n    location    "constant/polyMesh";\n' +
    `    object      points;\n}\n// * * * //\n${points.length}\n(\n${body}\n)\n`
  );
}

/** A permissive OpenFOAM scalar, matching the lib's own number grammar. */
const NUMBER = '[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?';

/** Extract the (x y z) vectors out of an ASCII points file. */
function readAsciiPoints(content: string): Array<[number, number, number]> {
  const re = new RegExp(`\\(\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*\\)`, 'g');
  const out: Array<[number, number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return out;
}

// --- BINARY points helpers ---------------------------------------------------

const BINARY_HEADER =
  'FoamFile\n{\n    version     2.0;\n    format      binary;\n' +
  '    class       vectorField;\n    location    "constant/polyMesh";\n' +
  '    object      points;\n}\n// * * * //\n';

/** Build a BINARY FoamFile points file: header + count + '(' + raw f64 LE + ')'. */
function binaryPoints(points: Array<[number, number, number]>): { buffer: Buffer; dataStart: number } {
  const prefix = `${BINARY_HEADER}${points.length}\n(`;
  const head = Buffer.from(prefix, 'latin1');
  const data = Buffer.alloc(points.length * 24);
  points.forEach((p, i) => {
    data.writeDoubleLE(p[0], i * 24);
    data.writeDoubleLE(p[1], i * 24 + 8);
    data.writeDoubleLE(p[2], i * 24 + 16);
  });
  const tail = Buffer.from(')\n// end //\n', 'latin1');
  return { buffer: Buffer.concat([head, data, tail]), dataStart: head.length };
}

/** Read `count` vertices from a binary points buffer starting at `dataStart`. */
function readBinaryPoints(buffer: Buffer, dataStart: number, count: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const off = dataStart + i * 24;
    out.push([buffer.readDoubleLE(off), buffer.readDoubleLE(off + 8), buffer.readDoubleLE(off + 16)]);
  }
  return out;
}

/** Assert a vertex equals the expected coordinates within float64 tolerance. */
function expectPointCloseTo(actual: [number, number, number], expected: [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 10);
  expect(actual[1]).toBeCloseTo(expected[1], 10);
  expect(actual[2]).toBeCloseTo(expected[2], 10);
}

describe('transformMeshPoints — ASCII', () => {
  it('applies the canonical parity fixture: (1 0 0) -> (1 3 3)', () => {
    const out = transformMeshPoints(Buffer.from(asciiPoints([[1, 0, 0]])), Q90Z, T123).toString('utf8');
    const [p] = readAsciiPoints(out);
    expectPointCloseTo(p, [1, 3, 3]);
  });

  it('transforms every vertex of a multi-point list', () => {
    const input: Array<[number, number, number]> = [
      [1, 0, 0], // -> [0,1,0] + t = [1,3,3]
      [0, 1, 0], // -> [-1,0,0] + t = [0,2,3]
      [0, 0, 1], // -> [0,0,1]  + t = [1,2,4]
      [2, -3, 5], // -> [3,2,5] + t = [4,4,8]
    ];
    const out = transformMeshPoints(Buffer.from(asciiPoints(input)), Q90Z, T123).toString('utf8');
    const got = readAsciiPoints(out);
    expect(got).toHaveLength(4);
    expectPointCloseTo(got[0], [1, 3, 3]);
    expectPointCloseTo(got[1], [0, 2, 3]);
    expectPointCloseTo(got[2], [1, 2, 4]);
    expectPointCloseTo(got[3], [4, 4, 8]);
  });

  it('preserves the FoamFile header, format and vertex count', () => {
    const out = transformMeshPoints(Buffer.from(asciiPoints([[1, 0, 0], [0, 1, 0]])), Q90Z, T123).toString('utf8');
    expect(out).toContain('format      ascii;');
    expect(out).toContain('class       vectorField;');
    expect(out).toMatch(/\}\s*\/\/ \* \* \* \/\/\s*2\s*\(/); // count 2 still precedes the list
    expect(readAsciiPoints(out)).toHaveLength(2);
  });

  it('is a no-op for an identity transform (bytes unchanged)', () => {
    const input = Buffer.from(asciiPoints([[1, 2, 3], [4, 5, 6]]));
    const out = transformMeshPoints(input, IDENTITY_Q, ZERO_T);
    // Identity leaves the coordinates numerically unchanged.
    expect(readAsciiPoints(out.toString('utf8'))).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it('defaults to ASCII when the header omits the format keyword', () => {
    const noFormat = `FoamFile\n{\n    class vectorField;\n    object points;\n}\n1\n(\n(1 0 0)\n)\n`;
    const out = transformMeshPoints(Buffer.from(noFormat), Q90Z, T123).toString('utf8');
    expectPointCloseTo(readAsciiPoints(out)[0], [1, 3, 3]);
  });
});

describe('transformMeshPoints — BINARY', () => {
  it('applies the canonical parity fixture: (1 0 0) -> (1 3 3)', () => {
    const { buffer, dataStart } = binaryPoints([[1, 0, 0]]);
    const out = transformMeshPoints(buffer, Q90Z, T123);
    // Same byte length: only the data block was rewritten, header/delimiters kept.
    expect(out.length).toBe(buffer.length);
    expectPointCloseTo(readBinaryPoints(out, dataStart, 1)[0], [1, 3, 3]);
  });

  it('transforms every vertex of a multi-point binary block', () => {
    const input: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [2, -3, 5],
    ];
    const { buffer, dataStart } = binaryPoints(input);
    const out = transformMeshPoints(buffer, Q90Z, T123);
    const got = readBinaryPoints(out, dataStart, input.length);
    expectPointCloseTo(got[0], [1, 3, 3]);
    expectPointCloseTo(got[1], [0, 2, 3]);
    expectPointCloseTo(got[2], [4, 4, 8]);
  });

  it('is a no-op for an identity transform (bytes unchanged)', () => {
    const { buffer } = binaryPoints([[1, 2, 3], [4, 5, 6]]);
    const out = transformMeshPoints(buffer, IDENTITY_Q, ZERO_T);
    expect(out.equals(buffer)).toBe(true);
  });

  it('does not mutate the caller-supplied buffer', () => {
    const { buffer, dataStart } = binaryPoints([[1, 0, 0]]);
    const before = Buffer.from(buffer);
    transformMeshPoints(buffer, Q90Z, T123);
    expect(buffer.equals(before)).toBe(true); // input untouched
    expect(readBinaryPoints(buffer, dataStart, 1)[0]).toEqual([1, 0, 0]);
  });
});

describe('ASCII ↔ BINARY parity', () => {
  it('yields identical transformed coordinates for both encodings', () => {
    const pts: Array<[number, number, number]> = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -3, 5]];
    const asciiOut = readAsciiPoints(
      transformMeshPoints(Buffer.from(asciiPoints(pts)), Q90Z, T123).toString('utf8'),
    );
    const { buffer, dataStart } = binaryPoints(pts);
    const binaryOut = readBinaryPoints(transformMeshPoints(buffer, Q90Z, T123), dataStart, pts.length);
    // Both paths run the exact same float64 formula, so the results are identical.
    expect(asciiOut).toEqual(binaryOut);
  });
});

describe('isIdentityTransform', () => {
  it('recognises the identity placement', () => {
    expect(isIdentityTransform({ meshId: 'm', rotation: IDENTITY_Q, translation: ZERO_T })).toBe(true);
  });

  it('rejects any real rotation or translation', () => {
    expect(isIdentityTransform({ meshId: 'm', rotation: Q90Z, translation: ZERO_T })).toBe(false);
    expect(isIdentityTransform({ meshId: 'm', rotation: IDENTITY_Q, translation: T123 })).toBe(false);
  });
});
