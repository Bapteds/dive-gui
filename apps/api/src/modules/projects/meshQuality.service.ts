// Mesh quality rating ("Notation" tab): business logic.
//
// POST runs `checkMesh -allGeometry` on the project's case mesh, grades the
// output per criterion (lib/meshQuality.ts) and persists the result as
// quality.json NEXT TO the case (sibling, like export/) so a rating never
// mutates case inputs and GET can re-serve the last run without re-running
// checkMesh (a full -allGeometry pass on a large mesh takes a while).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MeshQualityResult } from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand } from '../../lib/commandRunner';
import { planOpenfoamCommand } from '../../lib/openfoamCommand';
import { caseDirAbsolute, caseFileExists, projectDirAbsolute } from '../../lib/caseStorage';
import { MESH_FILES } from '../../lib/openfoamCase';
import { parseCheckMeshFigures, rateMeshQuality } from '../../lib/meshQuality';
import { assertProjectVisible, type Viewer } from './projects.service';

/** Persisted rating file, sibling of case/ (never inside it). */
function qualityFilePath(projectId: string): string {
  return path.join(projectDirAbsolute(projectId), 'quality.json');
}

/** Keep the stored/wire log bounded while preserving the useful tail. */
const LOG_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= LOG_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - LOG_TAIL_CHARS)}`;
}

/** All five polyMesh files present? (same gate as the viewer/merge). */
async function hasPolyMesh(projectId: string): Promise<boolean> {
  const presence = await Promise.all(MESH_FILES.map((file) => caseFileExists(projectId, file)));
  return presence.every(Boolean);
}

/**
 * Run checkMesh -allGeometry on the case mesh, grade it, persist and return
 * the rating. Tool failures do NOT throw (checkMesh exits non-zero on a mesh
 * that fails checks — that IS the rating); only access/pre-condition problems do.
 *
 * @throws 404 NOT_FOUND if the project is not visible (no existence leak).
 * @throws 409 NO_MESH if the project has no constant/polyMesh to rate.
 */
export async function runMeshQuality(viewer: Viewer, projectId: string): Promise<MeshQualityResult> {
  await assertProjectVisible(viewer, projectId);
  if (!(await hasPolyMesh(projectId))) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }

  const caseDir = caseDirAbsolute(projectId);
  // -allGeometry adds the face-flatness (twisting/folding) and face-volume-ratio
  // (cell-size uniformity) checks that the rating grades; the default run does
  // not print them.
  const plan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-allGeometry', '-case', caseDir], caseDir);
  const started = Date.now();
  const result = await runCommand({ ...plan, timeoutMs: env.MESH_BUILD_TIMEOUT_MS });
  const ranAt = new Date(started).toISOString();

  let rating: MeshQualityResult;
  if (result.spawnError) {
    // checkMesh is not installed on this host (e.g. a Windows dev box): report
    // honestly instead of grading nothing.
    rating = {
      available: false,
      ranAt,
      command: plan.display,
      meshOk: false,
      failedChecks: 0,
      cells: null,
      points: null,
      faces: null,
      negativeVolumeCells: 0,
      overall: { score: null, grade: null },
      metrics: [],
      notes: ['checkMesh is not available on this server — no rating could be produced.'],
      log: result.spawnError,
    };
  } else {
    const output = `${result.stdout}\n${result.stderr}`;
    rating = rateMeshQuality(parseCheckMeshFigures(output), ranAt, plan.display, tail(output));
    if (result.timedOut) {
      rating.notes.unshift(
        `checkMesh timed out after ${Math.round(env.MESH_BUILD_TIMEOUT_MS / 1000)}s — figures below may be partial.`,
      );
    }
  }

  await fs.writeFile(qualityFilePath(projectId), JSON.stringify(rating, null, 2), 'utf8');
  return rating;
}

/**
 * The last persisted rating, or null when none has been run yet. Stale-by-design:
 * the mesh may have changed since; the UI shows ranAt so the user can re-run.
 *
 * @throws 404 NOT_FOUND if the project is not visible (no existence leak).
 */
export async function getMeshQuality(viewer: Viewer, projectId: string): Promise<MeshQualityResult | null> {
  await assertProjectVisible(viewer, projectId);
  try {
    const raw = await fs.readFile(qualityFilePath(projectId), 'utf8');
    return JSON.parse(raw) as MeshQualityResult;
  } catch {
    // Missing or unreadable/corrupt file both mean "no rating yet".
    return null;
  }
}
