import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { anchorFromGeometry, computePlacement } from './placement';

/**
 * placement.test.ts - the PARITY PROOF for the multi-part assembly.
 *
 * The client (three.js) previews a part with `q, t`; the server transforms the
 * part's `constant/polyMesh/points` with the SAME `q, t`. Since both run V8
 * float64 and the server mirrors three.js's `Matrix4.compose` formula, the two
 * must agree bit-for-bit. This file and the API's `meshTransform.test.ts` assert
 * the SAME canonical numeric fixture, so a running OpenFOAM toolchain is not
 * needed to prove preview == result.
 *
 * CANONICAL PARITY FIXTURE (must match apps/api/tests/meshTransform.test.ts):
 *   q = [0, 0, sin(45deg), cos(45deg)]  (a 90deg rotation about +Z)
 *   t = [1, 2, 3]
 *   p = [1, 0, 0]   ->   q*p + t = [1, 3, 3]
 */
const SQRT_HALF = Math.SQRT1_2; // sin(45deg) = cos(45deg) = 0.7071067811865476
const FIXTURE_Q: [number, number, number, number] = [0, 0, SQRT_HALF, SQRT_HALF];
const FIXTURE_T: [number, number, number] = [1, 2, 3];
const FIXTURE_P: [number, number, number] = [1, 0, 0];
const FIXTURE_EXPECTED: [number, number, number] = [1, 3, 3];

/** Apply q then +t to a point, exactly as the viewer drives the preview group. */
function applyQt(
  q: [number, number, number, number],
  t: [number, number, number],
  p: [number, number, number],
): [number, number, number] {
  const v = new THREE.Vector3(p[0], p[1], p[2])
    .applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]))
    .add(new THREE.Vector3(t[0], t[1], t[2]));
  return [v.x, v.y, v.z];
}

describe('placement - convention sanity (shared parity fixture)', () => {
  it('applies q=[0,0,v,v] (90deg about +Z) to [1,0,0] -> [0,1,0]', () => {
    const rotated = new THREE.Vector3(1, 0, 0).applyQuaternion(
      new THREE.Quaternion(...FIXTURE_Q),
    );
    expect(rotated.x).toBeCloseTo(0, 12);
    expect(rotated.y).toBeCloseTo(1, 12);
    expect(rotated.z).toBeCloseTo(0, 12);
  });

  it('q*p + t matches the server fixture (client convention == server matrix)', () => {
    const out = applyQt(FIXTURE_Q, FIXTURE_T, FIXTURE_P);
    expect(out[0]).toBeCloseTo(FIXTURE_EXPECTED[0], 12);
    expect(out[1]).toBeCloseTo(FIXTURE_EXPECTED[1], 12);
    expect(out[2]).toBeCloseTo(FIXTURE_EXPECTED[2], 12);
  });
});

describe('computePlacement - mate + land invariants', () => {
  it('rotates the added normal onto the OPPOSITE of the base normal (nA -> -nT)', () => {
    const nA: [number, number, number] = [1, 0, 0];
    const nT: [number, number, number] = [0, 0, 1];
    const { rotation } = computePlacement([2, 0, 0], nA, [0, 0, 5], nT, 0, 0);

    const rotatedNormal = new THREE.Vector3(nA[0], nA[1], nA[2]).applyQuaternion(
      new THREE.Quaternion(...rotation),
    );
    expect(rotatedNormal.x).toBeCloseTo(0, 12);
    expect(rotatedNormal.y).toBeCloseTo(0, 12);
    expect(rotatedNormal.z).toBeCloseTo(-1, 12); // -nT
  });

  it('lands the anchor on the target: q*pA + t == pT + offset*nT', () => {
    const pA: [number, number, number] = [2, 1, -3];
    const nA: [number, number, number] = [0, 1, 0];
    const pT: [number, number, number] = [4, 4, 4];
    const nT: [number, number, number] = [0, 0, 1];
    const offset = 0.25;

    const { rotation, translation } = computePlacement(pA, nA, pT, nT, 0, offset);
    const landed = applyQt(rotation, translation, pA);

    // pT + offset*nT
    expect(landed[0]).toBeCloseTo(pT[0], 10);
    expect(landed[1]).toBeCloseTo(pT[1], 10);
    expect(landed[2]).toBeCloseTo(pT[2] + offset, 10);
  });

  it('keeps the anchor on the target under any roll about the mount normal', () => {
    const pA: [number, number, number] = [1, 2, 3];
    const nA: [number, number, number] = [1, 0, 0];
    const pT: [number, number, number] = [-2, 5, 1];
    const nT: [number, number, number] = [0, 1, 0];
    const offset = 0.5;
    const rollRad = (137 * Math.PI) / 180;

    const { rotation, translation } = computePlacement(pA, nA, pT, nT, rollRad, offset);
    const landed = applyQt(rotation, translation, pA);

    expect(landed[0]).toBeCloseTo(pT[0], 10);
    expect(landed[1]).toBeCloseTo(pT[1] + offset, 10); // offset along +Y (nT)
    expect(landed[2]).toBeCloseTo(pT[2], 10);

    // The roll rotates the part about nT: the added normal still opposes nT.
    const rotatedNormal = new THREE.Vector3(nA[0], nA[1], nA[2]).applyQuaternion(
      new THREE.Quaternion(...rotation),
    );
    expect(rotatedNormal.x).toBeCloseTo(0, 10);
    expect(rotatedNormal.y).toBeCloseTo(-1, 10);
    expect(rotatedNormal.z).toBeCloseTo(0, 10);
  });

  it('is identity-ish when the anchor already sits at the target with opposed normals', () => {
    // nA already opposes nT and pA == pT, offset 0 -> near-zero translation.
    const { rotation, translation } = computePlacement(
      [0, 0, 0],
      [0, 0, -1],
      [0, 0, 0],
      [0, 0, 1],
      0,
      0,
    );
    // Rotation maps [0,0,-1] -> [0,0,-1] (already opposed) => identity rotation.
    const rotatedNormal = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...rotation),
    );
    expect(rotatedNormal.z).toBeCloseTo(-1, 12);
    expect(translation[0]).toBeCloseTo(0, 12);
    expect(translation[1]).toBeCloseTo(0, 12);
    expect(translation[2]).toBeCloseTo(0, 12);
  });
});

describe('anchorFromGeometry - area-weighted centroid + outward normal', () => {
  it('computes the centroid and +Z normal of a unit square in the z=0 plane', () => {
    // Two CCW triangles (viewed from +Z) covering [0,1] x [0,1] at z = 0.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, // t0
      0, 0, 0, 1, 1, 0, 0, 1, 0, // t1
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const { point, normal } = anchorFromGeometry(geometry);
    expect(point[0]).toBeCloseTo(0.5, 6);
    expect(point[1]).toBeCloseTo(0.5, 6);
    expect(point[2]).toBeCloseTo(0, 6);
    expect(normal[0]).toBeCloseTo(0, 6);
    expect(normal[1]).toBeCloseTo(0, 6);
    expect(normal[2]).toBeCloseTo(1, 6); // outward +Z from CCW winding
  });

  it('feeds computePlacement so the mating patch lands on a picked base face', () => {
    // Added mating patch: a square at x = 2 facing +X.
    const addedPositions = new Float32Array([
      2, 0, 0, 2, 1, 0, 2, 1, 1,
      2, 0, 0, 2, 1, 1, 2, 0, 1,
    ]);
    const added = new THREE.BufferGeometry();
    added.setAttribute('position', new THREE.BufferAttribute(addedPositions, 3));
    const anchor = anchorFromGeometry(added);

    // Base picked face at z = 5 facing +Z.
    const target = { point: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    const { rotation, translation } = computePlacement(
      anchor.point,
      anchor.normal,
      target.point,
      target.normal,
      0,
      0,
    );
    const landed = applyQt(rotation, translation, anchor.point);
    expect(landed[0]).toBeCloseTo(target.point[0], 8);
    expect(landed[1]).toBeCloseTo(target.point[1], 8);
    expect(landed[2]).toBeCloseTo(target.point[2], 8);
  });
});
