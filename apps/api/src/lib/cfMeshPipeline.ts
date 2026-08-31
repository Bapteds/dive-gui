// Run the cfMesh (cartesianMesh) pipeline on a session's surfaces, returning a
// per-step report shaped exactly like the snappy pipeline's, so the web UI renders
// either identically. Same operational model as every OpenFOAM tool here (binaries
// configurable via env, sourced via OPENFOAM_BASHRC, absent on a Windows dev box ->
// a clean per-step "not found", never a throw). cfMesh is MULTITHREADED (OpenMP):
// the core count is passed as OMP_NUM_THREADS on the cartesianMesh command, NOT via
// decomposePar/MPI.
//
// Steps (ESI OpenFOAM.com v2406, cfMesh bundled):
//   FMS input:  cartesianMesh -> checkMesh
//   STL input:  [Combine surfaces] -> [surfaceFeatureEdges] -> cartesianMesh -> checkMesh
// Several STLs are combined IN-PROCESS into one multi-solid ASCII STL (stlMerge) —
// no surfaceAdd, which behaved unreliably on the deploy box. surfaceFeatureEdges
// then extracts feature edges into an FMS (when enabled). The combined/feature files
// live under <case>/.work so they never show up as input surfaces. A prior mesh is
// cleared first (the shared Allclean), so every run starts clean.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CfMeshConfig, ImportStep, MeshBounds, MeshImportConversion } from '@dive/shared';
import { FMS_EXTENSION, STL_EXTENSION } from '@dive/shared';
import { env } from '../config/env';
import { planOpenfoamCommand, type PlannedCommand } from './openfoamCommand';
import { renderMeshDict, resolveMaxCellSize } from './cfMeshDicts';
import { mergeStlFilesToAscii } from './stlMerge';
import {
  renderMeshingControlDict,
  renderMeshingFvSchemes,
  renderMeshingFvSolution,
} from './snappyDicts';
import {
  cleanPriorMeshArtifacts,
  finalize,
  runSteps,
  runStepsStreaming,
  skipped,
  type PlannedStep,
  type StreamRunControls,
} from './meshPipelineRun';

/** Relative (to the case dir) location of the input surfaces and the scratch dir. */
const TRI_SURFACE_REL = 'constant/triSurface';
const WORK_REL = '.work';
const COMBINED_STL_REL = `${WORK_REL}/combined.stl`;
const COMBINED_FMS_REL = `${WORK_REL}/combined.fms`;

/** Add OMP_NUM_THREADS to a planned command so cartesianMesh runs multithreaded. */
function withThreads(plan: PlannedCommand, threads: number): PlannedCommand {
  return { ...plan, env: { ...plan.env, OMP_NUM_THREADS: String(threads) } };
}

/** A synthetic (non-command) report step for the in-process surface merge. */
function mergeStep(status: 'success' | 'failed', detail: string): ImportStep {
  return {
    tool: 'stlMerge',
    label: 'Combine surfaces',
    command: 'combine STL surfaces → one multi-solid surface',
    status,
    exitCode: status === 'success' ? 0 : 1,
    stdout: status === 'success' ? detail : '',
    stderr: status === 'success' ? '' : detail,
    durationMs: 0,
  };
}

/** Write the cfMesh case dicts: meshDict + the minimal control/scheme/solution set. */
async function writeCfMeshDicts(
  caseDir: string,
  config: CfMeshConfig,
  surfaceFileRel: string,
  maxCellSize: number,
): Promise<void> {
  const systemDir = path.join(caseDir, 'system');
  await fs.mkdir(systemDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(systemDir, 'controlDict'), renderMeshingControlDict(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSchemes'), renderMeshingFvSchemes(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSolution'), renderMeshingFvSolution(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'meshDict'), renderMeshDict(config, surfaceFileRel, maxCellSize), 'utf8'),
  ]);
}

/**
 * Combine the STL inputs into one surface and resolve the meshDict `surfaceFile`:
 *  - one FMS  -> use it directly (features + patches already baked in);
 *  - one STL  -> use it directly;
 *  - many STL -> merge in-process into .work/combined.stl (one solid/patch each).
 * Returns the pre-steps (a synthetic merge report, if any) and the base surface
 * path; `ok` is false when the merge failed (the caller short-circuits).
 */
async function prepareSurface(
  caseDir: string,
  surfaceNames: string[],
): Promise<{ ok: boolean; pre: ImportStep[]; baseSurfaceRel: string | null; isFms: boolean }> {
  const fms = surfaceNames.find((n) => n.toLowerCase().endsWith(FMS_EXTENSION));
  if (fms) {
    return { ok: true, pre: [], baseSurfaceRel: `${TRI_SURFACE_REL}/${fms}`, isFms: true };
  }

  const stls = surfaceNames.filter((n) => n.toLowerCase().endsWith(STL_EXTENSION));
  if (stls.length <= 1) {
    return { ok: true, pre: [], baseSurfaceRel: `${TRI_SURFACE_REL}/${stls[0]}`, isFms: false };
  }

  try {
    const { triangles } = await mergeStlFilesToAscii(
      path.join(caseDir, 'constant', 'triSurface'),
      stls,
      path.join(caseDir, COMBINED_STL_REL),
    );
    const detail = `Combined ${stls.length} surfaces (${triangles} triangles) into one.`;
    return { ok: true, pre: [mergeStep('success', detail)], baseSurfaceRel: COMBINED_STL_REL, isFms: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, pre: [mergeStep('failed', detail)], baseSurfaceRel: null, isFms: false };
  }
}

/**
 * Generate the meshDict, prepare the surface, then run [surfaceFeatureEdges ->]
 * cartesianMesh (multithreaded) and checkMesh in `caseDir`, returning the per-step
 * report. `bounds` is the STL union bbox (null for an FMS input); `config.cores`
 * maps to OMP threads. Never throws on a tool failure — resolves `success: false`
 * with the captured logs.
 */
export async function runCfMeshPipeline(
  caseDir: string,
  surfaceNames: string[],
  bounds: MeshBounds | null,
  config: CfMeshConfig,
  stream?: { logFile: string; controls?: StreamRunControls },
): Promise<MeshImportConversion> {
  const threads = Math.max(1, Math.floor(config.cores || 1));

  const maxCellSize = resolveMaxCellSize(config, bounds);
  if (maxCellSize == null) {
    return finalize([
      {
        ...skipped(env.CARTESIAN_MESH_BIN, 'Generate mesh (cartesianMesh)', 'cartesianMesh'),
        status: 'failed',
        stderr: 'Set a base (max) cell size — it cannot be derived from an FMS input.',
      },
    ]);
  }

  await cleanPriorMeshArtifacts(caseDir);
  await fs.mkdir(path.join(caseDir, WORK_REL), { recursive: true });

  const cartesianLabel = `Generate mesh (cartesianMesh, ${threads} thread${threads === 1 ? '' : 's'})`;
  const cartesian: PlannedStep = {
    tool: env.CARTESIAN_MESH_BIN,
    label: cartesianLabel,
    plan: withThreads(planOpenfoamCommand(env.CARTESIAN_MESH_BIN, ['-case', caseDir], caseDir), threads),
  };
  const check: PlannedStep = {
    tool: env.CHECK_MESH_BIN,
    label: 'Check mesh',
    plan: planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir),
  };

  // Combine the STL inputs (or use the FMS / single STL directly).
  const surface = await prepareSurface(caseDir, surfaceNames);
  if (!surface.ok || !surface.baseSurfaceRel) {
    return finalize([
      ...surface.pre,
      skipped(env.CARTESIAN_MESH_BIN, cartesianLabel, cartesian.plan.display),
      skipped(env.CHECK_MESH_BIN, 'Check mesh', check.plan.display),
    ]);
  }

  // Optional feature extraction into an FMS (STL inputs only).
  const steps: PlannedStep[] = [];
  let surfaceFileRel = surface.baseSurfaceRel;
  if (!surface.isFms && config.extractFeatures) {
    steps.push({
      tool: env.SURFACE_FEATURE_EDGES_BIN,
      label: 'Extract feature edges (surfaceFeatureEdges)',
      plan: planOpenfoamCommand(
        env.SURFACE_FEATURE_EDGES_BIN,
        ['-angle', String(Math.max(0, config.featureAngle)), surface.baseSurfaceRel, COMBINED_FMS_REL],
        caseDir,
      ),
    });
    surfaceFileRel = COMBINED_FMS_REL;
  }

  await writeCfMeshDicts(caseDir, config, surfaceFileRel, maxCellSize);
  steps.push(cartesian, check);

  const ran = stream
    ? await runStepsStreaming(steps, env.CFMESH_STEP_TIMEOUT_MS, stream.logFile, stream.controls)
    : await runSteps(steps, env.CFMESH_STEP_TIMEOUT_MS);
  return finalize([...surface.pre, ...ran]);
}
