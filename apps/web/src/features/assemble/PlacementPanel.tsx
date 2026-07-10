import { useId } from 'react';
import {
  Crosshair,
  Link2,
  Move3d,
  MousePointerClick,
  RotateCcw,
  Rotate3d,
  Target,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup, type SegmentedOption } from '@/components/ui/segmented';
import { Diamond } from '@/components/brand/Diamond';
import { cn } from '@/lib/utils';
import type { MeshSource } from '@/lib/api/types';
import type { GizmoMode } from './AssemblyViewer';
import type { HitTarget } from './placement';

/**
 * PlacementPanel - the right pane of the Assemble workspace.
 *
 * Placement is OPTIONAL. The primary path is to COUPLE the active part to the
 * base: pick a base face (the patch it couples to) and the part's mating patch.
 * That defines the interface and NEVER moves the part, which keeps its imported
 * world position. Repositioning is an opt-in, collapsed section for the rare part
 * that is actually misaligned: a switch reveals a 6-DOF editor (a translate /
 * rotate gizmo toggle, numeric position + rotation fields, an optional
 * align-to-face starting point, and a reset), all writing the same transform.
 *
 * The single orange CTA lives in the workspace toolbar (Merge); every action here
 * is blue (secondary) or a low-emphasis ghost, so the hierarchy stays clear.
 */

/** Move / Rotate toggle for the gizmo. */
const MODE_OPTIONS: SegmentedOption<GizmoMode>[] = [
  { value: 'translate', label: 'Move', icon: Move3d },
  { value: 'rotate', label: 'Rotate', icon: Rotate3d },
];

export interface PlacementPanelProps {
  /** The added part being worked on (carries its mating-patch options), or null. */
  activePart: MeshSource | null;
  /** The base body's display name (for the coupling summary), or null. */
  baseName: string | null;
  matingPatch: string | null;
  onMatingPatchChange: (patch: string) => void;
  /** The picked base face (its patch is the coupling's base side), or null. */
  target: HitTarget | null;
  /** Clear the picked base face + mating patch for this part. */
  onClearCouple: () => void;
  /** Whether the user opted to reposition this part (reveals the 6-DOF editor). */
  reposition: boolean;
  onRepositionChange: (on: boolean) => void;
  gizmoMode: GizmoMode;
  onGizmoModeChange: (mode: GizmoMode) => void;
  /** Position X/Y/Z in metres (mesh frame). */
  position: [number, number, number];
  /** Rotation X/Y/Z in Euler degrees (mesh frame). */
  rotationDeg: [number, number, number];
  onPositionChange: (axis: 0 | 1 | 2, value: number) => void;
  onRotationChange: (axis: 0 | 1 | 2, value: number) => void;
  /** A base face + mating patch are picked, so "align to face" can be offered. */
  alignAvailable: boolean;
  onAlignToFace: () => void;
  /** Reset the part back to its imported position (identity transform). */
  onResetPosition: () => void;
  /** The part currently carries a non-identity transform (for the "Moved" chip). */
  isRepositioned: boolean;
}

export function PlacementPanel({
  activePart,
  baseName,
  matingPatch,
  onMatingPatchChange,
  target,
  onClearCouple,
  reposition,
  onRepositionChange,
  gizmoMode,
  onGizmoModeChange,
  position,
  rotationDeg,
  onPositionChange,
  onRotationChange,
  alignAvailable,
  onAlignToFace,
  onResetPosition,
  isRepositioned,
}: PlacementPanelProps) {
  const patchSelectId = useId();
  const repositionLabelId = useId();
  const repositionPanelId = useId();

  if (!activePart) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 text-sm font-semibold text-text">Placement</h2>
        <div className="mt-4 flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-strong px-5 py-8 text-center">
          <span className="grid size-10 place-items-center rounded-md bg-primary-tint">
            <Target className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <p className="max-w-[17rem] text-sm text-text-secondary">
            Parts keep their imported position. Select an added part, couple the touching patches, and
            merge. Only reposition a part if it is misaligned.
          </p>
        </div>
      </div>
    );
  }

  const patches = activePart.patches;
  const hasPatches = patches.length > 0;
  const hasFace = !!target;
  const isCoupled = hasFace && !!matingPatch;
  const hasCoupleDraft = hasFace || !!matingPatch;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text" title={activePart.name}>
          <span className="text-primary">{activePart.name}</span>
        </h2>
        {isCoupled && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-success-tint px-1.5 py-0.5 text-xs font-medium text-success">
            <Link2 className="size-3" strokeWidth={2.5} aria-hidden="true" />
            Coupled
          </span>
        )}
        {isRepositioned && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-tint px-1.5 py-0.5 text-xs font-medium text-accent-hover">
            <Move3d className="size-3" strokeWidth={2.5} aria-hidden="true" />
            Moved
          </span>
        )}
      </div>

      {/* Couple: pick a base face + the part's mating patch. This never moves the part. */}
      <section className="flex flex-col gap-3" aria-labelledby={`${patchSelectId}-couple`}>
        <div className="flex items-center justify-between gap-2">
          <h3 id={`${patchSelectId}-couple`} className="text-xs font-semibold text-text-secondary">
            Couple to base
          </h3>
          {hasCoupleDraft && (
            <button
              type="button"
              onClick={onClearCouple}
              className="inline-flex items-center gap-1 rounded-sm px-1 text-xs text-text-secondary transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            >
              <X className="size-3" strokeWidth={2} aria-hidden="true" />
              Clear
            </button>
          )}
        </div>

        {/* Base face (picked on the canvas). */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Base patch</span>
          <div
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm',
              hasFace ? 'border-primary/40 bg-primary-tint text-text' : 'border-border bg-bg text-text-secondary',
            )}
          >
            {hasFace ? (
              <>
                <Crosshair className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
                <code className="min-w-0 flex-1 truncate font-mono text-sm text-text" translate="no">
                  {target.patchName || 'face'}
                </code>
                <span className="shrink-0 text-xs text-text-secondary">picked</span>
              </>
            ) : (
              <>
                <MousePointerClick className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="min-w-0 flex-1">Click a face on the base in the viewport.</span>
              </>
            )}
          </div>
        </div>

        {/* Mating patch on the part. */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={patchSelectId} className="text-xs font-medium text-text-secondary">
            Mating patch on {activePart.name}
          </label>
          <NativeSelect
            id={patchSelectId}
            value={matingPatch ?? ''}
            disabled={!hasPatches}
            onChange={(event) => onMatingPatchChange(event.currentTarget.value)}
            className="font-mono"
          >
            <option value="">{hasPatches ? 'Select patch' : 'No patches - split it first'}</option>
            {patches.map((patch) => (
              <option key={patch.name} value={patch.name}>
                {patch.name} ({patch.type}, {patch.nFaces})
              </option>
            ))}
          </NativeSelect>
          {!hasPatches && (
            <p className="text-xs text-text-secondary">
              This part has no boundary patches yet. Split it into patches from its row on the left.
            </p>
          )}
        </div>

        <p className="flex items-start gap-1.5 text-xs text-text-secondary">
          <Diamond size={8} className="mt-[0.3rem] shrink-0 text-primary" />
          <span>
            {isCoupled ? (
              <>
                Couples <span className="font-medium text-text">{activePart.name}</span> to{' '}
                <span className="font-medium text-text">{baseName ?? 'the base'}</span> without moving it. The two
                patches must overlap.
              </>
            ) : (
              'Pick a base face and a mating patch to couple this part. It stays at its imported position.'
            )}
          </span>
        </p>
      </section>

      {/* Reposition: opt-in 6-DOF, collapsed by default. Only for a misaligned part. */}
      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-3">
          <span id={repositionLabelId} className="text-sm font-medium text-text">
            Reposition this part
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={reposition}
            aria-labelledby={repositionLabelId}
            aria-controls={repositionPanelId}
            onClick={() => onRepositionChange(!reposition)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
              reposition ? 'bg-primary' : 'bg-border-strong',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-block size-4 rounded-full bg-surface shadow-sm transition-transform duration-fast ease-out',
                reposition ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
        <p className="-mt-1 text-xs text-text-secondary">
          Only if the part is misaligned. Parts keep their imported position otherwise.
        </p>

        {reposition && (
          <div id={repositionPanelId} className="flex flex-col gap-4">
            {/* Gizmo mode. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs font-medium text-text-secondary">Gizmo</span>
              <SegmentedRadioGroup
                name="gizmo-mode"
                ariaLabel="Gizmo mode"
                value={gizmoMode}
                onChange={onGizmoModeChange}
                options={MODE_OPTIONS}
              />
            </div>

            <AxisTriplet
              legend="Position"
              unit="m"
              namePrefix="pos"
              values={position}
              step={0.001}
              onChange={onPositionChange}
            />
            <AxisTriplet
              legend="Rotation"
              unit="deg"
              namePrefix="rot"
              values={rotationDeg}
              step={1}
              onChange={onRotationChange}
            />

            <p className="text-xs text-text-secondary">
              Values are in the mesh coordinate frame. The gizmo, these fields, and the preview stay in sync.
            </p>

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={!alignAvailable}
                onClick={onAlignToFace}
              >
                <Wand2 strokeWidth={1.75} aria-hidden="true" />
                Align to base face
              </Button>
              <p className="text-xs text-text-secondary">
                {alignAvailable
                  ? 'A starting point that mates the mating patch to the picked base face. It aligns one face only, not a full nest.'
                  : 'Pick a base face and a mating patch to enable this starting point.'}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={!isRepositioned}
                onClick={onResetPosition}
              >
                <RotateCcw strokeWidth={1.75} aria-hidden="true" />
                Reset to imported position
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Round a value for a numeric field: fewer decimals for degrees than metres. */
function roundForInput(value: number, step: number): number {
  const decimals = step >= 1 ? 1 : 3;
  return Number(value.toFixed(decimals));
}

/** A labelled X/Y/Z triple of numeric inputs (a fieldset for screen readers). */
function AxisTriplet({
  legend,
  unit,
  namePrefix,
  values,
  step,
  onChange,
}: {
  legend: string;
  unit: string;
  namePrefix: string;
  values: [number, number, number];
  step: number;
  onChange: (axis: 0 | 1 | 2, value: number) => void;
}) {
  const axes = ['X', 'Y', 'Z'] as const;
  const groupId = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-text-secondary">
        {legend} <span className="font-normal">({unit})</span>
      </legend>
      <div className="grid grid-cols-3 gap-2">
        {axes.map((axis, index) => {
          const id = `${groupId}-${namePrefix}-${axis}`;
          const value = values[index];
          return (
            <div key={axis} className="flex items-center gap-1.5">
              <label
                htmlFor={id}
                className="w-3 shrink-0 text-center text-xs font-semibold text-text-secondary"
              >
                {axis}
              </label>
              <Input
                id={id}
                name={id}
                type="number"
                inputMode="decimal"
                step={step}
                value={Number.isFinite(value) ? roundForInput(value, step) : 0}
                onChange={(event) => onChange(index as 0 | 1 | 2, Number(event.currentTarget.value))}
                aria-label={`${legend} ${axis} in ${unit}`}
                autoComplete="off"
                className="h-9 min-w-0 px-2 tabular-nums"
              />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export default PlacementPanel;
