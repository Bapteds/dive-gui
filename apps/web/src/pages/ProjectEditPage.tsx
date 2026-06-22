import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, File as FileIcon, FileWarning, Folder, Loader2 } from 'lucide-react';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
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
 * ProjectEditPage - edit and auto-save the OpenFOAM case files of a project.
 *
 * Full-bleed (AppShell drops the centered container for this route): the file
 * tree fills the left column and the CodeMirror editor fills the rest of the
 * viewport. Edits auto-save on a short debounce (no Save button); a status line
 * reports "Saving…" / "All changes saved" / "Save failed". Switching files
 * flushes any pending edit first; the unsaved-changes guard covers the brief
 * window before a save lands (or a failed save). Files too large to edit show a
 * notice instead of the editor.
 */

const AUTOSAVE_DELAY_MS = 600;

export function ProjectEditPage() {
  const { id = '' } = useParams();
  const project = useProjectQuery(id);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const content = useCaseFileContentQuery(id, selectedPath);
  const { mutate: saveFile, isPending: saving, isError: saveFailed } = useSaveCaseFile(id);

  const [draft, setDraft] = useState('');
  // Sync the editor draft whenever a file's content loads (or reloads).
  useEffect(() => {
    if (content.data) setDraft(content.data.content);
  }, [content.data]);

  const isDirty = !!selectedPath && !!content.data && draft !== content.data.content;

  // Auto-save: persist the draft a short moment after the last keystroke. On
  // success the content cache updates to the new value, which clears isDirty.
  useEffect(() => {
    if (!selectedPath || !content.data || draft === content.data.content) return;
    const handle = setTimeout(() => saveFile({ path: selectedPath, content: draft }), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [draft, selectedPath, content.data, saveFile]);

  const requestSelect = (path: string) => {
    if (path === selectedPath) return;
    // Flush a pending edit to the current file before switching (no data loss).
    if (selectedPath && content.data && draft !== content.data.content) {
      saveFile({ path: selectedPath, content: draft });
    }
    setSelectedPath(path);
  };

  const retrySave = () => {
    if (selectedPath) saveFile({ path: selectedPath, content: draft });
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
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <UnsavedChangesPrompt when={isDirty} />
      <BackLink projectId={id} />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <FileListSidebar projectId={id} selectedPath={selectedPath} onSelect={requestSelect} />
        <EditorPanel
          selectedPath={selectedPath}
          content={content}
          draft={draft}
          onDraftChange={setDraft}
          isDirty={isDirty}
          saving={saving}
          saveFailed={saveFailed}
          onRetry={retrySave}
        />
      </div>
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
    <aside className="flex flex-col rounded-md border border-border bg-surface shadow-sm lg:min-h-0">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Files</h2>
      </header>
      <div className="max-h-72 overflow-auto p-2 lg:max-h-none lg:min-h-0 lg:flex-1">
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
          selected ? 'bg-primary-tint font-medium text-primary' : 'text-text hover:bg-bg',
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
  saveFailed,
  onRetry,
}: {
  selectedPath: string | null;
  content: ReturnType<typeof useCaseFileContentQuery>;
  draft: string;
  onDraftChange: (value: string) => void;
  isDirty: boolean;
  saving: boolean;
  saveFailed: boolean;
  onRetry: () => void;
}) {
  const tooLarge =
    content.isError && content.error instanceof ApiError && content.error.code === 'FILE_TOO_LARGE';

  // Fixed height on mobile (definite height for the editor), fills on desktop.
  const fillClass = 'h-[60vh] lg:h-auto lg:min-h-0 lg:flex-1';

  return (
    <section className="flex flex-col rounded-md border border-border bg-surface shadow-sm lg:min-h-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p className="min-w-0 truncate font-mono text-sm text-text" title={selectedPath ?? undefined}>
          {selectedPath ?? 'No file selected'}
        </p>
        <SaveStatus
          selected={!!selectedPath}
          dirty={isDirty}
          saving={saving}
          failed={saveFailed}
          onRetry={onRetry}
        />
      </header>

      <div className="flex flex-col p-2 lg:min-h-0 lg:flex-1">
        {!selectedPath ? (
          <EditorEmpty className={fillClass} />
        ) : content.isPending ? (
          <Skeleton className={cn('w-full', fillClass)} />
        ) : tooLarge ? (
          <div className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', fillClass)}>
            <FileWarning className="size-8 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-sm font-medium text-text">This file is too large to edit here</p>
            <p className="max-w-sm text-sm text-text-secondary">
              Download the case from the project page to edit this file locally.
            </p>
          </div>
        ) : content.isError ? (
          <div className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', fillClass)}>
            <p className="text-sm font-medium text-text">We could not load this file.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void content.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className={cn('overflow-hidden rounded-sm border border-border', fillClass)}>
            <CaseFileEditor value={draft} onChange={onDraftChange} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Auto-save status line (replaces a manual Save button). */
function SaveStatus({
  selected,
  dirty,
  saving,
  failed,
  onRetry,
}: {
  selected: boolean;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  if (!selected) return null;

  if (failed) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-danger">
        <AlertCircle className="size-4" strokeWidth={1.75} aria-hidden="true" />
        <span>Save failed</span>
        <Button type="button" variant="ghost" size="sm" onClick={onRetry} className="h-7 px-2 text-primary">
          Retry
        </Button>
      </div>
    );
  }

  if (saving) {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-text-secondary">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
        Saving…
      </p>
    );
  }

  if (dirty) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-text-secondary">
        Editing…
      </p>
    );
  }

  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-text-secondary">
      <Check className="size-4 text-success" strokeWidth={2} aria-hidden="true" />
      All changes saved
    </p>
  );
}

/** Empty editor: nothing selected yet. */
function EditorEmpty({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', className)}>
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
