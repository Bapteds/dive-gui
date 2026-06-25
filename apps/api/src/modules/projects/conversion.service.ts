// CGNS -> OpenFOAM mesh conversion: business logic.
//
// A project can hold one or more CGNS mesh sources (uploaded separately from the
// OpenFOAM case, see cgnsStorage). "Convert to Foam" turns a chosen CGNS into a
// `constant/polyMesh` for the case, using a chosen template for the surrounding
// configuration, by running an external three-step toolchain:
//
//   1. python3 CgnsToVtk.py <cgns> <vtk>      (standalone VTK)  -> legacy VTK
//   2. vtkUnstructuredToFoam -case <case> <vtk>  (OpenFOAM)     -> constant/polyMesh
//   3. checkMesh -case <case>                    (OpenFOAM)     -> mesh report
//
// These binaries live on the Debian deploy target, not on a Windows dev box, so
// every command is configurable (see config/env) and every failure — including
// a missing binary — is captured as a structured step result rather than thrown.
// The command runner is injectable (commandRunner.setCommandRunner) so this runs
// under test without the real toolchain.
//
// Access model: gated by *project* visibility (same as case files); any member
// may convert. Conversion overwrites the case's mesh, which the UI confirms.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONVERSION_STEPS, type ConversionStepId } from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import {
  caseDirAbsolute,
  caseFileExists,
  listCaseTree,
  type CaseEntry,
} from '../../lib/caseStorage';
import {
  cgnsBaseName,
  cgnsFileAbsolute,
  cgnsFileExists,
  deleteCgnsFile,
  listCgnsFiles,
  writeCgnsUpload,
} from '../../lib/cgnsStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import { scaffoldCase, verifyCase, type CaseVerification } from './files.service';
import { applyTemplate, getTemplate } from '../templates/templates.service';
import type { ConvertCgnsInput } from './conversion.schemas';

/** Public description of a stored CGNS source file. */
export interface CgnsFileInfo {
  /** Filename within the project's cgns store (no directory part). */
  name: string;
  /** Size in bytes. */
  size: number;
}

/** One executed (or skipped) step of the conversion pipeline. */
export interface ConversionStep {
  /** Stable id shared with the client (see CONVERSION_STEPS). */
  id: ConversionStepId;
  /** Human-readable step name. */
  label: string;
  /** The logical command line that was run (for transparency in the UI). */
  command: string;
  /** 'success' (exit 0), 'failed', or 'skipped' (an earlier step failed). */
  status: 'success' | 'failed' | 'skipped';
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail, truncated). */
  stdout: string;
  /** Captured stderr (tail, truncated). */
  stderr: string;
  /** Wall-clock duration in ms (0 for a skipped step). */
  durationMs: number;
}

/** Outcome of a conversion run: per-step report plus the refreshed case. */
export interface ConversionResult {
  /** True only when every step succeeded. */
  success: boolean;
  /** The three pipeline steps, in order. */
  steps: ConversionStep[];
  /** Informational notes (template applied, base files generated, …). */
  notes: string[];
  /** Refreshed mandatory-file verification after the run. */
  verification: CaseVerification;
  /** Refreshed case tree after the run. */
  entries: CaseEntry[];
}

/** Human labels for each pipeline step. */
const STEP_LABELS: Record<ConversionStepId, string> = {
  cgnsToVtk: 'Convert CGNS to VTK (python3 + VTK)',
  vtkToFoam: 'Build polyMesh (vtkUnstructuredToFoam)',
  checkMesh: 'Check mesh (checkMesh)',
};

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Map a stored cgns entry to its public shape. */
function toCgnsInfo(entry: { path: string; size: number }): CgnsFileInfo {
  return { name: entry.path, size: entry.size };
}

/** List a project's CGNS source files. */
export async function listCgns(viewer: Viewer, projectId: string): Promise<CgnsFileInfo[]> {
  await assertProjectVisible(viewer, projectId);
  return (await listCgnsFiles(projectId)).map(toCgnsInfo);
}

/**
 * Store an uploaded CGNS file. Validates the extension (a CGNS mesh, not just
 * any upload) and that bytes are present.
 * @throws 400 INVALID_CGNS for a non-.cgns name or empty file.
 */
export async function uploadCgns(
  viewer: Viewer,
  projectId: string,
  file: { name: string; data: Buffer },
): Promise<{ file: CgnsFileInfo; files: CgnsFileInfo[] }> {
  await assertProjectVisible(viewer, projectId);

  if (!file.name.toLowerCase().endsWith('.cgns')) {
    throw new AppError(400, 'INVALID_CGNS', 'Choose a .cgns mesh file');
  }
  if (file.data.length === 0) {
    throw new AppError(400, 'INVALID_CGNS', 'The uploaded CGNS file is empty');
  }

  const name = await writeCgnsUpload(projectId, file.name, file.data);
  const files = (await listCgnsFiles(projectId)).map(toCgnsInfo);
  const stored = files.find((f) => f.name === name) ?? { name, size: file.data.length };
  return { file: stored, files };
}

/**
 * Delete a CGNS source file (and never the case). Also removes a sibling .vtk
 * left from a previous conversion of the same base name, best-effort.
 * @throws 404 NOT_FOUND if the file does not exist.
 */
export async function removeCgns(
  viewer: Viewer,
  projectId: string,
  name: string,
): Promise<{ files: CgnsFileInfo[] }> {
  await assertProjectVisible(viewer, projectId);

  const safeName = cgnsBaseName(name);
  if (!(await cgnsFileExists(projectId, safeName))) {
    throw new AppError(404, 'NOT_FOUND', 'CGNS file not found');
  }
  await deleteCgnsFile(projectId, safeName);
  // Drop the intermediate VTK from a prior run, if any (ignore if absent).
  const vtkName = `${safeName.replace(/\.cgns$/i, '')}.vtk`;
  await deleteCgnsFile(projectId, vtkName).catch(() => undefined);

  const files = (await listCgnsFiles(projectId)).map(toCgnsInfo);
  return { files };
}

/** Absolute path of the CGNS->VTK ParaView script (configured, else bundled default). */
function cgnsToVtkScript(): string {
  const configured = env.CGNS_TO_VTK_SCRIPT.trim();
  if (configured) return configured;
  // Default: the script bundled with the API at apps/api/scripts/CgnsToVtk.py.
  // Resolved relative to THIS module (not process.cwd()), so it works whether the
  // API runs from source (tsx, src/) or the compiled output (dist/) and whatever
  // the working directory is. `scripts/` is not compiled, so it is three levels
  // up to apps/api from both src/modules/projects and dist/modules/projects.
  return path.resolve(__dirname, '../../../scripts/CgnsToVtk.py');
}

// planOpenfoamCommand + commandFailed are shared with the mesh actions (e.g.
// autoPatch) and live in lib/openfoamCommand.

/** Turn a raw command result into a reported, success step. */
function toStep(id: ConversionStepId, display: string, result: CommandResult): ConversionStep {
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError}`
    : result.timedOut
      ? '\n[runner] command timed out'
      : '';
  return {
    id,
    label: STEP_LABELS[id],
    command: display,
    status: commandFailed(result) ? 'failed' : 'success',
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr + extra),
    durationMs: result.durationMs,
  };
}

/** A step that never ran because an earlier one failed. */
function skippedStep(id: ConversionStepId, display: string): ConversionStep {
  return {
    id,
    label: STEP_LABELS[id],
    command: display,
    status: 'skipped',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
  };
}

/**
 * Convert a CGNS source into the project's OpenFOAM case mesh.
 *
 * Sequence: assert access -> apply the chosen template (adds its files, keeps
 * existing) -> ensure a `system/controlDict` exists (scaffold the minimal base
 * files if not, so the OpenFOAM utilities can run) -> run the three external
 * steps in order, short-circuiting on the first failure -> return the per-step
 * report with the refreshed verification and tree.
 *
 * Validation errors (unknown project/template, missing CGNS) throw; an external
 * tool failure does NOT — it resolves with `success: false` so the UI can show
 * the logs. The result's mesh is left as whatever the tools produced.
 *
 * @throws 404 NOT_FOUND (project not visible, template or CGNS file missing).
 */
export async function convertCgnsToFoam(
  viewer: Viewer,
  projectId: string,
  input: ConvertCgnsInput,
): Promise<ConversionResult> {
  await assertProjectVisible(viewer, projectId);

  const cgnsName = cgnsBaseName(input.cgnsFile);
  if (!(await cgnsFileExists(projectId, cgnsName))) {
    throw new AppError(404, 'NOT_FOUND', 'CGNS file not found');
  }

  const notes: string[] = [];

  // 1) Apply the chosen template (validates it exists). New files are added;
  //    existing case files are kept. getTemplate gives us a name for the note.
  const template = await getTemplate(input.templateId);
  const applied = await applyTemplate(viewer, projectId, input.templateId);
  notes.push(
    `Applied template "${template.name}": ${applied.applied.length} file(s) added` +
      (applied.skipped.length ? `, ${applied.skipped.length} kept` : ''),
  );

  // 2) The OpenFOAM utilities need system/controlDict. If the template did not
  //    provide one, generate the minimal base files so the pipeline can run.
  if (!(await caseFileExists(projectId, 'system/controlDict'))) {
    const scaffolded = await scaffoldCase(viewer, projectId);
    if (scaffolded.created.length) {
      notes.push(`Generated minimal base files: ${scaffolded.created.join(', ')}`);
    }
  }

  // 3) Resolve the real filesystem paths the external tools operate on.
  const caseDir = caseDirAbsolute(projectId);
  const cgnsAbs = cgnsFileAbsolute(projectId, cgnsName);
  const vtkName = `${cgnsName.replace(/\.cgns$/i, '')}.vtk`;
  const vtkAbs = cgnsFileAbsolute(projectId, vtkName);
  await fs.mkdir(caseDir, { recursive: true });

  const timeoutMs = env.CONVERSION_STEP_TIMEOUT_MS;
  const steps: ConversionStep[] = [];

  // --- Step 1: CGNS -> VTK via python3 + the standalone VTK wheel ---
  const scriptPath = cgnsToVtkScript();
  const step1Display = `${env.CGNS_PYTHON_BIN} ${scriptPath} ${cgnsAbs} ${vtkAbs}`;

  // Fail fast with an actionable message if the conversion script is missing,
  // rather than surfacing a cryptic interpreter error. The script IS shipped
  // with the API (apps/api/scripts/CgnsToVtk.py); this guards a server that
  // points CGNS_TO_VTK_SCRIPT at a path that does not exist.
  if (!(await pathExists(scriptPath))) {
    steps.push({
      id: 'cgnsToVtk',
      label: STEP_LABELS.cgnsToVtk,
      command: step1Display,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: `[runner] CGNS->VTK script not found at ${scriptPath}. Set CGNS_TO_VTK_SCRIPT to its absolute path.`,
      durationMs: 0,
    });
    steps.push(
      skippedStep('vtkToFoam', planVtkToFoamDisplay(caseDir, vtkAbs)),
      skippedStep('checkMesh', planCheckMeshDisplay(caseDir)),
    );
    return finalize(viewer, projectId, steps, notes);
  }

  const r1 = await runCommand({
    command: env.CGNS_PYTHON_BIN,
    args: [scriptPath, cgnsAbs, vtkAbs],
    cwd: path.dirname(cgnsAbs),
    env: process.env,
    timeoutMs,
  });
  const step1 = toStep('cgnsToVtk', step1Display, r1);
  // The script may exit 0 yet not produce the file; treat a missing VTK as a
  // failure so we don't run the next step on nothing.
  if (step1.status === 'success' && !(await pathExists(vtkAbs))) {
    step1.status = 'failed';
    step1.stderr = tail(`${step1.stderr}\n[runner] VTK output not found at ${vtkAbs}`);
  }
  steps.push(step1);

  if (step1.status !== 'success') {
    steps.push(
      skippedStep('vtkToFoam', planVtkToFoamDisplay(caseDir, vtkAbs)),
      skippedStep('checkMesh', planCheckMeshDisplay(caseDir)),
    );
    return finalize(viewer, projectId, steps, notes);
  }

  // --- Step 2: VTK -> constant/polyMesh via vtkUnstructuredToFoam ---
  const plan2 = planOpenfoamCommand(env.VTK_TO_FOAM_BIN, ['-case', caseDir, vtkAbs], caseDir);
  const r2 = await runCommand({ ...plan2, timeoutMs });
  const step2 = toStep('vtkToFoam', plan2.display, r2);
  steps.push(step2);

  if (step2.status !== 'success') {
    steps.push(skippedStep('checkMesh', planCheckMeshDisplay(caseDir)));
    return finalize(viewer, projectId, steps, notes);
  }

  // --- Step 3: checkMesh ---
  const plan3 = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir);
  const r3 = await runCommand({ ...plan3, timeoutMs });
  steps.push(toStep('checkMesh', plan3.display, r3));

  return finalize(viewer, projectId, steps, notes);
}

/** Logical display line for the vtkUnstructuredToFoam step (used when skipped). */
function planVtkToFoamDisplay(caseDir: string, vtkAbs: string): string {
  return `${env.VTK_TO_FOAM_BIN} -case ${caseDir} ${vtkAbs}`;
}

/** Logical display line for the checkMesh step (used when skipped). */
function planCheckMeshDisplay(caseDir: string): string {
  return `${env.CHECK_MESH_BIN} -case ${caseDir}`;
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

/** Assemble the final result: success flag + refreshed verification and tree. */
async function finalize(
  viewer: Viewer,
  projectId: string,
  steps: ConversionStep[],
  notes: string[],
): Promise<ConversionResult> {
  const [verification, entries] = await Promise.all([
    verifyCase(viewer, projectId),
    listCaseTree(projectId),
  ]);
  return {
    success: steps.every((step) => step.status === 'success'),
    steps,
    notes,
    verification,
    entries,
  };
}

/** The ordered step ids, re-exported for callers/tests that assert the sequence. */
export const CONVERSION_STEP_ORDER = CONVERSION_STEPS;
