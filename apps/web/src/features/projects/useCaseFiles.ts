import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCaseFiles,
  importCaseFolder,
  importCaseZip,
  scaffoldCase,
  verifyCase,
} from '@/lib/api/projects';
import type { CaseEntry, ImportCaseResponse, ScaffoldCaseResponse } from '@/lib/api/types';

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
