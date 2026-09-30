import { useEffect, useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Save } from 'lucide-react';
import {
  VORTEX_VELOCITY_FIELDS,
  type CfdCriteriaSettings,
  type ConvergenceMethod,
  type VortexVelocityField,
} from '@dive/shared';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { ErrorState } from '@/components/common/ErrorState';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { RadioCardGroup, type RadioCardItem } from './RadioCardGroup';
import { useCriteriaQuery, useSaveCriteria } from './useCriteria';

/**
 * ConvergenceSettings - the "Convergence criteria" section of the solver
 * configuration panel (WS-G, spec 2026-09-30-solver-convergence-vorticity-design).
 *
 * An inline disclosure (not a modal): collapsed it states the current criterion;
 * expanded it edits the method (the user's SimplePDropConvergence / robust
 * convergenceControl tools, or residuals only), its settings with units and help,
 * the inlet / outlet patches, and the vortex metrics. One secondary "Save criteria"
 * button: the zone's single orange CTA stays "Run solver" (brain/design/
 * design-system.md section 6). Every control is locked while a run is active.
 */

const METHOD_LABELS: Record<ConvergenceMethod, string> = {
  simplePDrop: 'Pressure drop, simple (default)',
  robust: 'Pressure drop, robust',
  residuals: 'Residuals only',
};

const METHOD_ITEMS: RadioCardItem[] = [
  {
    id: 'simplePDrop',
    label: METHOD_LABELS.simplePDrop,
    mono: 'SimplePDropConvergence',
    summary: 'Stops when Δp₀ stays within a band around its trailing mean for N iterations.',
  },
  {
    id: 'robust',
    label: METHOD_LABELS.robust,
    mono: 'convergenceControl',
    summary:
      'Stops when the windowed mean and trend settle and the residuals pass a gate. Disables residualControl.',
  },
  {
    id: 'residuals',
    label: METHOD_LABELS.residuals,
    mono: 'residualControl',
    summary: 'OpenFOAM residual tolerances of system/fvSolution only.',
  },
];

/** How one numeric field is shown, parsed and validated. */
interface NumberFieldSpec {
  label: string;
  unit: string;
  help?: string;
  integer?: boolean;
  min: number;
  /** min is exclusive (value must be > min). */
  exclusive?: boolean;
  max: number;
  /** Displayed value = stored value x scale (e.g. 100 for a fraction shown in %). */
  scale?: number;
}

type FieldKey =
  | 'window'
  | 'devTol'
  | 'nPass'
  | 'W'
  | 'tolMean'
  | 'K'
  | 'resTol'
  | 'rho'
  | 'qThreshold'
  | 'wallDistance'
  | 'qCrit'
  | 'vMin'
  | 'interval';

const FIELDS: Record<FieldKey, NumberFieldSpec> = {
  window: {
    label: 'Trailing window',
    unit: 'iterations',
    help: 'Iterations averaged into the trailing mean.',
    integer: true,
    min: 2,
    max: 100000,
  },
  devTol: {
    label: 'Deviation band',
    unit: '± %',
    help: 'Allowed deviation of Δp₀ from the trailing mean.',
    min: 0,
    exclusive: true,
    max: 100,
    scale: 100,
  },
  nPass: {
    label: 'Consecutive iterations',
    unit: 'iterations',
    help: 'Iterations in a row that must stay inside the band.',
    integer: true,
    min: 1,
    max: 1000000,
  },
  W: {
    label: 'Check window',
    unit: 'iterations',
    help: 'Averaging window; one check every W iterations.',
    integer: true,
    min: 2,
    max: 100000,
  },
  tolMean: {
    label: 'Mean tolerance',
    unit: 'Pa',
    help: 'Largest drift of the windowed mean, and of the trend over the window.',
    min: 0,
    exclusive: true,
    max: 1e9,
  },
  K: {
    label: 'Consecutive checks',
    unit: 'checks',
    help: 'Passing checks in a row required.',
    integer: true,
    min: 1,
    max: 1000,
  },
  resTol: {
    label: 'Residual gate',
    unit: 'max initial residual',
    help: "Set it just above your case's residual floor, read on the residual chart; below it the run rides to endTime.",
    min: 0,
    exclusive: true,
    max: 1,
  },
  rho: {
    label: 'Density',
    unit: 'kg/m³',
    help: 'Converts the kinematic pressure to Pa and the head to m (water: 1000).',
    min: 0,
    exclusive: true,
    max: 100000,
  },
  qThreshold: {
    label: 'Q threshold',
    unit: '1/s²',
    help: 'Cells with Q above it count in the vortex volume.',
    min: 0,
    max: 1e30,
  },
  wallDistance: {
    label: 'Wall distance',
    unit: 'm',
    help: 'The masked volume ignores cells closer to a wall (near-wall shear).',
    min: 0,
    max: 1e6,
  },
  qCrit: {
    label: 'Q core threshold',
    unit: '1/s²',
    help: 'Cells with Q at or above it form the core of the RMS vorticity. Keep it for every variant.',
    min: 0,
    max: 1e30,
  },
  vMin: {
    label: 'Minimum cell volume',
    unit: 'm³',
    help: 'Core cells need a larger volume (excludes boundary-layer cells). 0 = no filter.',
    min: 0,
    max: 1e6,
  },
  interval: {
    label: 'Evaluate every',
    unit: 'iterations',
    help: 'Also evaluated at every write time.',
    integer: true,
    min: 1,
    max: 1000000,
  },
};

/** Editable form state: numbers as the strings the user typed. */
interface FormState {
  method: ConvergenceMethod;
  inletPatch: string;
  outletPatch: string;
  vortexEnabled: boolean;
  velocityField: VortexVelocityField;
  writeFields: boolean;
  values: Record<FieldKey, string>;
}

/** Display a stored number (scaled) without float noise. */
function display(value: number, scale = 1): string {
  return String(Number((value * scale).toPrecision(12)));
}

function toForm(c: CfdCriteriaSettings): FormState {
  const f = FIELDS;
  return {
    method: c.convergence.method,
    inletPatch: c.convergence.inletPatch,
    outletPatch: c.convergence.outletPatch,
    vortexEnabled: c.vortex.enabled,
    velocityField: c.vortex.velocityField,
    writeFields: c.vortex.writeFields,
    values: {
      window: display(c.convergence.simplePDrop.window),
      devTol: display(c.convergence.simplePDrop.devTol, f.devTol.scale),
      nPass: display(c.convergence.simplePDrop.nPass),
      W: display(c.convergence.robust.W),
      tolMean: display(c.convergence.robust.tolMean),
      K: display(c.convergence.robust.K),
      resTol: display(c.convergence.robust.resTol),
      rho: display(c.convergence.rho),
      qThreshold: display(c.vortex.qThreshold),
      wallDistance: display(c.vortex.wallDistance),
      qCrit: display(c.vortex.qCrit),
      vMin: display(c.vortex.vMin),
      interval: display(c.vortex.interval),
    },
  };
}

/** Validate one field: the stored number, or an error message. */
function parseField(key: FieldKey, raw: string): { value: number } | { error: string } {
  const spec = FIELDS[key];
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) return { error: 'Enter a number.' };
  if (spec.integer && !Number.isInteger(n)) return { error: 'Enter a whole number.' };
  if (spec.exclusive ? n <= spec.min : n < spec.min) {
    return { error: spec.exclusive ? `Enter a value above ${spec.min}.` : `Enter a value of at least ${spec.min}.` };
  }
  if (n > spec.max) return { error: `Enter a value of at most ${spec.max}.` };
  return { value: n / (spec.scale ?? 1) };
}

/** The fields that matter for the current form (hidden ones are not validated). */
function visibleFields(form: FormState): FieldKey[] {
  const keys: FieldKey[] = [];
  if (form.method === 'simplePDrop') keys.push('window', 'devTol', 'nPass');
  if (form.method === 'robust') keys.push('W', 'tolMean', 'K', 'resTol');
  keys.push('rho');
  if (form.vortexEnabled) keys.push('qThreshold', 'wallDistance', 'qCrit', 'vMin', 'interval');
  return keys;
}

/** Build the settings to save, or the per-field errors. */
function fromForm(
  form: FormState,
  base: CfdCriteriaSettings,
): { settings: CfdCriteriaSettings } | { errors: Partial<Record<FieldKey, string>> } {
  const errors: Partial<Record<FieldKey, string>> = {};
  const values = {} as Record<FieldKey, number>;
  const shown = new Set(visibleFields(form));
  for (const key of Object.keys(FIELDS) as FieldKey[]) {
    const parsed = parseField(key, form.values[key]);
    if ('error' in parsed) {
      if (shown.has(key)) errors[key] = parsed.error;
      continue;
    }
    values[key] = parsed.value;
  }
  if (Object.keys(errors).length > 0) return { errors };
  // A hidden field that does not parse keeps its saved value.
  const pick = (key: FieldKey, fallback: number) => values[key] ?? fallback;
  const c = base.convergence;
  const v = base.vortex;
  return {
    settings: {
      convergence: {
        method: form.method,
        inletPatch: form.inletPatch,
        outletPatch: form.outletPatch,
        rho: pick('rho', c.rho),
        simplePDrop: {
          window: pick('window', c.simplePDrop.window),
          devTol: pick('devTol', c.simplePDrop.devTol),
          nPass: pick('nPass', c.simplePDrop.nPass),
        },
        robust: {
          W: pick('W', c.robust.W),
          tolMean: pick('tolMean', c.robust.tolMean),
          K: pick('K', c.robust.K),
          resTol: pick('resTol', c.robust.resTol),
        },
      },
      vortex: {
        enabled: form.vortexEnabled,
        velocityField: form.velocityField,
        qThreshold: pick('qThreshold', v.qThreshold),
        wallDistance: pick('wallDistance', v.wallDistance),
        qCrit: pick('qCrit', v.qCrit),
        vMin: pick('vMin', v.vMin),
        interval: pick('interval', v.interval),
        writeFields: form.writeFields,
      },
    },
  };
}

/** One-line state of the criteria shown on the collapsed header. */
function summaryOf(c: CfdCriteriaSettings): string {
  const method = METHOD_LABELS[c.convergence.method].replace(' (default)', '');
  return `${method}, vortex metrics ${c.vortex.enabled ? 'on' : 'off'}`;
}

export function ConvergenceSettings({ projectId, active }: { projectId: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const query = useCriteriaQuery(projectId);
  const bodyId = useId();

  return (
    <section className="rounded-md border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left',
          'transition-colors duration-fast ease-out hover:bg-bg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold text-text">Convergence criteria</span>
          {query.data && (
            <span className="truncate text-xs text-text-secondary">{summaryOf(query.data.criteria)}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-text-secondary transition-transform duration-fast ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div id={bodyId} className="border-t border-border p-3">
          {query.isPending ? (
            <div className="flex flex-col gap-3" role="status" aria-live="polite">
              <span className="sr-only">Loading the convergence criteria</span>
              <div className="h-20 animate-pulse rounded-md bg-bg" />
              <div className="h-10 w-2/3 animate-pulse rounded-sm bg-bg" />
            </div>
          ) : query.isError ? (
            <ErrorState
              title="We could not load the convergence criteria."
              description="Check your connection and try again."
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : !query.data.applicable ? (
            <p className="text-sm text-text-secondary">
              Convergence criteria apply to steady incompressible solvers (simpleFoam).
            </p>
          ) : (
            <CriteriaForm
              projectId={projectId}
              active={active}
              criteria={query.data.criteria}
              patches={query.data.patches}
              installed={query.data.installed}
            />
          )}
        </div>
      )}
    </section>
  );
}

function CriteriaForm({
  projectId,
  active,
  criteria,
  patches,
  installed,
}: {
  projectId: string;
  active: boolean;
  criteria: CfdCriteriaSettings;
  patches: string[];
  installed: boolean;
}) {
  const save = useSaveCriteria(projectId);
  const [form, setForm] = useState<FormState>(() => toForm(criteria));
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [dirty, setDirty] = useState(false);

  // Re-seed from the server only when nothing is being edited (never on the save
  // echo while the user types).
  useEffect(() => {
    if (!dirty) setForm(toForm(criteria));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [criteria]);

  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const setValue = (key: FieldKey, value: string) => {
    setForm((current) => ({ ...current, values: { ...current.values, [key]: value } }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setDirty(true);
  };

  const onSave = async () => {
    const result = fromForm(form, criteria);
    if ('errors' in result) {
      setErrors(result.errors);
      const first = Object.keys(result.errors)[0];
      if (first) document.getElementById(`criteria-${first}`)?.focus();
      return;
    }
    try {
      const saved = await save.mutateAsync(result.settings);
      setDirty(false);
      setForm(toForm(saved.criteria));
      toast.success('Convergence criteria saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const needsPatches = form.method !== 'residuals';

  return (
    <fieldset disabled={active} className="flex min-w-0 flex-col gap-4">
      <legend className="sr-only">Convergence criteria</legend>
      {active && (
        <p className="text-xs text-text-secondary" role="status">
          Locked while a run is active.
        </p>
      )}

      <RadioCardGroup
        name="convergence-method"
        legend="Stop the run when"
        items={METHOD_ITEMS}
        value={form.method}
        onChange={(id) => update({ method: id as ConvergenceMethod })}
        disabled={active}
      />

      <div className="flex flex-col gap-3">
        {form.method === 'simplePDrop' &&
          (['window', 'devTol', 'nPass'] as const).map((key) => (
            <NumberRow key={key} field={key} form={form} error={errors[key]} onChange={setValue} />
          ))}
        {form.method === 'robust' &&
          (['W', 'tolMean', 'K', 'resTol'] as const).map((key) => (
            <NumberRow key={key} field={key} form={form} error={errors[key]} onChange={setValue} />
          ))}
        <PatchRow
          id="criteria-inletPatch"
          label="Inlet patch"
          value={form.inletPatch}
          patches={patches}
          onChange={(value) => update({ inletPatch: value })}
        />
        <PatchRow
          id="criteria-outletPatch"
          label="Outlet patch"
          value={form.outletPatch}
          patches={patches}
          onChange={(value) => update({ outletPatch: value })}
        />
        {!needsPatches && (
          <p className="max-w-prose text-xs text-text-secondary">
            With residuals only, the patches are used to plot Δp₀ when vortex metrics are on.
          </p>
        )}
        <NumberRow field="rho" form={form} error={errors.rho} onChange={setValue} />
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-text">Vortex metrics</h3>
        <CheckRow
          id="criteria-vortexEnabled"
          label="Track vortex metrics"
          help="Masked Q volume and RMS vorticity in the Q core, computed during the run. They never stop it."
          checked={form.vortexEnabled}
          onChange={(checked) => update({ vortexEnabled: checked })}
        />
        {form.vortexEnabled && (
          <>
            <FieldRow id="criteria-velocityField" label="Velocity field" help="The same field is used for Q and the vorticity.">
              <NativeSelect
                id="criteria-velocityField"
                value={form.velocityField}
                onChange={(event) => update({ velocityField: event.target.value as VortexVelocityField })}
                className="max-w-[12rem]"
              >
                {VORTEX_VELOCITY_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {field === 'U' ? 'U (absolute frame)' : 'Urel (relative frame)'}
                  </option>
                ))}
              </NativeSelect>
            </FieldRow>
            {(['qThreshold', 'wallDistance', 'qCrit', 'vMin', 'interval'] as const).map((key) => (
              <NumberRow key={key} field={key} form={form} error={errors[key]} onChange={setValue} />
            ))}
            <CheckRow
              id="criteria-writeFields"
              label="Write the fields"
              help="Q, vorticity, wallDistance and Qfiltered in each written time, for the Visualize tab."
              checked={form.writeFields}
              onChange={(checked) => update({ writeFields: checked })}
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button variant="secondary" loading={save.isPending} disabled={active} onClick={() => void onSave()}>
          <Save strokeWidth={1.75} aria-hidden="true" />
          Save criteria
        </Button>
        <p className="text-xs text-text-secondary" aria-live="polite">
          {dirty ? (
            'Unsaved changes.'
          ) : installed ? (
            <span className="inline-flex items-center gap-1">
              <Check className="size-3.5 text-success" strokeWidth={1.75} aria-hidden="true" />
              Installed in the case. Also re-applied at every run start.
            </span>
          ) : (
            'Applied at the next save or run start.'
          )}
        </p>
      </div>
    </fieldset>
  );
}

/** Label column + control column, the same grid as the solver parameters. */
function FieldRow({
  id,
  label,
  unit,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  unit?: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
      <div className="flex flex-col pt-2">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {unit && <span className="text-xs text-text-secondary">{unit}</span>}
      </div>
      <div className="flex flex-col gap-1">
        {children}
        {error && (
          <p id={`${id}-error`} role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {help && (
          <p id={`${id}-help`} className="max-w-prose text-xs text-text-secondary">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}

function NumberRow({
  field,
  form,
  error,
  onChange,
}: {
  field: FieldKey;
  form: FormState;
  error?: string;
  onChange: (key: FieldKey, value: string) => void;
}) {
  const spec = FIELDS[field];
  const id = `criteria-${field}`;
  const describedBy = [error ? `${id}-error` : null, spec.help ? `${id}-help` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <FieldRow id={id} label={spec.label} unit={spec.unit} help={spec.help} error={error}>
      <input
        id={id}
        name={field}
        type="number"
        inputMode="decimal"
        step="any"
        autoComplete="off"
        value={form.values[field]}
        onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cn(
          'h-10 w-full max-w-[12rem] rounded-sm border border-border bg-surface px-3 text-sm tabular-nums text-text',
          'transition-colors duration-fast ease-out hover:border-border-strong',
          'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:bg-bg disabled:text-text-secondary',
          'aria-[invalid=true]:border-danger',
        )}
      />
    </FieldRow>
  );
}

function PatchRow({
  id,
  label,
  value,
  patches,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  patches: string[];
  onChange: (value: string) => void;
}) {
  const options = value && !patches.includes(value) ? [value, ...patches] : patches;
  const missing = value !== '' && !patches.includes(value);
  return (
    <FieldRow
      id={id}
      label={label}
      error={missing ? `"${value}" is not a patch of the current mesh.` : undefined}
    >
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[16rem]"
        translate="no"
      >
        {value === '' && <option value="">Choose a patch</option>}
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </NativeSelect>
    </FieldRow>
  );
}

function CheckRow({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 self-start text-sm font-medium text-text has-[:disabled]:cursor-not-allowed">
        <input
          id={id}
          name={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={`${id}-help`}
          className="size-4 shrink-0 rounded-xs border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
        />
        {label}
      </label>
      <p id={`${id}-help`} className="max-w-prose pl-6 text-xs text-text-secondary">
        {help}
      </p>
    </div>
  );
}
