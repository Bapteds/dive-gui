// Per-project solver convergence criteria + vortex metrics (WS-G, spec
// brain/specs/2026-09-30-solver-convergence-vorticity-design.md).
//
// Settings live in STORAGE_DIR/projects/<id>/cfd-criteria.json (outside case/, so
// a case reset keeps them; absent = defaults resolved on the mesh patches). They
// are installed into the case (function-object files in system/, managed
// #includes in controlDict, residualControl on/off in fvSolution) on save and
// again at every run start, since a scaffold or solver change rewrites the
// controlDict. Only steady incompressible solvers get them (criteriaApplicable).
//
// The on-demand vortex metrics run `postProcess -func diveVortexMetrics
// -latestTime` through the injectable command runner and parse its output.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  cfdCriteriaSchema,
  criteriaApplicable,
  type CfdCriteriaResponse,
  type CfdCriteriaSettings,
  type SaveCfdCriteriaResponse,
  type VortexMetricsSample,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { prisma } from '../../lib/prisma';
import {
  caseDirAbsolute,
  ensureProjectDir,
  projectDirAbsolute,
  readCaseFile,
  writeCaseFile,
} from '../../lib/caseStorage';
import {
  BOUNDARY_FILE,
  parseApplication,
  parseBoundaryPatchesWithTypes,
  type BoundaryPatch,
} from '../../lib/openfoamCase';
import {
  defaultCfdCriteria,
  disableResidualControl,
  patchProblem,
  planCriteriaInstall,
  readManagedIncludes,
  renderDiveVortexMetrics,
  restoreResidualControl,
  setManagedIncludes,
} from '../../lib/cfdCriteria';
import { parseMonitors } from '../../lib/monitorParser';
import { runCommand } from '../../lib/commandRunner';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import { assertProjectVisible, type Viewer } from './projects.service';

/** File name of the per-project settings, next to case/ and runs/. */
export const CRITERIA_FILENAME = 'cfd-criteria.json';

function criteriaFileAbsolute(projectId: string): string {
  return path.join(projectDirAbsolute(projectId), CRITERIA_FILENAME);
}

/** The saved settings, or null when absent or unreadable (then defaults apply). */
async function readStoredCriteria(projectId: string): Promise<CfdCriteriaSettings | null> {
  let raw: string;
  try {
    raw = await fs.readFile(criteriaFileAbsolute(projectId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = cfdCriteriaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persist the settings atomically (tmp + rename). */
async function writeStoredCriteria(projectId: string, settings: CfdCriteriaSettings): Promise<void> {
  await ensureProjectDir(projectId);
  const file = criteriaFileAbsolute(projectId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** Patches of constant/polyMesh/boundary (name + type), [] without a mesh. */
async function boundaryPatches(projectId: string): Promise<BoundaryPatch[]> {
  const buffer = await readCaseFile(projectId, BOUNDARY_FILE);
  return buffer ? parseBoundaryPatchesWithTypes(buffer.toString('utf8')) : [];
}

/** The solver named in system/controlDict, or null. */
async function caseSolver(projectId: string): Promise<string | null> {
  const buffer = await readCaseFile(projectId, 'system/controlDict');
  return buffer ? parseApplication(buffer.toString('utf8')) : null;
}

/** Saved settings, else the defaults resolved on the mesh patches. */
async function resolveCriteria(
  projectId: string,
  patches: BoundaryPatch[],
): Promise<CfdCriteriaSettings> {
  return (await readStoredCriteria(projectId)) ?? defaultCfdCriteria(patches);
}

/** 409 RUN_IN_PROGRESS when a run is active: the case must not change under the solver. */
async function assertNoActiveRun(projectId: string): Promise<void> {
  const active = await prisma.run.count({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  if (active > 0) {
    throw new AppError(409, 'RUN_IN_PROGRESS', 'A run is active for this project. Wait for it to finish.');
  }
}

/**
 * Write the criteria into the case. For a non-applicable solver the managed
 * includes are removed and residualControl restored instead. Returns whether the
 * criteria are now installed.
 * @throws 422 CRITERIA_INVALID when the saved patch pair no longer fits the mesh.
 */
async function installCriteria(
  projectId: string,
  settings: CfdCriteriaSettings,
  patches: BoundaryPatch[],
  applicable: boolean,
): Promise<boolean> {
  const controlDictBuf = await readCaseFile(projectId, 'system/controlDict');
  const fvSolutionBuf = await readCaseFile(projectId, 'system/fvSolution');
  const controlDict = controlDictBuf?.toString('utf8') ?? null;
  const fvSolution = fvSolutionBuf?.toString('utf8') ?? null;

  if (!applicable) {
    if (controlDict !== null) {
      const next = setManagedIncludes(controlDict, []);
      if (next !== controlDict) await writeCaseFile(projectId, 'system/controlDict', next);
    }
    if (fvSolution !== null) {
      const next = restoreResidualControl(fvSolution);
      if (next !== fvSolution) await writeCaseFile(projectId, 'system/fvSolution', next);
    }
    return false;
  }

  const plan = planCriteriaInstall(
    settings,
    patches.map((p) => p.name),
  );
  if (controlDict === null) return false;

  for (const [rel, content] of Object.entries(plan.files)) {
    await writeCaseFile(projectId, rel, content);
  }
  const nextControlDict = setManagedIncludes(controlDict, plan.includes);
  if (nextControlDict !== controlDict) {
    await writeCaseFile(projectId, 'system/controlDict', nextControlDict);
  }
  if (fvSolution !== null) {
    const next =
      plan.residualControl === 'disable'
        ? disableResidualControl(fvSolution)
        : restoreResidualControl(fvSolution);
    if (next !== fvSolution) await writeCaseFile(projectId, 'system/fvSolution', next);
  }
  return true;
}

/** Are the criteria currently wired into the case (includes + files present)? */
async function criteriaInstalled(
  projectId: string,
  settings: CfdCriteriaSettings,
  patches: BoundaryPatch[],
  applicable: boolean,
): Promise<boolean> {
  if (!applicable) return false;
  let plan;
  try {
    plan = planCriteriaInstall(
      settings,
      patches.map((p) => p.name),
    );
  } catch {
    return false;
  }
  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  if (!controlDict) return false;
  const present = readManagedIncludes(controlDict.toString('utf8'));
  if (present.join('|') !== plan.includes.join('|')) return false;
  for (const rel of Object.keys(plan.files)) {
    if (!(await readCaseFile(projectId, rel))) return false;
  }
  return true;
}

/** GET /projects/:id/criteria */
export async function getCriteria(viewer: Viewer, projectId: string): Promise<CfdCriteriaResponse> {
  await assertProjectVisible(viewer, projectId);
  const patches = await boundaryPatches(projectId);
  const criteria = await resolveCriteria(projectId, patches);
  const applicable = criteriaApplicable(await caseSolver(projectId));
  const installed = await criteriaInstalled(projectId, criteria, patches, applicable);
  return { criteria, patches: patches.map((p) => p.name), applicable, installed };
}

/**
 * PUT /projects/:id/criteria: validate against the mesh, persist, install.
 * @throws 409 RUN_IN_PROGRESS, 422 CRITERIA_INVALID.
 */
export async function saveCriteria(
  viewer: Viewer,
  projectId: string,
  input: CfdCriteriaSettings,
): Promise<SaveCfdCriteriaResponse> {
  await assertProjectVisible(viewer, projectId);
  await assertNoActiveRun(projectId);
  const patches = await boundaryPatches(projectId);
  if (input.convergence.method !== 'residuals') {
    const problem = patchProblem(
      input.convergence,
      patches.map((p) => p.name),
    );
    if (problem) throw new AppError(422, 'CRITERIA_INVALID', problem);
  }
  await writeStoredCriteria(projectId, input);
  const applicable = criteriaApplicable(await caseSolver(projectId));
  const installed = await installCriteria(projectId, input, patches, applicable);
  return { criteria: input, installed };
}

/**
 * Re-install the project's criteria right before a solver spawns (a scaffold or
 * solver change may have rewritten the controlDict). No access check: the run
 * service has asserted visibility already.
 * @throws 422 CRITERIA_INVALID when the saved patch pair no longer fits the mesh.
 */
export async function installCriteriaForRun(projectId: string): Promise<void> {
  const patches = await boundaryPatches(projectId);
  const criteria = await resolveCriteria(projectId, patches);
  const applicable = criteriaApplicable(await caseSolver(projectId));
  await installCriteria(projectId, criteria, patches, applicable);
}

/**
 * The project's effective criteria (saved, else the defaults resolved on the
 * current mesh patches) and whether the case solver takes them. No access check:
 * the optimisation study service (WS-H) snapshots them at study start.
 */
export async function resolveProjectCriteria(
  projectId: string,
): Promise<{ criteria: CfdCriteriaSettings; applicable: boolean }> {
  const patches = await boundaryPatches(projectId);
  return {
    criteria: await resolveCriteria(projectId, patches),
    applicable: criteriaApplicable(await caseSolver(projectId)),
  };
}

/**
 * Write a criteria snapshot back as the project's saved settings (WS-H: the
 * study re-installs its snapshot before each solve; startRun then installs it
 * into the case). No access check, no mesh validation (startRun validates).
 */
export async function writeProjectCriteria(
  projectId: string,
  settings: CfdCriteriaSettings,
): Promise<void> {
  await writeStoredCriteria(projectId, settings);
}

/** The latest numeric time directory > 0 of the case, or null. */
async function latestResultTime(projectId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(caseDirAbsolute(projectId));
  } catch {
    return null;
  }
  let best: { name: string; value: number } | null = null;
  for (const name of names) {
    if (!/^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(name)) continue;
    const value = Number(name);
    if (!(value > 0)) continue;
    if (!best || value > best.value) best = { name, value };
  }
  return best?.name ?? null;
}

/** The last few non-empty lines of a tool output (for a client-safe error). */
function lastLines(text: string, count = 5): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ')
    .slice(0, 600);
}

/**
 * POST /projects/:id/criteria/vortex: compute the vortex metrics at the latest
 * time with `postProcess -func diveVortexMetrics -latestTime`.
 * @throws 409 RUN_IN_PROGRESS, 409 NO_RESULTS, 502 POSTPROCESS_FAILED.
 */
export async function computeVortexOnDemand(
  viewer: Viewer,
  projectId: string,
): Promise<VortexMetricsSample> {
  await assertProjectVisible(viewer, projectId);
  await assertNoActiveRun(projectId);
  if (!(await latestResultTime(projectId))) {
    throw new AppError(409, 'NO_RESULTS', 'No results yet. Run the solver first.');
  }
  const patches = await boundaryPatches(projectId);
  const criteria = await resolveCriteria(projectId, patches);
  // The same function object the runs use, with the current settings.
  await writeCaseFile(projectId, 'system/diveVortexMetrics', renderDiveVortexMetrics(criteria.vortex));

  const caseDir = caseDirAbsolute(projectId);
  const result = await runCommand({
    ...planOpenfoamCommand(
      'postProcess',
      ['-case', caseDir, '-func', 'diveVortexMetrics', '-latestTime'],
      caseDir,
    ),
    timeoutMs: env.POSTPROCESS_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (commandFailed(result)) {
    const why = result.spawnError
      ? 'postProcess could not start. Check the OpenFOAM environment on the server.'
      : result.timedOut
        ? 'postProcess timed out.'
        : `postProcess exited with code ${result.exitCode}.`;
    const tail = lastLines(output);
    throw new AppError(502, 'POSTPROCESS_FAILED', tail ? `${why} ${tail}` : why);
  }
  const samples = parseMonitors(output).vortex;
  const latest = samples[samples.length - 1];
  if (!latest) {
    const tail = lastLines(output);
    throw new AppError(
      502,
      'POSTPROCESS_FAILED',
      `postProcess did not report vortex metrics.${tail ? ` ${tail}` : ''}`,
    );
  }
  return latest;
}
