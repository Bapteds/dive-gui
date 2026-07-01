import { useEffect, useId, useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  FileArchive,
  FileCog,
  FolderUp,
  MapPin,
  Scissors,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Diamond } from '@/components/brand/Diamond';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type { ImportStep, MeshPatch, MeshSource } from '@/lib/api/types';
import {
  useAutoPatchMeshSource,
  useDeleteMesh,
  useImportMesh,
  useRenameMeshSourcePatch,
} from '@/features/projects/useMeshes';
import { ImportReport } from '@/features/projects/ImportReport';

/**
 * PartsRail - the left pane of the Assemble workspace: the per-project mesh
 * LIBRARY as an assembly roster. The first source (order[0]) is the Base (never
 * moved); the rest are additional parts the user positions onto it. Selecting an
 * added part activates it for placement.
 *
 * Import / auto-patch / rename follow the same patterns as the "Merge meshes"
 * flow (SourcesStep / MeshRow / PatchEditor), reused here as a rail rather than a
 * dialog step so the whole thing lives beside the live canvas.
 */

export interface PartsRailProps {
  projectId: string;
  query: UseQueryResult<MeshSource[], Error>;
  /** Sources in assembly order (index 0 = base). */
  orderedMeshes: MeshSource[];
  /** The added part currently selected for placement, or null. */
  activePartId: string | null;
  /** Ids of added parts that already have a committed placement. */
  placedIds: Set<string>;
  onSelectPart: (meshId: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}

/** Read and clear a file input, returning the chosen files. */
function takeFiles(input: HTMLInputElement | null): File[] {
  if (!input?.files) return [];
  const files = Array.from(input.files);
  input.value = '';
  return files;
}

/** Top-level folder name of a folder upload (becomes the source's default name). */
export function PartsRail({
  projectId,
  query,
  orderedMeshes,
  activePartId,
  placedIds,
  onSelectPart,
  onMove,
}: PartsRailProps) {
  const { isPending, isError, refetch, isRefetching } = query;
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const meshFileInputRef = useRef<HTMLInputElement>(null);
  const importMesh = useImportMesh(projectId);
  const [importingKind, setImportingKind] = useState<'folder' | 'zip' | 'file' | null>(null);
  const [convReport, setConvReport] = useState<ImportStep[] | null>(null);
  const [name, setName] = useState('');

  // The folder picker needs the non-standard webkitdirectory/directory attrs.
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const runImport = async (kind: 'folder' | 'zip' | 'file', files: File[]) => {
    if (files.length === 0) return;
    setImportingKind(kind);
    setConvReport(null);
    const trimmed = name.trim() || undefined;
    try {
      const result =
        kind === 'folder'
          ? await importMesh.mutateAsync({ kind: 'folder', files, name: trimmed })
          : kind === 'zip'
            ? await importMesh.mutateAsync({ kind: 'zip', file: files[0], name: trimmed })
            : await importMesh.mutateAsync({ kind: 'file', file: files[0], name: trimmed });
      if (result.conversion && !result.conversion.success) {
        setConvReport(result.conversion.steps);
        toast.error('Mesh conversion failed. See the report below.');
      } else if (result.mesh) {
        setName('');
        toast.success(`Added ${result.mesh.name}.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed. Please try again.');
    } finally {
      setImportingKind(null);
    }
  };

  const hasMeshes = orderedMeshes.length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <h2 className="shrink-0 text-sm font-semibold text-text">
        Parts
        {hasMeshes && (
          <span className="ml-1.5 font-normal tabular-nums text-text-secondary">
            ({orderedMeshes.length})
          </span>
        )}
      </h2>

      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('folder', takeFiles(event.currentTarget))}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('zip', takeFiles(event.currentTarget))}
      />
      <input
        ref={meshFileInputRef}
        type="file"
        accept=".cgns,.msh"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void runImport('file', takeFiles(event.currentTarget))}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
        {isPending ? (
          <RailSkeleton />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger-tint px-3 py-3"
          >
            <p className="text-sm text-text">We could not load the parts library.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()} loading={isRefetching}>
              Try again
            </Button>
          </div>
        ) : hasMeshes ? (
          <ol className="flex flex-col gap-2">
            {orderedMeshes.map((mesh, index) => (
              <PartRow
                key={mesh.id}
                projectId={projectId}
                mesh={mesh}
                index={index}
                isBase={index === 0}
                isFirst={index === 0}
                isLast={index === orderedMeshes.length - 1}
                isActive={mesh.id === activePartId}
                isPlaced={placedIds.has(mesh.id)}
                onSelect={() => onSelectPart(mesh.id)}
                onMoveUp={() => onMove(index, -1)}
                onMoveDown={() => onMove(index, 1)}
              />
            ))}
          </ol>
        ) : (
          <EmptyHint />
        )}

        {convReport && (
          <div className="rounded-md border border-danger/40 bg-danger-tint/60 px-3 py-3">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
              <AlertCircle className="size-4 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
              Mesh conversion failed
            </p>
            <ImportReport steps={convReport} />
          </div>
        )}
      </div>

      {/* Import controls pinned to the foot of the rail. */}
      <div className="shrink-0 border-t border-border pt-3">
        <Field
          label="Name"
          helperText="Optional. Names the next imported part, e.g. rotor."
          className="mb-2"
        >
          <Input
            name="partName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. rotor"
            disabled={importingKind !== null}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => folderInputRef.current?.click()}
            loading={importingKind === 'folder'}
            disabled={importingKind !== null && importingKind !== 'folder'}
          >
            <FolderUp strokeWidth={1.75} aria-hidden="true" />
            Folder
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
            .zip
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => meshFileInputRef.current?.click()}
            loading={importingKind === 'file'}
            disabled={importingKind !== null && importingKind !== 'file'}
          >
            <FileCog strokeWidth={1.75} aria-hidden="true" />
            .cgns / .msh
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One part in the roster: base (static) or an added part (selectable). */
function PartRow({
  projectId,
  mesh,
  index,
  isBase,
  isFirst,
  isLast,
  isActive,
  isPlaced,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  projectId: string;
  mesh: MeshSource;
  index: number;
  isBase: boolean;
  isFirst: boolean;
  isLast: boolean;
  isActive: boolean;
  isPlaced: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const remove = useDeleteMesh(projectId);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const handleRemove = async () => {
    try {
      await remove.mutateAsync({ meshId: mesh.id });
      toast.success(`Removed ${mesh.name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the part.');
    }
  };

  return (
    <li
      className={cn(
        'flex flex-col rounded-md border bg-surface',
        isActive ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-primary-tint text-xs font-semibold tabular-nums text-primary">
          {index + 1}
        </span>

        {isBase ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Boxes className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0 truncate text-sm font-medium text-text" title={mesh.name}>
              {mesh.name}
            </span>
            <span className="shrink-0 rounded-sm bg-primary-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary">
              Base
            </span>
          </span>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={isActive}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <Boxes
              className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-text-secondary')}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span
              className={cn(
                'min-w-0 truncate text-sm font-medium',
                isActive ? 'text-primary' : 'text-text',
              )}
              title={mesh.name}
            >
              {mesh.name}
            </span>
            {isPlaced ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-success-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-success">
                <MapPin className="size-3" strokeWidth={2} aria-hidden="true" />
                Placed
              </span>
            ) : (
              <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
                Part {index}
              </span>
            )}
          </button>
        )}

        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-text-secondary"
            aria-label={`Move ${mesh.name} up`}
            disabled={isFirst}
            onClick={onMoveUp}
          >
            <ArrowUp strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-text-secondary"
            aria-label={`Move ${mesh.name} down`}
            disabled={isLast}
            onClick={onMoveDown}
          >
            <ArrowDown strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-text-secondary hover:bg-danger-tint hover:text-danger"
                aria-label={`Remove ${mesh.name}`}
                loading={remove.isPending}
                onClick={() => void handleRemove()}
              >
                <Trash2 strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from library</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="-mt-0.5 mb-1 ml-2.5 flex w-fit items-center gap-1 rounded-sm px-0.5 text-xs text-text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
      >
        <ChevronDown
          className={cn('size-3 transition-transform', open && 'rotate-180')}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="tabular-nums">
          {mesh.patches.length} patch{mesh.patches.length === 1 ? '' : 'es'}
        </span>
      </button>

      {open && (
        <div id={panelId} className="border-t border-border bg-bg px-2.5 py-2.5">
          <PatchEditor projectId={projectId} mesh={mesh} />
        </div>
      )}
    </li>
  );
}

/**
 * Re-patch a part before assembling: split its boundary into patches by feature
 * angle (so a single-patch import becomes mountable/stitchable), then give each a
 * meaningful name. Operates on the library source, not the case.
 */
function PatchEditor({ projectId, mesh }: { projectId: string; mesh: MeshSource }) {
  const autoPatch = useAutoPatchMeshSource(projectId);
  const [angle, setAngle] = useState('30');
  const [failure, setFailure] = useState<string | null>(null);

  const handleSplit = async () => {
    setFailure(null);
    try {
      const res = await autoPatch.mutateAsync({ meshId: mesh.id, featureAngle: Number(angle) });
      if (!res.result.success) {
        setFailure(res.result.stderr || res.result.stdout || 'autoPatch failed.');
        toast.error('Auto-split failed. See the log below.');
      } else {
        toast.success(`Split into ${res.mesh?.patches.length ?? 0} patch(es).`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Auto-split failed. Please try again.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Split by feature angle (°)"
          helperText="Use it when a part arrived as a single patch."
        >
          <Input
            type="number"
            inputMode="numeric"
            name="featureAngle"
            min={0}
            max={180}
            value={angle}
            onChange={(event) => setAngle(event.target.value)}
            disabled={autoPatch.isPending}
            autoComplete="off"
            className="w-24"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handleSplit()}
          loading={autoPatch.isPending}
        >
          <Scissors strokeWidth={1.75} aria-hidden="true" />
          Split patches
        </Button>
      </div>

      {failure && (
        <div className="rounded-md border border-danger/40 bg-danger-tint/60 px-3 py-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text">
            <AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
            autoPatch failed
          </p>
          <pre className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words text-[0.6875rem] leading-relaxed text-text-secondary">
            {failure}
          </pre>
        </div>
      )}

      {mesh.patches.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {mesh.patches.map((patch) => (
            <PatchRenameRow key={patch.name} projectId={projectId} meshId={mesh.id} patch={patch} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-secondary">No patches yet. Split the part to create some.</p>
      )}
    </div>
  );
}

/** One patch row: rename inline (Enter or the button); shows its type + face count. */
function PatchRenameRow({
  projectId,
  meshId,
  patch,
}: {
  projectId: string;
  meshId: string;
  patch: MeshPatch;
}) {
  const rename = useRenameMeshSourcePatch(projectId);
  const [value, setValue] = useState(patch.name);
  const id = useId();
  const next = value.trim();
  const changed = next !== patch.name && next.length > 0;

  const handleRename = async () => {
    if (!changed) return;
    try {
      await rename.mutateAsync({ meshId, from: patch.name, to: next });
      toast.success(`Renamed to ${next}.`);
    } catch (err) {
      setValue(patch.name);
      toast.error(err instanceof ApiError ? err.message : 'Could not rename the patch.');
    }
  };

  return (
    <li className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Rename patch {patch.name}
      </label>
      <Input
        id={id}
        name="patchName"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void handleRename();
        }}
        disabled={rename.isPending}
        spellCheck={false}
        autoComplete="off"
        className="h-8 min-w-0 flex-1 font-mono text-xs"
      />
      <span className="shrink-0 text-xs text-text-secondary tabular-nums">
        {patch.type}, {patch.nFaces}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 shrink-0"
        disabled={!changed}
        loading={rename.isPending}
        onClick={() => void handleRename()}
      >
        Rename
      </Button>
    </li>
  );
}

/** Empty state: a diamond mark and a one-line hint. */
function EmptyHint() {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
        <Diamond size={14} className="text-primary" />
      </span>
      <p className="text-sm text-text-secondary">
        No parts yet. Import the base part first, then add more to position onto it.
      </p>
    </div>
  );
}

/** Loading placeholder for the parts rail. */
function RailSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
          <Skeleton className="size-7 rounded-sm" />
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
    </div>
  );
}

export default PartsRail;
