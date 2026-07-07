// Run the snappyHexMesh meshing pipeline on a session's STL surfaces, returning
// a per-step report. Mirrors meshImport.convertMeshFileToCase EXACTLY: the
// OpenFOAM binaries are configurable (config/env), every failure — including a
// missing binary — is captured as a step rather than thrown, and the command
// runner is injectable so this runs under test without the toolchain.
//
// Steps (ESI OpenFOAM.com v2406 classic tools):
//   blockMesh -> surfaceFeatureExtract -> snappyHexMesh -overwrite -> checkMesh
// Writing the generated dicts (system/*) is done first; a mid-pipeline failure
// marks the remaining steps `skipped`, so the report reads top-to-bottom.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImportStep, MeshBounds, MeshImportConversion, SnappyConfig } from '@dive/shared';
import { env } from '../config/env';
import { runCommand, type CommandResult } from './commandRunner';
import { commandFailed, planOpenfoamCommand } from './openfoamCommand';
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

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Turn a raw command result into a reported step (copied from meshImport). */
function toStep(tool: string, label: string, display: string, result: CommandResult): ImportStep {
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError}`
    : result.timedOut
      ? '\n[runner] command timed out'
      : '';
  return {
    tool,
    label,
    command: display,
    status: commandFailed(result) ? 'failed' : 'success',
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr + extra),
    durationMs: result.durationMs,
  };
}

/** A step that never ran because an earlier one failed. */
function skipped(tool: string, label: string, display: string): ImportStep {
  return { tool, label, command: display, status: 'skipped', exitCode: null, stdout: '', stderr: '', durationMs: 0 };
}

function finalize(steps: ImportStep[]): MeshImportConversion {
  return { success: steps.every((step) => step.status === 'success'), steps };
}

/** Write the generated dictionaries (system/* ) into the case. */
async function writeDicts(
  caseDir: string,
  stlNames: string[],
  domain: SnappyDomain,
  config: SnappyConfig,
): Promise<void> {
  const systemDir = path.join(caseDir, 'system');
  await fs.mkdir(systemDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(systemDir, 'controlDict'), renderMeshingControlDict(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSchemes'), renderMeshingFvSchemes(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'fvSolution'), renderMeshingFvSolution(), 'utf8'),
    fs.writeFile(path.join(systemDir, 'blockMeshDict'), renderBlockMeshDict(domain), 'utf8'),
    fs.writeFile(
      path.join(systemDir, 'surfaceFeatureExtractDict'),
      renderSurfaceFeatureExtractDict(stlNames),
      'utf8',
    ),
    fs.writeFile(
      path.join(systemDir, 'snappyHexMeshDict'),
      renderSnappyHexMeshDict(stlNames, domain, config),
      'utf8',
    ),
  ]);
}

/**
 * Generate the dicts, then run blockMesh -> surfaceFeatureExtract ->
 * snappyHexMesh -overwrite -> checkMesh in `caseDir`, returning the per-step
 * report. Never throws on a tool failure — resolves `success: false` with the
 * captured logs; the caller decides what to do with a partial result.
 */
export async function runSnappyPipeline(
  caseDir: string,
  stlNames: string[],
  bounds: MeshBounds,
  config: SnappyConfig,
): Promise<MeshImportConversion> {
  const domain = computeDomain(bounds, config);
  await writeDicts(caseDir, stlNames, domain, config);

  const timeoutMs = env.SNAPPY_STEP_TIMEOUT_MS;
  const steps: ImportStep[] = [];

  // 1) blockMesh — build the background hex mesh.
  const blockPlan = planOpenfoamCommand(env.BLOCK_MESH_BIN, ['-case', caseDir], caseDir);
  const featPlan = planOpenfoamCommand(env.SURFACE_FEATURE_BIN, ['-case', caseDir], caseDir);
  const snappyPlan = planOpenfoamCommand(
    env.SNAPPY_HEX_MESH_BIN,
    ['-overwrite', '-case', caseDir],
    caseDir,
  );
  const checkPlan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir);

  const blockResult = await runCommand({ ...blockPlan, timeoutMs });
  steps.push(toStep(env.BLOCK_MESH_BIN, 'Background mesh (blockMesh)', blockPlan.display, blockResult));
  if (steps[0].status !== 'success') {
    steps.push(
      skipped(env.SURFACE_FEATURE_BIN, 'Extract surface features', featPlan.display),
      skipped(env.SNAPPY_HEX_MESH_BIN, 'Snap mesh to surface (snappyHexMesh)', snappyPlan.display),
      skipped(env.CHECK_MESH_BIN, 'Check mesh', checkPlan.display),
    );
    return finalize(steps);
  }

  // 2) surfaceFeatureExtract — feature edges (*.eMesh) for the snap.
  const featResult = await runCommand({ ...featPlan, timeoutMs });
  steps.push(toStep(env.SURFACE_FEATURE_BIN, 'Extract surface features', featPlan.display, featResult));
  if (steps[1].status !== 'success') {
    steps.push(
      skipped(env.SNAPPY_HEX_MESH_BIN, 'Snap mesh to surface (snappyHexMesh)', snappyPlan.display),
      skipped(env.CHECK_MESH_BIN, 'Check mesh', checkPlan.display),
    );
    return finalize(steps);
  }

  // 3) snappyHexMesh -overwrite — castellate + snap (+ layers) into constant/polyMesh.
  const snappyResult = await runCommand({ ...snappyPlan, timeoutMs });
  steps.push(
    toStep(env.SNAPPY_HEX_MESH_BIN, 'Snap mesh to surface (snappyHexMesh)', snappyPlan.display, snappyResult),
  );
  if (steps[2].status !== 'success') {
    steps.push(skipped(env.CHECK_MESH_BIN, 'Check mesh', checkPlan.display));
    return finalize(steps);
  }

  // 4) checkMesh — quality report on the produced mesh.
  const checkResult = await runCommand({ ...checkPlan, timeoutMs });
  steps.push(toStep(env.CHECK_MESH_BIN, 'Check mesh', checkPlan.display, checkResult));
  return finalize(steps);
}
