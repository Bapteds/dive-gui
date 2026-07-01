import { useMemo, useState } from 'react';
import { Boxes, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Diamond } from '@/components/brand/Diamond';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { MergePlan, MergeRunResult, MeshSource } from '@/lib/api/types';
import { MERGE_BASE_CASE } from '@/lib/api/types';
import {
  useAssemblyQuery,
  useMeshesQuery,
  useReapplyAssembly,
  useUndoAssembly,
} from '@/features/projects/useMeshes';
import { MergeRunReport, buildPipelinePreview, type PlannedStep } from './MergeRunReport';

/**
 * AssemblyManagePanel - the "Disassemble" surface of the Assemble tab. It appears
 * only once an assembly is applied (a merge has promoted added parts into the
 * case) and lets the user take it apart non-destructively:
 *
 *  - Remove ONE part: rebuild the case from a reduced plan (the applied order
 *    minus that part, with its interfaces + transform pruned). runMerge restores
 *    the pre-merge case first, so removals never stack.
 *  - Undo the WHOLE assembly: restore the case from the pre-merge backup and clear
 *    the record. Offered only when the base was the project case mesh (the only
 *    case with a guaranteed pre-merge backup); a library-only base has no original
 *    to revert to, so remove-parts is the way back.
 *
 * The shared MergeRunReport renders the rebuild's per-step outcome inline.
 */
export function AssemblyManagePanel({ projectId }: { projectId: string }) {
  const assemblyQuery = useAssemblyQuery(projectId);
  const meshesQuery = useMeshesQuery(projectId);
  const assembly = assemblyQuery.data ?? null;

  const meshById = useMemo(
    () => new Map((meshesQuery.data ?? []).map((m) => [m.id, m] as const)),
    [meshesQuery.data],
  );

  const reapply = useReapplyAssembly(projectId);
  const undo = useUndoAssembly(projectId);

  const [result, setResult] = useState<MergeRunResult | null>(null);
  const [pendingSteps, setPendingSteps] = useState<PlannedStep[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);

  // The applied added parts: the order minus the base (index 0) and the sentinel.
  const addedIds = useMemo(
    () => (assembly ? assembly.plan.order.slice(1).filter((id) => id !== MERGE_BASE_CASE) : []),
    [assembly],
  );

  // Only shown once an assembly with at least one added part is applied.
  if (!assembly || addedIds.length === 0) return null;

  const baseName = assembly.baseIsCase
    ? 'the project case mesh'
    : (meshById.get(assembly.plan.order[0])?.name ?? 'the base part');

  const busy = reapply.isPending || undo.isPending;

  /** Resolve a plan id to a display source (case sentinel + missing library ids handled). */
  const sourceFor = (id: string): MeshSource =>
    id === MERGE_BASE_CASE
      ? { id, name: 'Project case mesh', patches: [], createdAt: '' }
      : (meshById.get(id) ?? { id, name: id, patches: [], createdAt: '' });

  /** The applied plan minus one part: drop it from the order, its interfaces, its transform. */
  const reducedPlan = (removeId: string): MergePlan => ({
    order: assembly.plan.order.filter((id) => id !== removeId),
    interfaces: assembly.plan.interfaces.filter(
      (iface) => iface.aMeshId !== removeId && iface.bMeshId !== removeId,
    ),
    transforms: (assembly.plan.transforms ?? []).filter((t) => t.meshId !== removeId),
  });

  const handleRemove = async (removeId: string) => {
    const plan = reducedPlan(removeId);
    setResult(null);
    setPendingSteps(buildPipelinePreview(plan.order.map(sourceFor), plan.interfaces, meshById));
    setRemovingId(removeId);
    try {
      const res = await reapply.mutateAsync(plan);
      setResult(res);
      if (res.success) toast.success('Part removed from the assembly.');
      else toast.error('Rebuild failed. See the report.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the part.');
    } finally {
      setRemovingId(null);
    }
  };

  const handleUndo = async () => {
    try {
      await undo.mutateAsync();
      setResult(null);
      setPendingSteps([]);
      setConfirmUndo(false);
      toast.success('Assembly reverted to the pre-merge mesh.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not undo the assembly.');
    }
  };

  return (
    <>
      <section
        aria-label="Applied assembly"
        className="flex shrink-0 flex-col gap-3 rounded-md border border-border bg-bg p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-start gap-2">
            <Boxes className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text">Applied assembly</h3>
              <p className="text-xs text-text-secondary">
                <span className="tabular-nums">{addedIds.length}</span> part
                {addedIds.length === 1 ? '' : 's'} coupled onto {baseName}. Remove a part to rebuild
                without it.
              </p>
            </div>
          </div>
          {assembly.baseIsCase && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-danger hover:bg-danger-tint hover:text-danger"
              onClick={() => setConfirmUndo(true)}
              disabled={busy}
            >
              <RotateCcw strokeWidth={1.75} aria-hidden="true" />
              Undo assembly
            </Button>
          )}
        </div>

        <ul className="flex flex-col gap-1.5">
          {addedIds.map((id) => {
            const name = meshById.get(id)?.name ?? id;
            const removing = removingId === id;
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1.5"
              >
                <Diamond size={10} className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm text-text" title={name} translate="no">
                  {name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-danger hover:bg-danger-tint hover:text-danger"
                  onClick={() => void handleRemove(id)}
                  loading={removing}
                  disabled={busy && !removing}
                >
                  <Trash2 strokeWidth={1.75} aria-hidden="true" />
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>

        {(reapply.isPending || result) && (
          <div className="rounded-md border border-border bg-surface p-3">
            <MergeRunReport running={reapply.isPending} result={result} plannedSteps={pendingSteps} />
          </div>
        )}
      </section>

      <AlertDialog
        open={confirmUndo}
        onOpenChange={(open) => {
          if (!undo.isPending) setConfirmUndo(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo the whole assembly?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores the project case mesh (and its 0/ fields) from the pre-merge backup and
              clears the applied assembly. The added parts stay in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undo.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open while the restore runs; close on success.
                event.preventDefault();
                void handleUndo();
              }}
            >
              {undo.isPending ? 'Reverting…' : 'Undo assembly'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default AssemblyManagePanel;
