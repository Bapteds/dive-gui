import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { ApiError } from '@/lib/api/client';
import { useProjectQuery } from '@/features/projects/useProjects';
import {
  useCaseFileContentQuery,
  useCaseFilesQuery,
  useCreateCaseFile,
  useDeleteCaseDir,
  useDeleteCaseFile,
  useMoveCaseEntry,
  useSaveCaseFile,
} from '@/features/projects/useCaseFiles';
import { FileTreeEditor, type FileTreeResource } from '@/features/files/FileTreeEditor';

/**
 * ProjectEditPage - edit, create, delete and auto-save a project's OpenFOAM
 * case files. A thin wrapper that binds the project's case-file hooks to the
 * shared FileTreeEditor (which also powers the template editor).
 */
export function ProjectEditPage() {
  const { id = '' } = useParams();
  const project = useProjectQuery(id);

  // Bind the case-file hooks to this project id for the shared editor.
  const resource: FileTreeResource = {
    useFiles: () => useCaseFilesQuery(id),
    useContent: (path) => useCaseFileContentQuery(id, path),
    useSave: () => useSaveCaseFile(id),
    useCreate: () => useCreateCaseFile(id),
    useDelete: () => useDeleteCaseFile(id),
    useDeleteDir: () => useDeleteCaseDir(id),
    useMove: () => useMoveCaseEntry(id),
  };

  if (project.isPending) {
    return <FullPageLoader />;
  }

  if (project.isError) {
    const notFound = project.error instanceof ApiError && project.error.code === 'NOT_FOUND';
    return (
      <div className="flex flex-col gap-6">
        <BackLink projectId={id} />
        <div className="rounded-md border border-border bg-surface px-6 py-12 text-center shadow-sm">
          <p className="text-lg font-semibold text-text">
            {notFound ? 'Project not found' : 'We could not load this project'}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {notFound
              ? 'It may have been deleted, or you do not have access to it.'
              : 'Check your connection and try again.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <BackLink projectId={id} />
      <FileTreeEditor
        resource={resource}
        enableEasyMode
        emptyFilesHint={
          <>
            No files yet.{' '}
            <Link to={`/projects/${id}`} className="text-primary hover:underline">
              Import a case
            </Link>{' '}
            first, or add one above.
          </>
        }
      />
    </div>
  );
}

/** Back to the project detail page. */
function BackLink({ projectId }: { projectId: string }) {
  return (
    <Link
      to={`/projects/${projectId}`}
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      Project
    </Link>
  );
}
