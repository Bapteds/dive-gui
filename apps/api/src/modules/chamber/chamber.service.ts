// Business logic for the standalone Chamber Creation feature.
//
// The empirical model (X1/X2/X3 -> 12 parameters, with the optional Min/Max/Exact
// clamp) lives in @dive/shared and is evaluated HERE; the resolved FINAL params
// (converted mm -> m) plus the LENGTH input are handed to scripts/buildChamber.py,
// which is a pure CadQuery geometry builder. The build follows the same model as
// the mesh viewer: the builder runs through the injectable command runner (never
// throwing on a tool failure), its path is resolved relative to THIS module
// (cwd-independent), and a run that produces no GLB is treated as a failure.
//
// Not project-scoped: a build is keyed by a content hash of its params under
// <STORAGE_DIR>/chamber/<hash>, shared across the team behind requireAuth.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CHAMBER_OUTPUT_KEYS,
  CHAMBER_WALL_THICKNESS_MM,
  computeChamberOutputs,
  type ChamberInput,
  type ChamberOutput,
  type MeshManifest,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import {
  chamberGlbExists,
  chamberHash,
  chamberPaths,
  readChamberEdges,
  readChamberExport,
  readChamberGlb,
  readChamberManifest,
  writeChamberParams,
  type ChamberExportKind,
} from '../../lib/chamberStorage';

/** Sheet/model values are millimetres; the builder works in metres. */
const MM_TO_M = 1 / 1000;

/**
 * Hollow variant: the central cylinder's height is a fixed ratio of its own
 * diameter (independent of the empirical P12/hLast, which drives only the stepped
 * last cylinder). Height = 1.33 x central diameter.
 */
const CENTRAL_HEIGHT_OVER_DIAMETER = 1.33;

/** The result of a build request: the cache key + the twelve computed outputs. */
export interface ChamberBuildResult {
  hash: string;
  outputs: ChamberOutput[];
}

/** Resolve the builder script (configured path, else the bundled default). */
function buildChamberScript(): string {
  const configured = env.BUILD_CHAMBER_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ is not compiled, so three levels up from src/modules/chamber (or
  // dist/modules/chamber) reaches apps/api/scripts from source and compiled output.
  return path.resolve(__dirname, '../../../scripts/buildChamber.py');
}

/** Does an absolute path exist on disk? */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Keep a captured stderr tail bounded when surfacing a build failure. */
function tail(text: string): string {
  return text.length <= 4000 ? text : `…(truncated)\n${text.slice(text.length - 4000)}`;
}

/** Build a concise failure message from a command result. */
function summarizeFailure(result: CommandResult): string {
  if (result.spawnError) return `Could not start the chamber builder: ${result.spawnError}`;
  if (result.timedOut) return 'The chamber builder timed out.';
  const detail = tail(result.stderr || result.stdout || '');
  return `The chamber builder exited with code ${result.exitCode ?? 'null'}.${detail ? `\n${detail}` : ''}`;
}

/** The final (post-clamp) value of one output parameter, or 0 if absent. */
function outputFinal(outputs: ChamberOutput[], key: string): number {
  return outputs.find((o) => o.key === key)?.final ?? 0;
}

/**
 * The metres geometry params buildChamber.py consumes: the twelve FINAL outputs
 * (mm -> m) keyed by their param name, plus the resolved LENGTH (mm -> m) and,
 * for the 'hollow' variant, the derived hollow/central/dome dimensions.
 */
function resolveGeometryParams(
  input: ChamberInput,
  outputs: ChamberOutput[],
): Record<string, number | string> {
  const widthMm = outputFinal(outputs, 'width');
  const lengthMm = input.lengthOverride ?? 2 * widthMm; // default: length = 2 x width
  const variant = input.variant ?? 'stepped';

  const params: Record<string, number | string> = { length: lengthMm * MM_TO_M, variant };
  // Torque-foot orientation is an angle (degrees), not a length — passed as-is.
  // Default 40° (an intermediate angle where the triangular gusset can form).
  params.footAngleDeg = input.footAngleDeg ?? 40;
  for (const key of CHAMBER_OUTPUT_KEYS) {
    params[key] = outputFinal(outputs, key) * MM_TO_M;
  }

  if (variant === 'hollow') {
    const wallMm = input.wallThickness ?? CHAMBER_WALL_THICKNESS_MM;
    const centralDiameterMm = 0.75 * input.x1; // 0.75 * X1
    // Central cylinder height scales with its diameter (no longer tied to P12).
    const centralHeightMm = CENTRAL_HEIGHT_OVER_DIAMETER * centralDiameterMm;
    params.wallThickness = wallMm * MM_TO_M;
    params.hollowLength = (input.hollowLength ?? 0) * MM_TO_M;
    params.centralDiameter = centralDiameterMm * MM_TO_M;
    params.centralHeight = centralHeightMm * MM_TO_M;
    params.domeHeight = 0.2 * centralHeightMm * MM_TO_M; // 20% of the central height
  }
  return params;
}

/**
 * Compute the twelve outputs for the inputs and build the chamber geometry if it
 * has not been built for these exact params. Returns the cache key (hash) and the
 * outputs (for the table). Idempotent: identical inputs reuse the cached build.
 *
 * @throws 500 SCRIPT_MISSING if the builder is not on disk.
 * @throws 502 CHAMBER_BUILD_FAILED if the run errors or produces no GLB.
 */
export async function buildChamber(input: ChamberInput): Promise<ChamberBuildResult> {
  const outputs = computeChamberOutputs(input);
  const params = resolveGeometryParams(input, outputs);
  const hash = chamberHash(params);

  if (!(await chamberGlbExists(hash))) {
    const script = buildChamberScript();
    if (!(await pathExists(script))) {
      throw new AppError(
        500,
        'SCRIPT_MISSING',
        `Chamber builder not found at ${script}. Set BUILD_CHAMBER_SCRIPT to its absolute path.`,
      );
    }
    const paths = chamberPaths(hash);
    await writeChamberParams(hash, params);

    const result = await runCommand({
      command: env.CHAMBER_PYTHON_BIN,
      args: [script, paths.params, paths.dir],
      cwd: paths.dir,
      env: process.env,
      timeoutMs: env.CHAMBER_BUILD_TIMEOUT_MS,
    });
    if (
      result.spawnError ||
      result.timedOut ||
      result.exitCode !== 0 ||
      !(await pathExists(paths.glb))
    ) {
      throw new AppError(502, 'CHAMBER_BUILD_FAILED', summarizeFailure(result));
    }
  }

  return { hash, outputs };
}

/** Return a build's patch manifest. @throws 409 CHAMBER_NOT_BUILT when absent. */
export async function getChamberManifest(hash: string): Promise<MeshManifest> {
  const stored = await readChamberManifest(hash);
  if (!stored) {
    throw new AppError(409, 'CHAMBER_NOT_BUILT', 'This chamber has not been built yet.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/** Return the rendered GLB bytes. @throws 409 CHAMBER_NOT_BUILT when not built. */
export async function getChamberGeometry(hash: string): Promise<Buffer> {
  const glb = await readChamberGlb(hash);
  if (!glb) {
    throw new AppError(409, 'CHAMBER_NOT_BUILT', 'The 3D preview has not been built yet.');
  }
  return glb;
}

/** Return the cell-edge buffer, or null when this render has none. */
export async function getChamberEdges(hash: string): Promise<Buffer | null> {
  return readChamberEdges(hash);
}

/** Return one export artifact's bytes. @throws 404 when absent. */
export async function getChamberExport(hash: string, kind: ChamberExportKind): Promise<Buffer> {
  const buf = await readChamberExport(hash, kind);
  if (!buf) {
    throw new AppError(404, 'NOT_FOUND', 'That export was not found for this build.');
  }
  return buf;
}
