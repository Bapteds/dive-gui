// Convert a single mesh FILE (.cgns or Fluent/Gmsh .msh) into a target case's
// constant/polyMesh, returning a structured per-step report.
//
// This is the template-less core behind the "Import mesh file" paths — used both
// for a project's first case mesh (files.service) and for a merge-library source
// (meshes.service). It mirrors the CGNS conversion pipeline (conversion.service):
// the OpenFOAM/Python binaries are configurable (config/env), every failure —
// including a missing binary — is captured as a step rather than thrown, and the
// command runner is injectable so this runs under test without the toolchain.
//
//   - .cgns:  CGNS_PYTHON_BIN CgnsToVtk.py <cgns> <vtk>  ->  vtkUnstructuredToFoam  ->  checkMesh
//   - .msh:   FLUENT_TO_FOAM_BIN <msh> -case <case> [-scale s]                      ->  checkMesh
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImportStep, MeshImportConversion } from '@dive/shared';
import { env } from '../config/env';
import { runCommand, type CommandResult } from './commandRunner';
import { commandFailed, planOpenfoamCommand } from './openfoamCommand';
import { renderBaseFile, type BaseFilePath } from './openfoamCase';

/** A mesh-file format the importer can convert. */
export type MeshFileFormat = 'cgns' | 'msh';

const EXT_FORMAT: Record<string, MeshFileFormat> = { '.cgns': 'cgns', '.msh': 'msh' };

/** Detect the convertible format from a filename, or null if not one we handle. */
export function meshFileFormat(name: string): MeshFileFormat | null {
  return EXT_FORMAT[path.extname(name).toLowerCase()] ?? null;
}

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Turn a raw command result into a reported step. */
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

/** Does an absolute path exist on disk? */
async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the bundled CGNS->VTK script (or the configured override). */
function cgnsToVtkScript(): string {
  const configured = env.CGNS_TO_VTK_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ sits beside src/ and dist/ under apps/api, so two levels up from
  // src/lib (or dist/lib) reaches it whether running from source or compiled.
  return path.resolve(__dirname, '../../scripts/CgnsToVtk.py');
}

/** Ensure the case has the minimal system/ files the OpenFOAM importers need. */
async function ensureMinimalSystem(caseDir: string): Promise<void> {
  const files: BaseFilePath[] = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'];
  for (const file of files) {
    const abs = path.join(caseDir, file);
    if (await pathExists(abs)) continue;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, renderBaseFile(file, []), 'utf8');
  }
}

function finalize(steps: ImportStep[]): MeshImportConversion {
  return { success: steps.every((step) => step.status === 'success'), steps };
}

/** Logical display line for the checkMesh step (used when skipped). */
function checkMeshDisplay(caseDir: string): string {
  return `${env.CHECK_MESH_BIN} -case ${caseDir}`;
}

/**
 * Convert a mesh file into `caseDir`/constant/polyMesh, returning the per-step
 * report. `workDir` holds the intermediate VTK (CGNS only). Never throws on a
 * tool failure — resolves `success: false` with the captured logs; the caller
 * decides what to do with a partial result.
 */
export async function convertMeshFileToCase(
  caseDir: string,
  srcAbs: string,
  format: MeshFileFormat,
  workDir: string,
): Promise<MeshImportConversion> {
  await fs.mkdir(caseDir, { recursive: true });
  await ensureMinimalSystem(caseDir);
  const timeoutMs = env.CONVERSION_STEP_TIMEOUT_MS;
  const steps: ImportStep[] = [];

  if (format === 'cgns') {
    await fs.mkdir(workDir, { recursive: true });
    const vtkAbs = path.join(workDir, `${path.basename(srcAbs, path.extname(srcAbs))}.vtk`);
    const scriptPath = cgnsToVtkScript();
    const step1Display = `${env.CGNS_PYTHON_BIN} ${scriptPath} ${srcAbs} ${vtkAbs}`;
    const vtkToFoamDisplay = `${env.VTK_TO_FOAM_BIN} -case ${caseDir} ${vtkAbs}`;

    if (!(await pathExists(scriptPath))) {
      steps.push({
        tool: env.CGNS_PYTHON_BIN,
        label: 'Convert CGNS to VTK',
        command: step1Display,
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: `[runner] CGNS->VTK script not found at ${scriptPath}. Set CGNS_TO_VTK_SCRIPT to its absolute path.`,
        durationMs: 0,
      });
      steps.push(
        skipped(env.VTK_TO_FOAM_BIN, 'Build polyMesh', vtkToFoamDisplay),
        skipped(env.CHECK_MESH_BIN, 'Check mesh', checkMeshDisplay(caseDir)),
      );
      return finalize(steps);
    }

    const r1 = await runCommand({
      command: env.CGNS_PYTHON_BIN,
      args: [scriptPath, srcAbs, vtkAbs],
      cwd: workDir,
      env: process.env,
      timeoutMs,
    });
    const step1 = toStep(env.CGNS_PYTHON_BIN, 'Convert CGNS to VTK', step1Display, r1);
    if (step1.status === 'success' && !(await pathExists(vtkAbs))) {
      step1.status = 'failed';
      step1.stderr = tail(`${step1.stderr}\n[runner] VTK output not found at ${vtkAbs}`);
    }
    steps.push(step1);
    if (step1.status !== 'success') {
      steps.push(
        skipped(env.VTK_TO_FOAM_BIN, 'Build polyMesh', vtkToFoamDisplay),
        skipped(env.CHECK_MESH_BIN, 'Check mesh', checkMeshDisplay(caseDir)),
      );
      return finalize(steps);
    }

    const plan2 = planOpenfoamCommand(env.VTK_TO_FOAM_BIN, ['-case', caseDir, vtkAbs], caseDir);
    const r2 = await runCommand({ ...plan2, timeoutMs });
    const step2 = toStep(env.VTK_TO_FOAM_BIN, 'Build polyMesh', plan2.display, r2);
    steps.push(step2);
    if (step2.status !== 'success') {
      steps.push(skipped(env.CHECK_MESH_BIN, 'Check mesh', checkMeshDisplay(caseDir)));
      return finalize(steps);
    }
  } else {
    // Fluent/Gmsh .msh -> constant/polyMesh in one tool.
    const args = [srcAbs, '-case', caseDir];
    const scale = env.FLUENT_TO_FOAM_SCALE.trim();
    if (scale) args.push('-scale', scale);
    const plan = planOpenfoamCommand(env.FLUENT_TO_FOAM_BIN, args, caseDir);
    const result = await runCommand({ ...plan, timeoutMs });
    const step = toStep(env.FLUENT_TO_FOAM_BIN, 'Build polyMesh from .msh', plan.display, result);
    steps.push(step);
    if (step.status !== 'success') {
      steps.push(skipped(env.CHECK_MESH_BIN, 'Check mesh', checkMeshDisplay(caseDir)));
      return finalize(steps);
    }
  }

  const checkPlan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir);
  const checkResult = await runCommand({ ...checkPlan, timeoutMs });
  steps.push(toStep(env.CHECK_MESH_BIN, 'Check mesh', checkPlan.display, checkResult));
  return finalize(steps);
}
