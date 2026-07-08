import { useCallback, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileUp,
  Loader2,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
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
import { ApiError } from '@/lib/api/client';
import { getSessionZip } from '@/lib/api/meshing';
import type { SnappyConfig, StlFile } from '@/lib/api/types';
import { ImportReport } from '@/features/projects/ImportReport';
import {
  useDeleteMeshingSession,
  useDeleteStl,
  useMeshingSession,
  useRunSnappy,
  useSaveMeshingConfig,
  useUploadStl,
} from '@/features/meshing/useMeshing';
import { StlViewer } from '@/features/meshing/StlViewer';
import { SnappyConfigForm } from '@/features/meshing/SnappyConfigForm';
import { MeshResultViewer } from '@/features/meshing/MeshResultViewer';

/**
 * MeshingSessionPage - one meshing session: manage STL surfaces (upload / preview
 * / remove), configure and run snappyHexMesh (with a per-step report), then
 * visualize and download the resulting polyMesh. Renders the full state set
 * (loading / error / not-found), and each async action reports its own progress.
 */
export function MeshingSessionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const session = useMeshingSession(id);
  const runSnappy = useRunSnappy(id);
  const { mutate: saveConfig } = useSaveMeshingConfig(id);
  const deleteSession = useDeleteMeshingSession();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Autosave the edited config (debounced in the form). Best-effort: a lost save
  // is non-fatal, so a failure is swallowed rather than surfaced as a toast.
  const handleConfigChange = useCallback(
    (config: SnappyConfig) => saveConfig(config),
    [saveConfig],
  );

  const handleGenerate = async (config: SnappyConfig) => {
    try {
      const { result } = await runSnappy.mutateAsync(config);
      if (result.success) {
        toast.success('Mesh generated.');
      } else {
        toast.error('Meshing did not complete. See the run report below.');
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not run the mesher.');
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await getSessionZip(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `meshing-${session.data?.name ?? id}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not download the case.');
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteSession.mutateAsync(id);
      toast.success('Session deleted.');
      navigate('/meshing');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the session.');
    }
  };

  if (session.isPending) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">Loading session</span>
      </div>
    );
  }

  if (session.isError) {
    const notFound = session.error instanceof ApiError && session.error.status === 404;
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <EmptyState
          title={notFound ? 'Session not found.' : 'Could not load this session.'}
          description={
            notFound
              ? 'It may have been deleted. Return to the meshing list to pick another.'
              : 'Check your connection and try again.'
          }
        />
      </div>
    );
  }

  const data = session.data;
  const running = runSnappy.isPending;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2.5">
          <Diamond size={18} className="mt-1 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-2xl font-semibold text-text">{data.name}</h1>
            <p className="text-sm text-text-secondary">
              {data.stls.length} surface{data.stls.length === 1 ? '' : 's'} ·{' '}
              {data.hasMesh ? 'mesh ready' : 'not meshed yet'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data.hasMesh && (
            <Button type="button" variant="secondary" onClick={handleDownload} loading={downloading}>
              <Download strokeWidth={1.75} aria-hidden="true" />
              Download case
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            className="text-danger hover:bg-danger-tint hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 strokeWidth={1.75} aria-hidden="true" />
            Delete
          </Button>
        </div>
      </header>

      {/* Surfaces: manager (left) + client-side preview (right). */}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <StlManager sessionId={id} stls={data.stls} />
        <StlViewer sessionId={id} stls={data.stls} />
      </section>

      {/* snappyHexMesh configuration + run. Seeds from the autosaved config (else
          the last run) so every setting persists across reloads, and autosaves any
          edit so manual values survive even before a run. */}
      <SnappyConfigForm
        stls={data.stls}
        bounds={data.bounds}
        disabled={data.stls.length === 0}
        running={running}
        initialConfig={data.savedConfig ?? data.lastRun?.config ?? null}
        maxCores={data.maxCores}
        onGenerate={handleGenerate}
        onConfigChange={handleConfigChange}
      />

      {/* The last run's per-step report. */}
      {data.lastRun && (
        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-5 shadow-sm sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">Run report</h2>
            <StatusPill success={data.lastRun.result.success} />
          </div>
          <ImportReport steps={data.lastRun.result.steps} />
        </section>
      )}

      {/* The resulting polyMesh, when a run produced one. */}
      {data.hasMesh && (
        <section className="flex min-h-[55vh] flex-col gap-3">
          <h2 className="text-sm font-semibold text-text">Result mesh</h2>
          <MeshResultViewer sessionId={id} />
        </section>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleteSession.isPending && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the session, its STL surfaces, and any generated mesh. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSession.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleteSession.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Back to the meshing list. */
function BackLink() {
  return (
    <Link
      to="/meshing"
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium text-text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      Meshing
    </Link>
  );
}

/** OK / Failed pill for the run report header. */
function StatusPill({ success }: { success: boolean }) {
  return (
    <span
      className={
        success
          ? 'inline-flex items-center gap-1 rounded-sm bg-success-tint px-2 py-0.5 text-xs font-medium text-success'
          : 'inline-flex items-center gap-1 rounded-sm bg-danger-tint px-2 py-0.5 text-xs font-medium text-danger'
      }
    >
      {success ? 'Completed' : 'Failed'}
    </span>
  );
}

/**
 * StlManager - upload STL surfaces and list / remove them. The upload is a hidden
 * file input driven by a labelled button (accepts multiple .stl). Each row has a
 * remove control. Renders an empty hint when no surface is present.
 */
function StlManager({ sessionId, stls }: { sessionId: string; stls: StlFile[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadStl(sessionId);
  const remove = useDeleteStl(sessionId);
  const [removingName, setRemovingName] = useState<string | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.stl'));
    if (files.length === 0) {
      toast.error('Please choose one or more .stl files.');
      return;
    }
    try {
      await upload.mutateAsync(files);
      toast.success(files.length === 1 ? 'Surface added.' : `${files.length} surfaces added.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not upload the surface.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async (name: string) => {
    setRemovingName(name);
    try {
      await remove.mutateAsync(name);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the surface.');
    } finally {
      setRemovingName(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-text">STL surfaces</h2>
        <p className="text-sm text-text-secondary">The geometry snappyHexMesh snaps to.</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".stl,model/stl,application/sla"
        multiple
        aria-label="Upload STL surface files"
        className="sr-only"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        loading={upload.isPending}
        onClick={() => inputRef.current?.click()}
      >
        <FileUp strokeWidth={1.75} aria-hidden="true" />
        Upload STL
      </Button>

      {stls.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-bg px-3 py-4 text-sm text-text-secondary">
          <AlertTriangle className="size-4 shrink-0 text-neutral" strokeWidth={1.75} aria-hidden="true" />
          No surface yet. Upload an .stl to begin.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
          {stls.map((stl) => (
            <li key={stl.name} className="flex items-center gap-2 px-3 py-2.5">
              <Diamond size={7} className="shrink-0 text-neutral" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-text" title={stl.name}>
                {stl.name}
              </span>
              <span className="shrink-0 text-xs text-text-secondary tabular-nums">
                {formatBytes(stl.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => void handleRemove(stl.name)}
                disabled={removingName === stl.name}
                aria-label={`Remove ${stl.name}`}
                className="shrink-0 rounded-sm p-1 text-text-secondary transition-colors hover:bg-danger-tint hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
              >
                {removingName === stl.name ? (
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Human-readable byte size (KB / MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default MeshingSessionPage;
