// Extract a pipe centerline (+ radius profile) from the project case's wall patch,
// for the diameter-optimization "Optimisation" tab. Mirrors boundaryData.ts: the
// bundled Python script (extractCenterline.py) is run through the injectable command
// runner and its JSON output parsed back. Unlike the CSV pipeline this THROWS an
// AppError on failure — the UI needs the centerline to build a morph, so there is no
// "degraded step" to report.
//
//   MESH_PYTHON_BIN extractCenterline.py <caseDir> <wallPatch> <shape> <out.json> \
//       [<ax ay az> <bx by bz>]
//     -> { centerline: [[x,y,z], ...], radii: [...], length, shape, closed }
//
// The axis is obtained by fitting a parametric SHAPE (auto | straight | ring) to
// the wall cloud - robust, needs no clicked points. Optional A/B hint points
// reposition/clip the axis (straight: their region; ring: the arc).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Centerline } from '@dive/shared';
import { env } from '../config/env';
import { AppError } from './AppError';
import { runCommand } from './commandRunner';

/** Channel shape the axis is fitted as. */
export type ChannelShape = 'auto' | 'straight' | 'ring';

export interface CenterlineResult {
  /** The extracted axis polyline (raw polyMesh coords, metres). */
  centerline: Centerline;
  /** Mean wall radius (metres) at each centerline point; diameter = 2*radius. */
  radii: number[];
  /** Total polyline arc-length (metres). */
  length: number;
  /** The shape actually fitted (auto resolves to straight or ring). */
  shape: 'straight' | 'ring';
  /** True when the axis is a closed loop (a ring): the morph spans the whole loop. */
  closed: boolean;
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
 * Fit a centerline to `caseDir`'s wall patch as the given `shape`, returning the
 * axis polyline + radius profile. Optional `a`/`b` hint points reposition/clip it.
 * Throws AppError on any failure (missing script/interpreter, patch not found,
 * degenerate input).
 */
export async function extractCenterline(
  caseDir: string,
  wallPatch: string,
  shape: ChannelShape,
  a?: readonly [number, number, number],
  b?: readonly [number, number, number],
): Promise<CenterlineResult> {
  const scriptPath = centerlineScript();
  if (!(await pathExists(scriptPath))) {
    throw new AppError(500, 'SCRIPT_MISSING', `extractCenterline.py not found at ${scriptPath}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dive-centerline-'));
  const outFile = path.join(tmpDir, 'centerline.json');
  const hint =
    a && b
      ? [String(a[0]), String(a[1]), String(a[2]), String(b[0]), String(b[1]), String(b[2])]
      : [];
  try {
    const result = await runCommand({
      command: env.MESH_PYTHON_BIN,
      args: [scriptPath, caseDir, wallPatch, shape, outFile, ...hint],
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
      shape?: 'straight' | 'ring';
      closed?: boolean;
    };
    if (!parsed.centerline || parsed.centerline.length < 2) {
      throw new AppError(
        422,
        'STUDY_MORPH_FAILED',
        'Centerline fit returned too few points (try a clearer wall patch or a different shape)',
      );
    }
    return {
      centerline: { points: parsed.centerline },
      radii: parsed.radii ?? [],
      length: parsed.length ?? 0,
      shape: parsed.shape === 'ring' ? 'ring' : 'straight',
      closed: !!parsed.closed,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
