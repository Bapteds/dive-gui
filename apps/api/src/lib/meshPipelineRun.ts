// Shared plumbing for the meshing pipelines (snappyHexMesh and cfMesh): the
// per-step report shape, an ordered short-circuiting step runner, and the
// pre-run "Allclean" of prior mesh output. Both engines report results as an
// array of ImportStep (reusing the mesh-import shape), so the web UI renders
// either pipeline identically. Kept engine-agnostic here; each engine module
// only builds its own list of PlannedStep.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImportStep, MeshImportConversion } from '@dive/shared';
import { runCommand, type CommandResult } from './commandRunner';
import { commandFailed, type PlannedCommand } from './openfoamCommand';

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
export function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Turn a raw command result into a reported step (copied from meshImport). */
export function toStep(tool: string, label: string, display: string, result: CommandResult): ImportStep {
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
export function skipped(tool: string, label: string, display: string): ImportStep {
  return { tool, label, command: display, status: 'skipped', exitCode: null, stdout: '', stderr: '', durationMs: 0 };
}

/** Roll the per-step reports into a conversion result (success iff every step did). */
export function finalize(steps: ImportStep[]): MeshImportConversion {
  return { success: steps.every((step) => step.status === 'success'), steps };
}

/** One planned pipeline step: the tool + label to report, and its command. */
export interface PlannedStep {
  tool: string;
  label: string;
  plan: PlannedCommand;
}

/**
 * Run planned steps in order, short-circuiting on the first failure: every step
 * after a failed one is reported `skipped`, so the report reads top-to-bottom.
 */
export async function runSteps(steps: PlannedStep[], timeoutMs: number): Promise<ImportStep[]> {
  const out: ImportStep[] = [];
  let failed = false;
  for (const step of steps) {
    if (failed) {
      out.push(skipped(step.tool, step.label, step.plan.display));
      continue;
    }
    const result = await runCommand({ ...step.plan, timeoutMs });
    const reported = toStep(step.tool, step.label, step.plan.display, result);
    out.push(reported);
    if (reported.status !== 'success') failed = true;
  }
  return out;
}

/**
 * Clear a previous run's mesh output so each run starts from a clean slate — the
 * OpenFOAM `Allclean` rule. Without this, the mesher rewrites the mesh geometry
 * but leaves stale refinement fields (constant/polyMesh/cellLevel, pointLevel, …)
 * from an earlier, differently-sized mesh; a later decomposePar then reads the new
 * mesh against the old cellLevel and dies with "Size N is not equal to the
 * expected length M". Removes the mesh, any prior decomposition (processor*), and
 * every numeric time directory (0, 1, 2, … — snappy's intermediate outputs and any
 * stale level fields under 0/). Deliberately keeps the inputs: system/ and
 * constant/triSurface/ (surfaces + extracted features).
 */
export async function cleanPriorMeshArtifacts(caseDir: string): Promise<void> {
  const removals: Promise<unknown>[] = [
    fs.rm(path.join(caseDir, 'constant', 'polyMesh'), { recursive: true, force: true }),
  ];
  const entries = await fs.readdir(caseDir).catch(() => [] as string[]);
  for (const name of entries) {
    // processorN decompositions and pure-numeric time dirs (0, 1, 2, …).
    if (/^processor\d+$/.test(name) || /^\d+$/.test(name)) {
      removals.push(fs.rm(path.join(caseDir, name), { recursive: true, force: true }));
    }
  }
  await Promise.all(removals.map((p) => Promise.resolve(p).catch(() => undefined)));
}
