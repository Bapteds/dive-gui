import { apiClient } from './client';
import type {
  ApplyDecision,
  ApplyPreview,
  ApplyPreviewResponse,
  ApplyTemplateResponse,
  CaseEntry,
  CaseFileContent,
  CaseFileContentResponse,
  CaseFilesResponse,
  CaseVerification,
  CreateCaseFileResponse,
  CreateProjectInput,
  DeleteCaseFileResponse,
  ImportCaseResponse,
  ListProjectsResponse,
  Project,
  ProjectResponse,
  ScaffoldCaseResponse,
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

/** Create a new (empty) case file from the editor. Returns the refreshed tree. */
export async function createCaseFile(id: string, path: string): Promise<CreateCaseFileResponse> {
  return apiClient.post<CreateCaseFileResponse>(`/projects/${id}/files/content`, { path });
}

/** Delete a single case file from the editor. Returns the refreshed tree. */
export async function deleteCaseFile(id: string, path: string): Promise<DeleteCaseFileResponse> {
  return apiClient.delete<DeleteCaseFileResponse>(
    `/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
  );
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
