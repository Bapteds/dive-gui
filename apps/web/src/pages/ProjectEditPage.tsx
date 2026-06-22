import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, File as FileIcon, FileWarning, Folder, Save } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/sonner';
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type { CaseEntry } from '@/lib/api/types';
import { useProjectQuery } from '@/features/projects/useProjects';
import {
  useCaseFileContentQuery,
  useCaseFilesQuery,
  useSaveCaseFile,
} from '@/features/projects/useCaseFiles';
import { CaseFileEditor } from '@/features/projects/CaseFileEditor';

/**
 * ProjectEditPage - edit and save the OpenFOAM case files of a project.
 *
 * Reached from the "Edit files" button on the project detail page. Two panes:
 * the case file tree on the left, an online editor (CodeMirror) on the right.
 * Selecting a file loads its content; Save persists it (the single orange CTA).
 * Unsaved edits are guarded on route-leave and when switching files. The mesh
 * and other files too large to edit show a notice instead of the editor.
 */

export function ProjectEditPage() {
  const { id = '' } = useParams();
  const project = useProjectQuery(id);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // A file the user clicked while there are unsaved edits (awaiting confirm).
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const content = useCaseFileContentQuery(id, selectedPath);
  const save = useSaveCaseFile(id);

  const [draft, setDraft] = useState('');
  // Sync the editor draft whenever a file's content loads (or reloads).
  useEffect(() => {
    if (content.data) setDraft(content.data.content);
  }, [content.data]);

  const isDirty = !!selectedPath && !!content.data && draft !== content.data.content;

  const requestSelect = (path: string) => {
    if (path === selectedPath) return;
    if (isDirty) {
      setPendingPath(path);
      return;
    }
    setSelectedPath(path);
  };

  const handleSave = async () => {
    if (!selectedPath) return;
    try {
      await save.mutateAsync({ path: selectedPath, content: draft });
      toast.success('File saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the file.');
    }
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
    <div className="flex flex-col gap-6">
      <UnsavedChangesPrompt when={isDirty} />
      <BackLink projectId={id} />
      <PageHeader title={project.data.title} subtitle="Edit case files" />

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <FileListSidebar projectId={id} selectedPath={selectedPath} onSelect={requestSelect} />
        <EditorPanel
          selectedPath={selectedPath}
          content={content}
          draft={draft}
          onDraftChange={setDraft}
          isDirty={isDirty}
          saving={save.isPending}
          onSave={() => void handleSave()}
        />
      </div>

      <DiscardChangesDialog
        open={pendingPath !== null}
        onConfirm={() => {
          if (pendingPath !== null) setSelectedPath(pendingPath);
          setPendingPath(null);
        }}
        onCancel={() => setPendingPath(null)}
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

/** Left pane: the case file tree. Directories are labels; files are selectable. */
function FileListSidebar({
  projectId,
  selectedPath,
  onSelect,
}: {
  projectId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const { data: entries, isPending, isError, refetch, isRefetching } = useCaseFilesQuery(projectId);

  return (
    <aside className="rounded-md border border-border bg-surface shadow-sm lg:self-start">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Files</h2>
      </header>
      <div className="max-h-[60vh] overflow-auto p-2">
        {isPending ? (
          <div className="flex flex-col gap-2 p-1" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-start gap-2 p-2">
            <p className="text-sm text-text-secondary">Could not load files.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()} loading={isRefetching}>
              Try again
            </Button>
          </div>
        ) : entries.filter((entry) => entry.type === 'file').length === 0 ? (
          <p className="px-2 py-3 text-sm text-text-secondary">
            No files yet.{' '}
            <Link to={`/projects/${projectId}`} className="text-primary hover:underline">
              Import a case
            </Link>{' '}
            first.
          </p>
        ) : (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={entry.path === selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** A single tree row: a non-interactive directory label or a selectable file. */
function FileRow({
  entry,
  selected,
  onSelect,
}: {
  entry: CaseEntry;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const depth = entry.path.split('/').length - 1;
  const name = entry.path.split('/').pop() ?? entry.path;
  const indent = { paddingInlineStart: `${depth * 14 + 8}px` };

  if (entry.type === 'directory') {
    return (
      <li
        style={indent}
        className="flex items-center gap-2 py-1.5 pe-2 text-xs font-medium text-text-secondary"
      >
        <Folder className="size-4 shrink-0 text-neutral" strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{name}</span>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(entry.path)}
        aria-current={selected || undefined}
        title={entry.path}
        style={indent}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm py-1.5 pe-2 text-left text-sm transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
          selected
            ? 'bg-primary-tint font-medium text-primary'
            : 'text-text hover:bg-bg',
        )}
      >
        <FileIcon className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}

/** Right pane: the editor for the selected file (or empty / loading / error). */
function EditorPanel({
  selectedPath,
  content,
  draft,
  onDraftChange,
  isDirty,
  saving,
  onSave,
}: {
  selectedPath: string | null;
  content: ReturnType<typeof useCaseFileContentQuery>;
  draft: string;
  onDraftChange: (value: string) => void;
  isDirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const tooLarge =
    content.isError && content.error instanceof ApiError && content.error.code === 'FILE_TOO_LARGE';

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-surface shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p className="min-w-0 truncate font-mono text-sm text-text" title={selectedPath ?? undefined}>
          {selectedPath ?? 'No file selected'}
          {isDirty && <span className="ml-2 text-xs text-text-secondary">(unsaved)</span>}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={!selectedPath || !isDirty || content.isPending || tooLarge}
        >
          <Save strokeWidth={1.75} aria-hidden="true" />
          Save
        </Button>
      </header>

      <div className="p-2">
        {!selectedPath ? (
          <EditorEmpty />
        ) : content.isPending ? (
          <Skeleton className="h-[60vh] min-h-80 w-full" />
        ) : tooLarge ? (
          <div className="flex h-[60vh] min-h-80 flex-col items-center justify-center gap-3 px-6 text-center">
            <FileWarning className="size-8 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-sm font-medium text-text">This file is too large to edit here</p>
            <p className="max-w-sm text-sm text-text-secondary">
              Download the case from the project page to edit this file locally.
            </p>
          </div>
        ) : content.isError ? (
          <div className="flex h-[60vh] min-h-80 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium text-text">We could not load this file.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void content.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="h-[60vh] min-h-80 overflow-hidden rounded-sm border border-border">
            <CaseFileEditor value={draft} onChange={onDraftChange} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Empty editor: nothing selected yet. */
function EditorEmpty() {
  return (
    <div className="flex h-[60vh] min-h-80 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
        <Diamond size={18} className="text-primary" />
      </span>
      <p className="text-lg font-semibold text-text">Select a file to edit</p>
      <p className="max-w-sm text-sm text-text-secondary">
        Choose a file from the list to open it in the editor.
      </p>
    </div>
  );
}

/** Confirm discarding unsaved edits before switching to another file. */
function DiscardChangesDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved edits in the current file. If you open another file now, they will be
            lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            className="bg-danger text-white hover:bg-danger-hover"
            onClick={onConfirm}
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
