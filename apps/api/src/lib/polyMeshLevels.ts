// Per-patch height statistics of an OpenFOAM polyMesh, read in-process (WS-I §2).
//
// The Free surface tool needs the flat HORIZONTAL top patch of the case mesh
// (the rigid lid): all its face centres within ±1 mm of one z, every face normal
// vertical. Only boundary faces matter, so the reader streams `points` (kept as
// one Float64Array) then `faces` line by line and only looks at the faces from
// the first boundary patch on; nothing else of the mesh is loaded.
//
// Supported: ASCII `points` / `faces` (faceList or faceCompactList), the files
// the app's meshers write (writeFormat ascii). A binary or compressed mesh
// yields `null` (the caller reports the flatness as unknown).
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Height statistics of one boundary patch. */
export interface PatchLevel {
  name: string;
  type: string;
  nFaces: number;
  /** Flat (face centres within ±tol of one z) AND horizontal (vertical normals). */
  flat: boolean;
  /** Mean face-centre z (m), null for an empty patch. */
  z: number | null;
  /** Face-centre z range (m), null for an empty patch. */
  zMin: number | null;
  zMax: number | null;
}

interface BoundaryEntry {
  name: string;
  type: string;
  nFaces: number;
  startFace: number;
}

/** Parse name / type / nFaces / startFace of every patch of a boundary file. */
export function parseBoundaryEntries(content: string): BoundaryEntry[] {
  const cleaned = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out: BoundaryEntry[] = [];
  const block = /([A-Za-z_][A-Za-z0-9_.-]*)\s*\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(cleaned)) !== null) {
    if (m[1] === 'FoamFile') continue;
    const body = m[2];
    const nFaces = body.match(/\bnFaces\s+(\d+)\s*;/);
    const startFace = body.match(/\bstartFace\s+(\d+)\s*;/);
    if (!nFaces || !startFace) continue;
    out.push({
      name: m[1],
      type: body.match(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/)?.[1] ?? 'patch',
      nFaces: Number(nFaces[1]),
      startFace: Number(startFace[1]),
    });
  }
  return out;
}

const NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Thrown for a mesh this reader does not handle (binary / compressed). */
class UnsupportedMesh extends Error {}

/**
 * Stream the numbers of a Foam list file after its FoamFile header, skipping
 * comments. `onNumber` returns false to stop early. Returns the header's class.
 */
async function streamNumbers(
  file: string,
  onNumber: (value: number) => boolean | void,
): Promise<string> {
  const input = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let headerState: 'before' | 'in' | 'done' = 'before';
  let depth = 0;
  let header = '';
  let inBlockComment = false;
  let stopped = false;
  try {
    for await (const raw of rl) {
      let line = raw;
      // Block comments (the OpenFOAM banner) may span lines.
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      line = line.replace(/\/\*.*?\*\//g, '');
      const open = line.indexOf('/*');
      if (open >= 0) {
        inBlockComment = true;
        line = line.slice(0, open);
      }
      const lc = line.indexOf('//');
      if (lc >= 0) line = line.slice(0, lc);
      if (headerState !== 'done') {
        if (headerState === 'before') {
          const at = line.indexOf('FoamFile');
          if (at < 0) {
            if (!line.trim()) continue;
            // No header at all: treat the line as data.
            headerState = 'done';
          } else {
            headerState = 'in';
            line = line.slice(at + 'FoamFile'.length);
          }
        }
        if (headerState === 'in') {
          let cut = -1;
          for (let i = 0; i < line.length; i += 1) {
            if (line[i] === '{') depth += 1;
            else if (line[i] === '}') {
              depth -= 1;
              if (depth === 0) {
                cut = i;
                break;
              }
            }
          }
          if (cut < 0) {
            header += `${line}\n`;
            continue;
          }
          header += line.slice(0, cut);
          line = line.slice(cut + 1);
          headerState = 'done';
          if (/\bformat\s+binary\b/.test(header)) throw new UnsupportedMesh('binary');
        }
      }
      const matches = line.match(NUMBER_RE);
      if (!matches) continue;
      for (const token of matches) {
        if (onNumber(Number(token)) === false) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return header.match(/\bclass\s+([A-Za-z_]+)\s*;/)?.[1] ?? '';
}

/** Read every point of an ASCII points file as [x0, y0, z0, x1, …]. */
async function readPoints(file: string): Promise<Float64Array> {
  let count = -1;
  let coords = new Float64Array(0);
  let i = 0;
  await streamNumbers(file, (v) => {
    if (count < 0) {
      count = v;
      coords = new Float64Array(count * 3);
      return count > 0;
    }
    coords[i] = v;
    i += 1;
    return i < coords.length;
  });
  if (count < 0 || i < coords.length) throw new UnsupportedMesh('points');
  return coords;
}

/** Running statistics of one patch. */
interface Acc {
  zMin: number;
  zMax: number;
  zSum: number;
  count: number;
  horizontal: boolean;
}

/**
 * Compute the per-patch face-centre height statistics of a polyMesh directory.
 * Returns null when the mesh is missing or not readable here (binary, gzip).
 * `tol` is the flatness half-width (m, default 1 mm).
 */
export async function readPatchLevels(
  polyMeshDir: string,
  tol = 0.001,
): Promise<PatchLevel[] | null> {
  let boundaryText: string;
  try {
    boundaryText = await fs.readFile(path.join(polyMeshDir, 'boundary'), 'utf8');
  } catch {
    return null;
  }
  const patches = parseBoundaryEntries(boundaryText);
  if (patches.length === 0) return [];

  const accs: Acc[] = patches.map(() => ({
    zMin: Infinity,
    zMax: -Infinity,
    zSum: 0,
    count: 0,
    horizontal: true,
  }));
  const ordered = patches
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p.nFaces > 0)
    .sort((a, b) => a.startFace - b.startFace);
  const firstBoundary = ordered.length ? ordered[0].startFace : Infinity;
  const lastFace = ordered.reduce((m, p) => Math.max(m, p.startFace + p.nFaces), 0);

  try {
    const pts = await readPoints(path.join(polyMeshDir, 'points'));
    let cursor = 0; // index into `ordered`
    const patchOf = (face: number): number => {
      while (cursor < ordered.length && face >= ordered[cursor].startFace + ordered[cursor].nFaces)
        cursor += 1;
      const p = ordered[cursor];
      return p && face >= p.startFace ? p.index : -1;
    };
    const addFace = (face: number, verts: number[]): void => {
      const pi = patchOf(face);
      if (pi < 0 || verts.length < 3) return;
      let zs = 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let k = 0; k < verts.length; k += 1) {
        const a = verts[k] * 3;
        const b = verts[(k + 1) % verts.length] * 3;
        const ax = pts[a];
        const ay = pts[a + 1];
        const az = pts[a + 2];
        const bx = pts[b];
        const by = pts[b + 1];
        const bz = pts[b + 2];
        zs += az;
        // Newell's normal.
        nx += (ay - by) * (az + bz);
        ny += (az - bz) * (ax + bx);
        nz += (ax - bx) * (ay + by);
      }
      const zc = zs / verts.length;
      const acc = accs[pi];
      acc.zMin = Math.min(acc.zMin, zc);
      acc.zMax = Math.max(acc.zMax, zc);
      acc.zSum += zc;
      acc.count += 1;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0 && Math.abs(nz) / len < 0.99) acc.horizontal = false;
    };

    const facesFile = path.join(polyMeshDir, 'faces');
    // First pass on the header only: faceList vs faceCompactList.
    const cls = await streamNumbers(facesFile, () => false);
    if (cls === 'faceCompactList') {
      // offsets list (nFaces + 1 labels), then the vertex labels list.
      let nOffsets = -1;
      let oi = 0;
      const bOffsets: number[] = []; // offsets of faces firstBoundary .. lastFace
      let nLabels = -1;
      let li = 0;
      let face = firstBoundary;
      let verts: number[] = [];
      await streamNumbers(facesFile, (v) => {
        if (nOffsets < 0) {
          nOffsets = v;
          return true;
        }
        if (oi < nOffsets) {
          if (oi >= firstBoundary && oi <= lastFace) bOffsets.push(v);
          oi += 1;
          return true;
        }
        if (nLabels < 0) {
          nLabels = v;
          return nLabels > 0;
        }
        const label = v;
        const idx = li;
        li += 1;
        if (bOffsets.length < 2 || idx < bOffsets[0]) return li < nLabels;
        // Advance faces whose label range is done.
        while (
          face - firstBoundary + 1 < bOffsets.length &&
          idx >= bOffsets[face - firstBoundary + 1]
        ) {
          addFace(face, verts);
          verts = [];
          face += 1;
        }
        if (face >= lastFace) return false;
        verts.push(label);
        return li < nLabels;
      });
      if (verts.length && face < lastFace) addFace(face, verts);
    } else {
      // faceList: N, then per face "k(v0 … vk-1)".
      let n = -1;
      let face = 0;
      let need = -1;
      let verts: number[] = [];
      await streamNumbers(facesFile, (v) => {
        if (n < 0) {
          n = v;
          return n > 0;
        }
        if (need < 0) {
          need = v;
          verts = [];
          return true;
        }
        verts.push(v);
        if (verts.length === need) {
          if (face >= firstBoundary) addFace(face, verts);
          face += 1;
          need = -1;
          if (face >= lastFace || face >= n) return false;
        }
        return true;
      });
    }
  } catch (err) {
    if (err instanceof UnsupportedMesh) return null;
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }

  return patches.map((p, i) => {
    const a = accs[i];
    if (a.count === 0)
      return {
        name: p.name,
        type: p.type,
        nFaces: p.nFaces,
        flat: false,
        z: null,
        zMin: null,
        zMax: null,
      };
    return {
      name: p.name,
      type: p.type,
      nFaces: p.nFaces,
      flat: a.horizontal && a.zMax - a.zMin <= 2 * tol,
      z: a.zSum / a.count,
      zMin: a.zMin,
      zMax: a.zMax,
    };
  });
}
