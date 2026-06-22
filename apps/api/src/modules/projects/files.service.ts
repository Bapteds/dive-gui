// Case-files business logic for a project's OpenFOAM case directory.
//
// Access model: every operation requires the viewer to be able to *see* the
// project (owner, collaborator, or super-admin) — the same visibility rule the
// projects service enforces. Members may both read and contribute case files;
// project management (delete, collaborators) remains owner/super-admin only and
// lives in projects.service.
import { AppError } from '../../lib/AppError';
import {
  caseFileExists,
  caseIsEmpty,
  extractArchive,
  listCaseTree,
  readCaseFile,
  writeCaseFile,
  writeUploadedFiles,
  zipCase,
  type CaseEntry,
} from '../../lib/caseStorage';
import {
  BASE_FILE_PATHS,
  BOUNDARY_FILE,
  MESH_FILES,
  parseBoundaryPatches,
  renderBaseFile,
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
