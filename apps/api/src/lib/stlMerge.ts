// Merge several STL surfaces into ONE multi-solid ASCII STL, in-process.
//
// cfMesh's cartesianMesh takes a single `surfaceFile`; a multi-solid STL is the
// idiomatic way to feed it several regions (each `solid` becomes a patch named
// after the file). We do this in TypeScript rather than shelling out to an
// OpenFOAM surface utility so it works on any box (no extra tool dependency) and
// yields clean, predictable patch names. Both STL flavours are read (ASCII and
// binary, detected exactly as in stlBounds) and re-emitted as ASCII facets with a
// recomputed normal, so the output is always a valid single ASCII surface.
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Vec3 = [number, number, number];
interface Triangle {
  normal: Vec3;
  v: [Vec3, Vec3, Vec3];
}

/** Is `buffer` a binary STL? (length == 84 + triangles*50 — the reliable test). */
function isBinaryStl(buffer: Buffer): boolean {
  if (buffer.length < 84) return false;
  const triangles = buffer.readUInt32LE(80);
  return 84 + triangles * 50 === buffer.length;
}

/** Read all triangles from a binary STL (12-byte normal + 3×12-byte vertices + 2 attr). */
function parseBinary(buffer: Buffer): Triangle[] {
  const count = buffer.readUInt32LE(80);
  const tris: Triangle[] = [];
  for (let i = 0; i < count; i += 1) {
    const rec = 84 + i * 50;
    const normal: Vec3 = [buffer.readFloatLE(rec), buffer.readFloatLE(rec + 4), buffer.readFloatLE(rec + 8)];
    const v = [] as unknown as [Vec3, Vec3, Vec3];
    for (let k = 0; k < 3; k += 1) {
      const off = rec + 12 + k * 12;
      v[k] = [buffer.readFloatLE(off), buffer.readFloatLE(off + 4), buffer.readFloatLE(off + 8)];
    }
    tris.push({ normal, v });
  }
  return tris;
}

/** One ASCII `facet normal … vertex×3` block. */
const FACET_RE =
  /facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)[\s\S]*?vertex\s+(\S+)\s+(\S+)\s+(\S+)[\s\S]*?vertex\s+(\S+)\s+(\S+)\s+(\S+)[\s\S]*?vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;

/** Read all triangles from an ASCII STL. */
function parseAscii(text: string): Triangle[] {
  const tris: Triangle[] = [];
  FACET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FACET_RE.exec(text)) !== null) {
    const num = m.slice(1).map(Number);
    tris.push({
      normal: [num[0], num[1], num[2]],
      v: [
        [num[3], num[4], num[5]],
        [num[6], num[7], num[8]],
        [num[9], num[10], num[11]],
      ],
    });
  }
  return tris;
}

/** Read the triangles of an STL buffer (ASCII or binary). */
function parseTriangles(buffer: Buffer): Triangle[] {
  return isBinaryStl(buffer) ? parseBinary(buffer) : parseAscii(buffer.toString('utf8'));
}

/** Reduce a file stem to a valid OpenFOAM word (patch name): letters, digits, `_`. */
function foamWord(stem: string): string {
  const word = stem
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return word || 'surface';
}

/** A finite normal, recomputed from the winding when the stored one is degenerate. */
function faceNormal(t: Triangle): Vec3 {
  const [a, b, c] = t.v;
  const nx = t.normal[0];
  if (Number.isFinite(nx) && (t.normal[0] !== 0 || t.normal[1] !== 0 || t.normal[2] !== 0)) {
    return t.normal;
  }
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Emit one `solid … endsolid` block for a named region. */
function emitSolid(name: string, tris: Triangle[]): string {
  const out: string[] = [`solid ${name}`];
  for (const t of tris) {
    const n = faceNormal(t);
    out.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
    out.push('    outer loop');
    for (const p of t.v) out.push(`      vertex ${p[0]} ${p[1]} ${p[2]}`);
    out.push('    endloop');
    out.push('  endfacet');
  }
  out.push(`endsolid ${name}`);
  return out.join('\n');
}

/**
 * Merge the named STL files (read from `triSurfaceDirAbs`) into ONE multi-solid
 * ASCII STL written to `outAbs`. Each file becomes one solid named after its stem
 * (deduplicated), i.e. one cfMesh patch. Returns the total triangle count.
 * @throws when a file cannot be read or yields no triangles (a broken STL).
 */
export async function mergeStlFilesToAscii(
  triSurfaceDirAbs: string,
  names: string[],
  outAbs: string,
): Promise<{ triangles: number }> {
  const used = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  for (const name of names) {
    const buffer = await fs.readFile(path.join(triSurfaceDirAbs, name));
    const tris = parseTriangles(buffer);
    if (tris.length === 0) {
      throw new Error(`"${name}" contained no readable triangles.`);
    }
    total += tris.length;
    let solid = foamWord(name.replace(/\.[^.]+$/, ''));
    while (used.has(solid)) solid = `${solid}_`;
    used.add(solid);
    parts.push(emitSolid(solid, tris));
  }
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${parts.join('\n')}\n`, 'utf8');
  return { triangles: total };
}
