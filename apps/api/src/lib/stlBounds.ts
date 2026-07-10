// Pure-TypeScript STL parsing to an axis-aligned bounding box.
//
// The meshing feature needs the extent of the uploaded surface(s) to size the
// snappyHexMesh background box (blockMeshDict) and to default the keep-point
// (locationInMesh). Both are geometry, not OpenFOAM: computing them here means
// the whole config can be prepared on a machine without any OpenFOAM toolchain
// (the Windows dev box), and only the four CLI steps of the run need the tools.
//
// Both STL flavours are handled:
//   - binary: 80-byte header + uint32 triangle count + 50 bytes/triangle
//     (12-byte normal + 3x 12-byte vertices + 2 attribute bytes).
//   - ASCII : `vertex x y z` lines.
// Detection is by the exact-size test (the only reliable one): a binary file's
// length is exactly 84 + triangleCount*50. An ASCII file that happens to start
// with the word "solid" cannot satisfy that equality, so it never misdetects.

/** Axis-aligned bounding box in model units (metres for a CFD STL). */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Result of parsing one STL buffer: its box, triangle count, and validity. */
export interface StlParseResult extends Bounds {
  triangleCount: number;
  /** False when no finite vertex was read (empty / malformed STL). */
  valid: boolean;
}

/** A running min/max accumulator over vertex coordinates. */
interface Accumulator {
  min: [number, number, number];
  max: [number, number, number];
  count: number;
}

function newAccumulator(): Accumulator {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    count: 0,
  };
}

/** Fold one vertex into the accumulator, ignoring non-finite coordinates. */
function accumulate(acc: Accumulator, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < acc.min[0]) acc.min[0] = x;
  if (y < acc.min[1]) acc.min[1] = y;
  if (z < acc.min[2]) acc.min[2] = z;
  if (x > acc.max[0]) acc.max[0] = x;
  if (y > acc.max[1]) acc.max[1] = y;
  if (z > acc.max[2]) acc.max[2] = z;
  acc.count += 1;
}

/**
 * Does `buffer` look like a binary STL? The declared triangle payload must FIT in
 * the file — `84 + triangles*50 <= length`, not `===`, so a binary STL with
 * trailing padding (some exporters pad the file) is still recognised (M17). A real
 * ASCII STL cannot satisfy this: bytes 80-83 are printable text, giving a huge
 * `triangles`, so `84 + triangles*50` dwarfs any file length. The parse itself
 * falls back to ASCII if a "binary" read yields nothing, covering any rare misdetect.
 */
function looksBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < 84) return false;
  const triangles = buffer.readUInt32LE(80);
  return triangles > 0 && 84 + triangles * 50 <= buffer.length;
}

/** Parse a binary STL, folding every vertex into `acc`. */
function parseBinary(buffer: Buffer, acc: Accumulator): void {
  const triangles = buffer.readUInt32LE(80);
  for (let i = 0; i < triangles; i += 1) {
    // Each record: 12-byte normal, then 3 vertices of 12 bytes, then 2 attr bytes.
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v += 1) {
      const off = base + v * 12;
      accumulate(
        acc,
        buffer.readFloatLE(off),
        buffer.readFloatLE(off + 4),
        buffer.readFloatLE(off + 8),
      );
    }
  }
}

/** Match a `vertex x y z` line (tolerant of spacing and exponent notation). */
const VERTEX_RE = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;

/** Parse an ASCII STL, folding every `vertex` into `acc`. */
function parseAscii(text: string, acc: Accumulator): void {
  VERTEX_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VERTEX_RE.exec(text)) !== null) {
    accumulate(acc, Number(match[1]), Number(match[2]), Number(match[3]));
    // A vertex is one third of a triangle; report triangle count below.
  }
}

/**
 * Parse a single STL buffer (ASCII or binary) into its bounding box. Never
 * throws on malformed input: an unreadable / empty STL returns `valid: false`
 * with an empty (Infinity) box, which the caller treats as "not a usable STL".
 */
export function parseStlBounds(buffer: Buffer): StlParseResult {
  const acc = newAccumulator();
  try {
    if (looksBinaryStl(buffer)) {
      parseBinary(buffer, acc);
      // If a binary read found no vertices, the size test misdetected an ASCII
      // file — retry as ASCII rather than reporting an unreadable STL.
      if (acc.count === 0) parseAscii(buffer.toString('utf8'), acc);
    } else {
      parseAscii(buffer.toString('utf8'), acc);
    }
  } catch {
    // Corrupt binary offsets etc. — fall through to the validity check below.
  }
  const valid = acc.count > 0;
  return {
    min: valid ? acc.min : [0, 0, 0],
    max: valid ? acc.max : [0, 0, 0],
    // A vertex triple is one triangle; count is vertices/3 (floored).
    triangleCount: Math.floor(acc.count / 3),
    valid,
  };
}

/**
 * Combine several bounding boxes component-wise into their union, or null when
 * the list is empty. Used to size the background box across every session STL.
 */
export function unionBounds(boxes: Bounds[]): Bounds | null {
  if (boxes.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let i = 0; i < 3; i += 1) {
      if (box.min[i] < min[i]) min[i] = box.min[i];
      if (box.max[i] > max[i]) max[i] = box.max[i];
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
  return { min, max };
}
