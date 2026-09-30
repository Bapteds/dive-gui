// Glue between the free-surface job runner (WS-I) and the vendored LID ITERATION
// KIT (apps/api/scripts/lidkit/): interpreter and script paths, the base /
// fitted multi-solid STL <-> meshing-session surfaces mapping, the lidSurfaces
// function-object dict, and small pure readers (Δp₀ monitors, mesh cell count,
// time directories). No process is spawned here.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FMS_EXTENSION } from '@dive/shared';
import { env } from '../config/env';
import { emitSolid, foamWord, parseStlSolids, type Triangle } from './stlMerge';
import { listStl, readStl } from './meshingStorage';

/** The kit's interpreter: LIDKIT_PYTHON_BIN, else CHAMBER_PYTHON_BIN. */
export function lidkitPython(): string {
  return env.LIDKIT_PYTHON_BIN.trim() || env.CHAMBER_PYTHON_BIN;
}

/** The vendored kit scripts. */
export type LidkitScript = 'lidkit_surface.py' | 'lidkit_fitlid.py' | 'lidkit_post.py';

/** Absolute path of a kit script (scripts/ is not compiled: 2 levels up from src/lib or dist/lib). */
export function lidkitScript(name: LidkitScript): string {
  return path.resolve(__dirname, '../../scripts/lidkit', name);
}

/** The `lidSurfaces` function object (kit template) with the lid / inlet patch names. */
export async function renderLidSurfacesDict(lidPatch: string, inletPatch: string): Promise<string> {
  const template = await fs.readFile(
    path.resolve(__dirname, '../../scripts/lidkit/templates/lidSurfaces'),
    'utf8',
  );
  return template.replace(/@ATMOSPHERE@/g, lidPatch).replace(/@INLET@/g, inletPatch);
}

/** One solid of a session surface file. */
export interface SurfaceSolid {
  name: string;
  triangles: Triangle[];
}

/** One STL file of a session and the solids it contributes to the base STL. */
export interface SurfaceFile {
  file: string;
  solids: SurfaceSolid[];
}

/**
 * Read a session's STL surfaces as named solids. A file with two or more named
 * solids keeps their names; any other file is ONE solid named after its stem
 * (the cfMesh merge rule, so the names match the mesh patches). Names are
 * de-duplicated across files with a `_` suffix. FMS files are ignored.
 */
export async function readSessionSolids(sessionId: string): Promise<SurfaceFile[]> {
  const used = new Set<string>();
  const unique = (name: string): string => {
    let n = name;
    while (used.has(n)) n = `${n}_`;
    used.add(n);
    return n;
  };
  const out: SurfaceFile[] = [];
  for (const entry of await listStl(sessionId)) {
    if (entry.name.toLowerCase().endsWith(FMS_EXTENSION)) continue;
    const bytes = await readStl(sessionId, entry.name);
    if (!bytes) continue;
    const parsed = parseStlSolids(bytes).filter((s) => s.triangles.length > 0);
    if (parsed.length === 0) continue;
    const named = parsed.length >= 2 && parsed.every((s) => s.name);
    const solids: SurfaceSolid[] = named
      ? parsed.map((s) => ({ name: unique(foamWord(s.name as string)), triangles: s.triangles }))
      : [
          {
            name: unique(foamWord(entry.name.replace(/\.[^.]+$/, ''))),
            triangles: parsed.flatMap((s) => s.triangles),
          },
        ];
    out.push({ file: entry.name, solids });
  }
  return out;
}

/** The multi-solid ASCII base STL (the kit's flat `base_stl`). */
export function buildBaseStl(files: SurfaceFile[]): string {
  return `${files.flatMap((f) => f.solids.map((s) => emitSolid(s.name, s.triangles))).join('\n')}\n`;
}

/** Vertex z statistics of a solid (m). */
export function solidZStats(
  triangles: Triangle[],
): { min: number; max: number; mean: number } | null {
  if (triangles.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const t of triangles) {
    for (const v of t.v) {
      min = Math.min(min, v[2]);
      max = Math.max(max, v[2]);
      sum += v[2];
    }
  }
  return { min, max, mean: sum / (triangles.length * 3) };
}

/**
 * Split the fitted STL back into the session's surface files (same file names,
 * same solids per file). A solid the base did not have (an upstand patch other
 * than the lid) joins the file that holds the lid. Returns ASCII STL buffers.
 */
export function splitFittedStl(
  fitted: Buffer,
  files: SurfaceFile[],
  lidPatch: string,
): Array<{ name: string; data: Buffer }> {
  const byName = new Map<string, Triangle[]>();
  for (const solid of parseStlSolids(fitted)) {
    if (!solid.name) continue;
    byName.set(solid.name, [...(byName.get(solid.name) ?? []), ...solid.triangles]);
  }
  const known = new Set(files.flatMap((f) => f.solids.map((s) => s.name)));
  const extras = [...byName.keys()].filter((n) => !known.has(n));
  return files.map((f) => {
    const names = f.solids.map((s) => s.name);
    if (names.includes(lidPatch)) names.push(...extras);
    const text = names
      .filter((n) => (byName.get(n)?.length ?? 0) > 0)
      .map((n) => emitSolid(n, byName.get(n) as Triangle[]))
      .join('\n');
    return { name: f.file, data: Buffer.from(`${text}\n`, 'utf8') };
  });
}

/** Numeric time directory names of a case, ascending (`0` included). */
export async function listTimeDirs(caseDir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.readdir(caseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory() && /^[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** Read `postProcessing/<fo>/<t>/surfaceFieldValue.dat` rows as time -> value. */
async function readSurfaceFieldValue(caseDir: string, fo: string): Promise<Map<number, number>> {
  const rows = new Map<number, number>();
  const root = path.join(caseDir, 'postProcessing', fo);
  let starts: string[];
  try {
    starts = await fs.readdir(root);
  } catch {
    return rows;
  }
  for (const start of starts) {
    let text: string;
    try {
      text = await fs.readFile(path.join(root, start, 'surfaceFieldValue.dat'), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [t, v] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(t) && Number.isFinite(v)) rows.set(t, v);
    }
  }
  return rows;
}

/**
 * Δp₀ of a solved case (the kit's `dp0`): inlet minus outlet total pressure from
 * the `inlet_p0_flux` / `outlet_p0_flux` monitors (WS-G), last common time.
 * Null when the monitors are absent.
 */
export async function readDp0(caseDir: string): Promise<number | null> {
  const inlet = await readSurfaceFieldValue(caseDir, 'inlet_p0_flux');
  const outlet = await readSurfaceFieldValue(caseDir, 'outlet_p0_flux');
  const times = [...inlet.keys()].filter((t) => outlet.has(t)).sort((a, b) => a - b);
  if (times.length === 0) return null;
  const last = times[times.length - 1];
  return (inlet.get(last) as number) - (outlet.get(last) as number);
}

/** The cell count of the last checkMesh report in a mesher log, or null. */
export function parseMeshCells(log: string): number | null {
  const matches = [...log.matchAll(/^\s*cells:\s+(\d+)/gm)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}
