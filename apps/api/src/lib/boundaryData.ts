// Convert an uploaded runner-exit CSV profile into OpenFOAM boundaryData for a
// draft-tube inlet (timeVaryingMappedFixedValue reads constant/boundaryData, NOT
// a CSV directly). Mirrors the mesh-import pipeline (meshImport.ts): the bundled
// Python script is configurable (config/env), a missing interpreter/script is
// captured as a step rather than thrown, and the command runner is injectable so
// this runs under test and reports a clean "not found" on a Windows dev box.
//
//   MESH_PYTHON_BIN csv_to_boundaryData.py <csv> <caseDir> <inlet>
//     -> <caseDir>/constant/boundaryData/<inlet>/{points, 0/U [, 0/k, 0/omega]}
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImportStep } from '@dive/shared';
import { env } from '../config/env';
import { runCommand, type CommandResult } from './commandRunner';
import { commandFailed } from './openfoamCommand';

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

/** Does an absolute path exist on disk? */
async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the bundled CSV->boundaryData script (or the configured override). */
function csvToBoundaryDataScript(): string {
  const configured = env.CSV_TO_BOUNDARY_DATA_SCRIPT.trim();
  if (configured) return configured;
  // scripts/ sits beside src/ and dist/ under apps/api, so two levels up from
  // src/lib (or dist/lib) reaches it whether running from source or compiled.
  return path.resolve(__dirname, '../../scripts/csv_to_boundaryData.py');
}

export interface CsvToBoundaryResult {
  /** The conversion step (single Python call), for the UI report. Never throws. */
  steps: ImportStep[];
  /**
   * boundaryData field basenames the CSV produced: 'U' always on success, plus
   * 'k' / 'omega' only when the CSV carried that column. Drives whether the inlet
   * k / omega BCs are mapped (timeVaryingMappedFixedValue) or fall back to the
   * intensity / mixing-length inlet.
   */
  mappedFields: string[];
}

/**
 * Run the bundled csv_to_boundaryData.py to turn `csvAbs` into
 * `caseDir`/constant/boundaryData/`patch`/. Never throws on a tool failure —
 * resolves a failed step with the captured logs, like the mesh-import pipeline.
 */
export async function convertCsvToBoundaryData(
  caseDir: string,
  csvAbs: string,
  patch: string,
): Promise<CsvToBoundaryResult> {
  const scriptPath = csvToBoundaryDataScript();
  const display = `${env.MESH_PYTHON_BIN} ${scriptPath} ${csvAbs} ${caseDir} ${patch}`;
  const label = 'Map the CSV profile to boundaryData';

  if (!(await pathExists(scriptPath))) {
    return {
      steps: [
        {
          tool: env.MESH_PYTHON_BIN,
          label,
          command: display,
          status: 'failed',
          exitCode: null,
          stdout: '',
          stderr: `[runner] csv_to_boundaryData.py not found at ${scriptPath}. Set CSV_TO_BOUNDARY_DATA_SCRIPT to its absolute path.`,
          durationMs: 0,
        },
      ],
      mappedFields: [],
    };
  }

  const result = await runCommand({
    command: env.MESH_PYTHON_BIN,
    args: [scriptPath, csvAbs, caseDir, patch],
    cwd: caseDir,
    env: process.env,
    timeoutMs: env.CSV_TO_BOUNDARY_TIMEOUT_MS,
  });
  const step = toStep(env.MESH_PYTHON_BIN, label, display, result);

  const mappedFields: string[] = [];
  if (step.status === 'success') {
    const base = path.join(caseDir, 'constant', 'boundaryData', patch, '0');
    for (const field of ['U', 'k', 'omega']) {
      if (await pathExists(path.join(base, field))) mappedFields.push(field);
    }
  }
  return { steps: [step], mappedFields };
}
