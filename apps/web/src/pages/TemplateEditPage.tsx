import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileArchive, FolderUp } from 'lucide-react';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  useImportTemplate,
  useTemplateFileContentQuery,
  useTemplateFilesQuery,
  useCreateTemplateFile,
  useDeleteTemplateDir,
  useDeleteTemplateFile,
  useMoveTemplatePath,
  useSaveTemplateFile,
  useTemplateQuery,
} from '@/features/templates/useTemplates';
import { FileTreeEditor, type FileTreeResource } from '@/features/files/FileTreeEditor';
import { FolderImportDialog } from '@/features/files/FolderImportDialog';
import {
  groupPickedFolder,
  type PickedFolder,
  type UploadFile,
} from '@/features/files/folderImport';

/**
 * TemplateEditPage - build a shared template's files: create/edit/delete in the
 * editor, or import a folder / .zip. A thin wrapper that binds the template's
 * file hooks to the shared FileTreeEditor. Editing is limited to the author or a
 * super-admin; everyone else gets a read-only view.
 */
export function TemplateEditPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const template = useTemplateQuery(id);

  const canEdit =
    !!template.data &&
    (user?.role === 'SUPER_ADMIN' || template.data.owner.id === user?.id);

  const resource: FileTreeResource = {
    useFiles: () => useTemplateFilesQuery(id),
    useContent: (path) => useTemplateFileContentQuery(id, path),
    useSave: () => useSaveTemplateFile(id),
    useCreate: () => useCreateTemplateFile(id),
    useDelete: () => useDeleteTemplateFile(id),
    useDeleteDir: () => useDeleteTemplateDir(id),
    useMove: () => useMoveTemplatePath(id),
  };

  if (template.isPending) {
    return <FullPageLoader />;
  }

  if (template.isError) {
    const notFound = template.error instanceof ApiError && template.error.code === 'NOT_FOUND';
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <div className="rounded-md border border-border bg-surface px-6 py-12 text-center shadow-sm">
          <p className="text-lg font-semibold text-text">
            {notFound ? 'Template not found' : 'We could not load this template'}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {notFound
              ? 'It may have been deleted.'
              : 'Check your connection and try again.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <BackLink />
          <p className="truncate text-sm font-semibold text-text" title={template.data.name}>
            {template.data.name}
          </p>
        </div>
        {canEdit && <ImportControls templateId={id} />}
      </div>

      <FileTreeEditor
        resource={resource}
        canEdit={canEdit}
        emptyFilesHint={
          canEdit
            ? 'No files yet. Add one above, or import a folder / .zip.'
            : 'This template has no files yet.'
        }
      />
    </div>
  );
}

/**
 * Folder / .zip import for the template (author or super-admin only).
 *
 * Picking a folder doesn't import straight away: its contents are grouped by
 * immediate child and shown in a selection overlay, so the author can keep only
 * the subfolders/files they want before importing. A .zip imports as-is.
 */
function ImportControls({ templateId }: { templateId: string }) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [importingKind, setImportingKind] = useState<'folder' | 'zip' | null>(null);
  // The folder awaiting a keep-selection (null = overlay closed).
  const [picked, setPicked] = useState<PickedFolder | null>(null);
  const importTemplate = useImportTemplate(templateId);

  // The folder picker needs the non-standard directory attributes (not typed by React).
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const takeFiles = (input: HTMLInputElement | null): File[] => {
    if (!input?.files) return [];
    const files = Array.from(input.files);
    input.value = '';
    return files;
  };

  // A folder was picked: open the selection overlay instead of importing now.
  const handlePickFolder = (files: File[]) => {
    const grouped = groupPickedFolder(files);
    if (grouped) setPicked(grouped);
  };

  const runImport = async (
    payload: { kind: 'folder'; files: UploadFile[] } | { kind: 'zip'; file: File },
  ) => {
    setImportingKind(payload.kind);
    try {
      const result = await importTemplate.mutateAsync(payload);
      toast.success(
        `Imported ${result.written.length} file${result.written.length === 1 ? '' : 's'}.`,
      );
      setPicked(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed. Please try again.');
    } finally {
      setImportingKind(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => handlePickFolder(takeFiles(event.currentTarget))}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const [file] = takeFiles(event.currentTarget);
          if (file) void runImport({ kind: 'zip', file });
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => folderInputRef.current?.click()}
        loading={importingKind === 'folder'}
        disabled={importingKind === 'zip'}
      >
        <FolderUp strokeWidth={1.75} aria-hidden="true" />
        Import folder
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => zipInputRef.current?.click()}
        loading={importingKind === 'zip'}
        disabled={importingKind === 'folder'}
      >
        <FileArchive strokeWidth={1.75} aria-hidden="true" />
        Import .zip
      </Button>

      <FolderImportDialog
        picked={picked}
        importing={importingKind === 'folder'}
        onConfirm={(files) => void runImport({ kind: 'folder', files })}
        onCancel={() => setPicked(null)}
      />
    </div>
  );
}

/** Back to the templates list. */
function BackLink() {
  return (
    <Link
      to="/templates"
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      Templates
    </Link>
  );
}
