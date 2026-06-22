import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  File as FileIcon,
  FilePlus2,
  FileWarning,
  Folder,
  Loader2,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  CaseEntry,
  CaseFileContent,
  CreateCaseFileResponse,
  DeleteCaseFileResponse,
} from '@/lib/api/types';
import { CaseFileEditor } from '@/features/projects/CaseFileEditor';

/**
 * A resource whose files this editor reads and writes. Both the project case and
 * a template expose identically-shaped React Query hooks (already bound to their
 * id by the caller), so this editor drives either one.
 */
export interface FileTreeResource {
  useFiles: () => UseQueryResult<CaseEntry[], Error>;
  useContent: (path: string | null) => UseQueryResult<CaseFileContent, Error>;
  useSave: () => UseMutationResult<void, Error, { path: string; content: string }>;
  useCreate: () => UseMutationResult<CreateCaseFileResponse, Error, { path: string }>;
  useDelete: () => UseMutationResult<DeleteCaseFileResponse, Error, { path: string }>;
}

interface FileTreeEditorProps {
  resource: FileTreeResource;
  /** When false, the tree is read-only (no new/delete/auto-save). Default true. */
  canEdit?: boolean;
  /** Guidance shown in the sidebar when there are no files yet. */
  emptyFilesHint?: ReactNode;
}

const AUTOSAVE_DELAY_MS = 600;

/**
 * FileTreeEditor - a two-pane file tree + CodeMirror editor with auto-save and
 * file create/delete. Extracted from the project editor so the template editor
 * reuses the exact same behavior (labels and ARIA preserved).
 *
 * Full-bleed: the parent route is pinned to the viewport height (see AppShell),
 * so the tree fills the left column and the editor fills the rest; CodeMirror
 * scrolls internally. Edits auto-save on a short debounce — there is no Save
 * button; a status line reports "Saving…" / "All changes saved" / "Save failed".
 */
export function FileTreeEditor({ resource, canEdit = true, emptyFilesHint }: FileTreeEditorProps) {
  const files = resource.useFiles();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const content = resource.useContent(selectedPath);
  const { mutate: saveFile, isPending: saving, isError: saveFailed } = resource.useSave();

  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (content.data) setDraft(content.data.content);
  }, [content.data]);

  const isDirty = !!selectedPath && !!content.data && draft !== content.data.content;

  // Auto-save: persist the draft a short moment after the last keystroke.
  useEffect(() => {
    if (!canEdit || !selectedPath || !content.data || draft === content.data.content) return;
    const handle = setTimeout(
      () => saveFile({ path: selectedPath, content: draft }),
      AUTOSAVE_DELAY_MS,
    );
    return () => clearTimeout(handle);
  }, [draft, selectedPath, content.data, saveFile, canEdit]);

  const requestSelect = (path: string) => {
    if (path === selectedPath) return;
    // Flush a pending edit to the current file before switching (no data loss).
    if (canEdit && selectedPath && content.data && draft !== content.data.content) {
      saveFile({ path: selectedPath, content: draft });
    }
    setSelectedPath(path);
  };

  const retrySave = () => {
    if (selectedPath) saveFile({ path: selectedPath, content: draft });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <UnsavedChangesPrompt when={isDirty} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <FileListSidebar
          resource={resource}
          files={files}
          selectedPath={selectedPath}
          onSelect={requestSelect}
          onCreated={(path) => setSelectedPath(path)}
          canEdit={canEdit}
          emptyFilesHint={emptyFilesHint}
        />
        <EditorPanel
          resource={resource}
          selectedPath={selectedPath}
          content={content}
          draft={draft}
          onDraftChange={setDraft}
          isDirty={isDirty}
          saving={saving}
          saveFailed={saveFailed}
          onRetry={retrySave}
          canEdit={canEdit}
          onDeleted={() => setSelectedPath(null)}
        />
      </div>
    </div>
  );
}

/** Left pane: the file tree. Directories are labels; files are selectable. */
function FileListSidebar({
  resource,
  files,
  selectedPath,
  onSelect,
  onCreated,
  canEdit,
  emptyFilesHint,
}: {
  resource: FileTreeResource;
  files: UseQueryResult<CaseEntry[], Error>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCreated: (path: string) => void;
  canEdit: boolean;
  emptyFilesHint?: ReactNode;
}) {
  const { data: entries, isPending, isError, refetch, isRefetching } = files;
  const [newOpen, setNewOpen] = useState(false);

  return (
    <aside className="flex max-h-48 min-h-0 flex-col rounded-md border border-border bg-surface shadow-sm lg:max-h-none lg:w-[280px] lg:shrink-0">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Files</h2>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-primary"
            onClick={() => setNewOpen(true)}
          >
            <FilePlus2 strokeWidth={1.75} aria-hidden="true" />
            New file
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {isPending ? (
          <div className="flex flex-col gap-2 p-1" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-start gap-2 p-2">
            <p className="text-sm text-text-secondary">Could not load files.</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void refetch()}
              loading={isRefetching}
            >
              Try again
            </Button>
          </div>
        ) : entries.filter((entry) => entry.type === 'file').length === 0 ? (
          <p className="px-2 py-3 text-sm text-text-secondary">
            {emptyFilesHint ?? 'No files yet.'}
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

      {canEdit && (
        <NewFileDialog
          resource={resource}
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreated={onCreated}
        />
      )}
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
        <FileIcon
          className="size-4 shrink-0 text-text-secondary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}

/** Right pane: the editor for the selected file (or empty / loading / error). */
function EditorPanel({
  resource,
  selectedPath,
  content,
  draft,
  onDraftChange,
  isDirty,
  saving,
  saveFailed,
  onRetry,
  canEdit,
  onDeleted,
}: {
  resource: FileTreeResource;
  selectedPath: string | null;
  content: UseQueryResult<CaseFileContent, Error>;
  draft: string;
  onDraftChange: (value: string) => void;
  isDirty: boolean;
  saving: boolean;
  saveFailed: boolean;
  onRetry: () => void;
  canEdit: boolean;
  onDeleted: () => void;
}) {
  const tooLarge =
    content.isError && content.error instanceof ApiError && content.error.code === 'FILE_TOO_LARGE';

  const fillClass = 'min-h-0 flex-1';

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p
          className="min-w-0 truncate font-mono text-sm text-text"
          title={selectedPath ?? undefined}
        >
          {selectedPath ?? 'No file selected'}
        </p>
        <div className="flex items-center gap-3">
          <SaveStatus
            selected={!!selectedPath}
            dirty={isDirty}
            saving={saving}
            failed={saveFailed}
            onRetry={onRetry}
            canEdit={canEdit}
          />
          {canEdit && selectedPath && (
            <DeleteFileButton
              resource={resource}
              path={selectedPath}
              disabled={saving}
              onDeleted={onDeleted}
            />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col p-2">
        {!selectedPath ? (
          <EditorEmpty className={fillClass} />
        ) : content.isPending ? (
          <Skeleton className={cn('w-full', fillClass)} />
        ) : tooLarge ? (
          <div
            className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', fillClass)}
          >
            <FileWarning className="size-8 text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-sm font-medium text-text">This file is too large to edit here</p>
            <p className="max-w-sm text-sm text-text-secondary">
              Download it to edit this file locally.
            </p>
          </div>
        ) : content.isError ? (
          <div
            className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', fillClass)}
          >
            <p className="text-sm font-medium text-text">We could not load this file.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void content.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className={cn('overflow-hidden rounded-sm border border-border', fillClass)}>
            <CaseFileEditor value={draft} onChange={onDraftChange} readOnly={!canEdit} />
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
  canEdit,
}: {
  selected: boolean;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  onRetry: () => void;
  canEdit: boolean;
}) {
  if (!selected || !canEdit) return null;

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

/** "New file" dialog: enter a relative path, then create and open it. */
function NewFileDialog({
  resource,
  open,
  onOpenChange,
  onCreated,
}: {
  resource: FileTreeResource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (path: string) => void;
}) {
  const create = resource.useCreate();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset on each open so it starts blank without stale errors.
  useEffect(() => {
    if (open) {
      setPath('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = path.trim().replace(/^\/+/, '');
    if (!trimmed) {
      setError('Enter a file path.');
      return;
    }
    if (trimmed.split('/').some((segment) => segment === '..')) {
      setError('The path cannot contain “..”.');
      return;
    }
    try {
      const result = await create.mutateAsync({ path: trimmed });
      toast.success('File created.');
      onCreated(result.path);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FILE_EXISTS') {
        setError('A file already exists at that path.');
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not create the file.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="overscroll-contain">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>
            Enter a path relative to the root, e.g. <span className="font-mono">system/controlDict</span>.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <Field label="File path" required error={error ?? undefined}>
            <Input
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. 0/U…"
              value={path}
              disabled={create.isPending}
              onChange={(event) => {
                setPath(event.target.value);
                if (error) setError(null);
              }}
            />
          </Field>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create file
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Destructive "Delete file": removes the selected file (confirmed). */
function DeleteFileButton({
  resource,
  path,
  disabled,
  onDeleted,
}: {
  resource: FileTreeResource;
  path: string;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const remove = resource.useDelete();

  const handleConfirm = async () => {
    try {
      await remove.mutateAsync({ path });
      toast.success('File deleted.');
      setOpen(false);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the file.');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !remove.isPending && setOpen(next)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-text-secondary hover:bg-danger-tint hover:text-danger"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Trash2 strokeWidth={1.75} aria-hidden="true" />
        Delete
      </Button>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this file?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono">{path}</span> will be permanently removed. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="border-danger/50 bg-danger text-white hover:bg-danger/90"
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={remove.isPending}
            aria-busy={remove.isPending || undefined}
          >
            {remove.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
