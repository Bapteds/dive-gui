// Unit tests for the diameter morph: the shared math (prepareCenterline, blendWeight,
// morphPoint) and the server-side FoamFile bake (morphMeshPoints, ASCII + binary).
//
// The morph is the curvilinear radial scale the optimization sweep uses to realise
// each candidate diameter. Because the math lives in @dive/shared and BOTH the
// browser preview and this bake import the SAME morphPoint, one suite proves
// correctness for both — no hand-mirroring, so no twin fixture (unlike the rigid
// Assembly transform in meshTransform.test.ts). checkMesh cell-quality validation runs
// on the OpenFOAM box inside the sweep; here we validate geometry only. No HTTP / DB.
import { describe, expect, it } from 'vitest';
import {
  blendWeight,
  morphPoint,
  prepareCenterline,
  type Centerline,
  type MorphDefinition,
} from '@dive/shared';
import { morphMeshPoints } from '../src/lib/meshTransform';

// A straight centerline along +X from (0,0,0) to (10,0,0): arc-length fraction == x/10.
const STRAIGHT: Centerline = {
  points: [
    [0, 0, 0],
    [10, 0, 0],
  ],
};

describe('prepareCenterline', () => {
  it('computes cumulative arc-lengths and total', () => {
    const prep = prepareCenterline({
      points: [
        [0, 0, 0],
        [3, 0, 0],
        [3, 4, 0],
      ],
    });
    expect(prep.cumLen).toEqual([0, 3, 7]); // 3 (x-leg) + 4 (y-leg) of the polyline
    expect(prep.total).toBe(7);
  });
});

describe('blendWeight', () => {
  it('is 0 on/outside the stations', () => {
    expect(blendWeight(0.1, 0.2, 0.8, 0.1)).toBe(0);
    expect(blendWeight(0.9, 0.2, 0.8, 0.1)).toBe(0);
    expect(blendWeight(0.2, 0.2, 0.8, 0.1)).toBe(0);
  });
  it('is 1 in the core (past the blend band)', () => {
    expect(blendWeight(0.5, 0.2, 0.8, 0.1)).toBe(1);
  });
  it('ramps via half-cosine, reaching 0.5 at half the band', () => {
    expect(blendWeight(0.25, 0.2, 0.8, 0.1)).toBeCloseTo(0.5, 12);
  });
  it('treats blend<=0 as a hard step', () => {
    expect(blendWeight(0.5, 0.2, 0.8, 0)).toBe(1);
    expect(blendWeight(0.19, 0.2, 0.8, 0)).toBe(0);
  });
});

describe('morphPoint', () => {
  const prep = prepareCenterline(STRAIGHT);

  it('doubles the radial offset in the core when ratio=2', () => {
    const out = morphPoint([5, 1, 0], prep, 0.2, 0.8, 0, 2);
    expect(out[0]).toBeCloseTo(5, 12);
    expect(out[1]).toBeCloseTo(2, 12);
    expect(out[2]).toBeCloseTo(0, 12);
  });

  it('leaves points outside the zone untouched', () => {
    expect(morphPoint([1, 1, 0], prep, 0.2, 0.8, 0, 2)).toEqual([1, 1, 0]);
  });

  it('preserves the axial position (only the radial offset scales)', () => {
    const out = morphPoint([5, 0, 3], prep, 0.2, 0.8, 0, 1.5);
    expect(out[0]).toBeCloseTo(5, 12); // axial unchanged
    expect(out[2]).toBeCloseTo(4.5, 12); // radial 3 -> 4.5
  });

  it('is identity when ratio=1', () => {
    expect(morphPoint([5, 1, 2], prep, 0.2, 0.8, 0.1, 1)).toEqual([5, 1, 2]);
  });

  it('applies the blend ramp (half weight at half the band)', () => {
    const out = morphPoint([2.5, 1, 0], prep, 0.2, 0.8, 0.1, 2);
    expect(out[1]).toBeCloseTo(1.5, 12);
  });

  it('confines the morph radially (full inside falloffStart, zero beyond falloffEnd)', () => {
    // ratio 2, falloff start 1.2, end 2.0 (metres from the axis).
    const wall = morphPoint([5, 1, 0], prep, 0.2, 0.8, 0, 2, 1.2, 2);
    expect(wall[1]).toBeCloseTo(2, 12); // r=1 <= start -> full scale
    const far = morphPoint([5, 3, 0], prep, 0.2, 0.8, 0, 2, 1.2, 2);
    expect(far).toEqual([5, 3, 0]); // r=3 >= end -> untouched (a distant machine part)
    const mid = morphPoint([5, 1.6, 0], prep, 0.2, 0.8, 0, 2, 1.2, 2);
    expect(mid[1]).toBeGreaterThan(1.6); // partially dragged...
    expect(mid[1]).toBeLessThan(3.2); // ...but less than the full scale
  });

  it('has no radial limit when the falloff is omitted (legacy behaviour)', () => {
    const far = morphPoint([5, 3, 0], prep, 0.2, 0.8, 0, 2);
    expect(far[1]).toBeCloseTo(6, 12);
  });

  it('scales radially about a bent (curved) centerline', () => {
    // L-shape: (0,0,0)->(10,0,0)->(10,10,0), total 20. Point (11,5,0) sits off the
    // vertical leg: foot (10,5,0), radial +x offset 1, arc-length 15 -> sFrac 0.75.
    const bent = prepareCenterline({
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
    });
    const out = morphPoint([11, 5, 0], bent, 0.2, 0.8, 0, 3);
    expect(out[0]).toBeCloseTo(13, 10); // 10 + 1*3
    expect(out[1]).toBeCloseTo(5, 10); // axial (along the vertical leg) preserved
  });
});

// --- Server bake (morphMeshPoints) ------------------------------------------

const NUMBER = '[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?';

function asciiPoints(points: Array<[number, number, number]>): string {
  const body = points.map(([x, y, z]) => `(${x} ${y} ${z})`).join('\n');
  return (
    'FoamFile\n{\n    version     2.0;\n    format      ascii;\n' +
    '    class       vectorField;\n    location    "constant/polyMesh";\n' +
    `    object      points;\n}\n// * * * //\n${points.length}\n(\n${body}\n)\n`
  );
}

function readAsciiPoints(content: string): Array<[number, number, number]> {
  const re = new RegExp(`\\(\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*\\)`, 'g');
  const out: Array<[number, number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  return out;
}

function binaryPoints(points: Array<[number, number, number]>): {
  buffer: Buffer;
  dataStart: number;
} {
  const prefix =
    'FoamFile\n{\n    version     2.0;\n    format      binary;\n' +
    '    class       vectorField;\n    location    "constant/polyMesh";\n' +
    `    object      points;\n}\n// * * * //\n${points.length}\n(`;
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

function readBinaryPoints(
  buffer: Buffer,
  dataStart: number,
  count: number,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const off = dataStart + i * 24;
    out.push([
      buffer.readDoubleLE(off),
      buffer.readDoubleLE(off + 8),
      buffer.readDoubleLE(off + 16),
    ]);
  }
  return out;
}

// Baseline diameter 2 (radius 1). Morph to diameter 4 -> ratio 2 -> radius 1 -> 2.
const DEF: MorphDefinition = {
  wallPatch: 'wall',
  centerline: STRAIGHT,
  stationA: 0.2,
  stationB: 0.8,
  blend: 0,
  baselineDiameterM: 2,
};

describe('morphMeshPoints — ASCII', () => {
  it('scales in-zone radii, keeps out-of-zone vertices and the header/count', () => {
    const pts: Array<[number, number, number]> = [
      [5, 1, 0], // core -> [5,2,0]
      [1, 1, 0], // outside the zone -> unchanged
    ];
    const out = morphMeshPoints(Buffer.from(asciiPoints(pts)), DEF, 4).toString('utf8');
    expect(out).toContain('format      ascii;');
    const got = readAsciiPoints(out);
    expect(got).toHaveLength(2);
    expect(got[0][1]).toBeCloseTo(2, 10);
    expect(got[1]).toEqual([1, 1, 0]);
  });

  it('is a no-op when the diameter equals the baseline (ratio 1)', () => {
    const pts: Array<[number, number, number]> = [
      [5, 1, 0],
      [4, 0, 1],
    ];
    const got = readAsciiPoints(
      morphMeshPoints(Buffer.from(asciiPoints(pts)), DEF, 2).toString('utf8'),
    );
    expect(got).toEqual([
      [5, 1, 0],
      [4, 0, 1],
    ]);
  });
});

describe('morphMeshPoints — radial falloff', () => {
  it('honours the definition falloff (far vertices untouched)', () => {
    const def: MorphDefinition = { ...DEF, falloffStartM: 1.2, falloffEndM: 2 };
    const pts: Array<[number, number, number]> = [
      [5, 1, 0], // on the wall -> full scale to [5,2,0]
      [5, 3, 0], // beyond falloffEnd -> untouched
    ];
    const got = readAsciiPoints(
      morphMeshPoints(Buffer.from(asciiPoints(pts)), def, 4).toString('utf8'),
    );
    expect(got[0][1]).toBeCloseTo(2, 10);
    expect(got[1]).toEqual([5, 3, 0]);
  });
});

describe('morphMeshPoints — BINARY', () => {
  it('rewrites only the data block (same byte length) and scales in-zone radii', () => {
    const pts: Array<[number, number, number]> = [
      [5, 1, 0],
      [1, 1, 0],
    ];
    const { buffer, dataStart } = binaryPoints(pts);
    const out = morphMeshPoints(buffer, DEF, 4);
    expect(out.length).toBe(buffer.length);
    const got = readBinaryPoints(out, dataStart, 2);
    expect(got[0][1]).toBeCloseTo(2, 10);
    expect(got[1]).toEqual([1, 1, 0]);
  });

  it('does not mutate the caller-supplied buffer', () => {
    const { buffer } = binaryPoints([[5, 1, 0]]);
    const before = Buffer.from(buffer);
    morphMeshPoints(buffer, DEF, 4);
    expect(buffer.equals(before)).toBe(true);
  });
});
