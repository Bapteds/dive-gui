import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTemplate,
  createTemplateFile,
  deleteTemplate,
  deleteTemplateDir,
  deleteTemplateFile,
  getTemplate,
  getTemplateFileContent,
  getTemplateFiles,
  importTemplateFolder,
  importTemplateZip,
  listTemplates,
  moveTemplatePath,
  saveTemplateFileContent,
  updateTemplate,
} from '@/lib/api/templates';
import { applyTemplate, previewApplyTemplate } from '@/lib/api/projects';
import { caseFilesQueryKey } from '@/features/projects/useCaseFiles';
import type { UploadFile } from '@/features/files/folderImport';
import type {
  ApplyDecision,
  ApplyPreview,
  ApplyTemplateResponse,
  CaseEntry,
  CaseFileContent,
  CreateCaseFileResponse,
  CreateTemplateInput,
  DeleteCaseDirResponse,
  DeleteCaseFileResponse,
  ImportCaseResponse,
  MoveCaseEntryResponse,
  Template,
  UpdateTemplateInput,
} from '@/lib/api/types';

/**
 * useTemplates - React Query hooks for shared file templates.
 *
 * The roster is keyed by `['templates']`; CRUD mutations invalidate it. A
 * template's file tree and per-file content mirror the case-file hooks exactly
 * (same shapes) so the shared FileTreeEditor can drive either resource. Applying
 * a template writes to a project's case, so the apply hook refreshes that
 * project's case-tree cache.
 */

/** Query key for the template roster. */
export const templatesQueryKey = ['templates'] as const;

/** Query key for a single template's metadata. */
export const templateQueryKey = (id: string) => ['templates', id] as const;

/** Load every (shared) template. */
export function useTemplatesQuery() {
  return useQuery<Template[]>({
    queryKey: templatesQueryKey,
    queryFn: listTemplates,
  });
}

/** Load a single template's metadata. */
export function useTemplateQuery(id: string) {
  return useQuery<Template>({
    queryKey: templateQueryKey(id),
    queryFn: () => getTemplate(id),
    enabled: !!id,
  });
}

/** Create a template, then refresh the roster. */
export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTemplateInput) => createTemplate(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: templatesQueryKey });
    },
  });
}

/** Update a template, then refresh the roster and that template. */
export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) =>
      updateTemplate(id, input),
    onSuccess: (template) => {
      void queryClient.invalidateQueries({ queryKey: templatesQueryKey });
      queryClient.setQueryData(templateQueryKey(template.id), template);
    },
  });
}

/** Delete a template, then refresh the roster. */
export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: templatesQueryKey });
    },
  });
}

// ---- Template files (mirror the case-file hook shapes) ----

/** Query key for a template's file tree. */
export const templateFilesQueryKey = (templateId: string) =>
  ['templates', templateId, 'files'] as const;

/** Query key for a single template file's content. */
export const templateFileContentQueryKey = (templateId: string, path: string) =>
  ['templates', templateId, 'files', 'content', path] as const;

/** Load a template's file tree. */
export function useTemplateFilesQuery(templateId: string) {
  return useQuery<CaseEntry[]>({
    queryKey: templateFilesQueryKey(templateId),
    queryFn: () => getTemplateFiles(templateId),
  });
}

/** Load a single template file's content; disabled until a path is selected. */
export function useTemplateFileContentQuery(templateId: string, path: string | null) {
  return useQuery<CaseFileContent>({
    queryKey: templateFileContentQueryKey(templateId, path ?? ''),
    queryFn: () => getTemplateFileContent(templateId, path as string),
    enabled: !!path,
  });
}

/** Import a folder or a .zip into a template, then refresh the tree cache. */
export function useImportTemplate(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    ImportCaseResponse,
    Error,
    { kind: 'folder'; files: UploadFile[] } | { kind: 'zip'; file: File }
  >({
    mutationFn: (input) =>
      input.kind === 'folder'
        ? importTemplateFolder(templateId, input.files)
        : importTemplateZip(templateId, input.file),
    onSuccess: (result) => {
      queryClient.setQueryData(templateFilesQueryKey(templateId), result.entries);
    },
  });
}

/** Create a new (empty) template file, then write the refreshed tree into the cache. */
export function useCreateTemplateFile(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<CreateCaseFileResponse, Error, { path: string }>({
    mutationFn: ({ path }) => createTemplateFile(templateId, path),
    onSuccess: (result) => {
      queryClient.setQueryData(templateFilesQueryKey(templateId), result.entries);
    },
  });
}

/** Delete a single template file, then refresh the tree and drop its content cache. */
export function useDeleteTemplateFile(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteCaseFileResponse, Error, { path: string }>({
    mutationFn: ({ path }) => deleteTemplateFile(templateId, path),
    onSuccess: (result, { path }) => {
      queryClient.setQueryData(templateFilesQueryKey(templateId), result.entries);
      queryClient.removeQueries({ queryKey: templateFileContentQueryKey(templateId, path) });
    },
  });
}

/** Delete a whole template folder, then refresh the tree and drop stale content caches. */
export function useDeleteTemplateDir(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteCaseDirResponse, Error, { path: string }>({
    mutationFn: ({ path }) => deleteTemplateDir(templateId, path),
    onSuccess: (result) => {
      queryClient.setQueryData(templateFilesQueryKey(templateId), result.entries);
      queryClient.removeQueries({ queryKey: [...templateFilesQueryKey(templateId), 'content'] });
    },
  });
}

/** Move/rename a template file or folder, then refresh the tree and drop stale content caches. */
export function useMoveTemplatePath(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<MoveCaseEntryResponse, Error, { from: string; to: string }>({
    mutationFn: ({ from, to }) => moveTemplatePath(templateId, from, to),
    onSuccess: (result) => {
      queryClient.setQueryData(templateFilesQueryKey(templateId), result.entries);
      queryClient.removeQueries({ queryKey: [...templateFilesQueryKey(templateId), 'content'] });
    },
  });
}

/** Save edited template file content; refresh that file's cache and the tree. */
export function useSaveTemplateFile(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { path: string; content: string }>({
    mutationFn: ({ path, content }) => saveTemplateFileContent(templateId, path, content),
    onSuccess: (_data, { path, content }) => {
      queryClient.setQueryData<CaseFileContent>(templateFileContentQueryKey(templateId, path), {
        path,
        content,
        size: new Blob([content]).size,
      });
      void queryClient.invalidateQueries({ queryKey: templateFilesQueryKey(templateId) });
    },
  });
}

// ---- Applying a template to a project's case ----

/** Preview applying a template to a project (one-shot; drives the conflict UI). */
export function usePreviewApplyTemplate(projectId: string) {
  return useMutation<ApplyPreview, Error, { templateId: string }>({
    mutationFn: ({ templateId }) => previewApplyTemplate(projectId, templateId),
  });
}

/** Apply a template to a project's case, then refresh that case's tree cache. */
export function useApplyTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    ApplyTemplateResponse,
    Error,
    { templateId: string; decisions?: Record<string, ApplyDecision> }
  >({
    mutationFn: ({ templateId, decisions }) => applyTemplate(projectId, templateId, decisions),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
    },
  });
}
