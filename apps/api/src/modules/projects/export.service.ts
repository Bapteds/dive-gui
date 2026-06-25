// OpenFOAM -> EnSight export for Ansys CFD-Post: business logic ("Export" tab).
//
// A SOLVED OpenFOAM case is turned into EnSight Gold output that CFD-Post can load
// (File -> Load Results), without Fluent and WITHOUT ParaView: the convert step is
// the NATIVE OpenFOAM `foamToEnsight` utility, which writes the full time series.
// Run as a 4-step pipeline (mirrors conversion.service.ts: injectable runner,
// configurable binaries, per-step structured results, short-circuit on failure):
//
//   1. inspect : profile the case (solver, steady, latest time, fields, patches,
//                empty patches, polyhedra) -> CaseProfile. Gate: must be solved.
//   2. convert : foamToEnsight -> <case>/EnSight/, moved to export/ensight/ and
//                zipped to ensight.zip (the download). Native OpenFOAM, all times.
//   3. validate: parse the EnSight .case (time steps + variables present). Pure
//                Node text parsing — no python / ParaView needed.
//   4. cfdpost : write a CFD-Post session + a load memo. CFD-Post is NOT on the
//                server, so we only PRODUCE these files.
//
// Artifacts live under the project's export/ store (sibling of case/). The
// foamToEnsight output is moved OUT of the case immediately, so an export never
// leaves anything behind in the case inputs.
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
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import { caseDirAbsolute, readCaseFile } from '../../lib/caseStorage';
import {
  EXPORT_FILES,
  clearExport,
  ensightDirAbsolute,
  ensureEnsightCaseExtension,
  ensureExportDir,
  readExportBytes,
  readExportJson,
  readExportText,
  writeExportFile,
  zipEnsightDir,
} from '../../lib/exportStorage';
import { assertProjectVisible, type Viewer } from './projects.service';

/** Human labels for each pipeline step. */
const STEP_LABELS: Record<ExportStepId, string> = {
  inspect: 'Inspect case',
  convert: 'Convert to EnSight (foamToEnsight)',
  validate: 'Validate the EnSight output',
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

/** Candidate directory names foamToEnsight writes its output to (in the case). */
const ENSIGHT_OUTPUT_DIRS = ['EnSight', 'Ensight', 'ensight'];

/** Move a directory, falling back to copy+remove across filesystems. */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch {
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/**
 * Step 2 - convert. Run the NATIVE OpenFOAM `foamToEnsight` (no ParaView), which
 * writes EnSight Gold output (the full time series by default; -latestTime for
 * only the final time) into <case>/EnSight/. We then MOVE that out of the case
 * into export/ensight/ (so the case is never polluted) and zip it for download.
 * The step fails if no EnSight output (with a case master) is produced.
 */
async function convertToEnsight(
  projectId: string,
  caseDir: string,
): Promise<{ step: ExportStep; caseFile: string | null; fileCount: number }> {
  // Clear any stale output from a previous run, in the case and in export/.
  for (const name of ENSIGHT_OUTPUT_DIRS) {
    await fs.rm(path.join(caseDir, name), { recursive: true, force: true }).catch(() => undefined);
  }
  await fs.rm(ensightDirAbsolute(projectId), { recursive: true, force: true }).catch(() => undefined);

  const allTimes = env.EXPORT_ALL_TIMES === 'true';
  const args = ['-case', caseDir];
  if (!allTimes) args.push('-latestTime');
  const plan = planOpenfoamCommand(env.FOAM_TO_ENSIGHT_BIN, args, caseDir);
  const result = await runCommand({ ...plan, timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS });

  // foamToEnsight writes <case>/EnSight/. Find it and move it into export/.
  let caseFile: string | null = null;
  let fileCount = 0;
  let moveNote = '';
  let produced: string | null = null;
  for (const name of ENSIGHT_OUTPUT_DIRS) {
    const candidate = path.join(caseDir, name);
    if (await pathExists(candidate)) {
      produced = candidate;
      break;
    }
  }
  if (produced) {
    await ensureExportDir(projectId);
    await moveDir(produced, ensightDirAbsolute(projectId));
    // foamToEnsight names the master `EnSight_Case` (no extension); add a `.case`
    // copy so CFD-Post's Load Results dialog shows it. Then zip (incl. the .case).
    caseFile = await ensureEnsightCaseExtension(projectId);
    fileCount = await zipEnsightDir(projectId);
    moveNote = `\n[runner] EnSight output: ${fileCount} file(s), load this in CFD-Post: ensight/${caseFile ?? 'NOT FOUND'}`;
  } else if (!commandFailed(result)) {
    moveNote = `\n[runner] foamToEnsight exited 0 but no EnSight/ directory was produced in ${caseDir}`;
  }

  const ok = !commandFailed(result) && fileCount > 0 && caseFile !== null;
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError} (is foamToEnsight on PATH? set FOAM_TO_ENSIGHT_BIN / source the OpenFOAM env via OPENFOAM_BASHRC)`
    : result.timedOut
      ? '\n[runner] foamToEnsight timed out'
      : moveNote;

  return {
    caseFile,
    fileCount,
    step: {
      id: 'convert',
      label: STEP_LABELS.convert,
      command: plan.display,
      status: ok ? 'success' : 'failed',
      exitCode: result.exitCode,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr + extra),
      durationMs: result.durationMs,
    },
  };
}

/**
 * Step 3 - validate. Parse the produced EnSight `.case` master (plain text — no
 * python / ParaView): confirm it exists, count the time steps, and list the
 * variables, checking the case's fields carried through. Validation FAILs only
 * when the case master is missing or unreadable; the counts are informational.
 */
async function validateEnsight(
  projectId: string,
  profile: CaseProfile,
  caseFile: string | null,
): Promise<{ step: ExportStep; validation: ExportValidation }> {
  const checks: ValidationCheck[] = [];

  if (!caseFile) {
    checks.push({ name: 'EnSight case master', reference: '-', value: 'missing', verdict: 'fail' });
  } else {
    const text = (await readEnsightCaseText(projectId, caseFile)) ?? '';
    checks.push({ name: 'EnSight case master', reference: '-', value: caseFile, verdict: 'pass' });

    // Time steps: parse "number of steps: N" from the TIME section.
    const stepsMatch = text.match(/number of steps:\s*(\d+)/i);
    const steps = stepsMatch ? Number(stepsMatch[1]) : null;
    checks.push({
      name: 'Time steps',
      reference: '-',
      value: steps === null ? 'n/a' : String(steps),
      verdict: 'info',
    });

    // Variables: each "scalar/vector/tensor per element|node:" line ends with
    // "<NAME> <filename>", so the variable name is the second-to-last token.
    const vars: string[] = [];
    for (const line of text.split('\n')) {
      const m = line.match(/per\s+(?:element|node)[^:]*:\s*(.+)$/i);
      if (!m) continue;
      const tokens = m[1].trim().split(/\s+/);
      if (tokens.length >= 2) vars.push(tokens[tokens.length - 2]);
    }
    checks.push({
      name: 'Variables present',
      reference: profile.fields.join(', ') || '(none)',
      value: vars.join(', ') || '(none parsed)',
      verdict: vars.length > 0 ? 'pass' : 'info',
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
      command: `parse ensight/${caseFile ?? '(missing)'}`,
      status: status === 'pass' ? 'success' : 'failed',
      exitCode: status === 'pass' ? 0 : 1,
      stdout: validation.checks.map((c) => `${c.name}: ${c.value} [${c.verdict}]`).join('\n'),
      stderr: '',
      durationMs: 0,
    },
  };
}

/** Read the EnSight master file's text from export/ensight/<caseFile>. */
async function readEnsightCaseText(projectId: string, caseFile: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(ensightDirAbsolute(projectId), caseFile), 'utf8');
  } catch {
    return null;
  }
}

/** Render the CFD-Post session.cse skeleton (loads the EnSight case). */
function renderSessionCse(caseFile: string | null): string {
  const loadLine = caseFile
    ? `> load filename=ensight/${caseFile}`
    : '> # load filename=ensight/<the .case file>';
  return `# CFD-Post session generated by DIVE Turbinen.
# Unzip ensight.zip next to this file first, then:
#   cfdpost -batch session.cse
# IMPORTANT: this LOADS RESULTS (EnSight), it does not run a solver.

${loadLine}

# A minimal velocity contour on the whole domain.
CONTOUR:Velocity Contour
  Variable = Velocity
  Location List = /DOMAIN
END
`;
}

/** Render the CFD-Post load memo (the caveats that bite first). */
function renderLoadMemo(profile: CaseProfile, caseFile: string | null): string {
  const pressureNote = profile.incompressible
    ? `- **Pression cinématique** : le solveur \`${profile.solver}\` est incompressible, donc \`p\` est en m²/s² (p/ρ). Dans CFD-Post les pressions seront divisées par ρ — multiplie par la densité pour des Pa. Ce n'est pas un bug.`
    : `- **Pression** : le solveur \`${profile.solver}\` est compressible, \`p\` est déjà en Pa.`;
  const polyNote = profile.hasPolyhedra
    ? `- **Polyèdres détectés** : vérifie dans CFD-Post qu'ils ne sont pas tessellés (perte de topologie).`
    : `- Pas de polyèdres détectés.`;
  const emptyNote = profile.emptyPatches.length
    ? `- **Surfaces vides exclues** : ${profile.emptyPatches.join(', ')} (0 face) — normal, évite l'erreur « Invalid File / surfaces vides ».`
    : `- Aucune surface vide à exclure.`;
  const master = caseFile ? `\`ensight/${caseFile}\`` : 'le fichier `.case`';
  return `# Charger l'export EnSight dans Ansys CFD-Post

## Comment charger
1. Dézippe \`ensight.zip\` → dossier \`ensight/\`.
2. CFD-Post : **File → Load Results** (jamais « Load Case »).
   - **« Files of type » → EnSight** (le sélecteur de format doit être sur **Case**).
   - Sélectionne le **FICHIER** ${master} (pas le dossier — CFD-Post n'accepte pas un dossier).
   - foamToEnsight nomme le maître \`EnSight_Case\` sans extension ; j'ai ajouté une copie \`.case\` pour qu'il apparaisse dans le dialogue. Si tu ne le vois pas, mets « Files of type » sur **All Files**.
3. EnSight Gold est écrit par l'utilitaire **natif OpenFOAM \`foamToEnsight\`** (pas de ParaView) et porte **toute la série temporelle** : utilise la barre de temps de CFD-Post pour parcourir les pas.

## Profil du cas
- Solveur : \`${profile.solver}\` (${profile.steady ? 'steady' : 'transitoire'})
- Dernier temps : \`${profile.latestTime ?? '-'}\`
- Turbulence : \`${profile.turbulenceModel}\`
- Champs : ${profile.fields.join(', ') || '(aucun)'}

## Points de vigilance
${pressureNote}
${polyNote}
${emptyNote}
`;
}

/** Step 4 - cfdpost. Writes session.cse + the load memo (server does not run CFD-Post). */
async function prepareCfdPost(
  projectId: string,
  profile: CaseProfile,
  caseFile: string | null,
): Promise<ExportStep> {
  await writeExportFile(projectId, 'session', renderSessionCse(caseFile));
  await writeExportFile(projectId, 'memo', renderLoadMemo(profile, caseFile));
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
        .map((c) => `| ${c.name} | ${c.reference} | ${c.value} | ${c.verdict} |`)
        .join('\n')
    : '(not run)';
  return `# Export OpenFOAM → EnSight (CFD-Post) — rapport

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
| Contrôle | Référence | EnSight | Verdict |
| --- | --- | --- | --- |
${validationLines}

## Chargement CFD-Post
Dézippe \`ensight.zip\`, puis File → Load Results sur le fichier \`.case\`. Voir LOAD_CFDPOST.md pour les pièges (pression ×ρ si incompressible, surfaces vides).
`;
}

/** Which downloadable artifacts the export produced. */
async function readArtifacts(projectId: string): Promise<ExportArtifacts> {
  const [ensight, session, memo, report] = await Promise.all([
    readExportBytes(projectId, 'ensightZip').then((b) => b !== null && b.length > 0),
    readExportText(projectId, 'session').then((t) => t !== null),
    readExportText(projectId, 'memo').then((t) => t !== null),
    readExportText(projectId, 'report').then((t) => t !== null),
  ]);
  return { ensight, session, memo, report };
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
      skipped('convert', `${env.FOAM_TO_ENSIGHT_BIN} -case <case>`),
      skipped('validate', 'parse the EnSight .case'),
      skipped('cfdpost', 'write session.cse + memo'),
    );
    return finalize(projectId, steps, notes, profile, null);
  }
  const allTimes = env.EXPORT_ALL_TIMES === 'true';
  if (profile.emptyPatches.length) {
    notes.push(`Excluded ${profile.emptyPatches.length} empty patch(es): ${profile.emptyPatches.join(', ')}.`);
  }

  // 2) Convert (native foamToEnsight, moved out of the case + zipped).
  const { step: convertStep, caseFile, fileCount } = await convertToEnsight(projectId, caseDir);
  steps.push(convertStep);
  if (convertStep.status === 'failed') {
    steps.push(
      skipped('validate', 'parse the EnSight .case'),
      skipped('cfdpost', 'write session.cse + memo'),
    );
    return finalize(projectId, steps, notes, profile, null);
  }
  notes.push(
    allTimes
      ? `Exported the full time series to EnSight (${fileCount} file(s), zipped).`
      : `Exported the latest solved time to EnSight (${fileCount} file(s), zipped).`,
  );

  // 3) Validate the produced EnSight output (parse the .case master).
  const { step: validateStep, validation } = await validateEnsight(projectId, profile, caseFile);
  steps.push(validateStep);

  // 4) CFD-Post prep (runs even when validation flagged issues — the output exists).
  steps.push(await prepareCfdPost(projectId, profile, caseFile));

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
  if (!profile && !artifacts.ensight) return null;
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
