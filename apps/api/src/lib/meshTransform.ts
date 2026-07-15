// In-process rigid transform of an OpenFOAM `constant/polyMesh/points` file.
//
// The multi-part assembly feature lets the user place an added part onto a face
// of the base part and rotate it, previewing the result live in the browser
// (three.js). When the merge runs, the SAME placement must be baked into the
// added part's staged points so the merged geometry matches the preview exactly.
//
// CEO decision (ASSEMBLY_SPEC §1): do this in TypeScript, NOT via OpenFOAM's
// `transformPoints` (a v12 CLI landmine that already bit the merge) and NOT in
// Python. The client (three.js) and the server (Node) both run V8 float64, so
// mirroring three.js's EXACT quaternion→matrix formula (`Matrix4.compose`, §2e)
// gives bit-for-bit preview↔result parity, needs no subprocess, and is unit-
// testable on any box (incl. a Windows dev machine with no OpenFOAM).
//
// The transform is p' = R(rotation)·p + translation, with R built verbatim as
// three.js does (the quaternion is used as-is, NOT re-normalized — `compose`
// does not normalize either, and the client sends a normalized quaternion). Both
// the ASCII and BINARY FoamFile encodings are handled; the header (and thus the
// stored precision/format) and the vertex count are preserved. Pure: the only
// state is the passed buffer, and a fresh buffer/string is returned.
import { Buffer } from 'node:buffer';
import {
  morphPoint,
  prepareCenterline,
  type MorphDefinition,
  type PartTransform,
} from '@dive/shared';

/** A 3×3 rotation matrix, row-major: [m00,m01,m02, m10,m11,m12, m20,m21,m22]. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A quaternion (x, y, z, w) and a translation (x, y, z), as in PartTransform. */
type Quat = readonly [number, number, number, number];
type Vec3 = readonly [number, number, number];

/** A per-point coordinate map (x, y, z) -> (x', y', z'): the kernel of a rewrite. */
type PointMap = (x: number, y: number, z: number) => [number, number, number];

/** The identity placement: no rotation, no translation (today's behaviour). */
export function isIdentityTransform(transform: PartTransform): boolean {
  const [rx, ry, rz, rw] = transform.rotation;
  const [tx, ty, tz] = transform.translation;
  return rx === 0 && ry === 0 && rz === 0 && rw === 1 && tx === 0 && ty === 0 && tz === 0;
}

/**
 * Build the rotation matrix from a quaternion using three.js's EXACT
 * `Matrix4.compose` formula (ASSEMBLY_SPEC §2e). Every sub-expression (`x2=x+x`,
 * `xy=x*y2`, …) matches three.js term-for-term, so a point transformed here is
 * bit-identical to the same point transformed by three.js in the browser. The
 * quaternion is consumed verbatim — `compose` does not normalize, so neither do
 * we (the client already sends a unit quaternion).
 */
function rotationMatrix(rotation: Quat): Mat3 {
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

/**
 * Apply p' = R·p + t to a single point, in the SAME left-to-right operation
 * order three.js's `Vector3.applyMatrix4` uses (`e[0]*x + e[4]*y + e[8]*z + t`),
 * so the float64 rounding is identical to the browser preview.
 */
function applyPoint(m: Mat3, t: Vec3, px: number, py: number, pz: number): [number, number, number] {
  const nx = m[0] * px + m[1] * py + m[2] * pz + t[0];
  const ny = m[3] * px + m[4] * py + m[5] * pz + t[1];
  const nz = m[6] * px + m[7] * py + m[8] * pz + t[2];
  return [nx, ny, nz];
}

/** Index just past the matching `}` of the FoamFile header block, or 0 if none. */
function foamFileHeaderEnd(text: string): number {
  const idx = text.indexOf('FoamFile');
  if (idx < 0) return 0;
  const open = text.indexOf('{', idx);
  if (open < 0) return 0;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return 0;
}

/**
 * Read the `format` keyword from a FoamFile header. Defaults to 'ascii' (the
 * OpenFOAM default) when the keyword is absent. Only the header region is
 * inspected, so a binary file's arbitrary data bytes are never scanned.
 */
function detectFormat(header: string): 'ascii' | 'binary' {
  const end = foamFileHeaderEnd(header);
  const scope = end > 0 ? header.slice(0, end) : header;
  return /\bformat\s+binary\b/.test(scope) ? 'binary' : 'ascii';
}

// A single OpenFOAM scalar token: optional sign, integer / fraction / trailing
// dot, optional exponent. Covers 1, 1.0, 1., .5, -1.5e-06 — everything C++'s
// stream writer emits for a double.
const NUMBER = '[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?';
const VECTOR_RE = new RegExp(`\\(\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*\\)`, 'g');

/**
 * Format a transformed coordinate for the ASCII list. `String(n)` yields the
 * shortest round-trippable decimal for a float64, so the exact transformed value
 * is preserved (no precision loss vs the in-memory computation).
 */
function formatScalar(n: number): string {
  return String(n);
}

/**
 * Rewrite every `(x y z)` vector in the ASCII points list. Only the region after
 * the FoamFile header is touched (the header carries no such triples), so the
 * banner, header, point count and list delimiters are left byte-for-byte intact.
 */
function transformAscii(text: string, map: PointMap): string {
  const headerEnd = foamFileHeaderEnd(text);
  const head = text.slice(0, headerEnd);
  const body = text.slice(headerEnd);
  const rewritten = body.replace(VECTOR_RE, (_match, sx: string, sy: string, sz: string) => {
    const [nx, ny, nz] = map(Number(sx), Number(sy), Number(sz));
    return `(${formatScalar(nx)} ${formatScalar(ny)} ${formatScalar(nz)})`;
  });
  return head + rewritten;
}

/**
 * Rewrite the `count*3` little-endian float64 block of a BINARY points list. The
 * block sits between the top-level `(` and `)` that follow the point count; the
 * header and delimiters are preserved. `latin1` gives a 1:1 byte↔char string so
 * the header, count and opening `(` can be located while their string indices
 * still equal byte offsets in the buffer.
 */
function transformBinary(buffer: Buffer, latin1: string, map: PointMap): Buffer {
  const headerEnd = foamFileHeaderEnd(latin1);
  const openParen = latin1.indexOf('(', headerEnd);
  if (openParen < 0) {
    throw new Error('binary points: could not find the data-list opening "("');
  }
  const between = latin1.slice(headerEnd, openParen);
  const countMatch = between.match(/(\d+)\s*$/);
  if (!countMatch) {
    throw new Error('binary points: could not read the point count before "("');
  }
  const count = Number(countMatch[1]);
  const dataStart = openParen + 1;
  const dataEnd = dataStart + count * 3 * 8; // 3 doubles (x,y,z) × 8 bytes each
  if (dataEnd > buffer.length) {
    throw new Error(
      `binary points: declared ${count} points need ${count * 24} bytes but only ${
        buffer.length - dataStart
      } remain after "("`,
    );
  }

  // Copy so the caller's buffer is never mutated (purity), then rewrite in place.
  const out = Buffer.from(buffer);
  for (let i = 0; i < count; i += 1) {
    const off = dataStart + i * 24;
    const px = buffer.readDoubleLE(off);
    const py = buffer.readDoubleLE(off + 8);
    const pz = buffer.readDoubleLE(off + 16);
    const [nx, ny, nz] = map(px, py, pz);
    out.writeDoubleLE(nx, off);
    out.writeDoubleLE(ny, off + 8);
    out.writeDoubleLE(nz, off + 16);
  }
  return out;
}

/**
 * Rewrite every vertex of an OpenFOAM `constant/polyMesh/points` file through a pure
 * per-point map, returning the rewritten file. The `format` (ascii | binary) is read
 * from the FoamFile header and BOTH are handled; the header, precision and vertex
 * count are preserved. Pure — no I/O beyond the passed buffer.
 */
function rewriteMeshPoints(pointsBuffer: Buffer, map: PointMap): Buffer {
  // latin1 keeps char index == byte index and safely decodes the ASCII header of
  // either format (the binary data block is never interpreted as text here).
  const latin1 = pointsBuffer.toString('latin1');
  if (detectFormat(latin1) === 'binary') {
    return transformBinary(pointsBuffer, latin1, map);
  }
  // ASCII points are pure ASCII, so decode as UTF-8 for the textual rewrite.
  return Buffer.from(transformAscii(pointsBuffer.toString('utf8'), map), 'utf8');
}

/**
 * Apply a rigid transform (p' = R(rotation)·p + translation) to every vertex of an
 * OpenFOAM `constant/polyMesh/points` file. Rotation is built with three.js's exact
 * `Matrix4.compose` formula (§2e) for bit-exact parity with the browser preview.
 */
export function transformMeshPoints(
  pointsBuffer: Buffer,
  rotation: Quat,
  translation: Vec3,
): Buffer {
  const m = rotationMatrix(rotation);
  return rewriteMeshPoints(pointsBuffer, (x, y, z) => applyPoint(m, translation, x, y, z));
}

/**
 * Morph every vertex to realise a target `diameterM` for the pipe segment described
 * by `def`: a curvilinear radial scale of ratio `diameterM / def.baselineDiameterM`
 * about the frozen centerline, cosine-blended to 1 at the two stations so the segment
 * joins the rest of the pipe without a kink. Uses the SAME shared `morphPoint` the
 * browser preview runs, so the baked mesh matches the preview bit-for-bit. Both ASCII
 * and BINARY encodings are handled; header, precision and vertex count are preserved.
 * Pure — no I/O beyond the passed buffer.
 */
export function morphMeshPoints(
  pointsBuffer: Buffer,
  def: MorphDefinition,
  diameterM: number,
): Buffer {
  const centerline = prepareCenterline(def.centerline);
  const ratio = def.baselineDiameterM > 0 ? diameterM / def.baselineDiameterM : 1;
  return rewriteMeshPoints(pointsBuffer, (x, y, z) =>
    morphPoint([x, y, z], centerline, def.stationA, def.stationB, def.blend, ratio),
  );
}
