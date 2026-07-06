import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Container,
  Cylinder,
  Droplets,
  Fan,
  FilePlus2,
  FileSpreadsheet,
  Gauge,
  Loader2,
  SlidersHorizontal,
  SquarePen,
  Waves,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  DRIVING_MODE_LIBRARY,
  GRAVITY,
  OBJECT_TYPE_LIBRARY,
  OBJECT_TYPE_MODES,
  OBJECT_TYPE_TURBULENCE,
  type ApplyBoundaryConditionsRequest,
  type ApplyBoundaryConditionsResult,
  type DrivingMode,
  type ImportStep,
  type ObjectType,
} from '@dive/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type { MeshPatch } from '@/lib/api/types';
import { useMeshManifestQuery } from '@/features/visualize/useMesh';
import { useApplyBoundaryConditions } from '@/features/projects/useBoundaryConditions';

/**
 * BoundaryConditionDialog - the guided "what is this mesh?" overlay, opened right
 * after a mesh import lands a constant/polyMesh. It writes the physically correct
 * inlet / outlet / wall boundary conditions into the case's 0/ fields from the
 * DIVE turbine templates:
 *
 *  1. type    - what the mesh is (Turbine / Pipe / DraftTube / Chamber).
 *  2. mode    - how the flow is driven (pressure / flow-rate), filtered by type.
 *               Skipped when the type offers only one mode (Turbine, DraftTube).
 *  3. patches - which real mesh patch is the inlet / outlet; the rest are walls.
 *  4. values  - the operating point (net head H or flow rate Q, + turbulence);
 *               a DraftTube uploads its runner-exit CSV profile here instead.
 *  5. run     - apply, then a concise report (+ the CSV conversion log).
 *
 * It is skippable at any point (Escape / overlay / "Configure later"); every step
 * shares one width so the box never resizes between steps.
 */

const TYPE_ICON: Record<ObjectType, LucideIcon> = {
  turbine: Fan,
  pipe: Cylinder,
  draftTube: Waves,
  chamber: Container,
};

const MODE_ICON: Record<DrivingMode, LucideIcon> = {
  pressure: Gauge,
  flowRate: Droplets,
  csvProfile: FileSpreadsheet,
};

/** Format a number without trailing float noise (490.5, not 490.500001). */
function fmt(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** Read and clear a file input, returning the chosen file (or null). */
function takeFile(input: HTMLInputElement | null): File | null {
  if (!input?.files || input.files.length === 0) return null;
  const file = input.files[0];
  input.value = '';
  return file;
}

/** Guess a patch by name (first match), falling back to a positional default. */
function guessPatch(patches: MeshPatch[], re: RegExp, fallbackIndex: number): string {
  const named = patches.find((patch) => re.test(patch.name));
  return named?.name ?? patches[fallbackIndex]?.name ?? '';
}

type Step = 'type' | 'mode' | 'patches' | 'values' | 'run';

interface BoundaryConditionDialogProps {
  projectId: string;
  /** Close the whole flow. */
  onClose: () => void;
}

export function BoundaryConditionDialog({ projectId, onClose }: BoundaryConditionDialogProps) {
  const [step, setStep] = useState<Step>('type');
  const [objectType, setObjectType] = useState<ObjectType | null>(null);
  const [mode, setMode] = useState<DrivingMode | null>(null);
  const [inlet, setInlet] = useState('');
  const [outlet, setOutlet] = useState('');
  // Operating point. Turbulence knobs are null until edited: a null value follows
  // the object type's default, so switching type re-defaults them automatically.
  const [head, setHead] = useState('');
  const [flowRate, setFlowRate] = useState('');
  const [intensity, setIntensity] = useState<string | null>(null);
  const [mixingLength, setMixingLength] = useState<string | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [result, setResult] = useState<ApplyBoundaryConditionsResult | null>(null);

  const manifest = useMeshManifestQuery(projectId);
  const patches = useMemo(() => manifest.data?.patches ?? [], [manifest.data]);
  const apply = useApplyBoundaryConditions(projectId);
  const applying = apply.isPending;

  const turb = objectType ? OBJECT_TYPE_TURBULENCE[objectType] : null;
  const intensityValue = intensity ?? (turb ? String(turb.intensity) : '');
  const mixingLengthValue = mixingLength ?? (turb ? String(turb.mixingLength) : '');

  const pickType = (next: ObjectType) => {
    setObjectType(next);
    const modes = OBJECT_TYPE_MODES[next];
    setMode(modes.length === 1 ? modes[0] : null);
  };

  const continueFromType = () => {
    if (!objectType) return;
    setStep(OBJECT_TYPE_MODES[objectType].length === 1 ? 'patches' : 'mode');
  };

  // Default the inlet / outlet from the patch names once the manifest loads, so the
  // assignment step opens pre-filled whichever way the user reaches it (a
  // single-mode type skips the driving step and lands here directly).
  useEffect(() => {
    if (patches.length > 0 && !inlet && !outlet) {
      setInlet(guessPatch(patches, /inlet|in$/i, 0));
      setOutlet(guessPatch(patches, /outlet|out$/i, patches.length - 1));
    }
  }, [patches, inlet, outlet]);

  const wallNames = patches
    .map((patch) => patch.name)
    .filter((name) => name !== inlet && name !== outlet);

  const handleApply = async () => {
    if (!objectType || !mode) return;
    const values: ApplyBoundaryConditionsRequest['values'] = {};
    if (mode === 'pressure' && head) values.head = Number(head);
    if (mode === 'flowRate' && flowRate) values.flowRate = Number(flowRate);
    if (intensityValue) values.intensity = Number(intensityValue);
    if (mixingLengthValue) values.mixingLength = Number(mixingLengthValue);

    const request: ApplyBoundaryConditionsRequest = {
      objectType,
      mode,
      inlet,
      outlet,
      walls: wallNames,
      values,
    };

    setResult(null);
    setStep('run');
    try {
      const res = await apply.mutateAsync({ request, csv: mode === 'csvProfile' ? csvFile : null });
      setResult(res);
      toast.success('Boundary conditions applied.');
    } catch (err) {
      // Validation / transport error: return to the values step to correct + retry.
      setStep('values');
      toast.error(err instanceof ApiError ? err.message : 'Could not apply the boundary conditions.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !applying) onClose();
      }}
    >
      {step === 'type' && (
        <TypeStep
          objectType={objectType}
          onPick={pickType}
          onContinue={continueFromType}
          onSkip={onClose}
        />
      )}

      {step === 'mode' && objectType && (
        <ModeStep
          objectType={objectType}
          mode={mode}
          onPick={setMode}
          onBack={() => setStep('type')}
          onContinue={() => setStep('patches')}
        />
      )}

      {step === 'patches' && objectType && (
        <PatchesStep
          query={manifest}
          patches={patches}
          inlet={inlet}
          outlet={outlet}
          wallNames={wallNames}
          onInletChange={setInlet}
          onOutletChange={setOutlet}
          onBack={() => setStep(OBJECT_TYPE_MODES[objectType].length === 1 ? 'type' : 'mode')}
          onContinue={() => setStep('values')}
        />
      )}

      {step === 'values' && objectType && mode && (
        <ValuesStep
          objectType={objectType}
          mode={mode}
          head={head}
          flowRate={flowRate}
          intensity={intensityValue}
          mixingLength={mixingLengthValue}
          csvFile={csvFile}
          onHeadChange={setHead}
          onFlowRateChange={setFlowRate}
          onIntensityChange={setIntensity}
          onMixingLengthChange={setMixingLength}
          onCsvChange={setCsvFile}
          onBack={() => setStep('patches')}
          onApply={() => void handleApply()}
        />
      )}

      {step === 'run' && objectType && (
        <RunStep
          projectId={projectId}
          applying={applying}
          result={result}
          onRetry={() => setStep('values')}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** A selectable card wrapping a native radio (arrow-key navigable, blue when on). */
function OptionCard({
  name,
  value,
  checked,
  icon: Icon,
  label,
  description,
  onSelect,
}: {
  name: string;
  value: string;
  checked: boolean;
  icon: LucideIcon;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors duration-fast ease-out',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-focus-ring',
        checked ? 'border-primary bg-primary-tint' : 'border-border hover:bg-bg',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-md',
          checked ? 'bg-primary text-white' : 'bg-primary-tint text-primary',
        )}
      >
        <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-text">{label}</span>
        <span className="text-xs leading-relaxed text-text-secondary">{description}</span>
      </span>
      {checked && (
        <CheckCircle2
          className="absolute right-3 top-3 size-4 text-primary"
          strokeWidth={2}
          aria-hidden="true"
        />
      )}
    </label>
  );
}

/** Step 1 - what the mesh is. */
function TypeStep({
  objectType,
  onPick,
  onContinue,
  onSkip,
}: {
  objectType: ObjectType | null;
  onPick: (type: ObjectType) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>What is this mesh?</DialogTitle>
        <DialogDescription>
          Pick the component this mesh represents. It sets the inlet, outlet and wall boundary
          conditions written to the case&rsquo;s{' '}
          <code className="font-mono text-[0.8125rem]" translate="no">
            0/
          </code>{' '}
          fields. You can configure it later instead.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="min-w-0">
        <legend className="sr-only">Object type</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {OBJECT_TYPE_LIBRARY.map((info) => (
            <OptionCard
              key={info.id}
              name="objectType"
              value={info.id}
              checked={objectType === info.id}
              icon={TYPE_ICON[info.id]}
              label={info.label}
              description={info.summary}
              onSelect={() => onPick(info.id)}
            />
          ))}
        </div>
      </fieldset>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onSkip}>
          Configure later
        </Button>
        <Button type="button" onClick={onContinue} disabled={!objectType}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 2 - how the flow is driven (only for types with more than one mode). */
function ModeStep({
  objectType,
  mode,
  onPick,
  onBack,
  onContinue,
}: {
  objectType: ObjectType;
  mode: DrivingMode | null;
  onPick: (mode: DrivingMode) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const modes = OBJECT_TYPE_MODES[objectType];

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>How is the flow driven?</DialogTitle>
        <DialogDescription>
          Pressure-driven imposes the head and lets the flow rate settle; flow-rate-driven imposes Q.
          The outlet stays the single static-pressure reference either way.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="min-w-0">
        <legend className="sr-only">Driving mode</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {modes.map((id) => {
            const info = DRIVING_MODE_LIBRARY[id];
            return (
              <OptionCard
                key={id}
                name="drivingMode"
                value={id}
                checked={mode === id}
                icon={MODE_ICON[id]}
                label={info.label}
                description={info.summary}
                onSelect={() => onPick(id)}
              />
            );
          })}
        </div>
      </fieldset>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
          Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={!mode}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** A labeled native select of patch names. */
function PatchSelect({
  id,
  label,
  value,
  patches,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  patches: MeshPatch[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 font-mono text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {patches.map((patch) => (
          <option key={patch.name} value={patch.name}>
            {patch.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Step 3 - assign the inlet / outlet patches; the rest become walls. */
function PatchesStep({
  query,
  patches,
  inlet,
  outlet,
  wallNames,
  onInletChange,
  onOutletChange,
  onBack,
  onContinue,
}: {
  query: ReturnType<typeof useMeshManifestQuery>;
  patches: MeshPatch[];
  inlet: string;
  outlet: string;
  wallNames: string[];
  onInletChange: (value: string) => void;
  onOutletChange: (value: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const sameInOut = !!inlet && inlet === outlet;
  const ready = !!inlet && !!outlet && !sameInOut;

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Assign the boundary patches</DialogTitle>
        <DialogDescription>
          Choose which patch is the inlet and which is the outlet. Every other patch becomes a
          no-slip wall.
        </DialogDescription>
      </DialogHeader>

      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-9 w-full rounded-sm" />
          <Skeleton className="h-9 w-full rounded-sm" />
        </div>
      ) : query.isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-text">We could not read the mesh patches.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void query.refetch()}
            loading={query.isRefetching}
            className="shrink-0"
          >
            Try again
          </Button>
        </div>
      ) : patches.length < 2 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint">
            <Diamond size={14} className="text-primary" />
          </span>
          <p className="text-sm text-text-secondary">
            This mesh has fewer than two named patches, so it has no separate inlet and outlet. Split
            the boundary from the Visualize tab first, then set the conditions.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <PatchSelect
              id="bc-inlet"
              label="Inlet"
              value={inlet}
              patches={patches}
              onChange={onInletChange}
            />
            <PatchSelect
              id="bc-outlet"
              label="Outlet"
              value={outlet}
              patches={patches}
              onChange={onOutletChange}
            />
          </div>

          {sameInOut && (
            <p role="alert" className="text-xs text-danger">
              The inlet and outlet must be different patches.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">
              Walls ({wallNames.length})
            </span>
            {wallNames.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {wallNames.map((name) => (
                  <li
                    key={name}
                    className="rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-xs text-text-secondary"
                    translate="no"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-secondary">
                No wall patches: every patch is the inlet or the outlet.
              </p>
            )}
          </div>
        </div>
      )}

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
          Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={!ready}>
          Continue
          <ChevronRight strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** A labeled number input with optional helper text. */
function NumberField({
  id,
  label,
  unit,
  value,
  onChange,
  step,
  helper,
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
  helper?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
        {unit && <span className="ml-1 font-normal text-text-secondary/80">[{unit}]</span>}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step ?? 'any'}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-describedby={helper ? `${id}-help` : undefined}
        className="font-mono tabular-nums"
      />
      {helper && (
        <p id={`${id}-help`} className="text-xs text-text-secondary">
          {helper}
        </p>
      )}
    </div>
  );
}

/** Step 4 - the operating point (or the CSV profile for a draft tube). */
function ValuesStep({
  objectType,
  mode,
  head,
  flowRate,
  intensity,
  mixingLength,
  csvFile,
  onHeadChange,
  onFlowRateChange,
  onIntensityChange,
  onMixingLengthChange,
  onCsvChange,
  onBack,
  onApply,
}: {
  objectType: ObjectType;
  mode: DrivingMode;
  head: string;
  flowRate: string;
  intensity: string;
  mixingLength: string;
  csvFile: File | null;
  onHeadChange: (value: string) => void;
  onFlowRateChange: (value: string) => void;
  onIntensityChange: (value: string) => void;
  onMixingLengthChange: (value: string) => void;
  onCsvChange: (file: File | null) => void;
  onBack: () => void;
  onApply: () => void;
}) {
  const csvInputRef = useRef<HTMLInputElement>(null);

  const headNum = Number(head);
  const p0Helper =
    head && headNum > 0 ? `p0 = 9.81 x ${fmt(headNum)} = ${fmt(GRAVITY * headNum)} m2/s2 (kinematic)` : undefined;

  const ready =
    (mode === 'pressure' && !!head && headNum > 0) ||
    (mode === 'flowRate' && !!flowRate && Number(flowRate) > 0) ||
    (mode === 'csvProfile' && !!csvFile);

  return (
    <DialogContent className="max-w-2xl overscroll-contain">
      <DialogHeader>
        <DialogTitle>Operating point</DialogTitle>
        <DialogDescription>
          {mode === 'csvProfile'
            ? 'Upload the runner-exit profile as a CSV. It is mapped onto the inlet; the turbulence values below are the fallback when the CSV has no k / omega column.'
            : 'Set the driving value and the inlet turbulence. You can refine everything later in the case files.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {mode === 'pressure' && (
          <NumberField
            id="bc-head"
            label="Net head H"
            unit="m"
            value={head}
            onChange={onHeadChange}
            helper={p0Helper}
          />
        )}

        {mode === 'flowRate' && (
          <NumberField
            id="bc-flowrate"
            label="Volumetric flow rate Q"
            unit="m3/s"
            value={flowRate}
            onChange={onFlowRateChange}
          />
        )}

        {mode === 'csvProfile' && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-secondary">Runner-exit profile</span>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => onCsvChange(takeFile(event.currentTarget))}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={() => csvInputRef.current?.click()}
              >
                <FilePlus2 strokeWidth={1.75} aria-hidden="true" />
                {csvFile ? 'Replace CSV' : 'Add CSV profile'}
              </Button>
              {csvFile ? (
                <span
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-sm text-text"
                  translate="no"
                >
                  <FileSpreadsheet
                    className="size-4 shrink-0 text-primary"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="truncate">{csvFile.name}</span>
                </span>
              ) : (
                <span className="text-xs text-text-secondary">
                  Columns x, y, z, Ux, Uy, Uz (k, omega optional).
                </span>
              )}
            </div>
          </div>
        )}

        {/* Turbulence: sensible defaults per component; refine if needed. */}
        <div className="rounded-md border border-border bg-bg/60 px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal
              className="size-3.5 text-text-secondary"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-text-secondary">
              Inlet turbulence
              {objectType === 'draftTube' && ' (fallback)'}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="bc-intensity"
              label="Turbulent intensity"
              value={intensity}
              step="0.01"
              onChange={onIntensityChange}
              helper="Fraction, e.g. 0.05 = 5%."
            />
            <NumberField
              id="bc-mixing-length"
              label="Mixing length"
              unit="m"
              value={mixingLength}
              onChange={onMixingLengthChange}
              helper="About 0.07 of the hydraulic diameter."
            />
          </div>
        </div>
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
          Back
        </Button>
        <Button type="button" onClick={onApply} disabled={!ready}>
          Apply boundary conditions
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 5 - the applying state, then the report. */
function RunStep({
  projectId,
  applying,
  result,
  onRetry,
  onClose,
}: {
  projectId: string;
  applying: boolean;
  result: ApplyBoundaryConditionsResult | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  if (applying || !result) {
    return (
      <DialogContent className="max-w-2xl overscroll-contain">
        <DialogHeader>
          <DialogTitle>Applying</DialogTitle>
          <DialogDescription>
            Writing the boundary conditions into the case&rsquo;s fields.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 py-2" role="status" aria-live="polite">
          <Loader2 className="size-5 animate-spin text-primary" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-sm text-text">Applying boundary conditions&hellip;</span>
        </div>
      </DialogContent>
    );
  }

  const { applied } = result;

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain">
      <DialogHeader>
        <DialogTitle>Boundary conditions applied</DialogTitle>
        <DialogDescription>
          The inlet, outlet and walls now carry the {OBJECT_TYPE_LIBRARY.find((info) => info.id === applied.objectType)?.label ?? applied.objectType}{' '}
          conditions. Refine the values any time in the case files.
        </DialogDescription>
      </DialogHeader>

      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-success/40 bg-success-tint px-4 py-3 text-sm text-text"
      >
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.75} aria-hidden="true" />
        <span>
          Updated {applied.fields.length} field{applied.fields.length === 1 ? '' : 's'} across the
          inlet, outlet and {applied.walls.length} wall
          {applied.walls.length === 1 ? '' : 's'}.
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <SummaryRow term="Inlet" value={applied.inlet} mono />
        <SummaryRow term="Outlet" value={applied.outlet} mono />
        <SummaryRow term="Driving" value={DRIVING_MODE_LIBRARY[applied.mode].label} />
        {applied.p0 !== undefined && (
          <SummaryRow term="Total pressure p0" value={`${fmt(applied.p0)} m2/s2`} />
        )}
      </dl>

      {result.notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {result.notes.map((note, index) => (
            <li key={index} className="flex items-start gap-2 text-xs text-text-secondary">
              <Diamond size={8} className="mt-[0.3rem] text-primary" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      {result.csvSteps && result.csvSteps.length > 0 && <CsvReport steps={result.csvSteps} />}

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onRetry}>
          <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
          Adjust
        </Button>
        <Button asChild variant="secondary">
          <Link to={`/projects/${projectId}/edit`}>
            <SquarePen strokeWidth={1.75} aria-hidden="true" />
            Open files
          </Link>
        </Button>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** One term / value row of the applied-conditions summary. */
function SummaryRow({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-1.5">
      <dt className="text-text-secondary">{term}</dt>
      <dd className={cn('text-text', mono && 'font-mono')} translate={mono ? 'no' : undefined}>
        {value}
      </dd>
    </div>
  );
}

/** The CSV -> boundaryData conversion report (draft tube). Shows failures inline. */
function CsvReport({ steps }: { steps: ImportStep[] }) {
  return (
    <div className="rounded-md border border-border">
      <p className="border-b border-border px-3 py-2 text-xs font-medium text-text-secondary">
        Inlet profile (CSV to boundaryData)
      </p>
      <ul className="divide-y divide-border">
        {steps.map((step, index) => {
          const failed = step.status === 'failed';
          return (
            <li key={index} className="flex flex-col gap-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {failed ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                    <XCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    Failed
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                    <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    OK
                  </span>
                )}
                <span className="text-sm text-text">{step.label}</span>
              </div>
              {failed && step.stderr.trim().length > 0 && (
                <pre
                  className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-sm bg-bg px-2 py-1.5 font-mono text-xs text-danger"
                  translate="no"
                >
                  {step.stderr}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
