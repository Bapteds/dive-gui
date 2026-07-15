// checkMesh quality gate for the diameter-optimization sweep. A large morph can
// invert near-wall cells; before running a candidate diameter the sweep runs
// checkMesh and SKIPS the value when the mesh has negative-volume cells (which make
// the solve impossible). Minor quality warnings (skewness, non-orthogonality) do NOT
// block a solve, so they do not fail the gate. When checkMesh is not installed (e.g.
// a Windows dev box), the gate reports UNAVAILABLE and the sweep proceeds.
import { env } from '../config/env';
import { runCommand } from './commandRunner';
import { planOpenfoamCommand } from './openfoamCommand';

export interface CheckMeshVerdict {
  /** Safe to solve on this mesh? (false only on a fatal, solve-breaking defect). */
  ok: boolean;
  /** Was checkMesh actually run? (false when the binary is missing on this host). */
  available: boolean;
  /** Negative-volume cell count parsed from the output (0 when none / unknown). */
  negativeVolumeCells: number;
  /** Short human note for the sample (e.g. the failing summary, or "Mesh OK"). */
  note: string;
}

/** Parse checkMesh output into a verdict (pure, testable). */
export function parseCheckMesh(output: string): Omit<CheckMeshVerdict, 'available'> {
  const negMatch = output.match(/negative volume cells:\s*(\d+)/i);
  const negativeVolumeCells = negMatch ? Number(negMatch[1]) : 0;
  const meshOk = /Mesh OK\./.test(output);
  const failed = output.match(/Failed\s+(\d+)\s+mesh checks/i);
  // Fatal for a solve: inverted (negative-volume) cells. Everything else is a warning.
  const ok = negativeVolumeCells === 0;
  const note =
    negativeVolumeCells > 0
      ? `${negativeVolumeCells} negative-volume cell(s) — morph too large here`
      : meshOk
        ? 'Mesh OK'
        : failed
          ? `${failed[1]} non-fatal mesh check(s) flagged`
          : 'checkMesh completed';
  return { ok, negativeVolumeCells, note };
}

/** Run checkMesh on a case dir and return the gate verdict. */
export async function runCheckMeshGate(caseDir: string): Promise<CheckMeshVerdict> {
  const plan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir], caseDir);
  const result = await runCommand({ ...plan, timeoutMs: env.MESH_BUILD_TIMEOUT_MS });
  if (result.spawnError) {
    return { ok: true, available: false, negativeVolumeCells: 0, note: 'checkMesh unavailable (gate skipped)' };
  }
  return { ...parseCheckMesh(`${result.stdout}\n${result.stderr}`), available: true };
}
