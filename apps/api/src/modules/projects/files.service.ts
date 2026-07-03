// Case-files business logic for a project's OpenFOAM case directory.
//
// Access model: every operation requires the viewer to be able to *see* the
// project (owner, collaborator, or super-admin) — the same visibility rule the
// projects service enforces. Members may both read and contribute case files;
// project management (delete, collaborators) remains owner/super-admin only and
// lives in projects.service.
import {
  EDITABLE_FILE_MAX_BYTES,
  SOLVER_CATALOG,
  SOLVER_LIBRARY,
  TURBULENCE_FIELD_NAMES,
  TURBULENCE_MODELS,
  isConfigurableSolver,
  turbulenceFieldsFor,
  type ConfigurableSolverId,
  type SolverId,
} from '@dive/shared';
import { AppError } from '../../lib/AppError';
import {
  caseFileExists,
  caseIsEmpty,
  clearCase,
  deleteCaseDir,
  deleteCaseFile,
  extractArchive,
  listCaseTree,
  moveCasePath,
  readCaseFile,
  writeCaseFile,
  writeUploadedFiles,
  zipCase,
  type CaseEntry,
} from '../../lib/caseStorage';
import { sanitizeRelative } from '../../lib/fileTreeStorage';
import {
  BASE_FILE_PATHS,
  BOUNDARY_FILE,
  MESH_FILES,
  fieldBcBody,
  getFieldPatchType,
  mergeFieldBoundary,
  parseApplication,
  parseBoundaryPatchesWithTypes,
  parseTurbulenceModel,
  rebuildFieldBoundary,
  renderBaseFile,
  renderSolverFile,
  renderTurbulenceProperties,
  setApplication,
  setFieldPatchBc,
  type BoundaryPatch,
} from '../../lib/openfoamCase';
import { assertProjectVisible, type Viewer } from './projects.service';

/** Result of verifying which mandatory files a case has. */
export interface CaseVerification {
  /** All five constant/polyMesh/ mesh files are present. */
  hasMesh: boolean;
  /** Mesh files still absent (cannot be generated — they come from the import). */
  missingMesh: string[];
  /** Scaffoldable base files already present. */
  presentBase: string[];
  /** Scaffoldable base files still absent (what "create them" would generate). */
  missingBase: string[];
  /** No base files are missing. */
  complete: boolean;
  /** At least one base file is missing, so scaffolding has something to do. */
  canScaffold: boolean;
}

/** A folder upload: one file with its (browser) relative path and bytes. */
export interface UploadedFile {
  relativePath: string;
  data: Buffer;
}

/** Either an archive (single .zip) or a set of folder files. */
export interface ImportPayload {
  archive?: Buffer;
  files?: UploadedFile[];
}

/** Result of an import: what was written plus the refreshed tree. */
export interface ImportResult {
  written: string[];
  entries: CaseEntry[];
}

/** Result of a scaffold: what was created plus the refreshed report and tree. */
export interface ScaffoldResult {
  created: string[];
  verification: CaseVerification;
  entries: CaseEntry[];
}

/** A single case file's text content. */
export interface CaseFileContent {
  path: string;
  content: string;
  size: number;
}

/** List the case tree (empty until something is imported). */
export async function getCaseFiles(viewer: Viewer, projectId: string): Promise<CaseEntry[]> {
  await assertProjectVisible(viewer, projectId);
  return listCaseTree(projectId);
}

/** Import a folder or a .zip into the project's case tree. */
export async function importCaseFiles(
  viewer: Viewer,
  projectId: string,
  payload: ImportPayload,
): Promise<ImportResult> {
  await assertProjectVisible(viewer, projectId);

  let written: string[];
  if (payload.archive) {
    written = await extractArchive(projectId, payload.archive);
  } else if (payload.files && payload.files.length > 0) {
    written = await writeUploadedFiles(
      projectId,
      payload.files.map((f) => ({ relativePath: f.relativePath, data: f.data })),
    );
  } else {
    throw new AppError(400, 'NO_FILES_UPLOADED', 'No files were uploaded');
  }

  const entries = await listCaseTree(projectId);
  return { written, entries };
}

/** Remove every imported case file (the "Reset" action). Returns the now-empty tree. */
export async function resetCase(viewer: Viewer, projectId: string): Promise<ImportResult> {
  await assertProjectVisible(viewer, projectId);
  await clearCase(projectId);
  return { written: [], entries: await listCaseTree(projectId) };
}

/** Build a .zip of the whole case for download. @throws 404 if the case is empty. */
export async function buildCaseArchive(viewer: Viewer, projectId: string): Promise<Buffer> {
  await assertProjectVisible(viewer, projectId);
  if (await caseIsEmpty(projectId)) {
    throw new AppError(404, 'NOT_FOUND', 'This project has no files to download');
  }
  return zipCase(projectId);
}

/** Compute the mandatory-file report for a case. */
async function computeVerification(projectId: string): Promise<CaseVerification> {
  const meshPresence = await Promise.all(MESH_FILES.map((file) => caseFileExists(projectId, file)));
  const missingMesh = MESH_FILES.filter((_, i) => !meshPresence[i]);

  const basePresence = await Promise.all(
    BASE_FILE_PATHS.map((file) => caseFileExists(projectId, file)),
  );
  const presentBase = BASE_FILE_PATHS.filter((_, i) => basePresence[i]);
  const missingBase = BASE_FILE_PATHS.filter((_, i) => !basePresence[i]);

  return {
    hasMesh: missingMesh.length === 0,
    missingMesh,
    presentBase,
    missingBase,
    complete: missingBase.length === 0,
    canScaffold: missingBase.length > 0,
  };
}

/** Verify which mandatory files the case has (the "Suivant" check). */
export async function verifyCase(viewer: Viewer, projectId: string): Promise<CaseVerification> {
  await assertProjectVisible(viewer, projectId);
  return computeVerification(projectId);
}

/**
 * Generate the missing mandatory base files (the overlay's "Yes" action). The
 * 0/ fields reference the patches discovered in constant/polyMesh/boundary, so
 * the generated case stays coherent with the imported mesh. Existing files are
 * never overwritten.
 */
export async function scaffoldCase(viewer: Viewer, projectId: string): Promise<ScaffoldResult> {
  await assertProjectVisible(viewer, projectId);

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  const patches = boundary ? parseBoundaryPatchesWithTypes(boundary.toString('utf8')) : [];

  const created: string[] = [];
  for (const file of BASE_FILE_PATHS) {
    if (await caseFileExists(projectId, file)) continue;
    await writeCaseFile(projectId, file, renderBaseFile(file, patches));
    created.push(file);
  }

  const [verification, entries] = await Promise.all([
    computeVerification(projectId),
    listCaseTree(projectId),
  ]);
  return { created, verification, entries };
}

/** The pristine-initial-conditions directory OpenFOAM keeps alongside `0`. */
const ORIG_DIR = '0.orig/';

/**
 * OpenFOAM keeps a pristine `0.orig` and runs from a copy in `0` (mesh utilities
 * can clobber `0`, so the clean fields live in `0.orig`). When a case has
 * `0.orig/` files but no `0/`, seed `0/` from `0.orig/` — keeping `0.orig/`
 * untouched — so the solver has initial conditions to run from. No-op when `0/`
 * already exists or there is no `0.orig/`. Returns the files created in `0/`.
 */
async function ensureZeroFromOrig(projectId: string): Promise<string[]> {
  const tree = await listCaseTree(projectId);
  const hasZero = tree.some((entry) => entry.path === '0' || entry.path.startsWith('0/'));
  if (hasZero) return [];
  const origFiles = tree.filter(
    (entry) => entry.type === 'file' && entry.path.startsWith(ORIG_DIR),
  );
  if (origFiles.length === 0) return [];

  const seeded: string[] = [];
  for (const entry of origFiles) {
    const dest = `0/${entry.path.slice(ORIG_DIR.length)}`;
    const buffer = await readCaseFile(projectId, entry.path);
    if (buffer) {
      await writeCaseFile(projectId, dest, buffer);
      seeded.push(dest);
    }
  }
  return seeded;
}

/** Whether a case is ready to be run by simpleFoam, and what is missing if not. */
export interface RunnableCheck {
  /** All five constant/polyMesh/ mesh files are present. */
  hasMesh: boolean;
  /** Mesh files still absent (cannot be generated — they come from the import). */
  missingMesh: string[];
  /** Required solver files still absent (what "make runnable" would generate). */
  missingFiles: string[];
  /** Mesh present AND every required solver file present. */
  runnable: boolean;
  /** Solver read from system/controlDict `application`, or null when unset. */
  solver: string | null;
  /**
   * Whether the resolved solver is one the app fully scaffolds and easy-configures
   * (simpleFoam / pimpleFoam / rho*). False for any other library solver, which is
   * "manual setup": selectable + runnable best-effort, configured via the file editor.
   */
  scaffoldable: boolean;
}

/** Result of generating the missing simpleFoam files: created + refreshed state. */
export interface ScaffoldSolverResult {
  created: string[];
  /** 0/ turbulence fields removed because the chosen model does not read them
   * (e.g. a stale 0/omega dropped when switching to k-epsilon). */
  removed: string[];
  runnable: RunnableCheck;
  entries: CaseEntry[];
}

/** The 0/ turbulence field paths, any of which a model may or may not read. */
const TURBULENCE_FIELD_PATHS = TURBULENCE_FIELD_NAMES.map((field) => `0/${field}`);

/**
 * The files a case needs to be runnable by a solver whose base file set is
 * `baseRequired`, specialised to the turbulence `model`: the non-turbulence files
 * unchanged, plus EXACTLY the 0/ turbulence fields the model reads (k-epsilon →
 * k/epsilon/nut, k-omega → k/omega/nut, laminar → none). So the gate never demands
 * a stale 0/omega for a k-epsilon case (which would leave a correctly-cleaned case
 * wrongly reported NOT_RUNNABLE).
 */
function requiredFilesForModel(baseRequired: readonly string[], model: string): string[] {
  const turbSet = new Set(TURBULENCE_FIELD_PATHS);
  const nonTurb = baseRequired.filter((file) => !turbSet.has(file));
  const turb = turbulenceFieldsFor(model).map((field) => `0/${field}`);
  return [...nonTurb, ...turb];
}

/**
 * The case's turbulence model, read from constant/turbulenceProperties, or the
 * k-omega default when absent/unparseable (the app's default family). Drives which
 * 0/ turbulence fields and wall functions the generator and the gate expect.
 */
async function caseTurbulenceModel(projectId: string): Promise<string> {
  const turb = await readCaseFile(projectId, 'constant/turbulenceProperties');
  const parsed = turb ? parseTurbulenceModel(turb.toString('utf8')) : null;
  return parsed ?? 'kOmegaSST';
}

/** Wall-patch field BCs the app manages automatically (safe to refresh on a model
 * switch): a generic zeroGradient, noSlip, or any wall function. A custom BC (a
 * specific fixedValue, calculated, etc.) is left untouched. */
function isAutoManagedWallBc(bc: string): boolean {
  return bc === 'zeroGradient' || bc === 'noSlip' || bc.includes('WallFunction');
}

/**
 * Refresh the wall-patch entries of a RETAINED turbulence field to the current
 * model's wall function, so switching model updates them even on fields kept from
 * the previous model — e.g. k-omega -> Spalart-Allmaras changes nut from
 * nutkWallFunction to nutUSpaldingWallFunction (no k). Only auto-managed wall BCs
 * are rewritten (see isAutoManagedWallBc); a user's custom wall BC is preserved.
 * Idempotent: a same-model re-scaffold produces identical text. Pure text.
 */
function refreshWallBcs(
  text: string,
  fieldName: string,
  wallPatches: BoundaryPatch[],
  model: string,
): string {
  let out = text;
  for (const patch of wallPatches) {
    const current = getFieldPatchType(out, patch.name);
    if (current === null || !isAutoManagedWallBc(current)) continue;
    out = setFieldPatchBc(out, patch.name, fieldBcBody(fieldName, 'wall', model));
  }
  return out;
}

/**
 * Compute the runnable report for a case (no access check — callers that have
 * already asserted visibility, e.g. the run service, use this directly).
 */
export async function computeRunnable(projectId: string): Promise<RunnableCheck> {
  const meshPresence = await Promise.all(MESH_FILES.map((file) => caseFileExists(projectId, file)));
  const missingMesh = MESH_FILES.filter((_, i) => !meshPresence[i]);

  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  const solver = controlDict ? parseApplication(controlDict.toString('utf8')) : null;
  // The chosen turbulence model decides which 0/ turbulence fields are required
  // (k-epsilon needs epsilon not omega; laminar needs none), so the gate matches
  // exactly what scaffoldSolver writes for that model.
  const model = await caseTurbulenceModel(projectId);

  // Three tiers of gate, by what the app knows about the solver:
  //  1. configurable (simpleFoam/pimpleFoam/rho*): fully scaffolded + easy-configured,
  //     so check its exact required files AND solver-correct system/ numerics.
  //  2. known but not configurable (any other ESI library solver, e.g. interFoam): the
  //     app cannot auto-scaffold its solver-specific files, so it is best-effort — the
  //     user sets those up by hand; we only require a mesh and a system/ trio to run it.
  //  3. `foamRun` placeholder / unknown / unset: not runnable; the gate offers to pick a solver.
  const target = solver && isConfigurableSolver(solver) ? solver : null;
  const known = solver && SOLVER_LIBRARY.some((info) => info.id === solver);

  if (target) {
    const requiredFiles = requiredFilesForModel(SOLVER_CATALOG[target].requiredFiles, model);
    const presence = await Promise.all(requiredFiles.map((file) => caseFileExists(projectId, file)));
    const missingFiles = requiredFiles.filter((_, i) => !presence[i]);
    const systemRepairs = await Promise.all(
      [...SYSTEM_NUMERICS_FILES].map((file) => systemNumericsNeedsRepair(projectId, file, target)),
    );
    const numericsReady = systemRepairs.every((needsRepair) => !needsRepair);
    return {
      hasMesh: missingMesh.length === 0,
      missingMesh,
      missingFiles,
      runnable: missingMesh.length === 0 && missingFiles.length === 0 && numericsReady,
      solver,
      scaffoldable: true,
    };
  }

  if (known) {
    // Best-effort: a real solver the app cannot auto-scaffold. Require the mesh and a
    // system/ trio; trust the user for the solver-specific 0/ + constant/ files.
    const trio = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'];
    const presence = await Promise.all(trio.map((file) => caseFileExists(projectId, file)));
    const missingFiles = trio.filter((_, i) => !presence[i]);
    return {
      hasMesh: missingMesh.length === 0,
      missingMesh,
      missingFiles,
      runnable: missingMesh.length === 0 && missingFiles.length === 0,
      solver,
      scaffoldable: false,
    };
  }

  // foamRun / unknown / unset: not runnable. Guide against the default (simpleFoam) set.
  const requiredFiles = requiredFilesForModel(SOLVER_CATALOG.simpleFoam.requiredFiles, model);
  const presence = await Promise.all(requiredFiles.map((file) => caseFileExists(projectId, file)));
  const missingFiles = requiredFiles.filter((_, i) => !presence[i]);
  return {
    hasMesh: missingMesh.length === 0,
    missingMesh,
    missingFiles,
    runnable: false,
    solver,
    scaffoldable: false,
  };
}

/** Verify whether a case is runnable by simpleFoam (drives the Solver tab gate). */
export async function verifyRunnable(viewer: Viewer, projectId: string): Promise<RunnableCheck> {
  await assertProjectVisible(viewer, projectId);
  return computeRunnable(projectId);
}

/** The system/ numerics that must be simpleFoam-correct (not generic placeholders). */
const SYSTEM_NUMERICS_FILES = new Set<string>([
  'system/controlDict',
  'system/fvSchemes',
  'system/fvSolution',
]);

/**
 * Does a system/ numerics file need to be (re)written for `solver`? True when it
 * is missing, still a generic placeholder, or written for the *other* solver's
 * algorithm — detected by markers that differ steady vs transient:
 *  - fvSolution: needs a pressure reference (pRefCell/pRefPoint — without it the
 *    solver aborts on a closed domain), AND the target algorithm dictionary
 *    (`SIMPLE` for steady, `PIMPLE` for transient).
 *  - fvSchemes: needs a real divergence scheme (the base scaffold writes
 *    `div none`), AND a regime-correct time scheme (steady = `steadyState`,
 *    transient must NOT be `steadyState`).
 *  - controlDict: application must equal `solver`, with a regime-appropriate
 *    endTime (steady runs many iterations so `> 1`; transient any positive time).
 * Marker-guarded so a second "Make runnable" for the same solver is a no-op and a
 * real imported case is never overwritten, while switching solver re-renders the
 * trio for the new algorithm.
 */
async function systemNumericsNeedsRepair(
  projectId: string,
  file: string,
  solver: ConfigurableSolverId,
): Promise<boolean> {
  const buffer = await readCaseFile(projectId, file);
  if (!buffer) return true;
  const content = buffer.toString('utf8');
  const spec = SOLVER_CATALOG[solver];
  const transient = spec.regime === 'transient';
  const incompressible = spec.family === 'incompressible';

  if (file === 'system/fvSolution') {
    // Incompressible closed domains need a pressure reference; compressible p is
    // absolute (Pa) with a real value, so no pRef is required there.
    if (incompressible && !/pRef(Cell|Point)/.test(content)) return true;
    if (transient ? !/\bPIMPLE\b/.test(content) : !/\bSIMPLE\b/.test(content)) return true;
    // Family marker: a compressible setup carries a `rho` solver / relaxation entry.
    // Its presence/absence flips the trio when the family is switched.
    const hasRho = /\brho\b/.test(content);
    return incompressible ? hasRho : !hasRho;
  }
  if (file === 'system/fvSchemes') {
    if (!/\bdiv\(phi,U\)/.test(content)) return true;
    // Steady needs a steadyState time scheme; transient must NOT use steadyState.
    const steadyDdt = /default\s+steadyState/.test(content);
    if (transient ? steadyDdt : !steadyDdt) return true;
    // Family marker: a compressible setup carries the energy convection term.
    const hasEnergy = /div\(phi,e\)/.test(content);
    return incompressible ? hasEnergy : !hasEnergy;
  }
  // system/controlDict
  if (parseApplication(content) !== solver) return true;
  const match = content.match(/\bendTime\s+([0-9.eE+-]+)\s*;/);
  const endTime = match ? Number(match[1]) : 0;
  if (!Number.isFinite(endTime)) return true;
  return transient ? endTime <= 0 : endTime <= 1;
}

/**
 * Does 0/p need to be (re)written for `solver`'s family? Incompressible p is
 * KINEMATIC ([0 2 -2 …], i.e. p/rho); compressible p is ABSOLUTE pressure in Pa
 * ([1 -1 -2 …]). True when 0/p is missing or its dimensions belong to the OTHER
 * family, so switching a case between incompressible and compressible re-renders p
 * with the right dimensions (the other 0/ fields are shared or additive).
 */
async function pFieldNeedsRepair(
  projectId: string,
  solver: ConfigurableSolverId,
): Promise<boolean> {
  const buffer = await readCaseFile(projectId, '0/p');
  if (!buffer) return true;
  const content = buffer.toString('utf8');
  const compressible = SOLVER_CATALOG[solver].family === 'compressible';
  const hasAbsolute = /\[\s*1\s+-1\s+-2\b/.test(content);
  return compressible ? !hasAbsolute : hasAbsolute;
}

/**
 * Generate the files a case needs to be runnable by `solver` (the "Make runnable"
 * action; `solver` defaults to simpleFoam). The 0/ fields and constant/*Properties
 * are written only when missing, so user-set boundary conditions / property values
 * are kept (simpleFoam and pimpleFoam share the same incompressible-RANS set). The
 * system/ numerics (controlDict / fvSchemes / fvSolution) are instead REPAIRED when
 * they are generic placeholders (e.g. from the conversion flow) OR written for the
 * other solver's algorithm — so switching solver re-renders the trio (steady SIMPLE
 * <-> transient PIMPLE). The repair is marker-guarded, so a real imported case or a
 * second call for the same solver is left untouched.
 *
 * For a solver the app does NOT fully template (any library solver outside
 * SOLVER_CATALOG, e.g. interFoam), it only writes a generic skeleton (the system
 * trio + 0/{U,p}) and points controlDict at that solver; the user completes the
 * solver-specific files in the editor.
 */
export async function scaffoldSolver(
  viewer: Viewer,
  projectId: string,
  solver: SolverId = 'simpleFoam',
  turbulence?: string,
): Promise<ScaffoldSolverResult> {
  await assertProjectVisible(viewer, projectId);

  // Run from a copy of 0.orig when the case uses that convention and has no 0/
  // yet, so the template's initial conditions seed 0/ instead of generic ones.
  await ensureZeroFromOrig(projectId);

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  const patches = boundary ? parseBoundaryPatchesWithTypes(boundary.toString('utf8')) : [];

  // The effective turbulence model drives which 0/ fields and wall functions we
  // write: the wizard's explicit choice, else the case's current model (so a
  // "change solver" call preserves it), else the k-omega default. An unknown id
  // (should never reach here — the route validates) falls back to k-omega.
  const existingTurb = await readCaseFile(projectId, 'constant/turbulenceProperties');
  let model =
    turbulence ??
    (existingTurb ? parseTurbulenceModel(existingTurb.toString('utf8')) : null) ??
    'kOmegaSST';
  if (!TURBULENCE_MODELS.some((entry) => entry.id === model)) model = 'kOmegaSST';
  const simulationType =
    TURBULENCE_MODELS.find((entry) => entry.id === model)?.simulationType ?? 'RAS';
  const modelFields = turbulenceFieldsFor(model);

  const created: string[] = [];
  const removed: string[] = [];

  if (!isConfigurableSolver(solver)) {
    // Manual solver: write a generic skeleton and point controlDict at it. The user
    // completes the solver-specific 0/ + constant/ files in the editor afterwards.
    for (const file of BASE_FILE_PATHS) {
      if (await caseFileExists(projectId, file)) continue;
      await writeCaseFile(projectId, file, renderBaseFile(file, patches));
      created.push(file);
    }
    const controlDict = await readCaseFile(projectId, 'system/controlDict');
    if (controlDict) {
      const content = controlDict.toString('utf8');
      const next = setApplication(content, solver);
      if (next !== content) {
        await writeCaseFile(projectId, 'system/controlDict', next);
        if (!created.includes('system/controlDict')) created.push('system/controlDict');
      }
    }
    if (turbulence) {
      await writeCaseFile(
        projectId,
        'constant/turbulenceProperties',
        renderTurbulenceProperties(simulationType, model),
      );
      if (!created.includes('constant/turbulenceProperties')) {
        created.push('constant/turbulenceProperties');
      }
    }
    const [runnable, entries] = await Promise.all([
      computeRunnable(projectId),
      listCaseTree(projectId),
    ]);
    return { created, removed, runnable, entries };
  }

  for (const file of SOLVER_CATALOG[solver].requiredFiles) {
    // Turbulence-dependent files are written model-aware below: turbulenceProperties
    // for the chosen model, and ONLY the 0/ turbulence fields that model reads.
    if (file === 'constant/turbulenceProperties') continue;
    if (TURBULENCE_FIELD_PATHS.includes(file)) continue;
    if (SYSTEM_NUMERICS_FILES.has(file)) {
      if (await systemNumericsNeedsRepair(projectId, file, solver)) {
        await writeCaseFile(projectId, file, renderSolverFile(solver, file, patches, model));
        created.push(file);
      }
      continue;
    }
    // 0/p is family-sensitive (kinematic vs absolute Pa): rewrite it when missing OR
    // when its dimensions belong to the other family, so switching incompressible <->
    // compressible fixes the pressure field.
    if (file === '0/p') {
      if (await pFieldNeedsRepair(projectId, solver)) {
        await writeCaseFile(projectId, file, renderSolverFile(solver, file, patches, model));
        created.push(file);
      }
      continue;
    }
    // Other 0/ fields + constant/*Properties: keep what the user has, add what is missing.
    if (await caseFileExists(projectId, file)) continue;
    await writeCaseFile(projectId, file, renderSolverFile(solver, file, patches, model));
    created.push(file);
  }

  // Belt and suspenders: make sure controlDict targets the chosen solver even if
  // the repair check above kept it (idempotent no-op when already correct).
  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  if (controlDict) {
    const content = controlDict.toString('utf8');
    const next = setApplication(content, solver);
    if (next !== content) await writeCaseFile(projectId, 'system/controlDict', next);
  }

  // Turbulence model file — written for the effective model (wizard choice, or the
  // case's current/default model). Idempotent: unchanged content is not rewritten.
  {
    const content = renderTurbulenceProperties(simulationType, model);
    if (!existingTurb || existingTurb.toString('utf8') !== content) {
      await writeCaseFile(projectId, 'constant/turbulenceProperties', content);
      if (!created.includes('constant/turbulenceProperties')) {
        created.push('constant/turbulenceProperties');
      }
    }
  }

  // Turbulence 0/ fields, model-driven: write EXACTLY the fields the chosen model
  // reads (with the model-aware wall functions on the mesh's wall patches), REFRESH
  // the wall BCs of a retained field to the current model (so switching model updates
  // e.g. nut's wall function), and REMOVE the fields the model does not read — so a
  // k-epsilon case ships k/epsilon/nut and no stale 0/omega (from both 0/ and 0.orig/).
  const wallPatches = patches.filter((patch) => patch.type === 'wall');
  for (const field of modelFields) {
    const path = `0/${field}`;
    if (!(await caseFileExists(projectId, path))) {
      await writeCaseFile(projectId, path, renderSolverFile(solver, path, patches, model));
      created.push(path);
      continue;
    }
    // Retained field: refresh its wall functions to the current model (idempotent
    // when the model is unchanged). Do not push to `created` — the file already existed.
    if (wallPatches.length === 0) continue;
    const buffer = await readCaseFile(projectId, path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    const next = refreshWallBcs(text, field, wallPatches, model);
    if (next !== text) await writeCaseFile(projectId, path, next);
  }
  for (const field of TURBULENCE_FIELD_NAMES) {
    if (modelFields.includes(field)) continue;
    for (const path of [`0/${field}`, `${ORIG_DIR}${field}`]) {
      if (await caseFileExists(projectId, path)) {
        await deleteCaseFile(projectId, path);
        removed.push(path);
      }
    }
  }

  const [runnable, entries] = await Promise.all([
    computeRunnable(projectId),
    listCaseTree(projectId),
  ]);
  return { created, removed, runnable, entries };
}

/** Result of syncing boundaryFields to the mesh: which files changed + the patches. */
export interface SyncBoundariesResult {
  /** Field files whose boundaryField was rewritten. */
  updated: string[];
  /** The mesh patches (name + geometric type) the fields were aligned to. */
  patches: BoundaryPatch[];
  /** Refreshed case tree. */
  entries: CaseEntry[];
}

/** How syncBoundaryFields reconciles each field's boundaryField with the mesh. */
export interface SyncBoundaryOptions {
  /**
   * 'rebuild' (default): replace every field's boundaryField with a fresh block
   * covering exactly the mesh patches (existing BCs discarded) — the right choice
   * after a merge that renamed patches (m1_/m2_). 'merge': keep every existing BC
   * whose patch still exists and only ADD entries for new patches — used when
   * building onto the project case mesh (Assembly v2) so its physics is preserved.
   */
  mode?: 'rebuild' | 'merge';
}

/**
 * Apply the mesh boundary (patch names AND geometric types) to every field's
 * boundaryField, so the 0/ files cover exactly the mesh patches with a valid BC
 * per type. For a polyMesh imported then scaffolded or given a template, this is
 * what makes the case actually runnable (a template brings its own patch names;
 * the scaffold ignores the geometric type). In the default 'rebuild' mode every
 * boundaryField is regenerated (existing BCs discarded); in 'merge' mode the
 * existing BCs are preserved and only new patches get generic defaults (both modes
 * now emit the nonConformalCyclic / nonConformalError couple entries too, since
 * those are constraint types). The render is unaffected (only the 0/ fields
 * change). @throws 409 NO_MESH when there is no boundary file.
 */
export async function syncBoundaryFields(
  viewer: Viewer,
  projectId: string,
  options?: SyncBoundaryOptions,
): Promise<SyncBoundariesResult> {
  await assertProjectVisible(viewer, projectId);
  const mode = options?.mode ?? 'rebuild';

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  if (!boundary) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  const patches = parseBoundaryPatchesWithTypes(boundary.toString('utf8'));
  // Apply the case's turbulence model so a wall patch gets the model's wall function
  // (nutkWallFunction / kqRWallFunction / …) on every field, not a bare zeroGradient.
  const model = await caseTurbulenceModel(projectId);

  // Seed 0/ from 0.orig/ first when needed, then sync the runnable fields and
  // leave 0.orig/ pristine.
  await ensureZeroFromOrig(projectId);

  const updated: string[] = [];
  const tree = await listCaseTree(projectId);
  for (const entry of tree) {
    if (entry.type !== 'file') continue;
    if (entry.path.startsWith('constant/polyMesh/')) continue;
    if (entry.path.startsWith(ORIG_DIR)) continue; // keep 0.orig pristine
    if (entry.size > EDITABLE_FILE_MAX_BYTES) continue;
    const buffer = await readCaseFile(projectId, entry.path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    if (!text.includes('boundaryField')) continue;
    const fieldName = entry.path.split('/').pop() ?? entry.path;
    const next =
      mode === 'merge'
        ? mergeFieldBoundary(text, fieldName, patches, model)
        : rebuildFieldBoundary(text, fieldName, patches, model);
    if (next !== text) {
      await writeCaseFile(projectId, entry.path, next);
      updated.push(entry.path);
    }
  }

  return { updated, patches, entries: await listCaseTree(projectId) };
}

/**
 * Read a single case file's content for the in-app editor.
 * @throws 404 NOT_FOUND if the file does not exist, 413 FILE_TOO_LARGE if it
 *         exceeds the editable size cap.
 */
export async function readCaseFileContent(
  viewer: Viewer,
  projectId: string,
  relPath: string,
): Promise<CaseFileContent> {
  await assertProjectVisible(viewer, projectId);

  const buffer = await readCaseFile(projectId, relPath);
  if (!buffer) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  if (buffer.length > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'This file is too large to edit in the browser');
  }
  return { path: relPath, content: buffer.toString('utf8'), size: buffer.length };
}

/**
 * Save edited content back to an existing case file. Editing only: the file
 * must already exist (creation happens via import/scaffold, not the editor).
 * @throws 404 NOT_FOUND if the file does not exist, 413 FILE_TOO_LARGE if the
 *         new content exceeds the editable size cap.
 */
export async function saveCaseFileContent(
  viewer: Viewer,
  projectId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  await assertProjectVisible(viewer, projectId);

  if (!(await caseFileExists(projectId, relPath))) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The edited content is too large to save');
  }
  await writeCaseFile(projectId, relPath, content);
  return { path: relPath, size };
}

/**
 * Create a new, empty case file from the editor.
 * @throws 409 FILE_EXISTS if a file already exists at that path, 413
 *         FILE_TOO_LARGE if the optional initial content exceeds the cap.
 */
export async function createCaseFile(
  viewer: Viewer,
  projectId: string,
  relPath: string,
  content = '',
): Promise<{ path: string; entries: CaseEntry[] }> {
  await assertProjectVisible(viewer, projectId);

  const safePath = sanitizeRelative(relPath);
  if (await caseFileExists(projectId, safePath)) {
    throw new AppError(409, 'FILE_EXISTS', 'A file already exists at that path');
  }
  if (Buffer.byteLength(content, 'utf8') > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The file content is too large to create here');
  }

  await writeCaseFile(projectId, safePath, content);
  return { path: safePath, entries: await listCaseTree(projectId) };
}

/**
 * Delete a single case file from the editor. Returns the refreshed tree.
 * @throws 404 NOT_FOUND if the file does not exist.
 */
export async function deleteCaseFileContent(
  viewer: Viewer,
  projectId: string,
  relPath: string,
): Promise<{ entries: CaseEntry[] }> {
  await assertProjectVisible(viewer, projectId);

  if (!(await caseFileExists(projectId, relPath))) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  await deleteCaseFile(projectId, relPath);
  return { entries: await listCaseTree(projectId) };
}

/**
 * Delete a whole case directory subtree from the editor. Returns the refreshed
 * tree. @throws 404 NOT_FOUND if the folder does not exist.
 */
export async function deleteCaseDirContent(
  viewer: Viewer,
  projectId: string,
  relPath: string,
): Promise<{ entries: CaseEntry[] }> {
  await assertProjectVisible(viewer, projectId);
  await deleteCaseDir(projectId, relPath);
  return { entries: await listCaseTree(projectId) };
}

/**
 * Move (or rename) a case file or directory within the tree. Returns the
 * refreshed tree.
 * @throws 404 NOT_FOUND (source absent), 409 FILE_EXISTS (destination taken),
 *         400 VALIDATION_ERROR (moving a folder into itself).
 */
export async function moveCaseEntry(
  viewer: Viewer,
  projectId: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string; entries: CaseEntry[] }> {
  await assertProjectVisible(viewer, projectId);
  const result = await moveCasePath(projectId, from, to);
  return { from: result.from, to: result.to, entries: await listCaseTree(projectId) };
}
