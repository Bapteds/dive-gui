// Run the cfMesh (cartesianMesh) pipeline on a session's surfaces, returning a
// per-step report shaped exactly like the snappy pipeline's, so the web UI renders
// either identically. Same operational model as every OpenFOAM tool here (binaries
// configurable via env, sourced via OPENFOAM_BASHRC, absent on a Windows dev box ->
// a clean per-step "not found", never a throw). cfMesh is MULTITHREADED (OpenMP):
// the core count is passed as OMP_NUM_THREADS on the cartesianMesh command, NOT via
// decomposePar/MPI.
//
// Steps (ESI OpenFOAM.com v2406, cfMesh bundled):
//   FMS input:   cartesianMesh -> checkMesh
//   STL input:   [surfaceAdd × (n-1)] -> [surfaceFeatureEdges] -> cartesianMesh -> checkMesh
// Several STLs are folded into one surface with surfaceAdd; surfaceFeatureEdges
// then extracts feature edges into an FMS (when enabled). The merge/feature files
// live under <case>/.work so they never show up as input surfaces. A prior mesh is
// cleared first (the shared Allclean), so every run starts clean.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CfMeshConfig, MeshBounds, MeshImportConversion } from '@dive/shared';
import { FMS_EXTENSION, STL_EXTENSION } from '@dive/shared';
import { env } from '../config/env';
import { planOpenfoamCommand, type PlannedCommand } from './openfoamCommand';
import { renderMeshDict, resolveMaxCellSize } from './cfMeshDicts';
import {
  renderMeshingControlDict,
  renderMeshingFvSchemes,
  renderMeshingFvSolution,
} from './snappyDicts';
import {
  cleanPriorMeshArtifacts,
  finalize,
  runSteps,
  skipped,
  type PlannedStep,
} from './meshPipelineRun';

/** Relative (to the case dir) location of the input surfaces and the scratch dir. */
const TRI_SURFACE_REL = 'constant/triSurface';
const WORK_REL = '.work';

/** Add OMP_NUM_THREADS to a planned command so cartesianMesh runs multithreaded. */
function withThreads(plan: PlannedCommand, threads: number): PlannedCommand {
  return { ...plan, env: { ...plan.env, OMP_NUM_THREADS: String(threads) } };
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
 * Plan the surface-preparation steps and resolve the meshDict `surfaceFile`:
 *  - one FMS  -> use it directly (features + patches already baked in);
 *  - one STL  -> use it directly (optionally feature-extracted to an FMS);
 *  - many STL -> fold with surfaceAdd into one surface, then optionally extract.
 * All merge/feature outputs go under <case>/.work.
 */
function planSurfacePrep(
  caseDir: string,
  surfaceNames: string[],
  config: CfMeshConfig,
): { steps: PlannedStep[]; surfaceFileRel: string } {
  const fms = surfaceNames.find((n) => n.toLowerCase().endsWith(FMS_EXTENSION));
  if (fms) {
    return { steps: [], surfaceFileRel: `${TRI_SURFACE_REL}/${fms}` };
  }

  const stls = surfaceNames.filter((n) => n.toLowerCase().endsWith(STL_EXTENSION));
  const steps: PlannedStep[] = [];

  // Fold several STLs into one combined surface (surfaceAdd takes two inputs).
  // Surface utilities carry cwd = caseDir so their relative paths resolve.
  let combinedRel = `${TRI_SURFACE_REL}/${stls[0]}`;
  for (let i = 1; i < stls.length; i += 1) {
    const out = `${WORK_REL}/merged-${i}.stl`;
    steps.push({
      tool: env.SURFACE_ADD_BIN,
      label: `Merge surfaces (${i}/${stls.length - 1})`,
      // surfaceAdd <surf1> <surf2> <out>; a surface utility (no -case).
      plan: planOpenfoamCommand(
        env.SURFACE_ADD_BIN,
        [combinedRel, `${TRI_SURFACE_REL}/${stls[i]}`, out],
        caseDir,
      ),
    });
    combinedRel = out;
  }

  if (config.extractFeatures) {
    const fmsOut = `${WORK_REL}/combined.fms`;
    steps.push({
      tool: env.SURFACE_FEATURE_EDGES_BIN,
      label: 'Extract feature edges (surfaceFeatureEdges)',
      plan: planOpenfoamCommand(
        env.SURFACE_FEATURE_EDGES_BIN,
        ['-angle', String(Math.max(0, config.featureAngle)), combinedRel, fmsOut],
        caseDir,
      ),
    });
    return { steps, surfaceFileRel: fmsOut };
  }
  return { steps, surfaceFileRel: combinedRel };
}

/**
 * Generate the meshDict, prepare the surface, then run cartesianMesh (multithreaded)
 * and checkMesh in `caseDir`, returning the per-step report. `bounds` is the STL
 * union bbox (null for an FMS input); `config.cores` maps to OMP threads. Never
 * throws on a tool failure — resolves `success: false` with the captured logs.
 *
 * Returns a single failed step when the base cell size cannot be resolved (an FMS
 * input with no configured maxCellSize), rather than writing an invalid meshDict.
 */
export async function runCfMeshPipeline(
  caseDir: string,
  surfaceNames: string[],
  bounds: MeshBounds | null,
  config: CfMeshConfig,
): Promise<MeshImportConversion> {
  const threads = Math.max(1, Math.floor(config.cores || 1));

  const maxCellSize = resolveMaxCellSize(config, bounds);
  if (maxCellSize == null) {
    // No bounds (FMS) and no configured size: cartesianMesh needs one. Report it
    // as a failed first step so the UI shows a clear, actionable reason.
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

  const { steps: prep, surfaceFileRel } = planSurfacePrep(caseDir, surfaceNames, config);
  await writeCfMeshDicts(caseDir, config, surfaceFileRel, maxCellSize);

  const cartesian: PlannedStep = {
    tool: env.CARTESIAN_MESH_BIN,
    label: `Generate mesh (cartesianMesh, ${threads} thread${threads === 1 ? '' : 's'})`,
    plan: withThreads(planOpenfoamCommand(env.CARTESIAN_MESH_BIN, ['-case', caseDir], caseDir), threads),
  };
  const check: PlannedStep = {
    tool: env.CHECK_MESH_BIN,
    label: 'Check mesh',
    plan: planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir),
  };

  const steps = await runSteps([...prep, cartesian, check], env.CFMESH_STEP_TIMEOUT_MS);
  return finalize(steps);
}
