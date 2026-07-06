import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Combine,
  Download,
  File as FileIcon,
  FileArchive,
  Folder,
  FolderTree,
  FolderUp,
  ListChecks,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  SquarePen,
  TableProperties,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diamond } from '@/components/brand/Diamond';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { downloadCase } from '@/lib/api/projects';
import type { CaseEntry, CaseVerification } from '@/lib/api/types';
import {
  useCaseFilesQuery,
  useImportCase,
  useResetCase,
  useScaffoldCase,
  useVerifyCase,
} from '@/features/projects/useCaseFiles';
import { CaseSummary } from '@/features/projects/CaseSummary';
import { ConvertToFoamFlow } from '@/features/projects/ConvertToFoamFlow';
import { MergeMeshesFlow } from '@/features/projects/MergeMeshesFlow';
import { BoundaryConditionDialog } from '@/features/projects/BoundaryConditionDialog';
import { ApplyTemplateFlow } from '@/features/templates/ApplyTemplateFlow';

/**
 * CaseFilesSection - import, inspect, verify, and download a project's OpenFOAM
 * case, split across two tabs.
 *
 * - "Files" (default): the management view.
 *   1. Import the case as a folder (e.g. a polyMesh/ tree) or a .zip.
 *   2. The imported files render as a tree; the whole case can be downloaded.
 *   3. "Verify" checks the mandatory base files. If any are missing, an overlay
 *      offers to generate them as generic-minimal templates (Yes creates them,
 *      No closes). The mesh itself cannot be generated and is only reported.
 *   One filled orange CTA per state: "Import folder" while empty, "Verify case"
 *   once files exist. States: loading (skeleton), empty (import prompt), error
 *   (inline retry), data (toolbar + tree).
 *
 * - "Summary": a read-only synthesis of the settings entered in the readable
 *   dictionary files, for a glance at what is configured (see CaseSummary).
 *
 * "Convert a CGNS mesh" opens the guided CGNS -> OpenFOAM flow (ConvertToFoamFlow)
 * as a dialog, reachable from the empty state and the Files toolbar.
 *
 * The hidden file inputs and the generate-files overlay live at the section
 * level so they stay mounted whichever tab is active. From `lg` up the card is a
 * flex column whose active tab list fills the height and scrolls internally, so
 * the detail page never scrolls (the page gives the card `min-h-0 flex-1`).
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

export function CaseFilesSection({
  projectId,
  className,
}: {
  projectId: string;
  /** Lets the page make the card fill and scroll internally (min-h-0 flex-1). */
  className?: string;
}) {
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
  // Active tab: file management ("files") or the read-only synthesis ("summary").
  const [tab, setTab] = useState<'files' | 'summary'>('files');
  // Whether the guided CGNS -> Foam conversion dialog is open.
  const [convertOpen, setConvertOpen] = useState(false);
  // Whether the guided multi-mesh merge dialog is open.
  const [mergeOpen, setMergeOpen] = useState(false);
  // Whether the "boundary conditions" overlay is open (post-import setup).
  const [bcOpen, setBcOpen] = useState(false);

  const hasFiles = !!entries && entries.some((entry) => entry.type === 'file');
  const hasPolyMesh =
    !!entries &&
    entries.some((entry) => entry.type === 'file' && entry.path.startsWith('constant/polyMesh/'));

  const handleImport = async (kind: 'folder' | 'zip', files: File[]) => {
    if (files.length === 0) return;
    setImportingKind(kind);
    try {
      const result =
        kind === 'folder'
          ? await importCase.mutateAsync({ kind: 'folder', files })
          : await importCase.mutateAsync({ kind: 'zip', file: files[0] });
      toast.success(
        `Imported ${result.written.length} file${result.written.length === 1 ? '' : 's'}.`,
      );
      // A freshly imported mesh: offer to set its boundary conditions right away.
      if (result.written.some((path) => path.includes('polyMesh/'))) {
        setBcOpen(true);
      }
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
      // Verify, then open the set-up flow: add the built-in minimal files,
      // apply a saved template, or ignore. The flow tailors itself to whether
      // base files are missing (it also surfaces an incomplete mesh).
      const result = await verify.mutateAsync();
      setPendingVerification(result);
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
    <section
      className={cn(
        'rounded-md border border-border bg-surface shadow-sm lg:flex lg:flex-col',
        className,
      )}
    >
      <header className="shrink-0 px-5 pt-5 sm:px-6">
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
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as 'files' | 'summary')}
        className="mt-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
      >
        <TabsList className="shrink-0 px-5 sm:px-6">
          <TabsTrigger value="files">
            <FolderTree strokeWidth={1.75} aria-hidden="true" />
            Files
          </TabsTrigger>
          <TabsTrigger value="summary">
            <TableProperties strokeWidth={1.75} aria-hidden="true" />
            Summary
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="files"
          className="px-5 py-5 sm:px-6 lg:min-h-0 lg:flex-1 lg:flex-col lg:data-[state=active]:flex"
        >
          {isPending ? (
            <CaseTreeSkeleton />
          ) : isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between lg:my-auto"
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
              onConvert={() => setConvertOpen(true)}
              onMerge={() => setMergeOpen(true)}
              importingKind={importingKind}
            />
          ) : (
            <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
              <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => folderInputRef.current?.click()}
                  loading={importingKind === 'folder'}
                  disabled={importingKind !== null && importingKind !== 'folder'}
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
                  disabled={importingKind !== null && importingKind !== 'zip'}
                >
                  <FileArchive strokeWidth={1.75} aria-hidden="true" />
                  Import .zip
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setConvertOpen(true)}
                >
                  <Workflow strokeWidth={1.75} aria-hidden="true" />
                  Convert mesh
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setMergeOpen(true)}
                >
                  <Combine strokeWidth={1.75} aria-hidden="true" />
                  Merge meshes
                </Button>
                {hasPolyMesh && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setBcOpen(true)}
                  >
                    <SlidersHorizontal strokeWidth={1.75} aria-hidden="true" />
                    Boundary conditions
                  </Button>
                )}
                <Button asChild variant="secondary" size="sm">
                  <Link to={`/projects/${projectId}/edit`}>
                    <SquarePen strokeWidth={1.75} aria-hidden="true" />
                    Edit files
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDownload()}
                  loading={downloading}
                  className="text-cta hover:text-cta-hover"
                >
                  <Download strokeWidth={1.75} aria-hidden="true" />
                  Download
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <ResetCaseButton projectId={projectId} />
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
        </TabsContent>

        <TabsContent
          value="summary"
          className="px-5 py-5 sm:px-6 lg:min-h-0 lg:flex-1 lg:flex-col lg:data-[state=active]:flex"
        >
          <CaseSummary projectId={projectId} />
        </TabsContent>
      </Tabs>

      {pendingVerification && (
        <ApplyTemplateFlow
          projectId={projectId}
          verification={pendingVerification}
          onClose={() => setPendingVerification(null)}
          onApplyMinimal={() => void handleScaffold()}
          applyingMinimal={scaffold.isPending}
        />
      )}

      {convertOpen && (
        <ConvertToFoamFlow projectId={projectId} onClose={() => setConvertOpen(false)} />
      )}

      {mergeOpen && (
        <MergeMeshesFlow projectId={projectId} onClose={() => setMergeOpen(false)} />
      )}

      {bcOpen && (
        <BoundaryConditionDialog projectId={projectId} onClose={() => setBcOpen(false)} />
      )}
    </section>
  );
}

/**
 * Empty state: a diamond mark, the two import actions (orange CTA = folder), and
 * subordinate "Convert a CGNS mesh" / "Merge meshes" paths for users who start
 * from a mesh source (one CGNS, or several polyMesh parts to combine).
 */
function ImportPrompt({
  onPickFolder,
  onPickZip,
  onConvert,
  onMerge,
  importingKind,
}: {
  onPickFolder: () => void;
  onPickZip: () => void;
  onConvert: () => void;
  onMerge: () => void;
  importingKind: 'folder' | 'zip' | null;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-strong px-6 py-12 text-center lg:my-auto">
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
        <Diamond size={18} className="text-primary" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-lg font-semibold text-text">No case files yet</p>
        <p className="text-sm text-text-secondary">
          Import a polyMesh folder or a .zip of your case. You can also convert a CGNS mesh into one.
        </p>
      </div>
      <div className="mt-2 flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            onClick={onPickFolder}
            loading={importingKind === 'folder'}
            disabled={importingKind !== null && importingKind !== 'folder'}
          >
            <FolderUp strokeWidth={1.75} aria-hidden="true" />
            Import folder
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onPickZip}
            loading={importingKind === 'zip'}
            disabled={importingKind !== null && importingKind !== 'zip'}
          >
            <FileArchive strokeWidth={1.75} aria-hidden="true" />
            Import .zip
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-primary hover:bg-primary-tint hover:text-primary"
            onClick={onConvert}
          >
            <Workflow strokeWidth={1.75} aria-hidden="true" />
            Convert a CGNS mesh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-primary hover:bg-primary-tint hover:text-primary"
            onClick={onMerge}
          >
            <Combine strokeWidth={1.75} aria-hidden="true" />
            Merge meshes
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The imported case rendered as an indented tree (directories then files). */
function CaseTree({ entries }: { entries: CaseEntry[] }) {
  return (
    <ul className="max-h-80 overflow-auto overscroll-contain rounded-md border border-border lg:max-h-none lg:min-h-0 lg:flex-1">
      {entries.map((entry) => {
        const depth = entry.path.split('/').length - 1;
        const name = entry.path.split('/').pop() ?? entry.path;
        const isDir = entry.type === 'directory';
        return (
          <li
            key={entry.path}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
          >
            <span
              style={{ paddingInlineStart: `${depth * 16}px` }}
              className="flex min-w-0 items-center gap-2"
            >
              {isDir ? (
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
              <span
                title={entry.path}
                className={
                  isDir ? 'truncate text-sm font-medium text-text' : 'truncate text-sm text-text'
                }
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
        <div
          key={index}
          className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
        >
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

/** Destructive "Reset": remove all imported files (confirmed). */
function ResetCaseButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const reset = useResetCase(projectId);

  const handleConfirm = async () => {
    try {
      await reset.mutateAsync();
      toast.success('Imported files removed.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reset the files.');
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!reset.isPending) setOpen(next);
      }}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="border-danger/50 text-danger hover:bg-danger-tint"
        onClick={() => setOpen(true)}
      >
        <RotateCcw strokeWidth={1.75} aria-hidden="true" />
        Reset
      </Button>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Reset case files?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes every imported file for this project. You will need to import
            them again. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reset.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={reset.isPending}
            aria-busy={reset.isPending || undefined}
          >
            {reset.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
