// Run the cfMesh (cartesianMesh) pipeline on a session's surface, returning a
// per-step report shaped exactly like the snappy pipeline's, so the web UI renders
// either identically. Same operational model as every OpenFOAM tool here (binaries
// configurable via env, sourced via OPENFOAM_BASHRC, absent on a Windows dev box ->
// a clean per-step "not found", never a throw). cfMesh is MULTITHREADED (OpenMP):
// the core count is passed as OMP_NUM_THREADS on the cartesianMesh command, NOT via
// decomposePar/MPI.
//
// cfMesh takes ONE surfaceFile: a single STL (which may hold several named solids,
// one patch each) or a single FMS. Steps (ESI OpenFOAM.com v2406, cfMesh bundled):
//   FMS input:  cartesianMesh -> checkMesh
//   STL input:  [surfaceFeatureEdges -> FMS] -> cartesianMesh -> checkMesh
// The extracted feature file lives under <case>/.work so it never shows up as an
// input surface. A prior mesh is cleared first (the shared Allclean).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CfMeshConfig, MeshBounds, MeshImportConversion } from '@dive/shared';
import { FMS_EXTENSION } from '@dive/shared';
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
const COMBINED_FMS_REL = `${WORK_REL}/features.fms`;

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
 * Generate the meshDict, then run [surfaceFeatureEdges ->] cartesianMesh
 * (multithreaded) and checkMesh in `caseDir`, returning the per-step report.
 * cfMesh takes ONE surface: `surfaceNames[0]` is the STL/FMS to mesh. `bounds` is
 * the STL bbox (null for an FMS input); `config.cores` maps to OMP threads. Never
 * throws on a tool failure — resolves `success: false` with the captured logs.
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

  // The single input surface, referenced relative to the case dir.
  const surfaceName = surfaceNames[0];
  const isFms = surfaceName.toLowerCase().endsWith(FMS_EXTENSION);
  const inputRel = `${TRI_SURFACE_REL}/${surfaceName}`;

  // Optional feature extraction into an FMS (STL input only; an FMS already has them).
  const steps: PlannedStep[] = [];
  let surfaceFileRel = inputRel;
  if (!isFms && config.extractFeatures) {
    steps.push({
      tool: env.SURFACE_FEATURE_EDGES_BIN,
      label: 'Extract feature edges (surfaceFeatureEdges)',
      plan: planOpenfoamCommand(
        env.SURFACE_FEATURE_EDGES_BIN,
        ['-angle', String(Math.max(0, config.featureAngle)), inputRel, COMBINED_FMS_REL],
        caseDir,
      ),
    });
    surfaceFileRel = COMBINED_FMS_REL;
  }

  await writeCfMeshDicts(caseDir, config, surfaceFileRel, maxCellSize);

  steps.push(
    {
      tool: env.CARTESIAN_MESH_BIN,
      label: `Generate mesh (cartesianMesh, ${threads} thread${threads === 1 ? '' : 's'})`,
      plan: withThreads(planOpenfoamCommand(env.CARTESIAN_MESH_BIN, ['-case', caseDir], caseDir), threads),
    },
    {
      tool: env.CHECK_MESH_BIN,
      label: 'Check mesh',
      plan: planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir),
    },
  );

  return finalize(await runSteps(steps, env.CFMESH_STEP_TIMEOUT_MS));
}
