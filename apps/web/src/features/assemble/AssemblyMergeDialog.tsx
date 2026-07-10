import { useId, useMemo, useState } from 'react';
import { ChevronRight, Combine, Link2, Plus, Trash2, Workflow } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Diamond } from '@/components/brand/Diamond';
import { SegmentedRadioGroup, type SegmentedOption } from '@/components/ui/segmented';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  InterfaceCoupling,
  MergeRunResult,
  MeshInterface,
  MeshSource,
  PartTransform,
} from '@/lib/api/types';
import { MERGE_BASE_CASE } from '@/lib/api/types';
import { useRunMerge } from '@/features/projects/useMeshes';
import { RunStep, buildPipelinePreview, type PlannedStep } from './MergeRunReport';

/**
 * AssemblyMergeDialog - the final "merge into the case" flow for the Assemble
 * tab. It opens from the single orange Merge CTA once at least one part has been
 * positioned, walks the (optional) interfaces, confirms, then runs the same
 * server pipeline as the "Merge meshes" flow - but carrying `transforms`, so each
 * positioned part is staged at its placement before mergeMeshes runs.
 *
 * Interfaces default to a NON-CONFORMAL coupling (nonConformalCouple),
 * which KEEPS both parts as separate meshes and interpolates the flow across the
 * touching patches. A per-interface selector switches an interface to a conformal
 * stitch (stitchMesh), which fuses the two patches into one internal interface.
 */

/** A per-interface draft (fields fill in as the user picks). */
interface InterfaceDraft {
  aMeshId: string;
  aPatch: string;
  bMeshId: string;
  bPatch: string;
  coupling: InterfaceCoupling;
}

/** The default coupling for a new interface: v12-native non-conformal. */
const DEFAULT_COUPLING: InterfaceCoupling = 'nonConformal';

const EMPTY_DRAFT: InterfaceDraft = {
  aMeshId: '',
  aPatch: '',
  bMeshId: '',
  bPatch: '',
  coupling: DEFAULT_COUPLING,
};

const isComplete = (d: InterfaceDraft) => !!(d.aMeshId && d.aPatch && d.bMeshId && d.bPatch);
const isBlank = (d: InterfaceDraft) => !d.aMeshId && !d.aPatch && !d.bMeshId && !d.bPatch;

/** The two coupling options, with copy + icon, shared by every interface row. */
const COUPLING_OPTIONS: SegmentedOption<InterfaceCoupling>[] = [
  { value: 'nonConformal', label: 'Non-conformal', icon: Link2 },
  { value: 'stitch', label: 'Conformal stitch', icon: Combine },
];

/** One-line consequence of each coupling, shown under the selector. */
const COUPLING_HELP: Record<InterfaceCoupling, string> = {
  nonConformal:
    'Keeps both parts as separate meshes. Flow interpolates across the interface (nonConformalCouple).',
  stitch:
    'Fuses the two patches into one internal interface (stitchMesh). The parts become a single combined mesh.',
};

/** Short chip label for a coupling, used in the confirm summary. */
const COUPLING_CHIP: Record<InterfaceCoupling, string> = {
  nonConformal: 'Non-conformal',
  stitch: 'Stitch',
};

type Step = 'connections' | 'confirm' | 'run';

export interface AssemblyMergeDialogProps {
  projectId: string;
  /** Sources in assembly order (index 0 = base; may be the project case mesh). */
  orderedMeshes: MeshSource[];
  /** The committed transform of each part the user explicitly repositioned. */
  transforms: PartTransform[];
  /** Pre-seeded interfaces (each coupled part's mating patch <-> base patch). */
  seedInterfaces?: InterfaceDraft[] | null;
  onClose: () => void;
}

export function AssemblyMergeDialog({
  projectId,
  orderedMeshes,
  transforms,
  seedInterfaces,
  onClose,
}: AssemblyMergeDialogProps) {
  const meshById = useMemo(
    () => new Map(orderedMeshes.map((m) => [m.id, m] as const)),
    [orderedMeshes],
  );
  // The base is the project case mesh when order[0] is the sentinel.
  const caseBase = orderedMeshes[0]?.id === MERGE_BASE_CASE;
  const [step, setStep] = useState<Step>('connections');
  const [interfaces, setInterfaces] = useState<InterfaceDraft[]>(() =>
    (seedInterfaces ?? []).filter(isComplete),
  );
  const [result, setResult] = useState<MergeRunResult | null>(null);

  const merge = useRunMerge(projectId);
  const running = merge.isPending;

  const completeInterfaces = useMemo<MeshInterface[]>(
    () =>
      interfaces.filter(isComplete).map((s) => ({
        aMeshId: s.aMeshId,
        aPatch: s.aPatch,
        bMeshId: s.bMeshId,
        bPatch: s.bPatch,
        coupling: s.coupling,
      })),
    [interfaces],
  );

  const plannedSteps = useMemo(
    () => buildPipelinePreview(orderedMeshes, completeInterfaces, meshById),
    [orderedMeshes, completeInterfaces, meshById],
  );

  const handleRun = async () => {
    setResult(null);
    setStep('run');
    try {
      const res = await merge.mutateAsync({
        order: orderedMeshes.map((m) => m.id),
        interfaces: completeInterfaces,
        transforms,
      });
      setResult(res);
      if (res.success) toast.success('Assembly merged.');
      else toast.error('Merge failed. See the report.');
    } catch (err) {
      setStep('confirm');
      toast.error(err instanceof ApiError ? err.message : 'Could not start the merge.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      {step === 'connections' && (
        <ConnectionsStep
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          interfaces={interfaces}
          onChange={setInterfaces}
          onCancel={onClose}
          onContinue={() => setStep('confirm')}
        />
      )}
      {step === 'confirm' && (
        <ConfirmStep
          orderedMeshes={orderedMeshes}
          interfaces={completeInterfaces}
          transformCount={transforms.length}
          caseBase={caseBase}
          meshById={meshById}
          plannedSteps={plannedSteps}
          onBack={() => setStep('connections')}
          onConfirm={() => void handleRun()}
        />
      )}
      {step === 'run' && (
        <RunStep
          running={running}
          result={result}
          plannedSteps={plannedSteps}
          onRetry={() => setStep('confirm')}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 1 - the (optional) interface editor, pre-seeded with the obvious pair. */
function ConnectionsStep({
  orderedMeshes,
  meshById,
  interfaces,
  onChange,
  onCancel,
  onContinue,
}: {
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  interfaces: InterfaceDraft[];
  onChange: (next: InterfaceDraft[]) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const update = (index: number, patch: Partial<InterfaceDraft>) =>
    onChange(interfaces.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const add = () => onChange([...interfaces, { ...EMPTY_DRAFT }]);
  const remove = (index: number) => onChange(interfaces.filter((_, i) => i !== index));
  const hasPartial = interfaces.some((s) => !isBlank(s) && !isComplete(s));

  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Couple the parts</DialogTitle>
        <DialogDescription>
          Connect a patch of one part to a coincident patch of another (for example the part you
          positioned against the base face it mounts on). Non-conformal keeps the parts as separate
          meshes and interpolates the flow across the interface; conformal stitch fuses them into
          one. Leave this empty to combine the parts without coupling them.
        </DialogDescription>
      </DialogHeader>

      {interfaces.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
            <Diamond size={14} className="text-primary" />
          </span>
          <p className="text-sm text-text-secondary">
            No interfaces yet. The parts will be combined side by side. Add one to couple a shared
            boundary.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {interfaces.map((draft, index) => (
            <InterfaceRow
              key={index}
              index={index}
              draft={draft}
              orderedMeshes={orderedMeshes}
              meshById={meshById}
              onUpdate={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}

      <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={add}>
        <Plus strokeWidth={1.75} aria-hidden="true" />
        Add an interface
      </Button>

      <DialogFooter className="mt-2 sm:items-center">
        {hasPartial && (
          <p className="mr-auto text-xs text-danger">Finish or remove the incomplete interface.</p>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onContinue} disabled={hasPartial}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One row of the interface editor: part A.patch <diamond> part B.patch + coupling. */
function InterfaceRow({
  index,
  draft,
  orderedMeshes,
  meshById,
  onUpdate,
  onRemove,
}: {
  index: number;
  draft: InterfaceDraft;
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  onUpdate: (patch: Partial<InterfaceDraft>) => void;
  onRemove: () => void;
}) {
  const partial = !isBlank(draft) && !isComplete(draft);
  const helpId = useId();
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SidePicker
          rowIndex={index}
          side="a"
          meshId={draft.aMeshId}
          patch={draft.aPatch}
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          onMeshChange={(aMeshId) => onUpdate({ aMeshId, aPatch: '' })}
          onPatchChange={(aPatch) => onUpdate({ aPatch })}
        />
        <span className="flex items-center justify-center pb-2 sm:pb-2.5" aria-hidden="true">
          <Diamond size={12} className="text-primary" />
        </span>
        <SidePicker
          rowIndex={index}
          side="b"
          meshId={draft.bMeshId}
          patch={draft.bPatch}
          orderedMeshes={orderedMeshes}
          meshById={meshById}
          onMeshChange={(bMeshId) => onUpdate({ bMeshId, bPatch: '' })}
          onPatchChange={(bPatch) => onUpdate({ bPatch })}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 self-end text-text-secondary hover:bg-danger-tint hover:text-danger"
              aria-label={`Remove interface ${index + 1}`}
              onClick={onRemove}
            >
              <Trash2 strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove interface</TooltipContent>
        </Tooltip>
      </div>
      {partial && <p className="mt-2 text-xs text-danger">Pick a part and a patch on both sides.</p>}

      {/* Coupling: how the two patches are connected (default non-conformal). */}
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs font-medium text-text-secondary">Coupling</span>
          <SegmentedRadioGroup
            name={`coupling-${index}`}
            ariaLabel={`Coupling for interface ${index + 1}`}
            value={draft.coupling}
            onChange={(coupling) => onUpdate({ coupling })}
            options={COUPLING_OPTIONS}
          />
        </div>
        <p id={helpId} className="text-xs text-text-secondary">
          {COUPLING_HELP[draft.coupling]}
        </p>
      </div>
    </li>
  );
}

/** One side of an interface: a part select and a patch select. */
function SidePicker({
  rowIndex,
  side,
  meshId,
  patch,
  orderedMeshes,
  meshById,
  onMeshChange,
  onPatchChange,
}: {
  rowIndex: number;
  side: 'a' | 'b';
  meshId: string;
  patch: string;
  orderedMeshes: MeshSource[];
  meshById: Map<string, MeshSource>;
  onMeshChange: (meshId: string) => void;
  onPatchChange: (patch: string) => void;
}) {
  const label = side === 'a' ? 'A' : 'B';
  const meshFieldId = `aiface-${rowIndex}-${side}-mesh`;
  const patchFieldId = `aiface-${rowIndex}-${side}-patch`;
  const patches = meshId ? (meshById.get(meshId)?.patches ?? []) : [];

  return (
    <div className="grid flex-1 grid-cols-2 gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={meshFieldId} className="text-xs font-medium text-text-secondary">
          Part {label}
        </label>
        <NativeSelect
          id={meshFieldId}
          value={meshId}
          onChange={(event) => onMeshChange(event.currentTarget.value)}
        >
          <option value="">Select part</option>
          {orderedMeshes.map((mesh) => (
            <option key={mesh.id} value={mesh.id}>
              {mesh.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={patchFieldId} className="text-xs font-medium text-text-secondary">
          Patch
        </label>
        <NativeSelect
          id={patchFieldId}
          value={patch}
          disabled={!meshId}
          onChange={(event) => onPatchChange(event.currentTarget.value)}
          className="font-mono"
        >
          <option value="">{meshId ? 'Select patch' : '-'}</option>
          {patches.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.type}, {p.nFaces})
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

/** Step 2 - confirm the (mesh-overwriting) merge and preview the pipeline. */
function ConfirmStep({
  orderedMeshes,
  interfaces,
  transformCount,
  caseBase,
  meshById,
  plannedSteps,
  onBack,
  onConfirm,
}: {
  orderedMeshes: MeshSource[];
  interfaces: MeshInterface[];
  transformCount: number;
  caseBase: boolean;
  meshById: Map<string, MeshSource>;
  plannedSteps: PlannedStep[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Merge the assembly?</DialogTitle>
        <DialogDescription>
          {caseBase ? (
            <>
              This positions each added part and couples them onto your project mesh (
              <code className="font-mono text-sm" translate="no">
                constant/polyMesh
              </code>
              ), which is backed up first. Its existing{' '}
              <code className="font-mono text-sm" translate="no">
                0/
              </code>{' '}
              physics is preserved.
            </>
          ) : (
            <>
              This positions each part, combines them, and overwrites any existing{' '}
              <code className="font-mono text-sm" translate="no">
                constant/polyMesh
              </code>
              . It cannot be undone.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Parts ({orderedMeshes.length})</dt>
          <dd>
            <ol className="flex flex-col gap-1">
              {orderedMeshes.map((mesh, index) => (
                <li key={mesh.id} className="flex items-center gap-2 text-sm text-text">
                  <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{mesh.name}</span>
                  {index === 0 && (
                    <span className="shrink-0 text-xs text-text-secondary">
                      ({caseBase ? 'project mesh' : 'base'})
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Positioned parts</dt>
          <dd className="text-sm text-text-secondary">
            {transformCount === 0
              ? 'None - parts are combined at their imported coordinates.'
              : `${transformCount} part${transformCount === 1 ? '' : 's'} staged at their placement before merging.`}
          </dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-text-secondary">Interfaces ({interfaces.length})</dt>
          <dd>
            {interfaces.length === 0 ? (
              <p className="text-sm text-text-secondary">
                None - the parts are combined without coupling.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {interfaces.map((iface, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-text">
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(iface.aMeshId)?.name}.{iface.aPatch}
                    </code>
                    <Diamond size={9} className="text-primary" />
                    <code className="font-mono text-xs" translate="no">
                      {meshById.get(iface.bMeshId)?.name}.{iface.bPatch}
                    </code>
                    <CouplingChip coupling={iface.coupling} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      <div className="rounded-md border border-border bg-bg/60 px-4 py-3">
        <p className="mb-2 text-xs font-medium text-text-secondary">Pipeline</p>
        <ol className="flex flex-col gap-1.5">
          {plannedSteps.map((meta, index) => (
            <li key={index} className="flex items-center gap-2.5 text-sm text-text">
              <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-border text-xs font-semibold tabular-nums text-text-secondary">
                {index + 1}
              </span>
              <span className="min-w-0 truncate">{meta.label}</span>
              {meta.tool && (
                <code className="ml-auto shrink-0 font-mono text-xs text-text-secondary" translate="no">
                  {meta.tool}
                </code>
              )}
            </li>
          ))}
        </ol>
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        {/* The single orange CTA of the assembly flow. */}
        <Button type="button" onClick={onConfirm}>
          <Workflow strokeWidth={1.75} aria-hidden="true" />
          Merge assembly
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** A small chip naming an interface's coupling (never colour alone). */
function CouplingChip({ coupling }: { coupling: InterfaceCoupling }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium',
        coupling === 'nonConformal'
          ? 'bg-primary-tint text-primary'
          : 'border border-border text-text-secondary',
      )}
    >
      {COUPLING_CHIP[coupling]}
    </span>
  );
}

export type { InterfaceDraft };
export default AssemblyMergeDialog;
