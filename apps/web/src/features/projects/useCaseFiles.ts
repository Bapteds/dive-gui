import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createCaseFile,
  deleteCaseDir,
  deleteCaseFile,
  getCaseFileContent,
  getCaseFiles,
  importCaseFolder,
  importCaseZip,
  moveCasePath,
  resetCase,
  saveCaseFileContent,
  scaffoldCase,
  verifyCase,
} from '@/lib/api/projects';
import type {
  CaseEntry,
  CaseFileContent,
  CreateCaseFileResponse,
  DeleteCaseDirResponse,
  DeleteCaseFileResponse,
  ImportCaseResponse,
  MoveCaseEntryResponse,
  ScaffoldCaseResponse,
} from '@/lib/api/types';

/**
 * useCaseFiles - React Query hooks for a project's OpenFOAM case files.
 *
 * The tree is cached per project. Import and scaffold mutations write the
 * refreshed tree straight back into the cache so the file list stays in sync
 * without an extra round-trip. Verify is a one-shot action (not cached): the
 * detail view runs it on demand and drives the "generate missing files" overlay
 * from the result. Errors are surfaced via the thrown ApiError (mutateAsync).
 */

/** Query key for a project's case tree. */
export const caseFilesQueryKey = (projectId: string) => ['projects', projectId, 'files'] as const;

/** Load the project's case tree. */
export function useCaseFilesQuery(projectId: string) {
  return useQuery<CaseEntry[]>({
    queryKey: caseFilesQueryKey(projectId),
    queryFn: () => getCaseFiles(projectId),
  });
}

/** Import a folder or a .zip, then write the refreshed tree into the cache. */
export function useImportCase(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ImportCaseResponse, Error, { kind: 'folder'; files: File[] } | { kind: 'zip'; file: File }>({
    mutationFn: (input) =>
      input.kind === 'folder'
        ? importCaseFolder(projectId, input.files)
        : importCaseZip(projectId, input.file),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
    },
  });
}

/** Verify which mandatory files the case has (drives the overlay). */
export function useVerifyCase(projectId: string) {
  return useMutation({
    mutationFn: () => verifyCase(projectId),
  });
}

/** Reset: remove all imported files, then empty the tree cache. */
export function useResetCase(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<CaseEntry[]>({
    mutationFn: () => resetCase(projectId),
    onSuccess: (entries) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), entries);
    },
  });
}

/** Generate the missing base files, then write the refreshed tree into the cache. */
export function useScaffoldCase(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ScaffoldCaseResponse>({
    mutationFn: () => scaffoldCase(projectId),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
    },
  });
}

/** Query key for a single case file's content. */
export const caseFileContentQueryKey = (projectId: string, path: string) =>
  ['projects', projectId, 'files', 'content', path] as const;

/** Load a single file's content; disabled until a path is selected. */
export function useCaseFileContentQuery(projectId: string, path: string | null) {
  return useQuery<CaseFileContent>({
    queryKey: caseFileContentQueryKey(projectId, path ?? ''),
    queryFn: () => getCaseFileContent(projectId, path as string),
    enabled: !!path,
  });
}

/** Create a new (empty) file, then write the refreshed tree into the cache. */
export function useCreateCaseFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<CreateCaseFileResponse, Error, { path: string }>({
    mutationFn: ({ path }) => createCaseFile(projectId, path),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
    },
  });
}

/** Delete a single file, then write the refreshed tree and drop its content cache. */
export function useDeleteCaseFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteCaseFileResponse, Error, { path: string }>({
    mutationFn: ({ path }) => deleteCaseFile(projectId, path),
    onSuccess: (result, { path }) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
      queryClient.removeQueries({ queryKey: caseFileContentQueryKey(projectId, path) });
    },
  });
}

/** Delete a whole folder, then write the refreshed tree and drop stale content caches. */
export function useDeleteCaseDir(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<DeleteCaseDirResponse, Error, { path: string }>({
    mutationFn: ({ path }) => deleteCaseDir(projectId, path),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
      queryClient.removeQueries({ queryKey: [...caseFilesQueryKey(projectId), 'content'] });
    },
  });
}

/** Move/rename a file or folder, then refresh the tree and drop stale content caches. */
export function useMoveCaseEntry(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<MoveCaseEntryResponse, Error, { from: string; to: string }>({
    mutationFn: ({ from, to }) => moveCasePath(projectId, from, to),
    onSuccess: (result) => {
      queryClient.setQueryData(caseFilesQueryKey(projectId), result.entries);
      queryClient.removeQueries({ queryKey: [...caseFilesQueryKey(projectId), 'content'] });
    },
  });
}

/** Save edited file content; refresh that file's cache and the tree (size changes). */
export function useSaveCaseFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { path: string; content: string }>({
    mutationFn: ({ path, content }) => saveCaseFileContent(projectId, path, content),
    onSuccess: (_data, { path, content }) => {
      queryClient.setQueryData<CaseFileContent>(caseFileContentQueryKey(projectId, path), {
        path,
        content,
        size: new Blob([content]).size,
      });
      void queryClient.invalidateQueries({ queryKey: caseFilesQueryKey(projectId) });
    },
  });
}
