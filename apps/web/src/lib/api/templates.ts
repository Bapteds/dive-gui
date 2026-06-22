import { apiClient } from './client';
import type {
  CaseEntry,
  CaseFileContent,
  CaseFileContentResponse,
  CaseFilesResponse,
  CreateCaseFileResponse,
  CreateTemplateInput,
  DeleteCaseFileResponse,
  ImportCaseResponse,
  ListTemplatesResponse,
  Template,
  TemplateResponse,
  UpdateTemplateInput,
} from './types';

/**
 * templates.ts - shared file template endpoints (authenticated).
 *
 * Typed wrappers around `/templates`. Listing/reading/applying are open to any
 * authenticated user; mutating a template or its files is allowed only for the
 * author or a super-admin (enforced server-side). File responses reuse the case
 * file shapes, which are structurally identical.
 */

/** List every (shared) template, newest first. */
export async function listTemplates(): Promise<Template[]> {
  const data = await apiClient.get<ListTemplatesResponse>('/templates');
  return data.templates;
}

/** Fetch a single template by id. */
export async function getTemplate(id: string): Promise<Template> {
  const data = await apiClient.get<TemplateResponse>(`/templates/${id}`);
  return data.template;
}

/** Create a template owned by the current user. */
export async function createTemplate(input: CreateTemplateInput): Promise<Template> {
  const data = await apiClient.post<TemplateResponse>('/templates', input);
  return data.template;
}

/** Update a template's metadata (author or super-admin). */
export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<Template> {
  const data = await apiClient.patch<TemplateResponse>(`/templates/${id}`, input);
  return data.template;
}

/** Delete a template (author or super-admin). */
export async function deleteTemplate(id: string): Promise<void> {
  await apiClient.delete<void>(`/templates/${id}`);
}

// ---- Template files ----

/** List a template's file tree. */
export async function getTemplateFiles(id: string): Promise<CaseEntry[]> {
  const data = await apiClient.get<CaseFilesResponse>(`/templates/${id}/files`);
  return data.entries;
}

/** Import a folder of files into a template (author or super-admin). */
export async function importTemplateFolder(id: string, files: File[]): Promise<ImportCaseResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file, file.webkitRelativePath || file.name);
  }
  return apiClient.postForm<ImportCaseResponse>(`/templates/${id}/files/import`, form);
}

/** Import a .zip archive of files into a template (author or super-admin). */
export async function importTemplateZip(id: string, file: File): Promise<ImportCaseResponse> {
  const form = new FormData();
  form.append('archive', file, file.name);
  return apiClient.postForm<ImportCaseResponse>(`/templates/${id}/files/import`, form);
}

/** Read a single template file's text content for the editor. */
export async function getTemplateFileContent(id: string, path: string): Promise<CaseFileContent> {
  const data = await apiClient.get<CaseFileContentResponse>(
    `/templates/${id}/files/content?path=${encodeURIComponent(path)}`,
  );
  return data.file;
}

/** Save edited text content back to an existing template file. */
export async function saveTemplateFileContent(
  id: string,
  path: string,
  content: string,
): Promise<void> {
  await apiClient.putText(
    `/templates/${id}/files/content?path=${encodeURIComponent(path)}`,
    content,
  );
}

/** Create a new (empty) template file. Returns the refreshed tree. */
export async function createTemplateFile(id: string, path: string): Promise<CreateCaseFileResponse> {
  return apiClient.post<CreateCaseFileResponse>(`/templates/${id}/files/content`, { path });
}

/** Delete a single template file. Returns the refreshed tree. */
export async function deleteTemplateFile(id: string, path: string): Promise<DeleteCaseFileResponse> {
  return apiClient.delete<DeleteCaseFileResponse>(
    `/templates/${id}/files/content?path=${encodeURIComponent(path)}`,
  );
}
