import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  File as FileIcon,
  FileArchive,
  Folder,
  FolderUp,
  ListChecks,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { Skeleton } from '@/components/ui/skeleton';
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
import { ApiError } from '@/lib/api/client';
import { downloadCase } from '@/lib/api/projects';
import type { CaseEntry, CaseVerification } from '@/lib/api/types';
import {
  useCaseFilesQuery,
  useImportCase,
  useScaffoldCase,
  useVerifyCase,
} from '@/features/projects/useCaseFiles';

/**
 * CaseFilesSection - import, inspect, verify, and download a project's OpenFOAM
 * case.
 *
 * Flow (see docs/openfoam-fichiers-obligatoires.md):
 *  1. Import the case as a folder (e.g. a polyMesh/ tree) or a .zip.
 *  2. The imported files render as a tree; the whole case can be downloaded.
 *  3. "Verify" checks the mandatory base files. If any are missing, an overlay
 *     offers to generate them as generic-minimal templates (Yes creates them,
 *     No closes). The mesh itself cannot be generated and is only reported.
 *
 * One filled orange CTA per state: "Import folder" while empty, "Verify case"
 * once files exist. States: loading (skeleton), empty (import prompt), error
 * (inline retry), data (toolbar + tree).
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

/** Read and clear a file input, returning the chosen files. */
function takeFiles(input: HTMLInputElement | null): File[] {
  if (!input?.files) return [];
  const files = Array.from(input.files);
  input.value = '';
  return files;
}

export function CaseFilesSection({ projectId }: { projectId: string }) {
  const { data: entries, isPending, isError, refetch, isRefetching } = useCaseFilesQuery(projectId);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // The folder picker needs the non-standard `webkitdirectory`/`directory`
  // attributes, which are not part of React's typed input props; set them on
  // the DOM node once it mounts.
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const importCase = useImportCase(projectId);
  const verify = useVerifyCase(projectId);
  const scaffold = useScaffoldCase(projectId);

  // Which import control is busy, so only that button shows a spinner.
  const [importingKind, setImportingKind] = useState<'folder' | 'zip' | null>(null);
  const [downloading, setDownloading] = useState(false);
  // The verification that opened the overlay (null = overlay closed).
  const [pendingVerification, setPendingVerification] = useState<CaseVerification | null>(null);

  const hasFiles = !!entries && entries.some((entry) => entry.type === 'file');

  const handleImport = async (kind: 'folder' | 'zip', files: File[]) => {
    if (files.length === 0) return;
    setImportingKind(kind);
    try {
      const result = await importCase.mutateAsync(
        kind === 'folder' ? { kind, files } : { kind, file: files[0] },
      );
      toast.success(
        `Imported ${result.written.length} file${result.written.length === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed. Please try again.');
    } finally {
      setImportingKind(null);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await downloadCase(projectId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `case-${projectId}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleVerify = async () => {
    try {
      const result = await verify.mutateAsync();
      if (result.canScaffold) {
        // Missing base files: ask whether to generate them.
        setPendingVerification(result);
      } else if (result.hasMesh) {
        toast.success('All mandatory files are present.');
      } else {
        toast.success(
          'Base files are present. The mesh (constant/polyMesh) is still incomplete and must be imported.',
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Verification failed. Please try again.');
    }
  };

  const handleScaffold = async () => {
    try {
      const result = await scaffold.mutateAsync();
      toast.success(
        `Created ${result.created.length} base file${result.created.length === 1 ? '' : 's'}.`,
      );
      setPendingVerification(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the files.');
    }
  };

  return (
    <section className="rounded-md border border-border bg-surface shadow-sm">
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold text-text">Case files</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Import your OpenFOAM case (mesh and configuration), then verify it has the mandatory base
          files.
        </p>
      </header>

      {/* Hidden inputs, triggered by the visible buttons. The folder input gets
          its non-standard directory attributes set via ref (see effect below). */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void handleImport('folder', takeFiles(event.currentTarget))}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void handleImport('zip', takeFiles(event.currentTarget))}
      />

      <div className="px-5 py-5 sm:px-6">
        {isPending ? (
          <CaseTreeSkeleton />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-text">We could not load the case files.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void refetch()}
              loading={isRefetching}
              className="shrink-0"
            >
              Try again
            </Button>
          </div>
        ) : !hasFiles ? (
          <ImportPrompt
            onPickFolder={() => folderInputRef.current?.click()}
            onPickZip={() => zipInputRef.current?.click()}
            importingKind={importingKind}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleDownload()}
                loading={downloading}
              >
                <Download strokeWidth={1.75} aria-hidden="true" />
                Download
              </Button>
              <div className="ml-auto">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleVerify()}
                  loading={verify.isPending}
                >
                  <ListChecks strokeWidth={1.75} aria-hidden="true" />
                  Verify case
                </Button>
              </div>
            </div>

            <CaseTree entries={entries} />
          </div>
        )}
      </div>

      <GenerateFilesDialog
        verification={pendingVerification}
        pending={scaffold.isPending}
        onConfirm={() => void handleScaffold()}
        onOpenChange={(open) => {
          if (!open && !scaffold.isPending) setPendingVerification(null);
        }}
      />
    </section>
  );
}

/** Empty state: a diamond mark and the two import actions (orange CTA = folder). */
function ImportPrompt({
  onPickFolder,
  onPickZip,
  importingKind,
}: {
  onPickFolder: () => void;
  onPickZip: () => void;
  importingKind: 'folder' | 'zip' | null;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-strong px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
        <Diamond size={18} className="text-primary" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-lg font-semibold text-text">No case files yet</p>
        <p className="text-sm text-text-secondary">
          Import a polyMesh folder or a .zip of your case. You can add the rest later.
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button type="button" onClick={onPickFolder} loading={importingKind === 'folder'} disabled={importingKind === 'zip'}>
          <FolderUp strokeWidth={1.75} aria-hidden="true" />
          Import folder
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onPickZip}
          loading={importingKind === 'zip'}
          disabled={importingKind === 'folder'}
        >
          <FileArchive strokeWidth={1.75} aria-hidden="true" />
          Import .zip
        </Button>
      </div>
    </div>
  );
}

/** The imported case rendered as an indented tree (directories then files). */
function CaseTree({ entries }: { entries: CaseEntry[] }) {
  return (
    <ul className="max-h-80 overflow-auto rounded-md border border-border">
      {entries.map((entry) => {
        const depth = entry.path.split('/').length - 1;
        const name = entry.path.split('/').pop() ?? entry.path;
        const isDir = entry.type === 'directory';
        return (
          <li
            key={entry.path}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
          >
            <span style={{ paddingInlineStart: `${depth * 16}px` }} className="flex min-w-0 items-center gap-2">
              {isDir ? (
                <Folder className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
              )}
              <span
                title={entry.path}
                className={isDir ? 'truncate text-sm font-medium text-text' : 'truncate text-sm text-text'}
              >
                {name}
              </span>
            </span>
            {!isDir && (
              <span className="ml-auto shrink-0 text-xs text-text-secondary tabular-nums">
                {formatBytes(entry.size)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Loading placeholder mirroring the tree layout. */
function CaseTreeSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-md border border-border" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

/** Overlay asking whether to generate the missing mandatory base files. */
function GenerateFilesDialog({
  verification,
  pending,
  onConfirm,
  onOpenChange,
}: {
  verification: CaseVerification | null;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={!!verification} onOpenChange={onOpenChange}>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Generate the missing base files?</AlertDialogTitle>
          <AlertDialogDescription>
            These mandatory files are missing. They will be created as generic-minimal templates you
            can edit afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {verification && (
          <div className="flex flex-col gap-3">
            <ul className="rounded-md border border-border bg-bg/60 px-3 py-2.5">
              {verification.missingBase.map((path) => (
                <li key={path} className="flex items-center gap-2 py-0.5 text-sm text-text">
                  <FileIcon className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate font-mono text-[0.8125rem]">{path}</span>
                </li>
              ))}
            </ul>
            {!verification.hasMesh && (
              <p className="text-sm text-text-secondary">
                Note: the mesh (constant/polyMesh) is incomplete. It comes from your import and
                cannot be generated.
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Not now</AlertDialogCancel>
          <AlertDialogAction
            className="bg-cta font-bold text-white hover:bg-cta-hover"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <CheckCircle2 strokeWidth={1.75} aria-hidden="true" />
            )}
            Create files
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
