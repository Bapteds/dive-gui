/**
 * ringAxis - the pure geometry behind the two placed rings.
 *
 * The engineer drops two rings on the shape and may TILT each one so its cut plane
 * follows the real direction of the channel there (a bend, a cone, an oblique inlet).
 * A ring's tilt is the normal of its cut plane, and that normal is the axis TANGENT at
 * that ring: the axis between the two rings is the cubic Hermite curve that leaves ring
 * A along its normal and arrives at ring B along its normal. With no tilt both tangents
 * are the chord, and the Hermite collapses EXACTLY to the straight A->B segment, so the
 * untilted behaviour is unchanged.
 *
 * Why this matters: morphPoint bounds its zone by projecting onto the axis polyline, so
 * the zone's end boundaries sit perpendicular to the axis tangent at each end - i.e. in
 * each ring's own cut plane. Tilting a ring therefore genuinely tilts the zone boundary,
 * it is not a cosmetic rotation.
 *
 * Imported by BOTH the workspace (which builds the config the server bakes) and the
 * viewer (which draws the rings and previews the morph), so the two cannot diverge.
 */

export type Vec3 = [number, number, number];

/** A ring's cut-plane tilt, in DEGREES, off the default (perpendicular to the chord). */
export interface Tilt {
  x: number;
  y: number;
}

/** Tilt slider bound. Beyond this the Hermite axis starts to fold back on itself. */
export const TILT_LIMIT = 60;

export const NO_TILT: Tilt = { x: 0, y: 0 };

/** Points sampled along a tilted (curved) axis. */
const AXIS_SAMPLES = 24;

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Rotate `v` about unit `axis` by `angle` radians (Rodrigues). */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  if (angle === 0) return v;
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

/**
 * The frame the tilt sliders act in: the chord A->B plus two stable perpendiculars.
 * Shared by both rings so the X slider always tips the same visual way.
 */
export function tiltFrame(a: Vec3, b: Vec3): { d: Vec3; u: Vec3; v: Vec3 } {
  const d = normalize(sub(b, a));
  const up: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(d, up));
  const v = normalize(cross(d, u));
  return { d, u, v };
}

/** Cut-plane normal of one ring: the chord direction tipped by the ring's tilt. */
export function tiltedNormal(a: Vec3, b: Vec3, tilt: Tilt): Vec3 {
  const { d, u, v } = tiltFrame(a, b);
  const rx = (tilt.x * Math.PI) / 180;
  const ry = (tilt.y * Math.PI) / 180;
  return normalize(rotateAbout(rotateAbout(d, u, rx), v, ry));
}

/** Both rings' cut-plane normals (also the axis tangents at each end). */
export function ringNormals(a: Vec3, b: Vec3, tiltA: Tilt, tiltB: Tilt): { nA: Vec3; nB: Vec3 } {
  return { nA: tiltedNormal(a, b, tiltA), nB: tiltedNormal(a, b, tiltB) };
}

function untilted(t: Tilt): boolean {
  return t.x === 0 && t.y === 0;
}

/**
 * The axis polyline between the two rings. Straight (2 points) while both rings are
 * untilted; otherwise the Hermite curve leaving A along nA and arriving at B along nB.
 */
export function buildAxis(a: Vec3, b: Vec3, tiltA: Tilt, tiltB: Tilt): Vec3[] {
  if (untilted(tiltA) && untilted(tiltB)) return [a, b];
  const { nA, nB } = ringNormals(a, b, tiltA, tiltB);
  const L = dist3(a, b);
  const mA: Vec3 = [nA[0] * L, nA[1] * L, nA[2] * L];
  const mB: Vec3 = [nB[0] * L, nB[1] * L, nB[2] * L];
  const points: Vec3[] = [];
  for (let i = 0; i <= AXIS_SAMPLES; i += 1) {
    const t = i / AXIS_SAMPLES;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    points.push([
      h00 * a[0] + h10 * mA[0] + h01 * b[0] + h11 * mB[0],
      h00 * a[1] + h10 * mA[1] + h01 * b[1] + h11 * mB[1],
      h00 * a[2] + h10 * mA[2] + h01 * b[2] + h11 * mB[2],
    ]);
  }
  return points;
}

/**
 * The axis tangents at its two ends, which ARE the two rings' cut-plane normals (that
 * is how buildAxis constructs it). Reading them back off the axis means a drawn ring
 * always matches the axis it bounds, including for a saved study whose stored polyline
 * already has the tilt baked in.
 */
export function axisEndTangents(points: Vec3[]): { nA: Vec3; nB: Vec3 } | null {
  const n = points.length;
  if (n < 2) return null;
  const nA = normalize(sub(points[1], points[0]));
  const nB = normalize(sub(points[n - 1], points[n - 2]));
  return { nA, nB };
}

/** Total length of an axis polyline (the real zone length once tilted/curved). */
export function axisLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist3(points[i - 1], points[i]);
  return total;
}
