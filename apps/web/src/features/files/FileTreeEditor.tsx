import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  Code2,
  CornerUpRight,
  File as FileIcon,
  FilePlus2,
  FileWarning,
  Folder,
  GripVertical,
  Loader2,
  MoreVertical,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  DeleteCaseDirResponse,
  DeleteCaseFileResponse,
  MoveCaseEntryResponse,
} from '@/lib/api/types';
import { CaseFileEditor } from '@/features/projects/CaseFileEditor';
import { CaseFileForm } from '@/features/projects/CaseFileForm';
import { foamEasyModeAvailable, matchFoamFileDef } from '@/features/projects/foamForm';

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
  useDeleteDir: () => UseMutationResult<DeleteCaseDirResponse, Error, { path: string }>;
  useMove: () => UseMutationResult<MoveCaseEntryResponse, Error, { from: string; to: string }>;
}

interface FileTreeEditorProps {
  resource: FileTreeResource;
  /** When false, the tree is read-only (no new/delete/auto-save). Default true. */
  canEdit?: boolean;
  /** Guidance shown in the sidebar when there are no files yet. */
  emptyFilesHint?: ReactNode;
  /**
   * Offer an "easy mode" structured form (OpenFOAM field catalog) alongside the
   * raw editor. Enabled for the project case editor; off for templates.
   */
  enableEasyMode?: boolean;
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
export function FileTreeEditor({
  resource,
  canEdit = true,
  emptyFilesHint,
  enableEasyMode = false,
}: FileTreeEditorProps) {
  const files = resource.useFiles();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const content = resource.useContent(selectedPath);
  const { mutate: saveFile, isPending: saving, isError: saveFailed } = resource.useSave();

  const [draft, setDraft] = useState('');
  // Load the editor buffer only when we switch to a DIFFERENT file. content.data
  // also updates on a save-success echo for the SAME file; resetting the draft
  // then wiped any keystrokes typed during the save round-trip and jumped the
  // cursor (H4). The user's buffer wins for the file they are actively editing.
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!content.data) return;
    if (loadedPathRef.current !== selectedPath) {
      loadedPathRef.current = selectedPath;
      setDraft(content.data.content);
    }
  }, [content.data, selectedPath]);

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

  // Keep the open file in sync when a move/delete changes the tree under it.
  const handleMoved = (from: string, to: string) => {
    setSelectedPath((current) => {
      if (current === from) return to;
      if (current && current.startsWith(`${from}/`)) return `${to}${current.slice(from.length)}`;
      return current;
    });
  };
  const handleRemoved = (path: string) => {
    setSelectedPath((current) =>
      current === path || (current && current.startsWith(`${path}/`)) ? null : current,
    );
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
          onMoved={handleMoved}
          onRemoved={handleRemoved}
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
          enableEasyMode={enableEasyMode}
          onDeleted={() => setSelectedPath(null)}
        />
      </div>
    </div>
  );
}

// ---- Path helpers for moving entries within the tree ----

/** Last path segment (the entry's own name). */
function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Where `from` lands when moved into directory `dir` ('' = top level). */
function destinationPath(dir: string, from: string): string {
  const name = basename(from);
  return dir ? `${dir}/${name}` : name;
}

/**
 * A valid, non-trivial destination directory for moving `from`: not `from`
 * itself or one of its descendants, and not its current parent (a no-op).
 */
function canMoveInto(dir: string, from: string): boolean {
  if (dir === from || dir.startsWith(`${from}/`)) return false;
  return destinationPath(dir, from) !== from;
}

/** Left pane: the file tree with drag-and-drop move, per-row actions, and create/delete. */
function FileListSidebar({
  resource,
  files,
  selectedPath,
  onSelect,
  onCreated,
  onMoved,
  onRemoved,
  canEdit,
  emptyFilesHint,
}: {
  resource: FileTreeResource;
  files: UseQueryResult<CaseEntry[], Error>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCreated: (path: string) => void;
  onMoved: (from: string, to: string) => void;
  onRemoved: (path: string) => void;
  canEdit: boolean;
  emptyFilesHint?: ReactNode;
}) {
  const { data: entries, isPending, isError, refetch, isRefetching } = files;
  const [newOpen, setNewOpen] = useState(false);
  // The entry queued for delete confirmation (file or folder); null = closed.
  const [confirmDelete, setConfirmDelete] = useState<CaseEntry | null>(null);
  // Drag state: the path being dragged, and the hovered drop target ('' = top level).
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const move = resource.useMove();
  const deleteDir = resource.useDeleteDir();
  const deleteFile = resource.useDelete();

  const folderPaths = useMemo(
    () => (entries ?? []).filter((entry) => entry.type === 'directory').map((entry) => entry.path),
    [entries],
  );

  const busy = move.isPending || deleteDir.isPending || deleteFile.isPending;
  const hasFiles = !!entries && entries.some((entry) => entry.type === 'file');

  const runMove = async (from: string, to: string) => {
    try {
      await move.mutateAsync({ from, to });
      onMoved(from, to);
      toast.success('Moved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not move it.');
    }
  };

  // Drop the dragged entry into `dir` ('' = top level), skipping invalid/no-op moves.
  const dropInto = (dir: string) => {
    const from = dragPath;
    setDragPath(null);
    setDropTarget(null);
    if (from === null || !canMoveInto(dir, from)) return;
    void runMove(from, destinationPath(dir, from));
  };

  const handleConfirmDelete = async () => {
    const entry = confirmDelete;
    if (!entry) return;
    // Clear the selection BEFORE deleting. If the open file (or a file under the
    // deleted folder) is dirty, its armed 600ms autosave would otherwise fire
    // during the delete round-trip and re-create the file via PUT (M15). onRemoved
    // disarms that autosave; deleting a file implies discarding its unsaved edits.
    onRemoved(entry.path);
    try {
      if (entry.type === 'directory') await deleteDir.mutateAsync({ path: entry.path });
      else await deleteFile.mutateAsync({ path: entry.path });
      toast.success(entry.type === 'directory' ? 'Folder deleted.' : 'File deleted.');
      setConfirmDelete(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete it.');
    }
  };

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
        ) : !hasFiles ? (
          <p className="px-2 py-3 text-sm text-text-secondary">
            {emptyFilesHint ?? 'No files yet.'}
          </p>
        ) : (
          <ul
            className={cn(
              'flex flex-col rounded-sm',
              // While dragging, the list itself is the "top level" drop target.
              canEdit && dragPath !== null && 'ring-1 ring-inset ring-border',
              canEdit && dragPath !== null && dropTarget === '' && 'ring-2 ring-primary',
            )}
            onDragOver={(event) => {
              if (!canEdit || dragPath === null) return;
              event.preventDefault();
              setDropTarget('');
            }}
            onDrop={(event) => {
              if (!canEdit || dragPath === null) return;
              event.preventDefault();
              dropInto('');
            }}
          >
            {entries.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={entry.path === selectedPath}
                onSelect={onSelect}
                canEdit={canEdit}
                busy={busy}
                folderPaths={folderPaths}
                dragging={dragPath === entry.path}
                isDropTarget={entry.type === 'directory' && dropTarget === entry.path}
                onDragStart={() => setDragPath(entry.path)}
                onDragEnd={() => {
                  setDragPath(null);
                  setDropTarget(null);
                }}
                onDirDragOver={() => setDropTarget(entry.path)}
                onDropInto={dropInto}
                onMoveTo={(dir) => void runMove(entry.path, destinationPath(dir, entry.path))}
                onDelete={() => setConfirmDelete(entry)}
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
      {canEdit && (
        <DeleteEntryDialog
          entry={confirmDelete}
          pending={deleteDir.isPending || deleteFile.isPending}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </aside>
  );
}

/**
 * A single tree row: a draggable file (selectable) or folder, with a drag handle
 * and a row-actions menu (move into another folder / delete). Folders are drop
 * targets for the drag-and-drop move.
 */
function FileRow({
  entry,
  selected,
  onSelect,
  canEdit,
  busy,
  folderPaths,
  dragging,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDirDragOver,
  onDropInto,
  onMoveTo,
  onDelete,
}: {
  entry: CaseEntry;
  selected: boolean;
  onSelect: (path: string) => void;
  canEdit: boolean;
  busy: boolean;
  folderPaths: string[];
  dragging: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDirDragOver: () => void;
  onDropInto: (dir: string) => void;
  onMoveTo: (dir: string) => void;
  onDelete: () => void;
}) {
  const depth = entry.path.split('/').length - 1;
  const name = basename(entry.path);
  const indent = { paddingInlineStart: `${depth * 14 + 8}px` };
  const isDir = entry.type === 'directory';

  const dragProps = canEdit
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.path);
          onDragStart();
        },
        onDragEnd,
      }
    : {};

  // Folders accept drops; files don't (a drop on a file falls through to the list).
  const dropProps =
    canEdit && isDir
      ? {
          onDragOver: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            onDirDragOver();
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            onDropInto(entry.path);
          },
        }
      : {};

  return (
    <li
      className={cn(
        'group flex items-center gap-1 rounded-sm transition-colors duration-fast ease-out',
        dragging && 'opacity-50',
        isDropTarget && 'bg-primary-tint ring-1 ring-inset ring-primary',
      )}
      {...dragProps}
      {...dropProps}
    >
      {canEdit && (
        <span
          className="grid shrink-0 cursor-grab place-items-center pl-1 text-neutral opacity-0 transition-opacity duration-fast ease-out group-hover:opacity-100"
          aria-hidden="true"
        >
          <GripVertical className="size-3.5" strokeWidth={1.75} />
        </span>
      )}

      {isDir ? (
        <span
          style={indent}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-xs font-medium text-text-secondary"
        >
          <Folder className="size-4 shrink-0 text-neutral" strokeWidth={1.75} aria-hidden="true" />
          <span className="truncate" title={entry.path}>
            {name}
          </span>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(entry.path)}
          aria-current={selected || undefined}
          title={entry.path}
          style={indent}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 text-left text-sm transition-colors duration-fast ease-out',
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
      )}

      {canEdit && (
        <RowActions
          entry={entry}
          folderPaths={folderPaths}
          busy={busy}
          onMoveTo={onMoveTo}
          onDelete={onDelete}
        />
      )}
    </li>
  );
}

/** Per-row actions menu: move the entry into another folder (or top level), or delete it. */
function RowActions({
  entry,
  folderPaths,
  busy,
  onMoveTo,
  onDelete,
}: {
  entry: CaseEntry;
  folderPaths: string[];
  busy: boolean;
  onMoveTo: (dir: string) => void;
  onDelete: () => void;
}) {
  const isDir = entry.type === 'directory';
  // Valid destinations: top level plus every folder that isn't the entry itself,
  // a descendant of it, or its current parent.
  const destinations = useMemo(
    () => ['', ...folderPaths].filter((dir) => canMoveInto(dir, entry.path)),
    [folderPaths, entry.path],
  );

  return (
    // modal={false}: this row-actions menu is often rendered inside the solver-setup
    // Dialog; a modal menu would fight the parent Dialog (and clicking it could close
    // the wizard). Non-modal is also fine standalone on the project Edit page.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={`Actions for ${entry.path}`}
          className="mr-1 grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary opacity-0 transition-[opacity] duration-fast ease-out hover:bg-bg hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover:opacity-100 disabled:opacity-50 data-[state=open]:opacity-100"
        >
          <MoreVertical className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-auto">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {destinations.length === 0 ? (
          <DropdownMenuItem disabled>No other location</DropdownMenuItem>
        ) : (
          destinations.map((dir) => (
            <DropdownMenuItem key={dir || '/'} onSelect={() => onMoveTo(dir)}>
              <CornerUpRight strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{dir === '' ? 'Top level' : dir}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 strokeWidth={1.75} aria-hidden="true" />
          {isDir ? 'Delete folder' : 'Delete file'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Confirm dialog for deleting a file or a whole folder (and its contents). */
function DeleteEntryDialog({
  entry,
  pending,
  onConfirm,
  onCancel,
}: {
  entry: CaseEntry | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isDir = entry?.type === 'directory';
  return (
    <AlertDialog open={!!entry} onOpenChange={(next) => !pending && !next && onCancel()}>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>{isDir ? 'Delete this folder?' : 'Delete this file?'}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono">{entry?.path}</span>{' '}
            {isDir
              ? 'and everything inside it will be permanently removed.'
              : 'will be permanently removed.'}{' '}
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="border-danger/50 bg-danger text-white hover:bg-danger/90"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            {isDir ? 'Delete folder' : 'Delete file'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  enableEasyMode,
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
  enableEasyMode: boolean;
  onDeleted: () => void;
}) {
  const tooLarge =
    content.isError && content.error instanceof ApiError && content.error.code === 'FILE_TOO_LARGE';

  const fillClass = 'min-h-0 flex-1';
  const fileContent = content.data?.content ?? null;

  // Is the structured "easy mode" worth offering for this file, and is it a
  // recognised catalog file (→ default to easy)? Parse at most once each.
  const easyAvailable = useMemo(
    () => enableEasyMode && !tooLarge && !!fileContent && foamEasyModeAvailable(fileContent),
    [enableEasyMode, tooLarge, fileContent],
  );
  const recognized = useMemo(() => !!fileContent && !!matchFoamFileDef(fileContent), [fileContent]);

  // Editor mode, re-defaulted whenever the selected file changes (easy for a
  // recognised file, advanced otherwise). The user can flip it per file.
  const [mode, setMode] = useState<'easy' | 'advanced'>('advanced');
  const [modeForPath, setModeForPath] = useState<string | null>(null);
  if (fileContent !== null && selectedPath !== modeForPath) {
    setMode(easyAvailable && recognized ? 'easy' : 'advanced');
    setModeForPath(selectedPath);
  }
  const effectiveMode = easyAvailable ? mode : 'advanced';

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
          {easyAvailable && <ModeToggle mode={effectiveMode} onChange={setMode} />}
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
        ) : effectiveMode === 'easy' ? (
          <div className={cn('overflow-hidden rounded-sm border border-border', fillClass)}>
            <CaseFileForm value={draft} onChange={onDraftChange} readOnly={!canEdit} />
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

/** Segmented Easy / Advanced editor-mode switch. */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'easy' | 'advanced';
  onChange: (mode: 'easy' | 'advanced') => void;
}) {
  return (
    <div
      role="group"
      aria-label="Editor mode"
      className="inline-flex items-center rounded-md border border-border bg-bg p-0.5"
    >
      <ModeButton
        active={mode === 'easy'}
        onClick={() => onChange('easy')}
        icon={<Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
        label="Easy"
      />
      <ModeButton
        active={mode === 'advanced'}
        onClick={() => onChange('advanced')}
        icon={<Code2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
        label="Advanced"
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        active
          ? 'bg-surface text-primary shadow-sm'
          : 'text-text-secondary hover:text-text',
      )}
    >
      {icon}
      {label}
    </button>
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
      setError('The path cannot contain "..".');
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
