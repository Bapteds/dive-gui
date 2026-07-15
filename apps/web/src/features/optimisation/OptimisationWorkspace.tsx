import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { sweepValuesM, type StudySampleStatus } from '@dive/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  Download,
  Gauge,
  Loader2,
  MinusCircle,
  Play,
  Plus,
  Ruler,
  Square,
  Target,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { LengthUnit, MeshPatch, Study, StudyMetric, StudySample } from '@/lib/api/types';
import { useMeshManifestQuery } from '@/features/visualize/useMesh';
import { useRunLogQuery } from '@/features/solver/useRuns';
import { ResidualChart } from '@/features/solver/ResidualChart';
import { LossChart } from './LossChart';
import {
  isStudyActive,
  useCreateStudy,
  useDeleteStudy,
  useExtractCenterline,
  useRunStudy,
  useStopStudy,
  useStudiesQuery,
  useStudyQuery,
} from './useOptimisation';

// ---------------------------------------------------------------------------
// The "Optimisation" tab: set up and run a diameter-optimization sweep. An engineer
// picks the pipe wall patch + the two endpoints bounding a segment, traces its
// centerline, sets a diameter range + step and a loss objective (inlet/outlet
// pressure drop), and launches a background sweep that morphs the mesh and runs the
// solver once per diameter, then reads the loss-versus-diameter curve to find the
// least-loss ("water loss") diameter. Light theme, brand tokens only.
//
// NOTE: the live interactive 3D pick + morph preview (reusing the Assemble viewer) is
// the one piece that wants live-browser iteration; here the geometry is defined from
// the mesh manifest (wall patch) + the two endpoint coordinates, which the API traces
// into a centerline. The 3D preview canvas is a follow-up polish.
// ---------------------------------------------------------------------------

const UNITS: LengthUnit[] = ['mm', 'cm', 'm'];
const UNIT_M: Record<LengthUnit, number> = { mm: 0.001, cm: 0.01, m: 1 };
const METRICS: { id: StudyMetric; label: string }[] = [
  { id: 'pressureDrop', label: 'Pressure drop (Δp)' },
  { id: 'headLoss', label: 'Head loss' },
];
const MAX_SWEEP = 200;

type Vec3 = [number, number, number];

// ---- small on-brand primitives (native elements + brand token classes) ----

function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md bg-cta px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cta-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-px ${className}`}
    />
  );
}

function SecondaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-primary-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-px ${className}`}
    />
  );
}

function DangerButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-px ${className}`}
    />
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text tabular-nums transition-colors focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

function NumberField({
  id,
  value,
  onChange,
  step,
  min,
  disabled,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      autoComplete="off"
      className={inputClass}
      value={Number.isFinite(value) ? value : ''}
      step={step}
      min={min}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function PatchSelect({
  id,
  value,
  onChange,
  patches,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  patches: MeshPatch[];
  placeholder: string;
}) {
  return (
    <select
      id={id}
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {patches.map((p) => (
        <option key={p.name} value={p.name}>
          {p.name}
          {p.type && p.type !== '?' ? ` (${p.type})` : ''}
        </option>
      ))}
    </select>
  );
}

/** Segmented single-choice control (used for the unit + metric toggles). */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-bg p-0.5"
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.id)}
            className={`rounded-[6px] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
              active ? 'bg-surface text-primary shadow-sm' : 'text-text-secondary hover:text-text'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- status chips (icon + text, never color alone) ------------------------

const SAMPLE_META: Record<
  StudySampleStatus,
  { label: string; icon: typeof CheckCircle2; className: string; spin?: boolean }
> = {
  pending: { label: 'Pending', icon: CircleDashed, className: 'text-text-secondary' },
  running: { label: 'Running', icon: Loader2, className: 'text-primary', spin: true },
  done: { label: 'Done', icon: CheckCircle2, className: 'text-success' },
  meshFailed: { label: 'Mesh rejected', icon: AlertTriangle, className: 'text-accent-hover' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-danger' },
  skipped: { label: 'Skipped', icon: MinusCircle, className: 'text-text-secondary' },
};

function fmtDiameter(diameterM: number, unit: LengthUnit): string {
  const v = diameterM / UNIT_M[unit];
  return `${Number(v.toPrecision(4))} ${unit}`;
}

function SampleChip({ sample, unit }: { sample: StudySample; unit: LengthUnit }) {
  const meta = SAMPLE_META[sample.status];
  const Icon = meta.icon;
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
      title={sample.note ?? meta.label}
    >
      <span className="text-xs font-medium tabular-nums text-text">
        {fmtDiameter(sample.diameterM, unit)}
      </span>
      <span className={`inline-flex items-center gap-1 text-xs ${meta.className}`}>
        <Icon
          size={13}
          strokeWidth={2}
          className={meta.spin ? 'animate-spin' : undefined}
          aria-hidden="true"
        />
        {meta.label}
      </span>
    </div>
  );
}

// ---- panel shell ----------------------------------------------------------

function Panel({
  title,
  icon: Icon,
  children,
  aside,
}: {
  title: string;
  icon: typeof Ruler;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <Icon size={16} strokeWidth={1.75} className="text-primary" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---- setup form -----------------------------------------------------------

interface SetupState {
  name: string;
  wallPatch: string;
  a: Vec3;
  b: Vec3;
  unit: LengthUnit;
  minU: number;
  maxU: number;
  stepU: number;
  inletPatch: string;
  outletPatch: string;
  primary: StudyMetric;
  density: number;
  stationA: number;
  stationB: number;
  blend: number;
}

function defaultSetup(): SetupState {
  return {
    name: '',
    wallPatch: '',
    a: [0, 0, 0],
    b: [0, 0, 0],
    unit: 'mm',
    minU: 0,
    maxU: 0,
    stepU: 0,
    inletPatch: '',
    outletPatch: '',
    primary: 'pressureDrop',
    density: 1000,
    stationA: 0.15,
    stationB: 0.85,
    blend: 0.15,
  };
}

function SetupForm({
  projectId,
  patches,
  onCreated,
}: {
  projectId: string;
  patches: MeshPatch[];
  onCreated: (studyId: string) => void;
}) {
  const [s, setS] = useState<SetupState>(defaultSetup);
  const [baselineM, setBaselineM] = useState<number | null>(null);
  const [centerlinePts, setCenterlinePts] = useState<Vec3[] | null>(null);

  const extract = useExtractCenterline(projectId);
  const create = useCreateStudy(projectId);
  const run = useRunStudy(projectId);

  const walls = patches.filter((p) => p.type === 'wall' || p.type === '?' || !p.type);
  const set = (patch: Partial<SetupState>) => setS((prev) => ({ ...prev, ...patch }));

  const sweepValues = useMemo(() => {
    if (!(s.minU > 0) || !(s.maxU >= s.minU) || !(s.stepU > 0)) return [];
    return sweepValuesM({
      minM: s.minU * UNIT_M[s.unit],
      maxM: s.maxU * UNIT_M[s.unit],
      stepM: s.stepU * UNIT_M[s.unit],
      unit: s.unit,
    });
  }, [s.minU, s.maxU, s.stepU, s.unit]);

  const runCount = sweepValues.length;
  const sweepError =
    runCount === 0
      ? s.minU > 0 && s.maxU > 0 && s.stepU > 0
        ? 'Check the range: max must be ≥ min and step > 0.'
        : undefined
      : runCount > MAX_SWEEP
        ? `${runCount} runs exceeds the ${MAX_SWEEP}-run cap. Widen the step or narrow the range.`
        : undefined;

  const canExtract = !!s.wallPatch && (s.a.some((v) => v !== 0) || s.b.some((v) => v !== 0));
  const ready =
    baselineM !== null &&
    centerlinePts !== null &&
    runCount >= 1 &&
    runCount <= MAX_SWEEP &&
    !!s.inletPatch &&
    !!s.outletPatch &&
    s.inletPatch !== s.outletPatch &&
    s.density > 0;

  const buildConfig = () => ({
    name: s.name.trim() || undefined,
    morph: {
      wallPatch: s.wallPatch,
      centerline: { points: centerlinePts as Vec3[] },
      stationA: s.stationA,
      stationB: s.stationB,
      blend: s.blend,
      baselineDiameterM: baselineM as number,
    },
    sweep: {
      minM: s.minU * UNIT_M[s.unit],
      maxM: s.maxU * UNIT_M[s.unit],
      stepM: s.stepU * UNIT_M[s.unit],
      unit: s.unit,
    },
    objective: {
      inletPatch: s.inletPatch,
      outletPatch: s.outletPatch,
      primary: s.primary,
      densityKgM3: s.density,
    },
  });

  const onExtract = () => {
    extract.mutate(
      { wallPatch: s.wallPatch, endpointA: s.a, endpointB: s.b },
      {
        onSuccess: (res) => {
          const mean =
            res.radii.length > 0
              ? res.radii.reduce((acc, r) => acc + r, 0) / res.radii.length
              : 0;
          const dM = 2 * mean;
          setBaselineM(dM);
          setCenterlinePts(res.centerline.points as Vec3[]);
          // Seed a sensible sweep around the measured diameter if empty.
          if (!(s.minU > 0)) {
            const dUnit = dM / UNIT_M[s.unit];
            set({
              minU: Number((dUnit * 0.8).toPrecision(3)),
              maxU: Number((dUnit * 1.2).toPrecision(3)),
              stepU: Number((dUnit * 0.05).toPrecision(3)),
            });
          }
        },
      },
    );
  };

  const onCreate = (launch: boolean) => {
    create.mutate(buildConfig(), {
      onSuccess: (study) => {
        if (launch) run.mutate(study.id, { onSuccess: () => onCreated(study.id) });
        else onCreated(study.id);
      },
    });
  };

  const busy = create.isPending || run.isPending;

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Pipe segment geometry" icon={Ruler}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Wall patch" htmlFor="opt-wall" hint="The pipe wall whose diameter varies.">
            <PatchSelect
              id="opt-wall"
              value={s.wallPatch}
              onChange={(v) => set({ wallPatch: v })}
              patches={walls}
              placeholder="Select a wall patch…"
            />
          </Field>
          <Field
            label="Study name"
            htmlFor="opt-name"
            hint="Optional. A default name is used otherwise."
          >
            <input
              id="opt-name"
              className={inputClass}
              value={s.name}
              placeholder="Diameter study"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-medium text-text-secondary">
              Endpoint A (x, y, z, m)
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  value={s.a[i]}
                  aria-label={`Endpoint A ${axis}`}
                  step={0.001}
                  onChange={(n) => {
                    const a = [...s.a] as Vec3;
                    a[i] = n;
                    set({ a });
                  }}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-medium text-text-secondary">
              Endpoint B (x, y, z, m)
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  value={s.b[i]}
                  aria-label={`Endpoint B ${axis}`}
                  step={0.001}
                  onChange={(n) => {
                    const b = [...s.b] as Vec3;
                    b[i] = n;
                    set({ b });
                  }}
                />
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SecondaryButton onClick={onExtract} disabled={!canExtract || extract.isPending}>
            {extract.isPending ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Target size={15} strokeWidth={1.75} aria-hidden="true" />
            )}
            Trace centerline
          </SecondaryButton>
          {baselineM !== null && centerlinePts && (
            <p className="text-sm text-text-secondary" aria-live="polite">
              Traced{' '}
              <span className="font-semibold text-text tabular-nums">{centerlinePts.length}</span>{' '}
              axis points · measured diameter{' '}
              <span className="font-semibold text-text tabular-nums">
                {fmtDiameter(baselineM, s.unit)}
              </span>
            </p>
          )}
          {extract.isError && (
            <p className="text-sm text-danger" role="alert">
              {extract.error instanceof Error
                ? extract.error.message
                : 'Centerline tracing failed.'}
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Diameter sweep" icon={Gauge}>
        <div className="mb-4 flex items-center gap-3">
          <span className="text-sm font-medium text-text">Unit</span>
          <Segmented
            ariaLabel="Length unit"
            options={UNITS.map((u) => ({ id: u, label: u }))}
            value={s.unit}
            onChange={(unit) => set({ unit })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={`Min (${s.unit})`} htmlFor="opt-min">
            <NumberField id="opt-min" value={s.minU} min={0} onChange={(minU) => set({ minU })} />
          </Field>
          <Field label={`Max (${s.unit})`} htmlFor="opt-max">
            <NumberField id="opt-max" value={s.maxU} min={0} onChange={(maxU) => set({ maxU })} />
          </Field>
          <Field label={`Step (${s.unit})`} htmlFor="opt-step" error={sweepError}>
            <NumberField id="opt-step" value={s.stepU} min={0} onChange={(stepU) => set({ stepU })} />
          </Field>
        </div>
        {runCount >= 1 && runCount <= MAX_SWEEP && (
          <p className="mt-3 text-sm text-text-secondary">
            <span className="font-semibold text-text tabular-nums">{runCount}</span> solver run
            {runCount === 1 ? '' : 's'}, one per diameter, run sequentially in the background.
          </p>
        )}
      </Panel>

      <Panel title="Loss objective" icon={Target}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Inlet patch" htmlFor="opt-inlet">
            <PatchSelect
              id="opt-inlet"
              value={s.inletPatch}
              onChange={(v) => set({ inletPatch: v })}
              patches={patches}
              placeholder="Select the inlet…"
            />
          </Field>
          <Field
            label="Outlet patch"
            htmlFor="opt-outlet"
            error={
              s.inletPatch && s.inletPatch === s.outletPatch
                ? 'Inlet and outlet must differ.'
                : undefined
            }
          >
            <PatchSelect
              id="opt-outlet"
              value={s.outletPatch}
              onChange={(v) => set({ outletPatch: v })}
              patches={patches}
              placeholder="Select the outlet…"
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">Optimise for</span>
            <Segmented
              ariaLabel="Primary loss metric"
              options={METRICS}
              value={s.primary}
              onChange={(primary) => set({ primary })}
            />
          </div>
          <Field label="Fluid density (kg/m³)" htmlFor="opt-density" hint="Water = 1000.">
            <NumberField
              id="opt-density"
              value={s.density}
              min={1}
              onChange={(density) => set({ density })}
            />
          </Field>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {(create.isError || run.isError) && (
          <p className="mr-auto text-sm text-danger" role="alert">
            {(create.error ?? run.error) instanceof Error
              ? (create.error ?? run.error)?.message
              : 'Could not create the study.'}
          </p>
        )}
        <SecondaryButton onClick={() => onCreate(false)} disabled={!ready || busy}>
          Save draft
        </SecondaryButton>
        <PrimaryButton onClick={() => onCreate(true)} disabled={!ready || busy}>
          {busy ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={15} strokeWidth={2} aria-hidden="true" />
          )}
          Create and launch
        </PrimaryButton>
      </div>
    </div>
  );
}

// ---- run monitor ----------------------------------------------------------

function RunMonitor({ projectId, study }: { projectId: string; study: Study }) {
  const stop = useStopStudy(projectId);
  const log = useRunLogQuery(projectId, study.currentRunId ?? null);
  const done = study.samples.filter((x) => x.status !== 'pending').length;
  const pct = study.samples.length > 0 ? Math.round((done / study.samples.length) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title="Sweep in progress"
        icon={Loader2}
        aside={
          <DangerButton onClick={() => stop.mutate(study.id)} disabled={stop.isPending}>
            <Square size={14} strokeWidth={2} aria-hidden="true" />
            Stop
          </DangerButton>
        }
      >
        <div className="mb-2 flex items-center justify-between text-sm" aria-live="polite">
          <span className="text-text-secondary">
            <span className="font-semibold tabular-nums text-text">{done}</span> of{' '}
            <span className="tabular-nums">{study.samples.length}</span> diameters
          </span>
          <span className="font-semibold tabular-nums text-primary">{pct}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-primary-tint"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {study.samples.map((sample, i) => (
            <SampleChip key={i} sample={sample} unit={study.sweep.unit} />
          ))}
        </div>
      </Panel>

      <Panel title="Live residuals (current run)" icon={Gauge}>
        {study.currentRunId ? (
          <ResidualChart samples={log.data?.series ?? []} />
        ) : (
          <p className="py-6 text-center text-sm text-text-secondary">
            Preparing the next diameter…
          </p>
        )}
      </Panel>
    </div>
  );
}

// ---- results --------------------------------------------------------------

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <span
        className={`text-lg font-semibold tabular-nums ${accent ? 'text-accent-hover' : 'text-text'}`}
      >
        {value}
      </span>
    </div>
  );
}

function toCsv(study: Study): string {
  const u = study.sweep.unit;
  const header = ['diameter_m', `diameter_${u}`, 'status', 'pressureDrop_Pa', 'headLoss_m', 'runId'];
  const lines = study.samples.map((x) =>
    [
      x.diameterM,
      x.diameterM / UNIT_M[u],
      x.status,
      x.metrics?.pressureDropPa ?? '',
      x.metrics?.headLossM ?? '',
      x.runId ?? '',
    ].join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function ResultsReport({
  projectId,
  study,
  onRerun,
}: {
  projectId: string;
  study: Study;
  onRerun: () => void;
}) {
  const run = useRunStudy(projectId);
  const del = useDeleteStudy(projectId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const doneSamples = study.samples.filter((x) => x.status === 'done');
  const bestSample = study.samples.find(
    (x) => study.bestDiameterM !== undefined && Math.abs(x.diameterM - study.bestDiameterM) < 1e-12,
  );
  const bestLoss = bestSample?.metrics
    ? study.objective.primary === 'headLoss'
      ? `${Number(bestSample.metrics.headLossM.toPrecision(4))} m`
      : `${Number(bestSample.metrics.pressureDropPa.toPrecision(4))} Pa`
    : '-';

  const downloadCsv = () => {
    const blob = new Blob([toCsv(study)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${study.name.replace(/[^\w.-]+/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-5">
      {study.status === 'failed' && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-danger-tint px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{study.reason ?? 'The sweep did not produce a result.'}</span>
        </div>
      )}

      <Panel
        title="Loss versus diameter"
        icon={Target}
        aside={
          <SecondaryButton onClick={downloadCsv} className="px-3 py-1.5">
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            CSV
          </SecondaryButton>
        }
      >
        <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Optimal diameter"
            value={
              study.bestDiameterM !== undefined
                ? fmtDiameter(study.bestDiameterM, study.sweep.unit)
                : '-'
            }
            accent
          />
          <Stat
            label={study.objective.primary === 'headLoss' ? 'Least head loss' : 'Least Δp'}
            value={bestLoss}
          />
          <Stat label="Solved" value={`${doneSamples.length} / ${study.samples.length}`} />
          <Stat
            label="Skipped / failed"
            value={String(
              study.samples.filter((x) => x.status === 'meshFailed' || x.status === 'failed').length,
            )}
          />
        </div>
        <LossChart
          samples={study.samples}
          primary={study.objective.primary}
          unit={study.sweep.unit}
          bestDiameterM={study.bestDiameterM}
        />
      </Panel>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {confirmingDelete ? (
          <div
            className="mr-auto flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Confirm deletion"
          >
            <span className="text-sm text-text-secondary">Delete this study and its results?</span>
            <SecondaryButton className="px-3 py-1.5" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </SecondaryButton>
            <DangerButton
              className="px-3 py-1.5"
              onClick={() => del.mutate(study.id, { onSuccess: onRerun })}
              disabled={del.isPending}
            >
              {del.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Confirm delete
            </DangerButton>
          </div>
        ) : (
          <DangerButton className="mr-auto" onClick={() => setConfirmingDelete(true)}>
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
            Delete study
          </DangerButton>
        )}
        <PrimaryButton onClick={() => run.mutate(study.id)} disabled={run.isPending}>
          {run.isPending ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={15} strokeWidth={2} aria-hidden="true" />
          )}
          Run again
        </PrimaryButton>
      </div>
    </div>
  );
}

// ---- sidebar list ---------------------------------------------------------

const STUDY_STATUS_META: Record<Study['status'], { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-bg text-text-secondary' },
  queued: { label: 'Queued', className: 'bg-primary-tint text-primary' },
  running: { label: 'Running', className: 'bg-primary-tint text-primary' },
  completed: { label: 'Completed', className: 'bg-success-tint text-success' },
  failed: { label: 'Failed', className: 'bg-danger-tint text-danger' },
  stopped: { label: 'Stopped', className: 'bg-bg text-text-secondary' },
};

function StudyList({
  studies,
  selectedId,
  onSelect,
  onNew,
}: {
  studies: Study[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PrimaryButton onClick={onNew} className="w-full">
        <Plus size={15} strokeWidth={2} aria-hidden="true" />
        New study
      </PrimaryButton>
      <ul className="flex flex-col gap-1.5">
        {studies.map((study) => {
          const meta = STUDY_STATUS_META[study.status];
          const active = study.id === selectedId;
          return (
            <li key={study.id}>
              <button
                type="button"
                onClick={() => onSelect(study.id)}
                className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                  active
                    ? 'border-primary bg-primary-tint'
                    : 'border-border bg-surface hover:border-border-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-text">
                    {study.name}
                  </span>
                  {isStudyActive(study.status) && (
                    <Loader2 size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
                  >
                    {meta.label}
                  </span>
                  <span className="text-xs tabular-nums text-text-secondary">
                    {study.samples.length} pt
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- workspace root -------------------------------------------------------

function EmptyMesh() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface p-12 text-center">
      <span className="size-3 rotate-45 rounded-[3px] bg-neutral" aria-hidden="true" />
      <p className="text-base font-medium text-text">No mesh to optimise yet</p>
      <p className="max-w-sm text-sm text-text-secondary">
        Import and build a case mesh first. The optimisation sweep morphs that mesh across a range of
        pipe diameters to find the one with the least loss.
      </p>
    </div>
  );
}

export function OptimisationWorkspace({ projectId }: { projectId: string }) {
  const studiesQuery = useStudiesQuery(projectId);
  const manifest = useMeshManifestQuery(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selectedQuery = useStudyQuery(projectId, !creating ? selectedId : null);
  const patches = manifest.data?.patches ?? [];

  if (manifest.isPending || studiesQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-9 w-40 animate-pulse rounded-md bg-primary-tint" />
        <div className="h-64 animate-pulse rounded-lg border border-border bg-surface" />
      </div>
    );
  }

  if (patches.length === 0) {
    return <EmptyMesh />;
  }

  const studies = studiesQuery.data ?? [];
  const selected = selectedQuery.data;

  const showSetup = creating || (selected?.status === 'draft' && !isStudyActive(selected.status));

  return (
    <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(220px,280px)_1fr]">
      <aside className="lg:overflow-y-auto lg:pr-1">
        <StudyList
          studies={studies}
          selectedId={creating ? null : selectedId}
          onSelect={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
          onNew={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        />
      </aside>

      <div className="min-w-0 lg:overflow-y-auto lg:pr-1">
        {creating ? (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="inline-flex w-fit items-center gap-1 text-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
            >
              <ChevronLeft size={15} aria-hidden="true" />
              Back to studies
            </button>
            <SetupForm
              projectId={projectId}
              patches={patches}
              onCreated={(id) => {
                setCreating(false);
                setSelectedId(id);
              }}
            />
          </div>
        ) : !selected ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface p-10 text-center">
            <Gauge size={22} strokeWidth={1.5} className="text-neutral" aria-hidden="true" />
            <p className="text-base font-medium text-text">Select or create a study</p>
            <p className="max-w-sm text-sm text-text-secondary">
              A study sweeps a pipe diameter across a range and finds the value with the least loss.
            </p>
          </div>
        ) : showSetup ? (
          <SetupForm
            projectId={projectId}
            patches={patches}
            onCreated={(id) => setSelectedId(id)}
          />
        ) : isStudyActive(selected.status) ? (
          <RunMonitor projectId={projectId} study={selected} />
        ) : (
          <ResultsReport
            projectId={projectId}
            study={selected}
            onRerun={() => setSelectedId(selected.id)}
          />
        )}
      </div>
    </div>
  );
}
