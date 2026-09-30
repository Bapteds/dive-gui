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
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CHAMBER_OUTPUT_KEYS,
  CHAMBER_SPIRAL_DERIVED_KEYS,
  CHAMBER_VANE_COUNT_DEFAULT,
  CHAMBER_WALL_THICKNESS_MM,
  applyChamberSpiralToOutputs,
  blankGeneratorHeightRefusal,
  chamberConeChamferMm,
  chamberSpiralBoxDims,
  chamberSpiralInputs,
  chamberSpiralModelInput,
  runnerCaseClearanceRefusal,
  computeChamberGeneratorDims,
  computeChamberOutputs,
  nonPositiveChamberFinals,
  type ChamberInput,
  type ChamberOutput,
  type ChamberOutputKey,
  type ChamberSpiralBoxDims,
  type ChamberSpiralInputs,
  type ChamberSpiralSummary,
  type ChamberSpiralVertex,
  type MeshManifest,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import {
  CHAMBER_EXPORT_FILES,
  chamberGlbExists,
  chamberHash,
  chamberPaths,
  chamberSpiralPaths,
  readChamberBuildMeta,
  readChamberEdges,
  readChamberExport,
  readChamberGlb,
  readChamberManifest,
  readChamberSpiral,
  readChamberWarnings,
  writeChamberInput,
  writeChamberParams,
  writeChamberSpiralInput,
  writeChamberWarnings,
  type ChamberExportKind,
  type ChamberParams,
} from '../../lib/chamberStorage';

/** Sheet/model values are millimetres; the builder works in metres. */
const MM_TO_M = 1 / 1000;

/** In-flight work per build hash (promise-chain mutex); see withChamberLock. */
const chamberLocks = new Map<string, Promise<void>>();

/**
 * Serialize builder/mirrorer work per build hash: a build, a --step re-run,
 * and a mirror generation share one on-disk directory, so they must never run
 * concurrently for the same hash. Queued callers re-check the disk state when
 * they get the lock, so a doubled click costs one tool run and the second
 * caller takes the cache path. In-process only (like the rest of the app's
 * state); reads stay lock-free — safe because the builder writes every
 * artifact atomically (tmp + rename, GLB promoted last).
 */
async function withChamberLock<T>(hash: string, fn: () => Promise<T>): Promise<T> {
  const prev = chamberLocks.get(hash) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chamberLocks.set(hash, tail);
  void tail.then(() => {
    if (chamberLocks.get(hash) === tail) chamberLocks.delete(hash);
  });
  return run;
}

/** The result of a build request: the cache key + the twelve computed outputs
 * + any geometry clamp warnings the builder emitted (persisted per build)
 * + whether the STEP export carries the real guide vanes (null = not a
 * guide-vane build) — the gate for the mirrored-STEP download option. */
export interface ChamberBuildResult {
  hash: string;
  outputs: ChamberOutput[];
  warnings: string[];
  stepHasVanes: boolean | null;
  /** Semi-spiral quality + derived box (mm); null when the spiral is off. */
  spiral: ChamberSpiralSummary | null;
}

/**
 * Extract the builder's geometry warnings — lines like `WARN: …` (stderr) and
 * `WARNING: …` (stdout) — with the prefix stripped, stderr first. These are the
 * clamp/fallback notices (hollow fit-to-box, outlet radius, STEP vane fallback)
 * that must reach the UI, not just the server log.
 */
function extractBuilderWarnings(stderr: string, stdout: string): string[] {
  const warnings: string[] = [];
  for (const text of [stderr, stdout]) {
    for (const match of text.matchAll(/^WARN(?:ING)?:\s*(.+)$/gm)) {
      warnings.push(match[1].trim());
    }
  }
  return warnings;
}

/** Resolve the builder script (configured path, else the bundled default). */
function buildChamberScript(): string {
  const configured = env.BUILD_CHAMBER_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ is not compiled, so three levels up from src/modules/chamber (or
  // dist/modules/chamber) reaches apps/api/scripts from source and compiled output.
  return path.resolve(__dirname, '../../../scripts/buildChamber.py');
}

/** Resolve the STEP mirrorer script (configured path, else the bundled default). */
function mirrorStepScript(): string {
  const configured = env.MIRROR_STEP_SCRIPT.trim();
  if (configured) return configured;
  return path.resolve(__dirname, '../../../scripts/mirrorStep.py');
}

/** The bundled semi-spiral casing designer (numpy + scipy, CHAMBER_PYTHON_BIN). */
function designSemiSpiralScript(): string {
  return path.resolve(__dirname, '../../../scripts/designSemiSpiral.py');
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

/**
 * Build the user-facing failure message from a command result. A `KO:` line is
 * the tool's own refusal, already worded for the user: it is shown alone. Any
 * other failure keeps the exit code and the output tail for debugging.
 */
function summarizeFailure(result: CommandResult, action = 'build the chamber'): string {
  if (result.spawnError) {
    return `Could not start the chamber builder (${result.spawnError}). Check CHAMBER_PYTHON_BIN on the server.`;
  }
  if (result.timedOut) {
    return 'The chamber build took too long and was stopped. Try again; if it keeps timing out, lower Part scale or ask an admin to raise CHAMBER_BUILD_TIMEOUT_MS.';
  }
  const ko = /^KO:\s*(.+)$/m.exec(result.stderr || '')?.[1]?.trim();
  if (ko) return `Cannot ${action}. ${ko.charAt(0).toUpperCase()}${ko.slice(1)}`;
  if (result.exitCode === 0) {
    return 'The chamber builder finished without writing its output files. Try again; if it keeps failing, report it.';
  }
  const detail = tail(result.stderr || result.stdout || '');
  return `The chamber builder stopped unexpectedly (exit code ${result.exitCode ?? 'none'}).${detail ? `\nTechnical details:\n${detail}` : ''}`;
}

/**
 * Tag of the spiral method + settings, folded into the spiral cache key. Mirrors
 * ALGORITHM in scripts/designSemiSpiral.py: change both when the method changes.
 */
const SPIRAL_ALGORITHM = 'ref-2026-09-22-seed5';

/** A designed semi-spiral: what the builder params carry, plus the page's summary. */
interface DesignedSpiral {
  inputs: ChamberSpiralInputs;
  /** V0..V9 in metres, axis frame (frame x = builder X, frame y = builder Y). */
  vertices: ChamberSpiralVertex[];
  quality: { worst_area_error_m2: number; at_phi_deg: number; width_binding: boolean };
  /** The designer's warnings (the width-limit note), persisted with the build. */
  warnings: string[];
  summary: ChamberSpiralSummary;
}

/** Metres to millimetres, rounded to the micrometre (the tool rounds to 1e-6 m). */
const toMm = (m: number) => Math.round(m * 1e6) / 1e3;

/**
 * Validate a designSemiSpiral.py result read from disk and shape it for the
 * build. Returns null when it is not a complete result (never trusted blindly:
 * it becomes part of a build key and of the builder input).
 */
function parseSpiralResult(raw: unknown, inputs: ChamberSpiralInputs): DesignedSpiral | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    vertices?: unknown;
    quality?: { worst_area_error_m2?: unknown; at_phi_deg?: unknown; width_binding?: unknown };
    warnings?: unknown;
  };
  if (!Array.isArray(r.vertices) || r.vertices.length !== 10) return null;
  const vertices: ChamberSpiralVertex[] = [];
  for (const [i, v] of (r.vertices as { id?: unknown; x?: unknown; y?: unknown }[]).entries()) {
    if (v?.id !== `V${i}` || typeof v.x !== 'number' || typeof v.y !== 'number') return null;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    vertices.push({ id: v.id, x: v.x, y: v.y });
  }
  const q = r.quality;
  if (
    typeof q?.worst_area_error_m2 !== 'number' ||
    typeof q.at_phi_deg !== 'number' ||
    typeof q.width_binding !== 'boolean'
  ) {
    return null;
  }
  const quality = {
    worst_area_error_m2: q.worst_area_error_m2,
    at_phi_deg: q.at_phi_deg,
    width_binding: q.width_binding,
  };
  const box = chamberSpiralBoxDims(vertices);
  const boxMm = Object.fromEntries(
    Object.entries(box).map(([k, v]) => [k, toMm(v)]),
  ) as unknown as ChamberSpiralBoxDims;
  return {
    inputs,
    vertices,
    quality,
    warnings: Array.isArray(r.warnings)
      ? r.warnings.filter((w): w is string => typeof w === 'string')
      : [],
    summary: {
      widthMm: boxMm.width,
      worstAreaErrorM2: quality.worst_area_error_m2,
      atPhiDeg: quality.at_phi_deg,
      widthBinding: quality.width_binding,
      boxMm,
    },
  };
}

/** Stable 16-hex key of a set of spiral inputs + the algorithm tag. */
function spiralHash(inputs: ChamberSpiralInputs): string {
  const canonical = JSON.stringify({
    algorithm: SPIRAL_ALGORITHM,
    inputs: Object.keys(inputs)
      .sort()
      .map((k) => [k, inputs[k as keyof ChamberSpiralInputs]]),
  });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/** The user-facing message of a failed spiral run (a KO: line is shown alone). */
function summarizeSpiralFailure(result: CommandResult): string {
  if (result.spawnError) {
    return `Could not start the semi-spiral casing designer (${result.spawnError}). Check CHAMBER_PYTHON_BIN on the server.`;
  }
  if (result.timedOut) {
    return 'The semi-spiral casing design took too long and was stopped. Try again; if it keeps timing out, ask an admin to raise CHAMBER_SPIRAL_TIMEOUT_MS.';
  }
  const ko = /^KO:\s*(.+)$/m.exec(result.stderr || '')?.[1]?.trim();
  if (ko) return `Cannot build the chamber. ${ko.charAt(0).toUpperCase()}${ko.slice(1)}`;
  const detail = tail(result.stderr || result.stdout || '');
  return `The semi-spiral casing designer stopped unexpectedly (exit code ${result.exitCode ?? 'none'}).${detail ? `\nTechnical details:\n${detail}` : ''}`;
}

/**
 * The semi-spiral step (spec section 8): read the cached result for these
 * inputs, or run designSemiSpiral.py once (30 to 90 s) under a per-spiral lock
 * so concurrent builds sharing a spiral optimise it once. The builder never
 * optimises; it gets the frozen vertices through the build params.
 *
 * @throws 500 SCRIPT_MISSING / 502 CHAMBER_BUILD_FAILED on tooling failures.
 */
async function designSpiral(inputs: ChamberSpiralInputs): Promise<DesignedSpiral> {
  const key = spiralHash(inputs);
  return withChamberLock(`spiral:${key}`, async () => {
    const cached = parseSpiralResult(await readChamberSpiral(key), inputs);
    if (cached) return cached;

    const script = designSemiSpiralScript();
    if (!(await pathExists(script))) {
      throw new AppError(500, 'SCRIPT_MISSING', `Semi-spiral designer not found at ${script}.`);
    }
    const paths = chamberSpiralPaths(key);
    await writeChamberSpiralInput(key, inputs);
    // The script writes the result atomically (<result>.tmp then rename).
    const result = await runCommand({
      command: env.CHAMBER_PYTHON_BIN,
      args: [script, paths.input, paths.result],
      cwd: paths.dir,
      env: process.env,
      timeoutMs: env.CHAMBER_SPIRAL_TIMEOUT_MS,
    });
    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      throw new AppError(502, 'CHAMBER_BUILD_FAILED', summarizeSpiralFailure(result));
    }
    const designed = parseSpiralResult(await readChamberSpiral(key), inputs);
    if (!designed) {
      throw new AppError(
        502,
        'CHAMBER_BUILD_FAILED',
        'The semi-spiral casing designer finished without a usable result. Try again; if it keeps failing, report it.',
      );
    }
    return designed;
  });
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
  spiral: DesignedSpiral | null = null,
): ChamberParams {
  const widthMm = outputFinal(outputs, 'width');
  // Default: length = 2 x width — a true identity, so it inherits width's grid
  // snap (an empirical width is already on the 50 mm grid) or propagates a
  // user-driven width verbatim. A lengthOverride is the user's number as-is.
  const lengthMm = input.lengthOverride ?? 2 * widthMm;
  const variant = input.variant ?? 'stepped';

  const params: ChamberParams = { variant };
  // Semi-spiral casing: the spiral derives the box (length, B1, LT, the four
  // chamfer values) and its L2/L4 are the corner cuts, so those keys and
  // chamferEnabled are left out: only the spiral (inputs + frozen vertices)
  // keys the geometry. B Kammer stays in as the spiral's width limit. Off adds
  // nothing, so every existing build keeps its key.
  if (spiral) {
    params.semiSpiral = true;
    params.spiral = {
      inputs: spiral.inputs,
      vertices: spiral.vertices,
      quality: spiral.quality,
    };
  } else {
    params.length = lengthMm * MM_TO_M;
  }
  // Torque-foot orientation is an angle (degrees), not a length — passed as-is.
  // Default 40° (an intermediate angle where the triangular gusset can form).
  params.footAngleDeg = input.footAngleDeg ?? 40;
  // Guide-vane throat (geometry-only): a different flag => a different build.
  params.guideVanes = input.guideVanes ?? false;
  // Whether the box's two inlet-end corners get cut. Geometry-only: the
  // chamfer's own model values (chamferLength1/2 etc., in the loop below) are
  // computed unconditionally either way, and only this flag decides whether
  // make_box() actually cuts them. Default true (today's always-on behaviour).
  if (!spiral) params.chamferEnabled = input.chamferEnabled ?? true;
  // Whether the four torque-foot voids are cut. Geometry-only (footAngleDeg is
  // still validated either way); this flag decides whether make_feet() runs and
  // its result is cut. Part of the cache key, so a flip => a different build.
  params.feetEnabled = input.feetEnabled ?? true;
  // Absolute guide-vane open angle (deg, 45..55; asset baked at 50°); only affects
  // guide-vane builds. Part of the cache key, so a new angle => a new build.
  params.vaneAngleDeg = input.vaneAngleDeg ?? 50;
  // Guide vane count (whole number 8..32). Only passed for a guide-vane build with
  // a count other than 16: 16 (the asset) and any build without vanes omit it, so
  // their keys never change (and 18 keys exactly as it did when only 16/18 existed).
  const vaneCount = input.vaneCount ?? CHAMBER_VANE_COUNT_DEFAULT;
  if (params.guideVanes && vaneCount !== CHAMBER_VANE_COUNT_DEFAULT) params.vaneCount = vaneCount;
  // Uniform scale of the whole internal assembly (cylinders + feet + vanes +
  // hollow/dome) — the box + axis stay fixed. The builder clamps up-scaling to
  // the box height. Part of the cache key, so a new scale => a new build.
  params.partScale = input.partScale ?? 1;
  // Outlet inner/outer ratio (0.35..0.50, default 0.45) — guide-vane builds only,
  // but set unconditionally (like vaneAngleDeg/partScale) so it is always part of
  // the cache key. Part of the cache key, so a new ratio => a new build.
  params.outletRatio = input.outletRatio ?? 0.45;
  // Outlet OUTER diameter tracks X1 directly (metres). X1 is mm; params are metres.
  // Part of the cache key, so a different X1 => a different build.
  params.outletOuterD = input.x1 * MM_TO_M;
  // Manual overrides for the runner-case / guide-vanes diameters (mm -> m), passed
  // UNSCALED — the builder applies partScale and, when absent, the D_last ratios.
  // Both variants. Part of the cache key, so a new value => a new build.
  if (input.dFirst != null) params.dFirst = input.dFirst * MM_TO_M;
  if (input.dMiddle != null) params.dMiddle = input.dMiddle * MM_TO_M;
  for (const key of CHAMBER_OUTPUT_KEYS) {
    if (spiral && CHAMBER_SPIRAL_DERIVED_KEYS.includes(key)) continue;
    params[key] = outputFinal(outputs, key) * MM_TO_M;
  }
  // Closed generator: a typed generator height closes the last cylinder under
  // the chamber top; blank keeps it running through the top (key unchanged).
  if (variant === 'stepped' && input.centralHeight != null) {
    params.centralHeight = input.centralHeight * MM_TO_M;
  }
  // Cone chamfer (both designs, spec 2026-09-29-cone-foot-chamfer): a 45° foot
  // chamfer on the lower outer edge of the LE part. Only written when on, so
  // every existing build keeps its key. The builder scales it by partScale.
  const coneChamferMm = chamberConeChamferMm(input);
  if (coneChamferMm > 0) {
    params.coneChamferEnabled = true;
    params.coneChamferSize = coneChamferMm * MM_TO_M;
  }

  if (variant === 'hollow') {
    const wallMm = input.wallThickness ?? CHAMBER_WALL_THICKNESS_MM;
    // Generator (central cylinder) + dome dims from the empirical Gen Dim v3
    // model (X4 -> frame -> catalog Ø; Ø+L -> height; Ø -> dome). A manual
    // override wins verbatim, and an overridden Ø re-bases the height/dome
    // autos (the model's cascade). Only the RESOLVED mm values go to the
    // builder params (hence into the cache key) — x4 itself never does.
    const gen = computeChamberGeneratorDims({
      x1: input.x1,
      x2: input.x2,
      x3: input.x3,
      x4: input.x4,
      centralDiameter: input.centralDiameter,
      centralHeight: input.centralHeight,
      domeHeight: input.domeHeight,
    });
    params.wallThickness = wallMm * MM_TO_M;
    params.hollowLength = (input.hollowLength ?? 0) * MM_TO_M;
    params.centralDiameter = gen.resolved.centralDiameter * MM_TO_M;
    // Simplify Generator: no dome; the BUILDER pins the central cylinder
    // through the box top unless a generator height is typed (then a closed
    // cylinder). The dome and the auto height are OMITTED so they cannot
    // re-key the cache; the flag itself is part of the key.
    params.simplifyGenerator = input.simplifyGenerator ?? false;
    if (!params.simplifyGenerator) {
      params.centralHeight = gen.resolved.centralHeight * MM_TO_M;
      params.domeHeight = gen.resolved.domeHeight * MM_TO_M;
    } else if (input.centralHeight != null) {
      params.centralHeight = input.centralHeight * MM_TO_M;
    }
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
  // Semi-spiral casing: the rows the spiral derives read 'from spiral' (no
  // value until it is designed), so they are exempt from the refusals below.
  const spiralOn = input.semiSpiral === true;
  const modelOutputs = computeChamberOutputs(chamberSpiralModelInput(input));
  const outputs = spiralOn ? applyChamberSpiralToOutputs(modelOutputs, null) : modelOutputs;

  // The fits can go non-positive on legal inputs (esp. with relations off) —
  // refuse before hashing/building instead of handing CadQuery a negative
  // dimension. Chamfer setbacks are exempt while the chamfer is disabled (the
  // build does not consume them); LT/B1 always count (they place the axis).
  const chamferOnly: ChamberOutputKey[] = [
    'chamferLength1',
    'chamferWidth1',
    'chamferLength2',
    'chamferWidth2',
  ];
  const nonPositive = nonPositiveChamberFinals(outputs).filter(
    (o) => input.chamferEnabled !== false || !chamferOnly.includes(o.key),
  );
  if (nonPositive.length) {
    const list = nonPositive.map((o) => `${o.label} = ${Math.round(o.final)} mm`).join(', ');
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `Cannot build the chamber. These dimensions come out at 0 mm or below: ${list}. Change Runner Ø, Head or Q_max, turn the matching relation back on, or give them a Min or Exact value in the Parameters table.`,
    );
  }

  // An inverted range is a contradiction, not an input: building on the
  // silently-ignored model value hid the mistake (and it survived into saves).
  const inverted = outputs.filter((o) => o.status === '! min>max');
  if (inverted.length) {
    const list = inverted
      .map((o) => {
        const con = input.constraints?.[o.key];
        return `${o.label}: Min ${con?.min ?? '?'} > Max ${con?.max ?? '?'}`;
      })
      .join(', ');
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `Cannot build the chamber. The Min is larger than the Max for ${list}. Swap or clear those values in the Parameters table.`,
    );
  }

  // Blank generator height (Closed generator, With cone + Simplify generator):
  // the generator runs through the chamber top, so only this check stops
  // H Kammer from shrinking it below its Gen Dim height.
  const generatorRefusal = blankGeneratorHeightRefusal(input, outputs);
  if (generatorRefusal) throw new AppError(422, 'VALIDATION_ERROR', generatorRefusal);

  // Guide vanes: a typed Runner case Ø must clear the outlet (Runner Ø + 20 mm);
  // below LE Ø the builder adds the 20 mm ledge (spec 2026-09-29-runner-case-below-le).
  const runnerCaseRefusal = runnerCaseClearanceRefusal(input, outputs);
  if (runnerCaseRefusal) throw new AppError(422, 'VALIDATION_ERROR', runnerCaseRefusal);

  // The spiral step runs BEFORE hashing, so the build key covers the actual
  // geometry (the frozen vertices), not just the inputs that produced them.
  const spiral = spiralOn ? await designSpiral(chamberSpiralInputs(input, outputs)) : null;
  const responseOutputs = spiral
    ? applyChamberSpiralToOutputs(modelOutputs, spiral.summary.boxMm)
    : outputs;
  const params = resolveGeometryParams(input, outputs, spiral);
  const hash = chamberHash(params);

  // The cache check runs INSIDE the per-hash lock: a second identical build
  // arriving while the first is running waits, then takes the cache path —
  // two builders can never write the same directory concurrently.
  return withChamberLock(hash, async () => {
    // A cached build reports the warnings + STEP meta persisted at build time.
    if (await chamberGlbExists(hash)) {
      await writeChamberInput(hash, input, true).catch(() => undefined);
      return {
        hash,
        outputs: responseOutputs,
        warnings: await readChamberWarnings(hash),
        stepHasVanes: (await readChamberBuildMeta(hash)).stepHasVanes,
        spiral: spiral?.summary ?? null,
      };
    }

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
    // The ChamberInput behind this key (metadata only, not hashed).
    await writeChamberInput(hash, input);

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

    // Surface the builder's clamp/fallback warnings and persist them alongside
    // the build so cache hits keep reporting them.
    // The spiral step's own notes (the width-limit warning) come first.
    const warnings = [
      ...(spiral?.warnings ?? []),
      ...extractBuilderWarnings(result.stderr, result.stdout),
    ];
    await writeChamberWarnings(hash, warnings);
    return {
      hash,
      outputs: responseOutputs,
      warnings,
      stepHasVanes: (await readChamberBuildMeta(hash)).stepHasVanes,
      spiral: spiral?.summary ?? null,
    };
  });
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

/**
 * Generate a build's chamber.step by re-running the builder with --step.
 * Guide-vane builds defer the STEP (the OCC blade carve + verification gate is
 * ~2/3 of the build), so the first STEP download pays roughly one build here;
 * the file is then cached with the build. Non-vane builds write their STEP at
 * build time and never reach this. The original build's persisted warnings are
 * not touched.
 *
 * @throws 409 CHAMBER_NOT_BUILT when the build itself is absent.
 * @throws 500 SCRIPT_MISSING / 502 CHAMBER_BUILD_FAILED on tooling failures.
 */
async function generateStep(hash: string): Promise<void> {
  if (!(await chamberGlbExists(hash))) {
    throw new AppError(409, 'CHAMBER_NOT_BUILT', 'This chamber has not been built yet.');
  }
  const script = buildChamberScript();
  if (!(await pathExists(script))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `Chamber builder not found at ${script}. Set BUILD_CHAMBER_SCRIPT to its absolute path.`,
    );
  }
  const paths = chamberPaths(hash);
  const result = await runCommand({
    command: env.CHAMBER_PYTHON_BIN,
    args: [script, paths.params, paths.dir, '--step'],
    cwd: paths.dir,
    env: process.env,
    timeoutMs: env.CHAMBER_BUILD_TIMEOUT_MS,
  });
  const stepPath = path.join(paths.exportsDir, CHAMBER_EXPORT_FILES.step);
  if (
    result.spawnError ||
    result.timedOut ||
    result.exitCode !== 0 ||
    !(await pathExists(stepPath))
  ) {
    throw new AppError(
      502,
      'CHAMBER_BUILD_FAILED',
      summarizeFailure(result, 'generate the STEP file'),
    );
  }

  // The --step run can surface NEW warnings the original build could not know
  // (above all "chamber.step falls back to the vane-less solid"). Merge them
  // into the persisted list — deduped, since the re-run repeats the original
  // build's warnings too — so cache hits keep reporting the full story.
  const runWarnings = extractBuilderWarnings(result.stderr, result.stdout);
  const existing = await readChamberWarnings(hash);
  const fresh = runWarnings.filter((w) => !existing.includes(w));
  if (fresh.length) {
    await writeChamberWarnings(hash, [...existing, ...fresh]);
  }
}

/**
 * Generate the mirrored STEP ("Change rotational direction") for one build by
 * running mirrorStep.py on its chamber.step — generating THAT first when the
 * build deferred it. Only allowed when the STEP export carries the real guide
 * vanes (stepHasVanes true) — the vane-less fallback and non-vane builds
 * refuse. Callers hold the per-hash lock (getChamberExport), so concurrent
 * clicks serialize; the script's own mkstemp + rename is defense in depth.
 *
 * @throws 409 CHAMBER_NOT_BUILT when the build/meta does not qualify.
 * @throws 500 SCRIPT_MISSING / 502 CHAMBER_BUILD_FAILED on tooling failures.
 */
async function generateMirroredStep(hash: string): Promise<void> {
  const paths = chamberPaths(hash);
  const src = path.join(paths.exportsDir, CHAMBER_EXPORT_FILES.step);
  if (!(await pathExists(src))) {
    await generateStep(hash);
  }
  const meta = await readChamberBuildMeta(hash);
  if (meta.stepHasVanes !== true) {
    throw new AppError(
      409,
      'CHAMBER_NOT_BUILT',
      'The mirrored STEP is only available when the STEP export carries the guide vanes.',
    );
  }
  const script = mirrorStepScript();
  if (!(await pathExists(script))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `STEP mirrorer not found at ${script}. Set MIRROR_STEP_SCRIPT to its absolute path.`,
    );
  }
  const dst = path.join(paths.exportsDir, CHAMBER_EXPORT_FILES.stepMirrored);
  const result = await runCommand({
    command: env.CHAMBER_PYTHON_BIN,
    args: [script, src, dst],
    cwd: paths.dir,
    env: process.env,
    timeoutMs: env.CHAMBER_BUILD_TIMEOUT_MS,
  });
  if (result.spawnError || result.timedOut || result.exitCode !== 0 || !(await pathExists(dst))) {
    throw new AppError(
      502,
      'CHAMBER_BUILD_FAILED',
      summarizeFailure(result, 'generate the mirrored STEP file'),
    );
  }
}

/**
 * Return one export artifact's bytes. The guide-vane STEP and the mirrored
 * STEP are generated on demand at their first download and then served from
 * disk like every other export.
 * @throws 404 when absent (or the generation-specific 409/502, see above).
 */
export async function getChamberExport(hash: string, kind: ChamberExportKind): Promise<Buffer> {
  let buf = await readChamberExport(hash, kind);
  if (!buf && (kind === 'step' || kind === 'stepMirrored')) {
    buf = await withChamberLock(hash, async () => {
      // Re-check under the lock: a queued duplicate click finds the file the
      // first request just generated and skips the tool run entirely.
      const cached = await readChamberExport(hash, kind);
      if (cached) return cached;
      if (kind === 'step') await generateStep(hash);
      else await generateMirroredStep(hash);
      return readChamberExport(hash, kind);
    });
  }
  if (!buf) {
    throw new AppError(404, 'NOT_FOUND', 'That export was not found for this build.');
  }
  return buf;
}
