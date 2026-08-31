// Run the snappyHexMesh meshing pipeline on a session's STL surfaces, returning
// a per-step report. Mirrors meshImport.convertMeshFileToCase EXACTLY: the
// OpenFOAM binaries are configurable (config/env), every failure — including a
// missing binary — is captured as a step rather than thrown, and the command
// runner is injectable so this runs under test without the toolchain.
//
// Steps (ESI OpenFOAM.com v2406 classic tools):
//   serial (cores <= 1):
//     blockMesh -> surfaceFeatureExtract -> snappyHexMesh -overwrite -> checkMesh
//   parallel (cores > 1), the same story the solver already uses:
//     blockMesh -> surfaceFeatureExtract -> decomposePar
//       -> mpirun -np N snappyHexMesh -overwrite -parallel
//       -> reconstructParMesh -constant -> checkMesh
// Writing the generated dicts (system/*) is done first; a mid-pipeline failure
// marks the remaining steps `skipped`, so the report reads top-to-bottom. In the
// parallel path the processor* directories are removed once the mesh is
// reconstructed (kept on failure for debugging).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MeshBounds, MeshImportConversion, SnappyConfig } from '@dive/shared';
import { env } from '../config/env';
import { planOpenfoamCommand } from './openfoamCommand';
import { renderDecomposeParDict } from './openfoamCase';
import {
  cleanPriorMeshArtifacts,
  finalize,
  runSteps,
  runStepsStreaming,
  type PlannedStep,
  type StreamRunControls,
} from './meshPipelineRun';
import {
  computeDomain,
  renderBlockMeshDict,
  renderMeshingControlDict,
  renderMeshingFvSchemes,
  renderMeshingFvSolution,
  renderSnappyHexMeshDict,
  renderSurfaceFeatureExtractDict,
  type SnappyDomain,
} from './snappyDicts';

/** Write the generated dictionaries (system/* ) into the case. */
async function writeDicts(
  caseDir: string,
  stlNames: string[],
  domain: SnappyDomain,
  config: SnappyConfig,
  cores: number,
): Promise<void> {
  const systemDir = path.join(caseDir, 'system');
  await fs.mkdir(systemDir, { recursive: true });
  const writes = [
    fs.writeFile(path.join(systemDir, 'controlDict'), renderMeshingControlDict(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSchemes'), renderMeshingFvSchemes(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSolution'), renderMeshingFvSolution(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'blockMeshDict'), renderBlockMeshDict(domain), 'utf8'),
    fs.writeFile(
      path.join(systemDir, 'surfaceFeatureExtractDict'),
      renderSurfaceFeatureExtractDict(stlNames, config),
      'utf8',
    ),
    fs.writeFile(
      path.join(systemDir, 'snappyHexMeshDict'),
      renderSnappyHexMeshDict(stlNames, domain, config),
      'utf8',
    ),
  ];
  // Parallel runs need a decomposeParDict whose numberOfSubdomains matches -np N.
  if (cores > 1) {
    writes.push(
      fs.writeFile(
        path.join(systemDir, 'decomposeParDict'),
        renderDecomposeParDict(cores, env.DECOMPOSE_METHOD),
        'utf8',
      ),
    );
  }
  await Promise.all(writes);
}

/** The ordered steps for a run: serial or MPI-parallel snappyHexMesh. */
function planSteps(caseDir: string, cores: number): PlannedStep[] {
  const block: PlannedStep = {
    tool: env.BLOCK_MESH_BIN,
    label: 'Background mesh (blockMesh)',
    plan: planOpenfoamCommand(env.BLOCK_MESH_BIN, ['-case', caseDir], caseDir),
  };
  const feat: PlannedStep = {
    tool: env.SURFACE_FEATURE_BIN,
    label: 'Extract surface features',
    plan: planOpenfoamCommand(env.SURFACE_FEATURE_BIN, ['-case', caseDir], caseDir),
  };
  const check: PlannedStep = {
    tool: env.CHECK_MESH_BIN,
    label: 'Check mesh',
    plan: planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir),
  };

  if (cores <= 1) {
    const snappy: PlannedStep = {
      tool: env.SNAPPY_HEX_MESH_BIN,
      label: 'Snap mesh to surface (snappyHexMesh)',
      plan: planOpenfoamCommand(env.SNAPPY_HEX_MESH_BIN, ['-overwrite', '-case', caseDir], caseDir),
    };
    return [block, feat, snappy, check];
  }

  // Parallel: decompose the background mesh, snap under mpirun, then reassemble.
  // The MPI flags (default --allow-run-as-root --use-hwthread-cpus --oversubscribe)
  // make the requested core count map to MPI slots, avoiding the common "not enough
  // slots" failure on a hyperthreaded host — identical to the solver's parallel run.
  const mpiFlags = env.MPI_RUN_FLAGS.split(/\s+/).filter(Boolean);
  const decompose: PlannedStep = {
    tool: env.DECOMPOSE_PAR_BIN,
    label: `Decompose the mesh into ${cores} subdomains (decomposePar)`,
    plan: planOpenfoamCommand(env.DECOMPOSE_PAR_BIN, ['-case', caseDir, '-force'], caseDir),
  };
  const snappy: PlannedStep = {
    tool: env.SNAPPY_HEX_MESH_BIN,
    label: `Snap mesh to surface (snappyHexMesh, ${cores} cores)`,
    plan: planOpenfoamCommand(
      env.MPI_BIN,
      [...mpiFlags, '-np', String(cores), env.SNAPPY_HEX_MESH_BIN, '-overwrite', '-case', caseDir, '-parallel'],
      caseDir,
    ),
  };
  const reconstruct: PlannedStep = {
    tool: env.RECONSTRUCT_PAR_MESH_BIN,
    label: 'Reassemble the mesh (reconstructParMesh)',
    plan: planOpenfoamCommand(
      env.RECONSTRUCT_PAR_MESH_BIN,
      ['-constant', '-case', caseDir],
      caseDir,
    ),
  };
  return [block, feat, decompose, snappy, reconstruct, check];
}

/** Remove the processor0..N-1 directories a parallel run created (best-effort). */
async function cleanupProcessors(caseDir: string, cores: number): Promise<void> {
  for (let i = 0; i < cores; i += 1) {
    await fs
      .rm(path.join(caseDir, `processor${i}`), { recursive: true, force: true })
      .catch(() => undefined);
  }
}

/**
 * Generate the dicts, then run the meshing pipeline in `caseDir`, returning the
 * per-step report. `config.cores` selects the serial or MPI-parallel path. Never
 * throws on a tool failure — resolves `success: false` with the captured logs;
 * the caller decides what to do with a partial result.
 */
export async function runSnappyPipeline(
  caseDir: string,
  stlNames: string[],
  bounds: MeshBounds,
  config: SnappyConfig,
  stream?: { logFile: string; controls?: StreamRunControls },
): Promise<MeshImportConversion> {
  const cores = Math.max(1, Math.floor(config.cores || 1));
  const domain = computeDomain(bounds, config);
  // Start from a clean slate: drop any prior mesh, decomposition, and stale
  // refinement fields, so decomposePar never reads a new mesh against an old
  // cellLevel (the "Size N != expected length M" failure).
  await cleanPriorMeshArtifacts(caseDir);
  await writeDicts(caseDir, stlNames, domain, config, cores);

  const planned = planSteps(caseDir, cores);
  const steps = stream
    ? await runStepsStreaming(planned, env.SNAPPY_STEP_TIMEOUT_MS, stream.logFile, stream.controls)
    : await runSteps(planned, env.SNAPPY_STEP_TIMEOUT_MS);

  // Parallel: tidy the processor* dirs once the mesh is reassembled (kept on a
  // reconstruct failure so the decomposed result stays available for debugging).
  if (cores > 1) {
    const reconstructOk =
      steps.find((step) => step.tool === env.RECONSTRUCT_PAR_MESH_BIN)?.status === 'success';
    if (reconstructOk) await cleanupProcessors(caseDir, cores);
  }

  return finalize(steps);
}
