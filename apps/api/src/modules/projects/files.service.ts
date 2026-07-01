// Case-files business logic for a project's OpenFOAM case directory.
//
// Access model: every operation requires the viewer to be able to *see* the
// project (owner, collaborator, or super-admin) — the same visibility rule the
// projects service enforces. Members may both read and contribute case files;
// project management (delete, collaborators) remains owner/super-admin only and
// lives in projects.service.
import { EDITABLE_FILE_MAX_BYTES } from '@dive/shared';
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
  SOLVER_FILE_PATHS,
  mergeFieldBoundary,
  parseApplication,
  parseBoundaryPatches,
  parseBoundaryPatchesWithTypes,
  rebuildFieldBoundary,
  renderBaseFile,
  renderSolverFile,
  setApplication,
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
  const patches = boundary ? parseBoundaryPatches(boundary.toString('utf8')) : [];

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
}

/** Result of generating the missing simpleFoam files: created + refreshed state. */
export interface ScaffoldSolverResult {
  created: string[];
  runnable: RunnableCheck;
  entries: CaseEntry[];
}

/**
 * Compute the runnable report for a case (no access check — callers that have
 * already asserted visibility, e.g. the run service, use this directly).
 */
export async function computeRunnable(projectId: string): Promise<RunnableCheck> {
  const meshPresence = await Promise.all(MESH_FILES.map((file) => caseFileExists(projectId, file)));
  const missingMesh = MESH_FILES.filter((_, i) => !meshPresence[i]);

  const presence = await Promise.all(
    SOLVER_FILE_PATHS.map((file) => caseFileExists(projectId, file)),
  );
  const missingFiles = SOLVER_FILE_PATHS.filter((_, i) => !presence[i]);

  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  const solver = controlDict ? parseApplication(controlDict.toString('utf8')) : null;

  // Even when every file is present, the system/ numerics must be simpleFoam-ready
  // (not a generic placeholder), or the run aborts at solve time (e.g. an
  // fvSolution without pRefCell). Detect generic numerics so the gate re-offers
  // "Make runnable" (which repairs them), keeping the whole thing self-healing.
  const systemRepairs = await Promise.all(
    [...SYSTEM_NUMERICS_FILES].map((file) => systemNumericsNeedsRepair(projectId, file)),
  );
  const numericsReady = systemRepairs.every((needsRepair) => !needsRepair);

  // v1 runs simpleFoam end to end, and the scaffolded turbulence/transport files
  // are written for it. A case targeting another application (e.g. the generic
  // `foamRun` the conversion flow writes) is NOT runnable here.
  return {
    hasMesh: missingMesh.length === 0,
    missingMesh,
    missingFiles,
    runnable:
      missingMesh.length === 0 &&
      missingFiles.length === 0 &&
      solver === 'simpleFoam' &&
      numericsReady,
    solver,
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
 * Does a system/ numerics file need to be (re)written for simpleFoam? True when
 * it is missing or still a generic placeholder, detected by the marker that
 * simpleFoam requires and the base scaffold omits:
 *  - fvSolution: a pressure reference (pRefCell/pRefPoint) — without it simpleFoam
 *    aborts on a closed domain ("Unable to set reference cell for field p").
 *  - fvSchemes: a real divergence scheme (the base scaffold writes `div none`).
 *  - controlDict: application=simpleFoam and a non-trivial endTime (the base
 *    scaffold writes `application foamRun; endTime 1;`, which runs one step).
 * Marker-guarded so a second "Make runnable" is a no-op, and a real imported case
 * (which already has these markers) is never overwritten.
 */
async function systemNumericsNeedsRepair(projectId: string, file: string): Promise<boolean> {
  const buffer = await readCaseFile(projectId, file);
  if (!buffer) return true;
  const content = buffer.toString('utf8');

  if (file === 'system/fvSolution') return !/pRef(Cell|Point)/.test(content);
  if (file === 'system/fvSchemes') return !/\bdiv\(phi,U\)/.test(content);
  // system/controlDict
  if (parseApplication(content) !== 'simpleFoam') return true;
  const match = content.match(/\bendTime\s+([0-9.eE+-]+)\s*;/);
  const endTime = match ? Number(match[1]) : 0;
  return !Number.isFinite(endTime) || endTime <= 1;
}

/**
 * Generate the simpleFoam files a case needs to be runnable (the "Make runnable"
 * action). The 0/ fields and constant/*Properties are written only when missing,
 * so user-set boundary conditions / property values are kept. The system/
 * numerics (controlDict / fvSchemes / fvSolution) are instead REPAIRED when they
 * are generic placeholders (e.g. from the conversion flow): a placeholder
 * fvSolution lacks pRefCell and simpleFoam aborts, fvSchemes has `div none`, and
 * controlDict targets foamRun with endTime 1. The repair is marker-guarded, so a
 * real imported case or a second call is left untouched.
 */
export async function scaffoldSolver(
  viewer: Viewer,
  projectId: string,
): Promise<ScaffoldSolverResult> {
  await assertProjectVisible(viewer, projectId);

  // Run from a copy of 0.orig when the case uses that convention and has no 0/
  // yet, so the template's initial conditions seed 0/ instead of generic ones.
  await ensureZeroFromOrig(projectId);

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  const patches = boundary ? parseBoundaryPatches(boundary.toString('utf8')) : [];

  const created: string[] = [];
  for (const file of SOLVER_FILE_PATHS) {
    if (SYSTEM_NUMERICS_FILES.has(file)) {
      if (await systemNumericsNeedsRepair(projectId, file)) {
        await writeCaseFile(projectId, file, renderSolverFile(file, patches));
        created.push(file);
      }
      continue;
    }
    // 0/ fields + constant/*Properties: keep what the user has, add what is missing.
    if (await caseFileExists(projectId, file)) continue;
    await writeCaseFile(projectId, file, renderSolverFile(file, patches));
    created.push(file);
  }

  // Belt and suspenders: make sure controlDict targets simpleFoam even if the
  // repair check above kept it (idempotent no-op when already simpleFoam).
  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  if (controlDict) {
    const content = controlDict.toString('utf8');
    const next = setApplication(content, 'simpleFoam');
    if (next !== content) await writeCaseFile(projectId, 'system/controlDict', next);
  }

  const [runnable, entries] = await Promise.all([
    computeRunnable(projectId),
    listCaseTree(projectId),
  ]);
  return { created, runnable, entries };
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
        ? mergeFieldBoundary(text, fieldName, patches)
        : rebuildFieldBoundary(text, fieldName, patches);
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
