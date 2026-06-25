import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { downloadExportArtifact, getExportStatus, runExport } from '@/lib/api/projects';
import type { ExportArtifact, ExportResult, ExportStatus } from '@/lib/api/types';

/**
 * useExport - React Query hooks for the OpenFOAM -> CGNS (CFD-Post) export.
 *
 * The status query reflects the last export's profile / validation / downloadable
 * artifacts (null until one has run). Running the pipeline resolves with the full
 * per-step result even when a tool failed (the steps carry the logs), and writes
 * the refreshed status back into the cache.
 */

/** Query key for a project's export status. */
export const exportStatusQueryKey = (projectId: string) =>
  ['projects', projectId, 'export'] as const;

/** Load the last export's status (profile / validation / artifacts), or null. */
export function useExportStatusQuery(projectId: string, enabled = true) {
  return useQuery<ExportStatus | null>({
    queryKey: exportStatusQueryKey(projectId),
    queryFn: () => getExportStatus(projectId),
    enabled,
  });
}

/**
 * Run the export pipeline. Resolves with the per-step report (success false on a
 * tool failure — inspect result.success, not just onError). On completion the
 * artifacts/profile/validation changed, so refresh the status query.
 */
export function useRunExport(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ExportResult, Error>({
    mutationFn: () => runExport(projectId),
    onSuccess: (result) => {
      const next: ExportStatus = {
        profile: result.profile,
        validation: result.validation,
        artifacts: result.artifacts,
      };
      queryClient.setQueryData<ExportStatus | null>(exportStatusQueryKey(projectId), () => next);
    },
  });
}

/** Default download filename per artifact. */
const ARTIFACT_FILENAMES: Record<ExportArtifact, string> = {
  cgns: 'out_cgns.zip',
  session: 'session.cse',
  memo: 'LOAD_CFDPOST.md',
  report: 'REPORT.md',
};

/**
 * Fetch a produced export artifact (with the auth header, via the API client) and
 * trigger a browser download. A plain <a href> cannot carry the bearer token, so
 * we fetch the Blob then click a transient object URL.
 */
export async function downloadArtifact(projectId: string, artifact: ExportArtifact): Promise<void> {
  const blob = await downloadExportArtifact(projectId, artifact);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ARTIFACT_FILENAMES[artifact];
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
