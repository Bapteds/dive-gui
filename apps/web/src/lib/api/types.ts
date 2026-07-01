/**
 * API contract types - mirror the DIVE backend (`/api/v1`).
 *
 * These are the shapes exchanged with the Express + Prisma backend. They are
 * the single typed contract consumed by the API client, the auth feature, and
 * (later) the admin screens.
 */

import type {
  CaseProfile,
  ConversionStepId,
  ExportArtifacts,
  ExportResult,
  ExportStep,
  ExportStepId,
  ExportValidation,
  ImportStep,
  MergeResult,
  MergeStep,
  MergeStepKind,
  MeshBackupInfo,
  MeshImportConversion,
  MeshManifest,
  MeshPatch,
  MeshPatchEdit,
  MeshPatchType,
  MeshSource,
  ResidualSample,
  Role,
  RunStatus,
  ServerErrorCode,
  SolverId,
  StitchPair,
  ValidationCheck,
} from '@dive/shared';

/** User roles. The super-admin is permanent and cannot be removed or downgraded. */
export type { Role };

/** A platform account as returned by the backend. */
export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  /** true for the permanent super-admin account (cannot be deleted/downgraded). */
  isProtected: boolean;
  /** false for a disabled account: it cannot log in until re-enabled. */
  isActive: boolean;
  /** ISO 8601 timestamp of the last successful login, or null if never. */
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Normalised error body: `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Error codes the UI may surface to the user: every code the server can emit
 * (from the shared contract) plus the transport-only codes the client adds when
 * a request never reaches a normalized response.
 */
export type ApiErrorCode = ServerErrorCode | 'UNAUTHORIZED' | 'NETWORK_ERROR' | 'UNKNOWN';

// ---- Auth responses ----

/** `POST /auth/login` and `POST /auth/refresh` response. */
export interface AuthResponse {
  accessToken: string;
  user: User;
}

/** `GET /auth/me` response. */
export interface MeResponse {
  user: User;
}

// ---- Users responses ----

/** `GET /users` response. */
export interface ListUsersResponse {
  users: User[];
}

/** Response shape for endpoints returning a single user. */
export interface UserResponse {
  user: User;
}

/** Payload for `POST /users`. */
export interface CreateUserInput {
  fullName: string;
  email: string;
  password: string;
  role: Role;
}

/** Payload for `PATCH /users/:id` (all fields optional). */
export interface UpdateUserInput {
  fullName?: string;
  email?: string;
  password?: string;
  role?: Role;
  /** Enable (true) or disable (false) the account. */
  isActive?: boolean;
}

// ---- Projects ----

/** Minimal public user shape embedded in a project (owner / collaborators). */
export interface UserSummary {
  id: string;
  fullName: string;
  email: string;
}

/** A project the current user owns or collaborates on (or any, for super-admin). */
export interface Project {
  id: string;
  title: string;
  owner: UserSummary;
  collaborators: UserSummary[];
  createdAt: string;
  updatedAt: string;
}

/** Payload for `POST /projects`. */
export interface CreateProjectInput {
  title: string;
}

/** `GET /projects` response. */
export interface ListProjectsResponse {
  projects: Project[];
}

/** Response shape for endpoints returning a single project. */
export interface ProjectResponse {
  project: Project;
}

// ---- Project case files (OpenFOAM) ----

/** A node in a project's case tree. */
export interface CaseEntry {
  /** Forward-slash relative path from the case root. */
  path: string;
  type: 'file' | 'directory';
  /** Size in bytes (0 for directories). */
  size: number;
}

/** Report of which mandatory files a case has (the "Verify" check). */
export interface CaseVerification {
  /** All five constant/polyMesh/ mesh files are present. */
  hasMesh: boolean;
  /** Mesh files still absent (come from the import, cannot be generated). */
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

/** `GET /projects/:id/files` response. */
export interface CaseFilesResponse {
  entries: CaseEntry[];
}

/** `GET /projects/:id/files/verify` response. */
export interface VerifyCaseResponse {
  verification: CaseVerification;
}

/** `POST /projects/:id/files/import` response. */
export interface ImportCaseResponse {
  written: string[];
  entries: CaseEntry[];
  /** Present when the import was a .cgns/.msh file (the conversion report). */
  conversion?: MeshImportConversion;
}

/** `POST /projects/:id/files/scaffold` response. */
export interface ScaffoldCaseResponse {
  created: string[];
  verification: CaseVerification;
  entries: CaseEntry[];
}

/** A single case file's text content (for the editor). */
export interface CaseFileContent {
  path: string;
  content: string;
  size: number;
}

/** `GET /projects/:id/files/content` response. */
export interface CaseFileContentResponse {
  file: CaseFileContent;
}

/** `POST /projects/:id/files/content` (create file) response. */
export interface CreateCaseFileResponse {
  path: string;
  entries: CaseEntry[];
}

/** `DELETE /projects/:id/files/content` (delete file) response. */
export interface DeleteCaseFileResponse {
  entries: CaseEntry[];
}

/** `DELETE /projects/:id/files/dir` (delete folder) response. */
export interface DeleteCaseDirResponse {
  entries: CaseEntry[];
}

/** `POST /projects/:id/files/move` (move/rename) response. */
export interface MoveCaseEntryResponse {
  from: string;
  to: string;
  entries: CaseEntry[];
}

// ---- Templates (shared, reusable file templates) ----

/** A reusable, shared file template (its files live under the template tree). */
export interface Template {
  id: string;
  name: string;
  description: string | null;
  /** The author; templates are shared, so this is shown for attribution. */
  owner: UserSummary;
  createdAt: string;
  updatedAt: string;
}

/** Payload for `POST /templates`. */
export interface CreateTemplateInput {
  name: string;
  description?: string;
}

/** Payload for `PATCH /templates/:id` (all fields optional). */
export interface UpdateTemplateInput {
  name?: string;
  description?: string;
}

/** `GET /templates` response. */
export interface ListTemplatesResponse {
  templates: Template[];
}

/** Response shape for endpoints returning a single template. */
export interface TemplateResponse {
  template: Template;
}

/** Per-file decision when a template file collides with an existing case file. */
export type ApplyDecision = 'overwrite' | 'keep';

/** Preview of applying a template to a project's case. */
export interface ApplyPreview {
  /** Every file the template would contribute. */
  files: string[];
  /** Template files whose path already exists in the case (need a decision). */
  conflicts: string[];
  /** Template files not present in the case (always written). */
  newFiles: string[];
}

/** `GET /projects/:id/apply-template/:templateId/preview` response. */
export interface ApplyPreviewResponse {
  preview: ApplyPreview;
}

/** `POST /projects/:id/apply-template/:templateId` response. */
export interface ApplyTemplateResponse {
  applied: string[];
  skipped: string[];
  entries: CaseEntry[];
}

// ---- CGNS mesh sources + CGNS -> OpenFOAM conversion ----

/** A CGNS mesh source file stored on a project. */
export interface CgnsFile {
  /** Filename within the project's cgns store (no directory part). */
  name: string;
  /** Size in bytes. */
  size: number;
}

/** `GET /projects/:id/cgns` response. */
export interface CgnsListResponse {
  files: CgnsFile[];
}

/** `POST /projects/:id/cgns` (upload) response. */
export interface UploadCgnsResponse {
  file: CgnsFile;
  files: CgnsFile[];
}

/** `DELETE /projects/:id/cgns` response. */
export interface DeleteCgnsResponse {
  files: CgnsFile[];
}

/** Re-export of the shared pipeline step ids (cgnsToVtk | vtkToFoam | checkMesh). */
export type { ConversionStepId };

/** Outcome of a single conversion step. */
export type ConversionStepStatus = 'success' | 'failed' | 'skipped';

/** One executed (or skipped) step of the conversion pipeline. */
export interface ConversionStep {
  id: ConversionStepId;
  /** Human-readable step name. */
  label: string;
  /** The logical command line that was run. */
  command: string;
  status: ConversionStepStatus;
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail). */
  stdout: string;
  /** Captured stderr (tail). */
  stderr: string;
  /** Wall-clock duration in ms (0 for a skipped step). */
  durationMs: number;
}

/** Result of a CGNS -> OpenFOAM conversion run. */
export interface ConversionResult {
  /** True only when every step succeeded. */
  success: boolean;
  steps: ConversionStep[];
  /** Informational notes (template applied, base files generated, ...). */
  notes: string[];
  /** Refreshed mandatory-file verification after the run. */
  verification: CaseVerification;
  /** Refreshed case tree after the run. */
  entries: CaseEntry[];
}

/** `POST /projects/:id/cgns/convert` response. */
export interface ConvertCgnsResponse {
  result: ConversionResult;
}

/** Body for `POST /projects/:id/cgns/convert`. */
export interface ConvertCgnsInput {
  cgnsFile: string;
  templateId: string;
}

// ---- Multi-mesh import + merge ("Merge meshes" flow) ----------------------

/** Re-export of the shared mesh-library + merge shapes. */
export type {
  MeshSource,
  StitchPair,
  MergeStep,
  MergeStepKind,
  MergeResult,
  ImportStep,
  MeshImportConversion,
};

/**
 * Rigid placement of an added part in a multi-part assembly: p' = R(rotation)*p +
 * translation, in the part's polyMesh units (metres, SI). No scaling. `rotation`
 * is a unit quaternion in three.js (x, y, z, w) order; identity = [0, 0, 0, 1].
 *
 * Local mirror of the `@dive/shared` type. The backend is adding it to the shared
 * package in parallel; the web contract lives here, so a mirror keeps the two dev
 * tracks unblocked and matches spec 2a exactly.
 */
export interface PartTransform {
  meshId: string;
  translation: [number, number, number];
  rotation: [number, number, number, number];
}

/**
 * A merge plan: the ordered source ids to combine (the first is the master/base,
 * never moved), the patch pairs to stitch, and - for the Assemble workspace - the
 * rigid transform applied to each added part before it is merged. `transforms`
 * absent or identity reproduces the existing side-by-side behaviour (backward
 * compatible: this extends the shared `MergePlan` with an optional field).
 */
export interface MergePlan {
  order: string[];
  stitches: StitchPair[];
  transforms?: PartTransform[];
}

/** `GET /projects/:id/meshes` response. */
export interface MeshesResponse {
  meshes: MeshSource[];
}

/** `POST /projects/:id/meshes/import` response. */
export interface ImportMeshResponse {
  /** The new source (absent when a .cgns/.msh conversion failed). */
  mesh?: MeshSource;
  meshes: MeshSource[];
  /** Present when the import was a .cgns/.msh file (the conversion report). */
  conversion?: MeshImportConversion;
}

/** `DELETE /projects/:id/meshes/:meshId` response. */
export interface DeleteMeshResponse {
  meshes: MeshSource[];
}

/** `GET /projects/:id/meshes/:meshId/patches` response. */
export interface MeshPatchesResponse {
  patches: MeshPatch[];
}

/** The autoPatch run report when re-patching a library mesh (no reject on tool failure). */
export interface MeshSourceAutoPatchRun {
  success: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** `POST /projects/:id/meshes/:meshId/auto-patch` response. */
export interface AutoPatchMeshSourceResponse {
  result: MeshSourceAutoPatchRun;
  /** The refreshed source with its new patches (absent on a tool failure). */
  mesh?: MeshSource;
  meshes: MeshSource[];
}

/** `POST /projects/:id/meshes/:meshId/patches/rename` response. */
export interface RenameMeshSourcePatchResponse {
  mesh: MeshSource;
  meshes: MeshSource[];
}

/** Outcome of a merge run: the shared report plus the refreshed case tree. */
export type MergeRunResult = MergeResult & {
  /** Refreshed case tree after a successful promote (unchanged on failure). */
  entries: CaseEntry[];
};

/** `POST /projects/:id/meshes/merge` response. */
export interface MergeResponse {
  result: MergeRunResult;
}

/** `GET /projects/:id/meshes/plan` and `PUT` response. */
export interface MergePlanResponse {
  plan: MergePlan | null;
}

// ---- 3D mesh viewer ("Visualize" tab) ----

/** Re-export of the shared mesh shapes (one patch; the full manifest). */
export type { MeshPatch, MeshManifest, MeshPatchType, MeshPatchEdit, MeshBackupInfo };

/** `GET /projects/:id/mesh/manifest` and `POST /projects/:id/mesh/rebuild` response. */
export interface MeshManifestResponse {
  manifest: MeshManifest;
}

/**
 * Outcome of an autoPatch run. Like a conversion step, a tool failure resolves
 * with `success: false` and the captured logs rather than rejecting, so the UI
 * inspects `success` (not just onError).
 */
export interface AutoPatchResult {
  /** True only when autoPatch exited 0. */
  success: boolean;
  /** The logical command line that was run. */
  command: string;
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail). */
  stdout: string;
  /** Captured stderr (tail). */
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Boundary patch names after the run (the auto-generated patches on success). */
  patches: string[];
}

/** `POST /projects/:id/mesh/auto-patch` response. */
export interface AutoPatchResponse {
  result: AutoPatchResult;
}

/** `GET /projects/:id/mesh/backup` and `POST /projects/:id/mesh/backup` response. */
export interface MeshBackupResponse {
  /** The backup slot status, or null when no backup has been taken yet. */
  backup: MeshBackupInfo | null;
}

// ---- OpenFOAM -> CGNS export ("Export" tab) -------------------------------

export type {
  CaseProfile,
  ExportStep,
  ExportStepId,
  ExportResult,
  ExportValidation,
  ValidationCheck,
  ExportArtifacts,
};

/** The downloadable export artifacts and their route param. */
export type ExportArtifact = 'cgns' | 'session' | 'memo' | 'report';

/** The last export's persisted status (null when no export has run). */
export interface ExportStatus {
  profile: CaseProfile | null;
  validation: ExportValidation | null;
  artifacts: ExportArtifacts;
}

/** `POST /projects/:id/export` response. */
export interface ExportRunResponse {
  result: ExportResult;
}

/** `GET /projects/:id/export` response. */
export interface ExportStatusResponse {
  status: ExportStatus | null;
}

// ---- Solver runs ("Solver" tab) -------------------------------------------

/** Whether a case can be run by simpleFoam, and what is missing if not. */
export interface RunnableCheck {
  /** All five constant/polyMesh/ mesh files are present. */
  hasMesh: boolean;
  /** Mesh files still absent (come from the import). */
  missingMesh: string[];
  /** Required solver files still absent (what "Make runnable" generates). */
  missingFiles: string[];
  /** Mesh present AND every required solver file present. */
  runnable: boolean;
  /** Solver read from controlDict `application`, or null. */
  solver: string | null;
}

/** `GET /projects/:id/runnable` response. */
export interface RunnableResponse {
  runnable: RunnableCheck;
}

/** `POST /projects/:id/runnable/scaffold` response. */
export interface ScaffoldSolverResponse {
  created: string[];
  runnable: RunnableCheck;
  entries: CaseEntry[];
}

/** A solver run as surfaced to the client. */
export interface RunSummary {
  id: string;
  solver: string;
  status: RunStatus;
  /** Process exit code, or null while running / never spawned. */
  exitCode: number | null;
  /** Short terminal explanation (diverged / failed / stopped), or null. */
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** `POST /projects/:id/runs` and `GET /projects/:id/runs/:runId` response. */
export interface RunResponse {
  run: RunSummary;
}

/** `GET /projects/:id/runs` response. */
export interface ListRunsResponse {
  runs: RunSummary[];
}

/**
 * `GET /projects/:id/runs/:runId/log` response: the run, its residual series
 * (downsampled), a bounded log tail, and the total log size in bytes.
 */
export interface RunLogPayload {
  run: RunSummary;
  series: ResidualSample[];
  logTail: string;
  logBytes: number;
}

export type { RunStatus, SolverId, ResidualSample };
