import * as THREE from 'three';

/**
 * placement.ts - the parity-critical placement math for the multi-part 3D
 * assembly ("Assemble" tab).
 *
 * ALL vectors here live in RAW polyMesh coordinates (metres, SI). The three.js
 * `GLTFLoader` / trimesh export bakes a Z-up -> Y-up transform on the GLB root,
 * so the viewer's WORLD space is NOT the raw space. The viewer neutralises that
 * baked transform and calls into this module with raw coordinates only, so the
 * quaternion + translation computed here are exactly the ones POSTed to the
 * server and applied to `constant/polyMesh/points`. That is what guarantees
 * preview == server result (see ASSEMBLY_SPEC.md sec 2d/2e + the parity test).
 *
 * The rotation is factored into ONE formula (`computePlacement`) that the API
 * mirrors bit-for-bit (`Matrix4.compose`), so `placement.test.ts` and the API's
 * `meshTransform.test.ts` assert the SAME numeric fixture on both sides.
 */

/** A 3-vector as a plain tuple (raw polyMesh coords, metres). */
export type Vec3 = [number, number, number];
/** A unit quaternion in three.js order (x, y, z, w); identity = [0,0,0,1]. */
export type Quat = [number, number, number, number];

/** An anchor: a point on a patch plus its outward unit normal (raw coords). */
export interface Anchor {
  point: Vec3;
  normal: Vec3;
}

/** A base-face pick: the raycast target plus the base patch it belongs to (raw). */
export interface HitTarget {
  /** The base boundary patch the picked face belongs to (for the highlight). */
  patchName: string;
  point: Vec3;
  normal: Vec3;
}

/** The rigid placement of an added part: p' = R(rotation)*p + translation. */
export interface Placement {
  rotation: Quat;
  translation: Vec3;
}

/** Squared length below which a summed area-normal is treated as degenerate. */
const DEGENERATE_AREA = 1e-20;

/**
 * computePlacement - the single authoritative placement formula (spec 2d).
 *
 * Given the added part's anchor (`pA`, `nA` = area-weighted centroid + outward
 * normal of its chosen mating patch) and the base target (`pT`, `nT` = the picked
 * face point + normal), returns the rotation+translation that:
 *   1. mates the surfaces: the added outward normal `nA` is rotated to oppose the
 *      base normal (`nA -> -nT`), so the two faces meet face-to-face;
 *   2. applies the user's `rollRad` about the base normal `nT`;
 *   3. lands the anchor on the target, offset `offset` metres along `nT`:
 *      q*pA + t == pT + offset*nT.
 * Every vector is in raw polyMesh coordinates.
 */
export function computePlacement(
  pA: Vec3,
  nA: Vec3,
  pT: Vec3,
  nT: Vec3,
  rollRad: number,
  offset: number,
): Placement {
  const nAv = new THREE.Vector3(nA[0], nA[1], nA[2]).normalize();
  const nTv = new THREE.Vector3(nT[0], nT[1], nT[2]).normalize();

  // Mate: rotate the added outward normal onto the OPPOSITE of the base normal
  // so the surfaces face each other (a lid onto a pot, not through it).
  const q1 = new THREE.Quaternion().setFromUnitVectors(nAv, nTv.clone().negate());
  // User roll about the base mount normal.
  const qRoll = new THREE.Quaternion().setFromAxisAngle(nTv, rollRad);
  // q = qRoll after q1 (apply the mate first, then the roll).
  const q = qRoll.multiply(q1).normalize();

  // Translation so the rotated anchor lands on the target + offset along nT.
  const rotatedAnchor = new THREE.Vector3(pA[0], pA[1], pA[2]).applyQuaternion(q);
  const t = new THREE.Vector3(pT[0], pT[1], pT[2])
    .addScaledVector(nTv, offset)
    .sub(rotatedAnchor);

  return {
    rotation: [q.x, q.y, q.z, q.w],
    translation: [t.x, t.y, t.z],
  };
}

/**
 * anchorFromGeometry - area-weighted centroid + outward unit normal over every
 * triangle of a (single-patch) BufferGeometry, in its LOCAL/raw space.
 *
 * The centroid is weighted by triangle area (so tiny slivers do not skew it) and
 * the normal is the normalised sum of the per-triangle area vectors (0.5*cross),
 * i.e. the area-weighted average normal - consistent and outward for a boundary
 * surface with consistent winding (which trimesh's triangulation gives us).
 * A degenerate (zero-area) patch falls back to the plain vertex centroid.
 */
export function anchorFromGeometry(geometry: THREE.BufferGeometry): Anchor {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position || position.count < 3) {
    return { point: [0, 0, 0], normal: [0, 0, 1] };
  }
  const index = geometry.getIndex();
  const triCount = Math.floor((index ? index.count : position.count) / 3);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const faceCross = new THREE.Vector3(); // cross(ab, ac); |faceCross| = 2*area
  const centroid = new THREE.Vector3();

  const areaNormal = new THREE.Vector3(); // sum of area_i * unitNormal_i (= 0.5*cross)
  const weightedCentroid = new THREE.Vector3(); // sum of area_i * centroid_i
  const centroidSum = new THREE.Vector3(); // fallback for a degenerate patch
  let areaSum = 0;

  for (let t = 0; t < triCount; t += 1) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    faceCross.crossVectors(ab, ac);
    const area = faceCross.length() * 0.5;
    areaNormal.addScaledVector(faceCross, 0.5); // 0.5*cross = area * unitNormal
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    weightedCentroid.addScaledVector(centroid, area);
    centroidSum.add(centroid);
    areaSum += area;
  }

  if (areaSum <= DEGENERATE_AREA) {
    const p = triCount > 0 ? centroidSum.multiplyScalar(1 / triCount) : centroidSum;
    const n =
      areaNormal.lengthSq() > 0 ? areaNormal.normalize() : new THREE.Vector3(0, 0, 1);
    return { point: [p.x, p.y, p.z], normal: [n.x, n.y, n.z] };
  }

  const point = weightedCentroid.multiplyScalar(1 / areaSum);
  const normal = areaNormal.normalize();
  return { point: [point.x, point.y, point.z], normal: [normal.x, normal.y, normal.z] };
}

/**
 * anchorFromPatch - resolve the named patch mesh inside a loaded GLB object and
 * return its area-weighted anchor in RAW/local space (no world matrix applied,
 * so the baked Z-up->Y-up root transform never leaks in). Returns null when the
 * patch is not present in the object.
 */
export function anchorFromPatch(source: THREE.Object3D, patchName: string): Anchor | null {
  let found: THREE.Mesh | null = null;
  source.traverse((object) => {
    if (found) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && (mesh.name === patchName || mesh.parent?.name === patchName)) {
      found = mesh;
    }
  });
  return found ? anchorFromGeometry((found as THREE.Mesh).geometry as THREE.BufferGeometry) : null;
}

/**
 * targetFromHit - convert a raycast hit on the base into a raw-space target: the
 * point and face normal expressed in `baseObject`'s LOCAL frame (which the viewer
 * keeps equal to the base's raw polyMesh frame). Both the point (via the inverse
 * world matrix) and the normal (via the rotation part - transforms are rigid, no
 * scale) are mapped out of viewer-world back into raw coordinates.
 */
export function targetFromHit(
  intersection: THREE.Intersection,
  baseObject: THREE.Object3D,
): HitTarget {
  baseObject.updateWorldMatrix(true, false);
  const invBaseWorld = new THREE.Matrix4().copy(baseObject.matrixWorld).invert();

  const point = intersection.point.clone().applyMatrix4(invBaseWorld);

  const hitObject = intersection.object;
  hitObject.updateWorldMatrix(true, false);
  // Rigid transforms only (no scale) -> the rotation part maps normals correctly.
  const hitRotation = new THREE.Matrix3().setFromMatrix4(hitObject.matrixWorld);
  const invBaseRotation = new THREE.Matrix3().setFromMatrix4(invBaseWorld);

  const faceNormal = intersection.face
    ? intersection.face.normal.clone()
    : new THREE.Vector3(0, 0, 1);
  const normal = faceNormal
    .applyMatrix3(hitRotation) // local(hit) -> world
    .applyMatrix3(invBaseRotation) // world -> local(base) = raw
    .normalize();

  const patchName = hitObject.name || hitObject.parent?.name || '';
  return {
    patchName,
    point: [point.x, point.y, point.z],
    normal: [normal.x, normal.y, normal.z],
  };
}

/**
 * bakedRootTransform - the raw -> viewer-world matrix baked into a freshly loaded
 * GLB (the trimesh Z-up->Y-up flip). Every patch mesh in one export shares it
 * (extractPatches adds each patch with an identity node transform), so it is read
 * off the first mesh. Its inverse, applied as a wrapper-group matrix, neutralises
 * the flip so the group's local frame IS the raw polyMesh frame.
 */
export function bakedRootTransform(loaded: THREE.Object3D): THREE.Matrix4 {
  loaded.updateWorldMatrix(true, true);
  let first: THREE.Mesh | null = null;
  loaded.traverse((object) => {
    if (!first && (object as THREE.Mesh).isMesh) first = object as THREE.Mesh;
  });
  return first
    ? new THREE.Matrix4().copy((first as THREE.Mesh).matrixWorld)
    : new THREE.Matrix4();
}
