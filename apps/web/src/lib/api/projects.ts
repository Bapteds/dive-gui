import { ApiError, apiClient } from './client';
import type {
  ApplyDecision,
  ApplyPreview,
  ApplyPreviewResponse,
  ApplyTemplateResponse,
  AutoPatchResult,
  AutoPatchResponse,
  CaseEntry,
  CaseFileContent,
  CaseFileContentResponse,
  CaseFilesResponse,
  CaseVerification,
  CreateCaseFileResponse,
  CreateProjectInput,
  DeleteCaseDirResponse,
  DeleteCaseFileResponse,
  ImportCaseResponse,
  MoveCaseEntryResponse,
  ExportArtifact,
  ExportResult,
  ExportRunResponse,
  ExportStatus,
  ExportStatusResponse,
  ListProjectsResponse,
  MeshBackupInfo,
  MeshBackupResponse,
  MeshManifest,
  MeshManifestResponse,
  MeshPatchEdit,
  MeshPatchType,
  Project,
  ProjectResponse,
  ListRunsResponse,
  RunLogPayload,
  RunResponse,
  RunSummary,
  RunnableCheck,
  RunnableResponse,
  ScaffoldCaseResponse,
  ScaffoldSolverResponse,
  SolverId,
  VerifyCaseResponse,
} from './types';

/**
 * projects.ts - project endpoints (authenticated, visibility-scoped).
 *
 * Typed wrappers around `/projects`. Each unwraps the `{ project }` / `{ projects }`
 * envelope so callers receive plain values.
 */

/** List the projects visible to the current user (newest first). */
export async function listProjects(): Promise<Project[]> {
  const data = await apiClient.get<ListProjectsResponse>('/projects');
  return data.projects;
}

/** Fetch a single project by id. */
export async function getProject(id: string): Promise<Project> {
  const data = await apiClient.get<ProjectResponse>(`/projects/${id}`);
  return data.project;
}

/** Create a project owned by the current user. */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const data = await apiClient.post<ProjectResponse>('/projects', input);
  return data.project;
}

/** Rename a project's title (owner or super-admin). */
export async function renameProject(id: string, title: string): Promise<Project> {
  const data = await apiClient.patch<ProjectResponse>(`/projects/${id}`, { title });
  return data.project;
}

/** Delete a project (owner or super-admin). */
export async function deleteProject(id: string): Promise<void> {
  await apiClient.delete<void>(`/projects/${id}`);
}

/** Add a collaborator to a project by email (owner or super-admin). */
export async function addCollaborator(id: string, email: string): Promise<Project> {
  const data = await apiClient.post<ProjectResponse>(`/projects/${id}/collaborators`, { email });
  return data.project;
}

/** Remove a collaborator from a project (owner or super-admin). */
export async function removeCollaborator(id: string, userId: string): Promise<Project> {
  const data = await apiClient.delete<ProjectResponse>(`/projects/${id}/collaborators/${userId}`);
  return data.project;
}

// ---- Case files (OpenFOAM) ----

/** List the project's case tree (empty until something is imported). */
export async function getCaseFiles(id: string): Promise<CaseEntry[]> {
  const data = await apiClient.get<CaseFilesResponse>(`/projects/${id}/files`);
  return data.entries;
}

/**
 * Import a folder of case files. Each file carries its relative path (the
 * browser's webkitRelativePath) as the multipart part filename so the server
 * can rebuild the tree (e.g. a polyMesh/ folder lands under constant/polyMesh/).
 */
export async function importCaseFolder(id: string, files: File[]): Promise<ImportCaseResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file, file.webkitRelativePath || file.name);
  }
  return apiClient.postForm<ImportCaseResponse>(`/projects/${id}/files/import`, form);
}

/** Import a .zip archive of a case (or a polyMesh folder). */
export async function importCaseZip(id: string, file: File): Promise<ImportCaseResponse> {
  const form = new FormData();
  form.append('archive', file, file.name);
  return apiClient.postForm<ImportCaseResponse>(`/projects/${id}/files/import`, form);
}

/** Verify which mandatory files the case has. */
export async function verifyCase(id: string): Promise<CaseVerification> {
  const data = await apiClient.get<VerifyCaseResponse>(`/projects/${id}/files/verify`);
  return data.verification;
}

/** Generate the missing mandatory base files. */
export async function scaffoldCase(id: string): Promise<ScaffoldCaseResponse> {
  return apiClient.post<ScaffoldCaseResponse>(`/projects/${id}/files/scaffold`);
}

/** Download the whole case as a .zip blob. */
export async function downloadCase(id: string): Promise<Blob> {
  return apiClient.getBlob(`/projects/${id}/files/download`);
}

/** Remove all imported case files (reset). Returns the now-empty tree. */
export async function resetCase(id: string): Promise<CaseEntry[]> {
  const data = await apiClient.delete<{ entries: CaseEntry[] }>(`/projects/${id}/files`);
  return data.entries;
}

/** Read a single case file's text content for the editor. */
export async function getCaseFileContent(id: string, path: string): Promise<CaseFileContent> {
  const data = await apiClient.get<CaseFileContentResponse>(
    `/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
  );
  return data.file;
}

/** Save edited text content back to an existing case file. */
export async function saveCaseFileContent(
  id: string,
  path: string,
  content: string,
): Promise<void> {
  await apiClient.putText(`/projects/${id}/files/content?path=${encodeURIComponent(path)}`, content);
}

/**
 * Create a new case file from the editor, optionally seeded with content
 * (e.g. a generated dictionary). Returns the refreshed tree.
 */
export async function createCaseFile(
  id: string,
  path: string,
  content?: string,
): Promise<CreateCaseFileResponse> {
  return apiClient.post<CreateCaseFileResponse>(`/projects/${id}/files/content`, { path, content });
}

/** Delete a single case file from the editor. Returns the refreshed tree. */
export async function deleteCaseFile(id: string, path: string): Promise<DeleteCaseFileResponse> {
  return apiClient.delete<DeleteCaseFileResponse>(
    `/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
  );
}

/** Delete a whole case folder (and its contents). Returns the refreshed tree. */
export async function deleteCaseDir(id: string, path: string): Promise<DeleteCaseDirResponse> {
  return apiClient.delete<DeleteCaseDirResponse>(
    `/projects/${id}/files/dir?path=${encodeURIComponent(path)}`,
  );
}

/** Move (or rename) a case file or folder. Returns the refreshed tree. */
export async function moveCasePath(
  id: string,
  from: string,
  to: string,
): Promise<MoveCaseEntryResponse> {
  return apiClient.post<MoveCaseEntryResponse>(`/projects/${id}/files/move`, { from, to });
}

// ---- 3D mesh viewer ("Visualize" tab) ----

/**
 * Fetch the patch manifest for a project's mesh. This call builds the render on
 * the server if it is missing or stale (so the first load may take a moment).
 */
export async function getMeshManifest(id: string): Promise<MeshManifest> {
  const data = await apiClient.get<MeshManifestResponse>(`/projects/${id}/mesh/manifest`);
  return data.manifest;
}

/** Fetch the rendered mesh geometry (a GLB) as a Blob for three.js to parse. */
export async function getMeshGeometry(id: string): Promise<Blob> {
  return apiClient.getBlob(`/projects/${id}/mesh/geometry`);
}

/**
 * Fetch the cell-edge buffer (raw float32 line-segment endpoints), or null when
 * this render has none (an older build) — the viewer then falls back to a
 * client-side edge overlay.
 */
export async function getMeshEdges(id: string): Promise<ArrayBuffer | null> {
  try {
    const blob = await apiClient.getBlob(`/projects/${id}/mesh/edges`);
    return await blob.arrayBuffer();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Force a rebuild of the render (e.g. after a build failure), returning the manifest. */
export async function rebuildMesh(id: string): Promise<MeshManifest> {
  const data = await apiClient.post<MeshManifestResponse>(`/projects/${id}/mesh/rebuild`);
  return data.manifest;
}

/** Rename a boundary patch (updates the mesh boundary + field boundaryFields). */
export async function renameMeshPatch(
  id: string,
  from: string,
  to: string,
): Promise<{ patches: string[] }> {
  return apiClient.post<{ patches: string[] }>(`/projects/${id}/mesh/patches/rename`, { from, to });
}

/** Set a boundary patch's geometric type (propagated into the 0/ fields server-side). */
export async function setMeshPatchType(
  id: string,
  patch: string,
  type: MeshPatchType,
): Promise<{ patches: string[] }> {
  return apiClient.post<{ patches: string[] }>(`/projects/${id}/mesh/patches/type`, { patch, type });
}

/**
 * Run `autoPatch <featureAngle> -overwrite` on the project mesh: splits the
 * external boundary faces into patches by feature angle, rewriting the mesh
 * boundary in place. Resolves with the per-run report even when the tool itself
 * fails (`result.success === false`); only access / missing-mesh errors reject.
 */
export async function autoPatchMesh(id: string, featureAngle: number): Promise<AutoPatchResult> {
  const data = await apiClient.post<AutoPatchResponse>(`/projects/${id}/mesh/auto-patch`, {
    featureAngle,
  });
  return data.result;
}

/**
 * Apply a batch of patch name/type edits at once (the "edit names & types"
 * overlay). Propagated into the 0/ fields server-side; returns the refreshed
 * patch-name list. The original case is backed up before the first edit.
 */
export async function editMeshPatches(
  id: string,
  edits: MeshPatchEdit[],
): Promise<{ patches: string[] }> {
  return apiClient.put<{ patches: string[] }>(`/projects/${id}/mesh/patches`, { edits });
}

/** Status of the project's single mesh-backup slot, or null when none taken. */
export async function getMeshBackup(id: string): Promise<MeshBackupInfo | null> {
  const data = await apiClient.get<MeshBackupResponse>(`/projects/${id}/mesh/backup`);
  return data.backup;
}

/** Overwrite the backup slot with the current case (the "make this the baseline" action). */
export async function saveMeshBackup(id: string): Promise<MeshBackupInfo> {
  const data = await apiClient.post<MeshBackupResponse>(`/projects/${id}/mesh/backup`);
  // The slot always exists after a save, so `backup` is non-null here.
  return data.backup as MeshBackupInfo;
}

/** Restore the case (mesh + 0/ fields) from the backup slot; returns the fresh manifest. */
export async function restoreMeshBackup(id: string): Promise<MeshManifest> {
  const data = await apiClient.post<MeshManifestResponse>(`/projects/${id}/mesh/backup/restore`);
  return data.manifest;
}

// ---- OpenFOAM -> CGNS export ("Export" tab) -------------------------------

/**
 * Run the full OpenFOAM -> CGNS export pipeline (inspect -> convert -> validate ->
 * cfdpost). Resolves with the per-step report even when a tool fails (the steps
 * carry the logs); only access errors reject.
 */
export async function runExport(id: string): Promise<ExportResult> {
  const data = await apiClient.post<ExportRunResponse>(`/projects/${id}/export`);
  return data.result;
}

/** The last export's profile/validation/artifacts, or null when none has run. */
export async function getExportStatus(id: string): Promise<ExportStatus | null> {
  const data = await apiClient.get<ExportStatusResponse>(`/projects/${id}/export`);
  return data.status;
}

/** Download a produced export artifact (out.cgns / session.cse / memo / report) as a Blob. */
export async function downloadExportArtifact(id: string, artifact: ExportArtifact): Promise<Blob> {
  return apiClient.getBlob(`/projects/${id}/export/download/${artifact}`);
}

// ---- Applying a shared template to this project's case ----

/** Preview applying a template: which files are new and which conflict. */
export async function previewApplyTemplate(
  projectId: string,
  templateId: string,
): Promise<ApplyPreview> {
  const data = await apiClient.get<ApplyPreviewResponse>(
    `/projects/${projectId}/apply-template/${templateId}/preview`,
  );
  return data.preview;
}

/** Apply a template to this project's case, resolving conflicts per file. */
export async function applyTemplate(
  projectId: string,
  templateId: string,
  decisions: Record<string, ApplyDecision> = {},
): Promise<ApplyTemplateResponse> {
  return apiClient.post<ApplyTemplateResponse>(
    `/projects/${projectId}/apply-template/${templateId}`,
    { decisions },
  );
}

/** Import SELECTED template files into this project's case ("Add from template file"). */
export async function applyTemplateFiles(
  projectId: string,
  templateId: string,
  paths: string[],
): Promise<ApplyTemplateResponse> {
  return apiClient.post<ApplyTemplateResponse>(
    `/projects/${projectId}/apply-template/${templateId}/files`,
    { paths },
  );
}

// ---- Solver runs ("Solver" tab) ----

/** Report whether the case can run simpleFoam (drives the Solver tab gate). */
export async function getRunnable(id: string): Promise<RunnableCheck> {
  const data = await apiClient.get<RunnableResponse>(`/projects/${id}/runnable`);
  return data.runnable;
}

/** Generate the files a case needs to be runnable by `solver` + turbulence model. */
export async function scaffoldSolver(
  id: string,
  solver?: SolverId,
  turbulence?: string,
): Promise<ScaffoldSolverResponse> {
  const body: { solver?: SolverId; turbulence?: string } = {};
  if (solver) body.solver = solver;
  if (turbulence) body.turbulence = turbulence;
  return apiClient.post<ScaffoldSolverResponse>(`/projects/${id}/runnable/scaffold`, body);
}

/** Apply the mesh boundary (patch names + types) to every 0/ field's boundaryField. */
export async function syncBoundaries(
  id: string,
): Promise<{ updated: string[]; entries: CaseEntry[] }> {
  return apiClient.post<{ updated: string[]; entries: CaseEntry[] }>(
    `/projects/${id}/files/sync-boundaries`,
  );
}

/** Start a solver run. Resolves with the created run (status `running`). `cores` > 1
 * runs the solver in parallel (decomposePar + mpirun); omitted / 1 = serial. */
export async function startRun(
  id: string,
  opts?: { solver?: SolverId; cores?: number },
): Promise<RunSummary> {
  const body: { solver?: SolverId; cores?: number } = {};
  if (opts?.solver) body.solver = opts.solver;
  if (opts?.cores && opts.cores > 1) body.cores = opts.cores;
  const data = await apiClient.post<RunResponse>(`/projects/${id}/runs`, body);
  return data.run;
}

/** List a project's runs, newest first. */
export async function listRuns(id: string): Promise<RunSummary[]> {
  const data = await apiClient.get<ListRunsResponse>(`/projects/${id}/runs`);
  return data.runs;
}

/** Fetch the catch-up log payload (run + residual series + log tail) for a run. */
export async function getRunLog(id: string, runId: string): Promise<RunLogPayload> {
  return apiClient.get<RunLogPayload>(`/projects/${id}/runs/${runId}/log`);
}

/** Stop a run (graceful, with a SIGTERM fallback). */
export async function stopRun(id: string, runId: string): Promise<RunSummary> {
  const data = await apiClient.post<RunResponse>(`/projects/${id}/runs/${runId}/stop`);
  return data.run;
}
