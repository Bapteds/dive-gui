import { useId } from 'react';
import { Check, Crosshair, MousePointerClick, RotateCw, Target, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Diamond } from '@/components/brand/Diamond';
import { cn } from '@/lib/utils';
import type { MeshSource } from '@/lib/api/types';
import type { HitTarget } from './placement';

/**
 * PlacementPanel - the right pane of the Assemble workspace: how the active part
 * mounts onto the base. The user picks the part's mating patch (its face that
 * meets the base), rolls it about the base mount normal, and sets an offset; the
 * canvas previews it live. Confirm commits the placement.
 *
 * The single orange CTA of the workspace is the final "Merge"; this per-part
 * Confirm is a blue (secondary) action, so the hierarchy stays: blue for the
 * step, orange for the one irreversible action.
 */

/** Shared styling for the native select (matches the token form vocabulary). */
const SELECT_CLASS =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

export interface PlacementPanelProps {
  /** The additional part being placed (carries its mating-patch options), or null. */
  activePart: MeshSource | null;
  matingPatch: string | null;
  onMatingPatchChange: (patch: string) => void;
  target: HitTarget | null;
  rollDeg: number;
  onRollDegChange: (deg: number) => void;
  offset: number;
  onOffsetChange: (offset: number) => void;
  /** The viewer has a valid live placement (a face is picked and a patch chosen). */
  canConfirm: boolean;
  onConfirm: () => void;
  /** Clear the in-progress pick + draft for the active part. */
  onClear: () => void;
  /** Whether the active part already has a committed placement (re-placing). */
  isPlaced: boolean;
}

export function PlacementPanel({
  activePart,
  matingPatch,
  onMatingPatchChange,
  target,
  rollDeg,
  onRollDegChange,
  offset,
  onOffsetChange,
  canConfirm,
  onConfirm,
  onClear,
  isPlaced,
}: PlacementPanelProps) {
  const patchSelectId = useId();
  const rollId = useId();

  if (!activePart) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 text-sm font-semibold text-text">Placement</h2>
        <div className="mt-4 flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-strong px-5 py-8 text-center">
          <span className="grid size-10 place-items-center rounded-md bg-primary-tint">
            <Target className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <p className="max-w-[16rem] text-sm text-text-secondary">
            Select an added part on the left to position it, or add one to start building the
            assembly.
          </p>
        </div>
      </div>
    );
  }

  const patches = activePart.patches;
  const hasPatches = patches.length > 0;
  const hasFace = !!target;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text" title={activePart.name}>
          Placing <span className="text-primary">{activePart.name}</span>
        </h2>
        {isPlaced && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-success-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-success">
            <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
            Placed
          </span>
        )}
      </div>

      {/* Step 1 - the base mount face (picked on the canvas). */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-text-secondary">1. Base mount face</span>
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
              <span className="min-w-0 flex-1 truncate">
                <code className="font-mono text-[0.8125rem] text-text" translate="no">
                  {target.patchName || 'face'}
                </code>
              </span>
              <span className="shrink-0 text-xs text-text-secondary">picked</span>
            </>
          ) : (
            <>
              <MousePointerClick className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0 flex-1">Click a face on the base part in the viewport.</span>
            </>
          )}
        </div>
      </div>

      {/* Step 2 - the part's mating patch (the face that meets the base). */}
      <div className="flex flex-col gap-2">
        <label htmlFor={patchSelectId} className="text-xs font-medium text-text-secondary">
          2. Mating patch on {activePart.name}
        </label>
        <select
          id={patchSelectId}
          value={matingPatch ?? ''}
          disabled={!hasPatches}
          onChange={(event) => onMatingPatchChange(event.currentTarget.value)}
          className={cn(SELECT_CLASS, 'font-mono')}
        >
          <option value="">{hasPatches ? 'Select patch' : 'No patches - auto-patch it first'}</option>
          {patches.map((patch) => (
            <option key={patch.name} value={patch.name}>
              {patch.name} ({patch.type}, {patch.nFaces})
            </option>
          ))}
        </select>
        {!hasPatches && (
          <p className="text-xs text-text-secondary">
            This part has no boundary patches yet. Split it into patches from its row on the left.
          </p>
        )}
      </div>

      {/* Step 3 - orient: roll about the mount normal + offset along it. */}
      <div className="flex flex-col gap-3">
        <span className="text-xs font-medium text-text-secondary">3. Orient</span>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label htmlFor={rollId} className="flex items-center gap-1.5 text-sm font-medium text-text">
              <RotateCw className="size-3.5 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
              Roll
            </label>
            <output htmlFor={rollId} className="text-sm tabular-nums text-text-secondary">
              {Math.round(rollDeg)}&deg;
            </output>
          </div>
          <input
            id={rollId}
            name="roll"
            type="range"
            min={0}
            max={360}
            step={1}
            value={rollDeg}
            disabled={!hasFace || !matingPatch}
            onChange={(event) => onRollDegChange(Number(event.currentTarget.value))}
            aria-valuetext={`${Math.round(rollDeg)} degrees`}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-border outline-none disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            style={{ accentColor: 'var(--color-accent)' }}
          />
          <p className="text-xs text-text-secondary">Rotates the part about the base mount normal.</p>
        </div>

        <Field
          label="Offset (m)"
          helperText="Gap along the mount normal. 0 means the faces touch (needed to stitch)."
        >
          <Input
            name="offset"
            type="number"
            inputMode="decimal"
            step={0.001}
            value={Number.isFinite(offset) ? offset : 0}
            disabled={!hasFace || !matingPatch}
            onChange={(event) => onOffsetChange(Number(event.currentTarget.value))}
            autoComplete="off"
            className="tabular-nums"
          />
        </Field>
      </div>

      {/* Actions - blue Confirm (the orange CTA is the workspace-level Merge). */}
      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          <Check strokeWidth={1.75} aria-hidden="true" />
          {isPlaced ? 'Update placement' : 'Confirm placement'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={!hasFace && rollDeg === 0 && offset === 0 && !matingPatch}
          onClick={onClear}
        >
          <X strokeWidth={1.75} aria-hidden="true" />
          Reset this placement
        </Button>
        {!canConfirm && (
          <p className="flex items-start gap-1.5 text-xs text-text-secondary">
            <Diamond size={8} className="mt-[0.3rem] shrink-0 text-primary" />
            <span>Pick a base face and a mating patch to place the part.</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default PlacementPanel;
