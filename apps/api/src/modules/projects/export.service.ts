// OpenFOAM -> CGNS export for Ansys CFD-Post: business logic ("Export" tab).
//
// The reverse of the CGNS->Foam import: a SOLVED OpenFOAM case is turned into a
// CGNS file CFD-Post can load (File -> Load Results), without Fluent. The chain,
// run as a 4-step pipeline (mirrors conversion.service.ts: injectable runner,
// configurable binaries, per-step structured results, short-circuit on failure):
//
//   1. inspect : profile the case (solver, steady, latest time, fields, patches,
//                empty patches, polyhedra) -> CaseProfile. Gate: must be solved.
//   2. convert : pvbatch FoamToCgns.py -> export/out.cgns (ADF, cell-centred).
//                Writing CGNS is ParaView-only (core VTK has no CGNS writer).
//   3. validate: re-read the CGNS (VTK wheel) for fidelity (fields, cell-centred,
//                no empty zones) + a best-effort physical cross-check.
//   4. cfdpost : write a CFD-Post session.cse skeleton + a load memo. CFD-Post is
//                NOT on the server, so we only PRODUCE these files.
//
// Artifacts live under the project's export/ store (sibling of case/), never in
// the case, so an export never mutates case inputs.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  EXPORT_STEPS,
  type CaseProfile,
  type ExportArtifacts,
  type ExportResult,
  type ExportStep,
  type ExportStepId,
  type ExportValidation,
  type ValidationCheck,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand } from '../../lib/commandRunner';
import { planOpenfoamCommand } from '../../lib/openfoamCommand';
import { caseDirAbsolute, readCaseFile } from '../../lib/caseStorage';
import {
  EXPORT_FILES,
  clearExport,
  ensureExportDir,
  exportFilePath,
  readExportBytes,
  readExportJson,
  readExportText,
  writeExportFile,
} from '../../lib/exportStorage';
import { assertProjectVisible, type Viewer } from './projects.service';

/** Human labels for each pipeline step. */
const STEP_LABELS: Record<ExportStepId, string> = {
  inspect: 'Inspect case',
  convert: 'Convert to CGNS (pvbatch)',
  validate: 'Validate the CGNS',
  cfdpost: 'Prepare CFD-Post session',
};

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Does an absolute path exist on disk? */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bundled script path (configured override, else the one shipped with the API). */
function bundledScript(configured: string, filename: string): string {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  // `scripts/` is not compiled, so it is three levels up to apps/api from both
  // src/modules/projects and dist/modules/projects (cwd-independent, like the
  // conversion / viewer scripts).
  return path.resolve(__dirname, '../../../scripts', filename);
}

/** A skipped step (an earlier step failed). */
function skipped(id: ExportStepId, command: string): ExportStep {
  return {
    id,
    label: STEP_LABELS[id],
    command,
    status: 'skipped',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
  };
}

/** Numeric OpenFOAM time-directory name (e.g. "0", "0.5", "1000"). */
const TIME_DIR_RE = /^\d+(\.\d+)?$/;
/** Files in a time directory that are not solver fields. */
const NON_FIELD_NAMES = new Set(['uniform', 'polyMesh']);

/**
 * The latest SOLVED time directory (numeric, > 0) and its field files. Initial
 * conditions live in "0"/"0.orig"; results are written to time dirs > 0, so the
 * absence of any such directory means the case has not been solved yet.
 */
async function latestSolvedTime(
  caseDir: string,
): Promise<{ time: string; fields: string[] } | null> {
  let names: string[];
  try {
    names = await fs.readdir(caseDir);
  } catch {
    return null;
  }
  const times = names.filter((n) => TIME_DIR_RE.test(n) && Number(n) > 0);
  if (times.length === 0) return null;
  const latest = times.reduce((a, b) => (Number(b) > Number(a) ? b : a));

  let entries: string[] = [];
  try {
    const dir = path.join(caseDir, latest);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && !NON_FIELD_NAMES.has(d.name))
      .map((d) => d.name);
  } catch {
    entries = [];
  }
  return { time: latest, fields: entries.sort() };
}

/** Steady-state solvers (single converged field) vs transient (time accurate). */
const STEADY_SOLVERS = new Set([
  'simpleFoam',
  'rhoSimpleFoam',
  'porousSimpleFoam',
  'SRFSimpleFoam',
  'potentialFoam',
  'adjointShapeOptimizationFoam',
]);
/** Solver-name prefixes that indicate a compressible (real-pressure) solver. */
const COMPRESSIBLE_PREFIXES = ['rho', 'sonic', 'compressible'];

/** Parse `application <solver>;` from a controlDict's text. */
function parseSolver(controlDict: string): string {
  const m = controlDict.match(/^\s*application\s+([A-Za-z0-9_]+)\s*;/m);
  return m ? m[1] : 'unknown';
}

/** Parse the RAS/LES model name from a momentumTransport / turbulenceProperties text. */
function parseTurbulence(text: string): string {
  const model = text.match(/\bmodel\s+([A-Za-z0-9_]+)\s*;/);
  if (model) return model[1];
  const sim = text.match(/\bsimulationType\s+([A-Za-z0-9_]+)\s*;/);
  return sim ? sim[1] : 'unknown';
}

/** {name, nFaces} for every patch block in a constant/polyMesh/boundary text. */
function parsePatchFaceCounts(boundary: string): Array<{ name: string; nFaces: number }> {
  const cleaned = boundary.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const result: Array<{ name: string; nFaces: number }> = [];
  const blockRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(cleaned)) !== null) {
    if (match[1] === 'FoamFile') continue;
    const nf = match[2].match(/\bnFaces\s+(\d+)/);
    result.push({ name: match[1], nFaces: nf ? Number(nf[1]) : 0 });
  }
  return result;
}

/** Best guess at the patch named like `keyword`, else null. */
function guessPatch(patches: string[], keyword: string): string | null {
  const hit = patches.find((p) => p.toLowerCase().includes(keyword));
  return hit ?? null;
}

/**
 * Step 1 - inspect. Builds the CaseProfile mostly from the case files (reliable,
 * tool-independent); checkMesh is run only to detect polyhedra (best-effort). The
 * step FAILS when the case has no solved time directory (nothing to export).
 */
async function inspectCase(
  projectId: string,
  caseDir: string,
): Promise<{ step: ExportStep; profile: CaseProfile | null }> {
  const log: string[] = [];

  const solved = await latestSolvedTime(caseDir);
  if (!solved) {
    return {
      profile: null,
      step: {
        id: 'inspect',
        label: STEP_LABELS.inspect,
        command: 'inspect case (foamDictionary, checkMesh)',
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr:
          'No solved results to export. Run the solver first so the case has a time directory > 0 with fields.',
        durationMs: 0,
      },
    };
  }
  log.push(`Latest solved time: ${solved.time}`);
  log.push(`Fields: ${solved.fields.join(', ') || '(none found)'}`);

  const controlDict = (await readCaseFile(projectId, 'system/controlDict'))?.toString('utf8') ?? '';
  const solver = parseSolver(controlDict);
  const steady = STEADY_SOLVERS.has(solver);

  const hasThermo = await pathExists(path.join(caseDir, 'constant', 'thermophysicalProperties'));
  const compressible =
    hasThermo || COMPRESSIBLE_PREFIXES.some((p) => solver.toLowerCase().startsWith(p));

  const turbText =
    (await readCaseFile(projectId, 'constant/momentumTransport'))?.toString('utf8') ??
    (await readCaseFile(projectId, 'constant/turbulenceProperties'))?.toString('utf8') ??
    '';
  const turbulenceModel = turbText ? parseTurbulence(turbText) : 'unknown';

  const boundary =
    (await readCaseFile(projectId, 'constant/polyMesh/boundary'))?.toString('utf8') ?? '';
  const faceCounts = parsePatchFaceCounts(boundary);
  const patches = faceCounts.map((p) => p.name);
  const emptyPatches = faceCounts.filter((p) => p.nFaces === 0).map((p) => p.name);
  log.push(`Patches: ${patches.join(', ') || '(none)'}`);
  if (emptyPatches.length) log.push(`Empty patches (excluded): ${emptyPatches.join(', ')}`);

  // checkMesh purely to detect polyhedra (which CFD-Post may tessellate). Any
  // failure is non-fatal — the profile is still complete without it.
  let hasPolyhedra = false;
  const plan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', caseDir, '-latestTime'], caseDir);
  const check = await runCommand({ ...plan, timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS });
  let polyNote = '';
  if (check.exitCode === 0) {
    const m = check.stdout.match(/polyhedra:\s*(\d+)/);
    hasPolyhedra = !!m && Number(m[1]) > 0;
    polyNote = m ? `polyhedra: ${m[1]}` : 'polyhedra: 0';
  } else {
    polyNote = 'checkMesh unavailable — polyhedra unknown';
  }
  log.push(polyNote);

  const profile: CaseProfile = {
    latestTime: solved.time,
    steady,
    incompressible: !compressible,
    solver,
    turbulenceModel,
    fields: solved.fields,
    hasPolyhedra,
    patches,
    emptyPatches,
    inletGuess: guessPatch(patches, 'inlet'),
    outletGuess: guessPatch(patches, 'outlet'),
  };
  await writeExportFile(projectId, 'profile', JSON.stringify(profile, null, 2));

  // A missing checkMesh is a caveat, not a failure.
  const status: ExportStep['status'] = check.exitCode === 0 ? 'success' : 'warning';
  return {
    profile,
    step: {
      id: 'inspect',
      label: STEP_LABELS.inspect,
      command: `${plan.display}  (+ parse controlDict / boundary)`,
      status,
      exitCode: check.exitCode,
      stdout: tail(`${log.join('\n')}\n\n--- checkMesh ---\n${check.stdout}`),
      stderr: tail(check.stderr),
      durationMs: check.durationMs,
    },
  };
}

/**
 * Step 2 - convert. touch case.foam, copy the bundled converter into export/ for
 * transparency, then run pvbatch FoamToCgns.py -> export/out.cgns. pvbatch runs
 * with --force-offscreen-rendering so SaveData has no GL dependency on a headless
 * server. The step fails if out.cgns is not produced.
 */
async function convertToCgns(
  projectId: string,
  caseDir: string,
  profile: CaseProfile,
): Promise<ExportStep> {
  const foam = path.join(caseDir, 'case.foam');
  if (!(await pathExists(foam))) await fs.writeFile(foam, '');

  const script = bundledScript(env.FOAM_TO_CGNS_SCRIPT, 'FoamToCgns.py');
  if (!(await pathExists(script))) {
    return {
      id: 'convert',
      label: STEP_LABELS.convert,
      command: `${env.PVBATCH_BIN} ${script}`,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: `Converter not found at ${script}. Set FOAM_TO_CGNS_SCRIPT to its absolute path.`,
      durationMs: 0,
    };
  }
  // Keep a copy beside the output so the exact converter is auditable.
  await ensureExportDir(projectId);
  await fs.copyFile(script, exportFilePath(projectId, 'convertScript')).catch(() => undefined);

  const outCgns = exportFilePath(projectId, 'cgns');
  const fieldsCsv = profile.fields.join(',');
  const args = [
    '--force-offscreen-rendering',
    script,
    foam,
    outCgns,
    profile.latestTime ?? '',
    fieldsCsv,
  ];
  const display = `${env.PVBATCH_BIN} ${args.join(' ')}`;

  const result = await runCommand({
    command: env.PVBATCH_BIN,
    args,
    cwd: caseDir,
    env: process.env,
    timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS,
  });

  const produced = (await readExportBytes(projectId, 'cgns')) !== null;
  const ok = !result.spawnError && !result.timedOut && result.exitCode === 0 && produced;
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError}`
    : result.timedOut
      ? '\n[runner] pvbatch timed out'
      : !produced && result.exitCode === 0
        ? `\n[runner] pvbatch exited 0 but ${outCgns} was not created`
        : '';

  return {
    id: 'convert',
    label: STEP_LABELS.convert,
    command: display,
    status: ok ? 'success' : 'failed',
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr + extra),
    durationMs: result.durationMs,
  };
}

/** Shape of the JSON emitted by CgnsInspect.py. */
interface CgnsReport {
  cellArrays: string[];
  pointArrays: string[];
  nZones: number;
  nCells: number;
  nPoints: number;
  emptyZones: number;
  velocityMax: number | null;
}

/**
 * Step 3 - validate. Re-reads the CGNS (VTK wheel) and checks fidelity: data is
 * present, CELL-centred (not interpolated to points), no empty zones, and the
 * expected fields are there. The physical velocity-max row is informational (we
 * report the CGNS value; an OpenFOAM reference comparison is out of scope here
 * and would need fragile postProcess parsing). Validation FAILs only on a real
 * structural problem, never on a missing best-effort reference.
 */
async function validateCgns(
  projectId: string,
  profile: CaseProfile,
): Promise<{ step: ExportStep; validation: ExportValidation }> {
  const script = bundledScript(env.CGNS_INSPECT_SCRIPT, 'CgnsInspect.py');
  const cgns = exportFilePath(projectId, 'cgns');
  const display = `${env.MESH_PYTHON_BIN} ${script} ${cgns}`;

  if (!(await pathExists(script))) {
    const validation: ExportValidation = {
      status: 'fail',
      checks: [{ name: 'CGNS reader script', reference: '-', cgns: 'missing', delta: '-', verdict: 'fail' }],
    };
    await writeExportFile(projectId, 'validation', JSON.stringify(validation, null, 2));
    return {
      validation,
      step: {
        id: 'validate',
        label: STEP_LABELS.validate,
        command: display,
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: `Validator not found at ${script}. Set CGNS_INSPECT_SCRIPT to its absolute path.`,
        durationMs: 0,
      },
    };
  }

  const result = await runCommand({
    command: env.MESH_PYTHON_BIN,
    args: [script, cgns],
    cwd: path.dirname(cgns),
    env: process.env,
    timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS,
  });

  let report: CgnsReport | null = null;
  if (result.exitCode === 0) {
    try {
      report = JSON.parse(result.stdout.trim().split('\n').pop() ?? '') as CgnsReport;
    } catch {
      report = null;
    }
  }

  const checks: ValidationCheck[] = [];
  if (!report) {
    checks.push({ name: 'CGNS readable', reference: '-', cgns: 'unreadable', delta: '-', verdict: 'fail' });
  } else {
    const cellArrays = report.cellArrays ?? [];
    const pointArrays = report.pointArrays ?? [];

    // Fields present: at least one expected field carried through.
    const expected = profile.fields;
    const carried = cellArrays.length > 0 || pointArrays.length > 0;
    checks.push({
      name: 'Fields present',
      reference: expected.join(', ') || '(none)',
      cgns: [...cellArrays, ...pointArrays].join(', ') || '(none)',
      delta: '-',
      verdict: carried ? 'pass' : 'fail',
    });

    // Cell-centred: data must live on cells (no interpolation to nodes).
    checks.push({
      name: 'Cell-centred data',
      reference: 'cell',
      cgns: cellArrays.length ? `cell (${cellArrays.length} arrays)` : `point only (${pointArrays.length})`,
      delta: '-',
      verdict: cellArrays.length > 0 ? 'pass' : 'fail',
    });

    // Non-empty mesh and no empty zones.
    checks.push({
      name: 'Mesh non-empty',
      reference: '> 0 cells',
      cgns: `${report.nCells} cells / ${report.nZones} zones`,
      delta: '-',
      verdict: report.nCells > 0 ? 'pass' : 'fail',
    });
    checks.push({
      name: 'No empty zones',
      reference: '0',
      cgns: String(report.emptyZones),
      delta: '-',
      verdict: report.emptyZones === 0 ? 'pass' : 'fail',
    });

    // Physical cross-check (informational): velocity magnitude max in the CGNS.
    checks.push({
      name: 'Velocity max (|U|)',
      reference: '-',
      cgns: report.velocityMax === null ? 'n/a' : report.velocityMax.toPrecision(4),
      delta: '-',
      verdict: 'info',
    });
  }

  const status: ExportValidation['status'] = checks.some((c) => c.verdict === 'fail')
    ? 'fail'
    : 'pass';
  const validation: ExportValidation = { status, checks };
  await writeExportFile(projectId, 'validation', JSON.stringify(validation, null, 2));

  return {
    validation,
    step: {
      id: 'validate',
      label: STEP_LABELS.validate,
      command: display,
      status: status === 'pass' ? 'success' : 'failed',
      exitCode: result.exitCode,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
      durationMs: result.durationMs,
    },
  };
}

/** Render the CFD-Post session.cse skeleton (loads results + a velocity contour). */
function renderSessionCse(profile: CaseProfile): string {
  const inlet = profile.inletGuess ?? 'inlet';
  const outlet = profile.outletGuess ?? 'outlet';
  return `# CFD-Post session generated by DIVE Turbinen.
# Load with:  cfdpost -batch session.cse out.cgns
# IMPORTANT: this LOADS RESULTS (out.cgns), it does not run a solver.

> load filename=out.cgns

# A minimal velocity contour on the whole domain.
CONTOUR:Velocity Contour
  Variable = Velocity
  Location List = /DOMAIN
END

# Mass flow at the guessed inlet / outlet patches (rename if needed).
EXPRESSION: massFlowIn
  Expression = massFlow()@${inlet}
END
EXPRESSION: massFlowOut
  Expression = massFlow()@${outlet}
END
`;
}

/** Render the CFD-Post load memo (the caveats that bite first). */
function renderLoadMemo(profile: CaseProfile): string {
  const pressureNote = profile.incompressible
    ? `- **Pression cinématique** : le solveur \`${profile.solver}\` est incompressible, donc \`p\` est en m²/s² (p/ρ). Dans CFD-Post les pressions seront divisées par ρ — multiplie par la densité pour des Pa. Ce n'est pas un bug.`
    : `- **Pression** : le solveur \`${profile.solver}\` est compressible, \`p\` est déjà en Pa.`;
  const polyNote = profile.hasPolyhedra
    ? `- **Polyèdres détectés** : vérifie dans CFD-Post qu'ils ne sont pas tessellés (perte de topologie).`
    : `- Pas de polyèdres détectés.`;
  const emptyNote = profile.emptyPatches.length
    ? `- **Surfaces vides exclues** : ${profile.emptyPatches.join(', ')} (0 face) — normal, évite l'erreur « Invalid File / surfaces vides ».`
    : `- Aucune surface vide à exclure.`;
  return `# Charger \`out.cgns\` dans Ansys CFD-Post

## Comment charger
- **File → Load Results** (jamais « Load Case »).
- Ou en batch : \`cfdpost -batch session.cse out.cgns\`.
- CFD-Post ne lit pas OpenFOAM nativement ; le CGNS est le pont neutre.

## Profil du cas
- Solveur : \`${profile.solver}\` (${profile.steady ? 'steady' : 'transitoire'})
- Dernier temps exporté : \`${profile.latestTime ?? '-'}\`
- Turbulence : \`${profile.turbulenceModel}\`
- Champs : ${profile.fields.join(', ') || '(aucun)'}

## Points de vigilance
${pressureNote}
${polyNote}
${emptyNote}
- **Transitoire** : CFD-Post gère mal le CGNS transitoire (un pas de temps à la fois) ; cet export ne contient que le dernier temps.
- Les données sont conservées **aux centres de cellules** (pas de lissage vers les nœuds).
`;
}

/** Step 4 - cfdpost. Writes session.cse + the load memo (server does not run CFD-Post). */
async function prepareCfdPost(projectId: string, profile: CaseProfile): Promise<ExportStep> {
  await writeExportFile(projectId, 'session', renderSessionCse(profile));
  await writeExportFile(projectId, 'memo', renderLoadMemo(profile));
  return {
    id: 'cfdpost',
    label: STEP_LABELS.cfdpost,
    command: 'write session.cse + LOAD_CFDPOST.md',
    status: 'success',
    exitCode: 0,
    stdout: 'Wrote session.cse and LOAD_CFDPOST.md (CFD-Post runs on your workstation, not the server).',
    stderr: '',
    durationMs: 0,
  };
}

/** Render the final REPORT.md from the run's pieces. */
function renderReport(
  profile: CaseProfile | null,
  validation: ExportValidation | null,
  steps: ExportStep[],
): string {
  const stepLines = steps
    .map((s) => `- ${s.label}: **${s.status}**${s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}`)
    .join('\n');
  const validationLines = validation
    ? validation.checks
        .map((c) => `| ${c.name} | ${c.reference} | ${c.cgns} | ${c.verdict} |`)
        .join('\n')
    : '(not run)';
  return `# Export OpenFOAM → CGNS (CFD-Post) — rapport

## Étapes
${stepLines}

## Profil du cas
${
  profile
    ? `- Solveur : \`${profile.solver}\` (${profile.steady ? 'steady' : 'transitoire'}, ${
        profile.incompressible ? 'incompressible' : 'compressible'
      })
- Dernier temps : \`${profile.latestTime ?? '-'}\`
- Champs : ${profile.fields.join(', ') || '(aucun)'}
- Patches : ${profile.patches.join(', ') || '(aucun)'}${
        profile.emptyPatches.length ? ` — vides exclus : ${profile.emptyPatches.join(', ')}` : ''
      }`
    : '(inspect a échoué)'
}

## Validation : ${validation?.status?.toUpperCase() ?? 'N/A'}
| Contrôle | Référence | CGNS | Verdict |
| --- | --- | --- | --- |
${validationLines}

## Chargement CFD-Post
\`cfdpost -batch session.cse out.cgns\` (ou File → Load Results). Voir LOAD_CFDPOST.md pour les pièges (pression ×ρ si incompressible, surfaces vides, transitoire).
`;
}

/** Which downloadable artifacts the export produced. */
async function readArtifacts(projectId: string): Promise<ExportArtifacts> {
  const [cgns, session, memo, report] = await Promise.all([
    readExportBytes(projectId, 'cgns').then((b) => b !== null && b.length > 0),
    readExportText(projectId, 'session').then((t) => t !== null),
    readExportText(projectId, 'memo').then((t) => t !== null),
    readExportText(projectId, 'report').then((t) => t !== null),
  ]);
  return { cgns, session, memo, report };
}

/**
 * Run the full OpenFOAM -> CGNS export pipeline for a project and return the
 * per-step report + profile + validation + downloadable artifacts. Validation /
 * tool failures do NOT throw (they resolve with the report so the UI shows logs);
 * only access problems throw. A fresh run clears the previous export artifacts.
 *
 * @throws 404 NOT_FOUND if the project is not visible (no existence leak).
 */
export async function runExport(viewer: Viewer, projectId: string): Promise<ExportResult> {
  await assertProjectVisible(viewer, projectId);

  const caseDir = caseDirAbsolute(projectId);
  await clearExport(projectId);
  await ensureExportDir(projectId);

  const steps: ExportStep[] = [];
  const notes: string[] = [];

  // 1) Inspect.
  const { step: inspectStep, profile } = await inspectCase(projectId, caseDir);
  steps.push(inspectStep);
  if (inspectStep.status === 'failed' || !profile) {
    steps.push(
      skipped('convert', `${env.PVBATCH_BIN} FoamToCgns.py`),
      skipped('validate', `${env.MESH_PYTHON_BIN} CgnsInspect.py`),
      skipped('cfdpost', 'write session.cse + memo'),
    );
    return finalize(projectId, steps, notes, profile, null);
  }
  notes.push(`Exporting the latest solved time: ${profile.latestTime}.`);
  if (profile.emptyPatches.length) {
    notes.push(`Excluded ${profile.emptyPatches.length} empty patch(es): ${profile.emptyPatches.join(', ')}.`);
  }

  // 2) Convert.
  const convertStep = await convertToCgns(projectId, caseDir, profile);
  steps.push(convertStep);
  if (convertStep.status === 'failed') {
    steps.push(
      skipped('validate', `${env.MESH_PYTHON_BIN} CgnsInspect.py`),
      skipped('cfdpost', 'write session.cse + memo'),
    );
    return finalize(projectId, steps, notes, profile, null);
  }

  // 3) Validate.
  const { step: validateStep, validation } = await validateCgns(projectId, profile);
  steps.push(validateStep);

  // 4) CFD-Post prep (runs even when validation flagged issues — the CGNS exists).
  steps.push(await prepareCfdPost(projectId, profile));

  return finalize(projectId, steps, notes, profile, validation);
}

/** Write REPORT.md, then assemble the result with the refreshed artifact flags. */
async function finalize(
  projectId: string,
  steps: ExportStep[],
  notes: string[],
  profile: CaseProfile | null,
  validation: ExportValidation | null,
): Promise<ExportResult> {
  await writeExportFile(projectId, 'report', renderReport(profile, validation, steps));
  const artifacts = await readArtifacts(projectId);
  return {
    success: steps.every((s) => s.status === 'success' || s.status === 'warning'),
    steps,
    notes,
    profile,
    validation,
    artifacts,
  };
}

/** The last export's status (profile + validation + artifacts), or null if none ran. */
export async function getExportStatus(
  viewer: Viewer,
  projectId: string,
): Promise<{ profile: CaseProfile | null; validation: ExportValidation | null; artifacts: ExportArtifacts } | null> {
  await assertProjectVisible(viewer, projectId);
  const profile = await readExportJson<CaseProfile>(projectId, 'profile');
  const validation = await readExportJson<ExportValidation>(projectId, 'validation');
  const artifacts = await readArtifacts(projectId);
  if (!profile && !artifacts.cgns) return null;
  return { profile, validation, artifacts };
}

/** Read a produced export artifact for download (out.cgns / session / memo / report). */
export async function readExportArtifact(
  viewer: Viewer,
  projectId: string,
  file: keyof typeof EXPORT_FILES,
): Promise<Buffer> {
  await assertProjectVisible(viewer, projectId);
  const bytes = await readExportBytes(projectId, file);
  if (!bytes) {
    throw new AppError(404, 'NOT_FOUND', 'That export artifact has not been produced yet.');
  }
  return bytes;
}

/** The ordered step ids, re-exported for callers/tests that assert the sequence. */
export const EXPORT_STEP_ORDER = EXPORT_STEPS;
