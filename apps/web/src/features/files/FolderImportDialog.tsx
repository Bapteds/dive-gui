import { useMemo, useState } from 'react';
import { File as FileIcon, Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { uploadPath, type PickedFolder, type UploadFile } from '@/features/files/folderImport';

/**
 * FolderImportDialog - after a folder is picked, let the user keep only the
 * parts they want before importing.
 *
 * The picked folder's files are grouped by immediate child (see
 * groupPickedFolder) — subfolders first, then loose files — and shown one
 * checkbox per child. Confirming imports only the files belonging to the
 * selected children; the relative paths are preserved exactly, so the resulting
 * tree matches what was on disk minus what was unchecked.
 *
 * The dialog is the keyboard-accessible counterpart to the folder picker: it is
 * focus-trapped, Esc/scrim closes it, and every row is a real <label> wrapping a
 * native checkbox.
 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Human-readable byte size with one decimal above 1 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

interface FolderImportDialogProps {
  /** The picked folder to choose from; null keeps the dialog closed. */
  picked: PickedFolder | null;
  /** Import is in flight — disables controls and shows the button spinner. */
  importing: boolean;
  /** Import the selected files under their resolved relative paths. */
  onConfirm: (files: UploadFile[]) => void;
  /** Dismiss without importing. */
  onCancel: () => void;
}

export function FolderImportDialog({
  picked,
  importing,
  onConfirm,
  onCancel,
}: FolderImportDialogProps) {
  // Start with everything selected; keyed by child name (unique within a root).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Re-seed the selection whenever a new folder is picked.
  const pickedKey = picked ? `${picked.root}:${picked.children.length}` : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (picked && pickedKey !== seededFor) {
    setSelected(new Set(picked.children.map((child) => child.name)));
    setSeededFor(pickedKey);
  }

  // Whether to keep the picked root folder as a path prefix (default: strip it,
  // so `OFSolverExample/0/U` imports as `0/U`).
  const [keepRoot, setKeepRoot] = useState(false);

  const children = picked?.children ?? [];
  const allSelected = children.length > 0 && selected.size === children.length;

  const selectedFileCount = useMemo(() => {
    if (!picked) return 0;
    return picked.children.reduce(
      (total, child) => (selected.has(child.name) ? total + child.files.length : total),
      0,
    );
  }, [picked, selected]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(children.map((child) => child.name)));
  };

  const handleConfirm = () => {
    const uploads = children
      .filter((child) => selected.has(child.name))
      .flatMap((child) => child.files)
      .map((file) => ({ file, path: uploadPath(file, keepRoot) }));
    if (uploads.length > 0) onConfirm(uploads);
  };

  return (
    <Dialog
      open={!!picked}
      onOpenChange={(next) => {
        if (!next && !importing) onCancel();
      }}
    >
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle>Select what to import</DialogTitle>
          <DialogDescription>
            {picked ? (
              <>
                Choose which items from{' '}
                <span className="font-medium text-text">{picked.root}</span> to keep. Only the
                checked ones are imported.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <p className="text-sm text-text-secondary">
            {children.length} item{children.length === 1 ? '' : 's'}
          </p>
          <button
            type="button"
            onClick={toggleAll}
            disabled={importing || children.length === 0}
            className="rounded-sm text-sm font-medium text-primary transition-colors duration-fast ease-out hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        <ul className="max-h-72 divide-y divide-border overflow-auto overscroll-contain rounded-md border border-border">
          {children.map((child) => {
            const isChecked = selected.has(child.name);
            return (
              <li key={child.name}>
                <label
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors duration-fast ease-out hover:bg-bg has-[:focus-visible]:bg-bg"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={importing}
                    onChange={() => toggle(child.name)}
                    className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                  />
                  {child.isDir ? (
                    <Folder
                      className="size-4 shrink-0 text-primary"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  ) : (
                    <FileIcon
                      className="size-4 shrink-0 text-text-secondary"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                    {child.name}
                  </span>
                  <span className="shrink-0 text-xs text-text-secondary tabular-nums">
                    {child.isDir
                      ? `${child.files.length} file${child.files.length === 1 ? '' : 's'} · ${formatBytes(child.size)}`
                      : formatBytes(child.size)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {picked && (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-text">
            <input
              type="checkbox"
              checked={keepRoot}
              disabled={importing}
              onChange={(event) => setKeepRoot(event.currentTarget.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            />
            <span>
              Keep the{' '}
              <span className="font-medium">{picked.root}</span> folder
              <span className="mt-0.5 block text-xs text-text-secondary">
                {keepRoot
                  ? `Imported under ${picked.root}/…`
                  : 'Its contents are imported at the top level.'}
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={importing}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            loading={importing}
            disabled={selectedFileCount === 0}
          >
            Import {selectedFileCount} file{selectedFileCount === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
