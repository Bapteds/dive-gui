// Extract a pipe centerline (+ radius profile) from the project case's wall patch,
// for the diameter-optimization "Optimisation" tab. Mirrors boundaryData.ts: the
// bundled Python script (extractCenterline.py) is run through the injectable command
// runner and its JSON output parsed back. Unlike the CSV pipeline this THROWS an
// AppError on failure — the UI needs the centerline to build a morph, so there is no
// "degraded step" to report.
//
//   MESH_PYTHON_BIN extractCenterline.py <caseDir> <wallPatch> <out.json> \
//       <ax ay az> [<vx vy vz> ...] <bx by bz>
//     -> { centerline: [[x,y,z], ...], radii: [...], length }
//
// Two or more ORDERED waypoints: the wall path is walked leg by leg, so via
// points between A and B disambiguate the route (the far side of a closed ring
// for a full tour, or which way around a spiral).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Centerline } from '@dive/shared';
import { env } from '../config/env';
import { AppError } from './AppError';
import { runCommand } from './commandRunner';

export interface CenterlineResult {
  /** The extracted axis polyline (raw polyMesh coords, metres). */
  centerline: Centerline;
  /** Mean wall radius (metres) at each centerline point; diameter = 2*radius. */
  radii: number[];
  /** Total polyline arc-length (metres). */
  length: number;
}

/** Does an absolute path exist on disk? */
async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the bundled centerline script. scripts/ sits beside src/ and
 * dist/ under apps/api, so two levels up from src/lib (or dist/lib) reaches it
 * whether running from source or compiled (same resolution as boundaryData.ts).
 */
function centerlineScript(): string {
  return path.resolve(__dirname, '../../scripts/extractCenterline.py');
}

/**
 * Run extractCenterline.py on `caseDir`'s wall patch through the ORDERED
 * `waypoints` (first = A, last = B, any between are via points), returning the
 * centerline polyline + radius profile. Throws AppError on any failure (missing
 * script/interpreter, patch not found, degenerate input).
 */
export async function extractCenterline(
  caseDir: string,
  wallPatch: string,
  waypoints: readonly (readonly [number, number, number])[],
): Promise<CenterlineResult> {
  if (waypoints.length < 2) {
    throw new AppError(422, 'STUDY_MORPH_FAILED', 'A centerline needs at least two waypoints');
  }
  const scriptPath = centerlineScript();
  if (!(await pathExists(scriptPath))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `extractCenterline.py not found at ${scriptPath}`,
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dive-centerline-'));
  const outFile = path.join(tmpDir, 'centerline.json');
  try {
    const result = await runCommand({
      command: env.MESH_PYTHON_BIN,
      args: [
        scriptPath,
        caseDir,
        wallPatch,
        outFile,
        ...waypoints.flatMap((w) => [String(w[0]), String(w[1]), String(w[2])]),
      ],
      cwd: caseDir,
      env: process.env,
      timeoutMs: env.MESH_BUILD_TIMEOUT_MS,
    });

    if (result.spawnError) {
      throw new AppError(
        500,
        'SCRIPT_MISSING',
        `Could not run ${env.MESH_PYTHON_BIN} (${result.spawnError}). Is Python + PyVista installed?`,
      );
    }
    if (result.exitCode !== 0) {
      const why = (result.stderr || result.stdout || 'unknown error').trim().split('\n').pop();
      throw new AppError(422, 'STUDY_MORPH_FAILED', `Centerline extraction failed: ${why}`);
    }

    const parsed = JSON.parse(await fs.readFile(outFile, 'utf8')) as {
      centerline?: [number, number, number][];
      radii?: number[];
      length?: number;
    };
    if (!parsed.centerline || parsed.centerline.length < 2) {
      throw new AppError(
        422,
        'STUDY_MORPH_FAILED',
        'Centerline extraction returned too few points (pick a clearer wall patch or endpoints)',
      );
    }
    return {
      centerline: { points: parsed.centerline },
      radii: parsed.radii ?? [],
      length: parsed.length ?? 0,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
