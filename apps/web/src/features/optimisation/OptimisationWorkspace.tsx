import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { sweepValuesM, type StudySampleStatus } from '@dive/shared';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Crosshair,
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
import { useMeshGeometryQuery, useMeshManifestQuery } from '@/features/visualize/useMesh';
import { useRunLogQuery } from '@/features/solver/useRuns';
import { ResidualChart } from '@/features/solver/ResidualChart';
import type { ChannelShape } from '@/lib/api/studies';
import { LossChart } from './LossChart';
import { MorphViewer } from './MorphViewer';
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
// The "Optimisation" tab, laid out like the Assemble tab: a large 3D stage on the
// left, a compact configuration/monitor rail on the right. Setting up a diameter
// sweep is direct: click the pipe twice (the wall patch is inferred from the click),
// the centerline traces itself, the range pre-fills around the measured diameter,
// pick the inlet/outlet, and launch. While the sweep runs the rail shows live
// progress; once it finishes the loss-versus-diameter report takes the stage.
// Light theme, brand tokens only.
// ---------------------------------------------------------------------------

const UNITS: LengthUnit[] = ['mm', 'cm', 'm'];
const UNIT_M: Record<LengthUnit, number> = { mm: 0.001, cm: 0.01, m: 1 };
const METRICS: { id: StudyMetric; label: string }[] = [
  { id: 'pressureDrop', label: 'Pressure drop (Δp)' },
  { id: 'headLoss', label: 'Head loss' },
];
const MAX_SWEEP = 200;
const SHAPES: { id: ChannelShape; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'straight', label: 'Straight' },
  { id: 'ring', label: 'Ring' },
];

type Vec3 = [number, number, number];

// ---- small on-brand primitives ---------------------------------------------

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

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text tabular-nums transition-colors focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

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
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

function NumberField({
  id,
  value,
  onChange,
  step,
  min,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
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
    <select id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
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

/** Segmented single-choice control (unit + metric toggles). */
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
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-md border border-border bg-bg p-0.5">
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

/** Toggle that arms the next mesh click: pick the channel wall, or move a hint end. */
function PickToggle({
  which,
  active,
  placed,
  onToggle,
}: {
  which: 'patch' | 'c1' | 'c2';
  active: boolean;
  placed: boolean;
  onToggle: () => void;
}) {
  const dot = which === 'c1' ? 'bg-primary' : which === 'c2' ? 'bg-primary-light' : 'bg-neutral';
  const n = which === 'c1' ? 'A' : 'B';
  const label =
    which === 'patch'
      ? active
        ? 'Click a face on the channel'
        : 'Pick channel'
      : active
        ? `Click to place ring ${n}`
        : placed
          ? `Move ring ${n}`
          : `Place ring ${n}`;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
        active
          ? 'border-primary bg-primary-tint text-primary'
          : 'border-border-strong bg-surface text-text hover:bg-primary-tint'
      }`}
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
      <Crosshair size={13} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}

/** Position of one cross-section circle along the axis (0..1), as a labelled slider. */
function ZoneSlider({
  label,
  color,
  value,
  onChange,
}: {
  label: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = `opt-zone-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="flex w-[4.5rem] shrink-0 items-center gap-1.5 text-xs text-text-secondary">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: color }}
      />
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-text-secondary">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

// ---- status metadata (icon + text, never color alone) ----------------------

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

const STUDY_STATUS_META: Record<Study['status'], { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-bg text-text-secondary' },
  queued: { label: 'Queued', className: 'bg-primary-tint text-primary' },
  running: { label: 'Running', className: 'bg-primary-tint text-primary' },
  completed: { label: 'Completed', className: 'bg-success-tint text-success' },
  failed: { label: 'Failed', className: 'bg-danger-tint text-danger' },
  stopped: { label: 'Stopped', className: 'bg-bg text-text-secondary' },
};

function fmtDiameter(diameterM: number, unit: LengthUnit): string {
  return `${Number((diameterM / UNIT_M[unit]).toPrecision(4))} ${unit}`;
}

function SampleChip({ sample, unit }: { sample: StudySample; unit: LengthUnit }) {
  const meta = SAMPLE_META[sample.status];
  const Icon = meta.icon;
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
      title={sample.note ?? meta.label}
    >
      <span className="text-xs font-medium tabular-nums text-text">
        {fmtDiameter(sample.diameterM, unit)}
      </span>
      <span className={`inline-flex items-center gap-1 text-xs ${meta.className}`}>
        <Icon size={13} strokeWidth={2} className={meta.spin ? 'animate-spin' : undefined} aria-hidden="true" />
        {meta.label}
      </span>
    </li>
  );
}

// ---- layout shells ----------------------------------------------------------

/** One compact section of the right rail (hairline separators, not nested cards). */
function RailSection({
  title,
  icon: Icon,
  aside,
  children,
}: {
  title: string;
  icon: typeof Ruler;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
          <Icon size={15} strokeWidth={1.75} className="text-primary" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The two-pane frame: a large stage (3D / report) + the config rail. */
function WorkspaceFrame({ stage, rail }: { stage: ReactNode; rail: ReactNode }) {
  return (
    <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]">
      <div className="flex min-h-[26rem] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.05)] lg:min-h-0">
        {stage}
      </div>
      <aside className="flex flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.05)] lg:min-h-0">
        {rail}
      </aside>
    </div>
  );
}

/** The study switcher pinned at the top of the rail (every mode). */
function StudySwitcher({
  studies,
  selectedId,
  onSelect,
  onNew,
}: {
  studies: Study[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      <label htmlFor="opt-study" className="sr-only">
        Study
      </label>
      <select
        id="opt-study"
        className={`${inputClass} min-w-0 flex-1`}
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">New study…</option>
        {studies.map((study) => (
          <option key={study.id} value={study.id}>
            {study.name} ({STUDY_STATUS_META[study.status].label})
          </option>
        ))}
      </select>
      <SecondaryButton className="shrink-0 px-3 py-2" onClick={onNew} aria-label="New study">
        <Plus size={15} strokeWidth={2} aria-hidden="true" />
      </SecondaryButton>
    </div>
  );
}

/** Two-step inline confirmation for deleting a study (destructive action). */
function DeleteStudyButton({ onConfirm, pending }: { onConfirm: () => void; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <DangerButton className="w-full" onClick={() => setConfirming(true)}>
        <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
        Delete study
      </DangerButton>
    );
  }
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Confirm deletion">
      <p className="text-sm text-text-secondary">Delete this study and its results?</p>
      <div className="flex gap-2">
        <SecondaryButton className="flex-1 px-3 py-1.5" onClick={() => setConfirming(false)}>
          Cancel
        </SecondaryButton>
        <DangerButton className="flex-1 px-3 py-1.5" onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          Confirm
        </DangerButton>
      </div>
    </div>
  );
}

/** Label/value row used in the rail summaries. */
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-text-secondary">{label}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums text-text">{value}</span>
    </div>
  );
}

// ---- CSV export -------------------------------------------------------------

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

function downloadCsv(study: Study): void {
  const blob = new Blob([toCsv(study)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${study.name.replace(/[^\w.-]+/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ---- setup mode (new study) -------------------------------------------------

interface SetupSweep {
  name: string;
  unit: LengthUnit;
  minU: number;
  maxU: number;
  stepU: number;
  inletPatch: string;
  outletPatch: string;
  primary: StudyMetric;
  density: number;
}

function defaultSweep(): SetupSweep {
  return {
    name: '',
    unit: 'mm',
    minU: 0,
    maxU: 0,
    stepU: 0,
    inletPatch: '',
    outletPatch: '',
    primary: 'pressureDrop',
    density: 1000,
  };
}

function SetupFlow({
  projectId,
  patches,
  geometry,
  geometryError,
  switcher,
  onCreated,
}: {
  projectId: string;
  patches: MeshPatch[];
  geometry: ArrayBuffer | null;
  geometryError: boolean;
  switcher: ReactNode;
  onCreated: (studyId: string) => void;
}) {
  // Pick a face (-> the wall patch), choose the channel SHAPE, and the axis is fitted
  // automatically. Then place TWO cross-section circles along it: the zone BETWEEN the
  // circles is what the sweep grows/shrinks.
  const [wallPatch, setWallPatch] = useState<string>('');
  const [shape, setShape] = useState<ChannelShape>('auto');
  const [pickMode, setPickMode] = useState<'patch' | 'c1' | 'c2' | null>('patch');
  // Fit result.
  const [baselineM, setBaselineM] = useState<number | null>(null);
  const [centerlinePts, setCenterlinePts] = useState<Vec3[] | null>(null);
  const [centerlineRadii, setCenterlineRadii] = useState<number[] | null>(null);
  const [fittedShape, setFittedShape] = useState<'straight' | 'ring' | null>(null);
  const [previewU, setPreviewU] = useState<number | null>(null);
  // The two circles bounding the morph zone (arc-length fractions 0..1 along the axis).
  const [station1, setStation1] = useState<number | null>(null);
  const [station2, setStation2] = useState<number | null>(null);
  // Sweep + objective.
  const [s, setS] = useState<SetupSweep>(defaultSweep);
  const set = (patch: Partial<SetupSweep>) => setS((prev) => ({ ...prev, ...patch }));

  const extract = useExtractCenterline(projectId);
  const create = useCreateStudy(projectId);
  const run = useRunStudy(projectId);

  const onPick = (_point: Vec3, patch: string | null) => {
    if (patch) setWallPatch(patch); // clicking a face selects the channel wall
    setPickMode(null);
  };
  const onPickStation = (which: 'c1' | 'c2', fraction: number) => {
    const f = Number(fraction.toFixed(4));
    if (which === 'c1') setStation1(f);
    else setStation2(f);
    setPickMode(null);
  };

  // Auto-fit: once a wall patch is chosen, fit the axis for the current shape
  // (debounced; re-fits when the shape changes). Retry on error.
  const traceKey = useMemo(
    () => (wallPatch ? JSON.stringify([wallPatch, shape]) : null),
    [wallPatch, shape],
  );
  const lastTraced = useRef<string | null>(null);
  const doTraceRef = useRef<() => void>(() => {});
  doTraceRef.current = () => {
    if (!wallPatch) return;
    extract.mutate(
      { wallPatch, shape },
      {
        onSuccess: (res) => {
          const mean =
            res.radii.length > 0 ? res.radii.reduce((acc, r) => acc + r, 0) / res.radii.length : 0;
          const dM = 2 * mean;
          const dUnit = dM / UNIT_M[s.unit];
          setBaselineM(dM);
          setCenterlinePts(res.centerline.points as Vec3[]);
          setCenterlineRadii(res.radii);
          setFittedShape(res.shape);
          setPreviewU(Number(dUnit.toPrecision(4)));
          // Seed the two circles the first time (a sensible zone the user then moves).
          setStation1((prev) => (prev === null ? 0.25 : prev));
          setStation2((prev) => (prev === null ? 0.75 : prev));
          // Pre-fill a sensible range around the measured diameter (only when empty,
          // so a user-tuned range survives a re-fit).
          setS((prev) =>
            prev.minU > 0
              ? prev
              : {
                  ...prev,
                  minU: Number((dUnit * 0.8).toPrecision(3)),
                  maxU: Number((dUnit * 1.2).toPrecision(3)),
                  stepU: Number((dUnit * 0.05).toPrecision(3)),
                },
          );
        },
        onError: () => {
          lastTraced.current = null;
        },
      },
    );
  };
  useEffect(() => {
    if (!traceKey || traceKey === lastTraced.current) return;
    const timer = setTimeout(() => {
      lastTraced.current = traceKey;
      doTraceRef.current();
    }, 400);
    return () => clearTimeout(timer);
  }, [traceKey]);

  // The morph zone = between the two circles, with a small taper (blend) at each so the
  // grown segment rejoins the untouched mesh smoothly. Order-independent (min/max).
  const stationA = Math.min(station1 ?? 0.25, station2 ?? 0.75);
  const stationB = Math.max(station1 ?? 0.25, station2 ?? 0.75);
  const zoneValid = stationB - stationA > 0.01;
  const blend = Math.min(0.12, Math.max(0.02, (stationB - stationA) * 0.3));
  const stations = { stationA, stationB, blend };

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

  const traced = baselineM !== null && centerlinePts !== null;
  const ready =
    traced &&
    zoneValid &&
    runCount >= 1 &&
    runCount <= MAX_SWEEP &&
    !!s.inletPatch &&
    !!s.outletPatch &&
    s.inletPatch !== s.outletPatch &&
    s.density > 0;

  // Radial confinement derived from the measured wall radius: full scale over the
  // channel itself, fading to zero a little beyond it, so a complex machine mesh
  // (a spiral casing) never drags distant parts. Mirrors what the server bakes.
  const falloffStartM =
    baselineM !== null ? Number(((baselineM / 2) * 1.3).toPrecision(6)) : undefined;
  const falloffEndM =
    baselineM !== null ? Number(((baselineM / 2) * 2.2).toPrecision(6)) : undefined;

  const buildConfig = () => ({
    name: s.name.trim() || undefined,
    morph: {
      wallPatch,
      centerline: { points: centerlinePts as Vec3[] },
      stationA: stations.stationA,
      stationB: stations.stationB,
      blend: stations.blend,
      baselineDiameterM: baselineM as number,
      falloffStartM,
      falloffEndM,
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

  const onLaunch = (launch: boolean) => {
    create.mutate(buildConfig(), {
      onSuccess: (study) => {
        if (launch) run.mutate(study.id, { onSuccess: () => onCreated(study.id) });
        else onCreated(study.id);
      },
    });
  };
  const busy = create.isPending || run.isPending;

  // Stable across unrelated re-renders so the viewer only re-fits/re-morphs when the
  // geometry or the zone actually changes.
  const centerlineObj = useMemo(
    () => (centerlinePts ? { points: centerlinePts } : null),
    [centerlinePts],
  );
  const morphPreview = useMemo(
    () =>
      traced && previewU !== null
        ? {
            baselineDiameterM: baselineM as number,
            diameterM: previewU * UNIT_M[s.unit],
            stationA,
            stationB,
            blend,
            falloffStartM,
            falloffEndM,
          }
        : null,
    [traced, previewU, baselineM, s.unit, stationA, stationB, blend, falloffStartM, falloffEndM],
  );

  const stage = (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Segmented ariaLabel="Channel shape" options={SHAPES} value={shape} onChange={setShape} />
        <PickToggle
          which="patch"
          active={pickMode === 'patch'}
          placed={!!wallPatch}
          onToggle={() => setPickMode((m) => (m === 'patch' ? null : 'patch'))}
        />
        {traced && (
          <>
            <PickToggle
              which="c1"
              active={pickMode === 'c1'}
              placed={station1 !== null}
              onToggle={() => setPickMode((m) => (m === 'c1' ? null : 'c1'))}
            />
            <PickToggle
              which="c2"
              active={pickMode === 'c2'}
              placed={station2 !== null}
              onToggle={() => setPickMode((m) => (m === 'c2' ? null : 'c2'))}
            />
          </>
        )}
        <span className="ml-auto text-xs text-text-secondary">
          Grab a ring to slide it; drag elsewhere to orbit.
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        {geometry ? (
          <MorphViewer
            geometry={geometry}
            centerline={centerlineObj}
            radii={centerlineRadii ?? undefined}
            station1={station1}
            station2={station2}
            ringRadiusM={baselineM ? baselineM / 2 : 0}
            pickMode={pickMode}
            onPick={onPick}
            onPickStation={onPickStation}
            morphPreview={morphPreview}
          />
        ) : geometryError ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-bg p-8 text-center">
            <AlertTriangle size={20} strokeWidth={1.5} className="text-neutral" aria-hidden="true" />
            <p className="text-sm font-medium text-text">3D preview unavailable</p>
            <p className="max-w-sm text-xs text-text-secondary">
              The mesh render could not be built on this host. Select the wall patch in the Pipe
              segment section instead; the axis is still fitted automatically.
            </p>
          </div>
        ) : (
          <div className="h-full min-h-64 animate-pulse rounded-md border border-border bg-bg" />
        )}
      </div>
      {traced && (
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-text">Morph zone</span>
              <span className="text-xs tabular-nums text-text-secondary">
                between the rings, {Math.round(stationA * 100)} to {Math.round(stationB * 100)}%
              </span>
            </div>
            <ZoneSlider
              label="Ring A"
              color="var(--color-primary)"
              value={station1 ?? 0.25}
              onChange={setStation1}
            />
            <ZoneSlider
              label="Ring B"
              color="var(--color-primary-light)"
              value={station2 ?? 0.75}
              onChange={setStation2}
            />
            {!zoneValid && (
              <p className="text-xs text-danger" role="alert">
                Move the two rings apart to define a zone to grow.
              </p>
            )}
          </div>
          {previewU !== null && s.maxU > s.minU && (
            <div>
              <label
                htmlFor="opt-preview"
                className="mb-1.5 flex items-center justify-between text-sm font-medium text-text"
              >
                <span>Preview diameter</span>
                <span className="tabular-nums text-primary">
                  {Number(previewU.toPrecision(4))} {s.unit}
                </span>
              </label>
              <input
                id="opt-preview"
                type="range"
                min={Math.min(s.minU, previewU)}
                max={Math.max(s.maxU, previewU)}
                step={(s.maxU - s.minU) / 100 || 0.001}
                value={previewU}
                onChange={(e) => setPreviewU(Number(e.target.value))}
                className="w-full"
                style={{ accentColor: 'var(--color-primary)' }}
              />
            </div>
          )}
        </div>
      )}
    </>
  );

  const rail = (
    <>
      {switcher}
      <RailSection title="Pipe segment" icon={Ruler}>
        <div className="flex flex-col gap-2">
          <SummaryRow
            label="Wall patch"
            value={
              wallPatch ? (
                <span translate="no">{wallPatch}</span>
              ) : (
                <span className="font-normal text-text-secondary">click a face</span>
              )
            }
          />
          <SummaryRow
            label="Fitted shape"
            value={
              fittedShape ? (
                `${fittedShape === 'ring' ? 'Ring (full loop)' : 'Straight'}${shape === 'auto' ? ', auto' : ''}`
              ) : (
                <span className="font-normal text-text-secondary">
                  {SHAPES.find((x) => x.id === shape)?.label}
                </span>
              )
            }
          />
          <div aria-live="polite">
            {extract.isPending ? (
              <p className="flex items-center gap-1.5 text-sm text-text-secondary">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Fitting the axis…
              </p>
            ) : traced ? (
              <SummaryRow label="Measured Ø" value={fmtDiameter(baselineM as number, s.unit)} />
            ) : null}
          </div>
          {traced && (
            <SummaryRow
              label="Morph zone"
              value={
                <span className="tabular-nums">
                  {Math.round(stationA * 100)} to {Math.round(stationB * 100)}% of the axis
                </span>
              }
            />
          )}
          {extract.isError && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-danger" role="alert">
                {extract.error instanceof Error ? extract.error.message : 'Axis fit failed.'}
              </p>
              <SecondaryButton className="px-3 py-1.5" onClick={() => doTraceRef.current()}>
                Retry fit
              </SecondaryButton>
            </div>
          )}
          <p className="text-xs text-text-secondary">
            Click a face to fit the axis (Auto detects straight vs ring). Two rings drop around the
            tube: grab a ring on the 3D to slide it, or use the Ring A/B sliders. The highlighted
            band between the rings is what the sweep grows.
          </p>
        </div>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
            Choose the wall patch from a list
          </summary>
          <div className="mt-2">
            <Field label="Wall patch" htmlFor="opt-wall">
              <PatchSelect
                id="opt-wall"
                value={wallPatch}
                onChange={setWallPatch}
                patches={patches}
                placeholder="Select the channel wall…"
              />
            </Field>
          </div>
        </details>
      </RailSection>

      <RailSection
        title="Diameter sweep"
        icon={Gauge}
        aside={
          <Segmented
            ariaLabel="Length unit"
            options={UNITS.map((u) => ({ id: u, label: u }))}
            value={s.unit}
            onChange={(unit) => set({ unit })}
          />
        }
      >
        <div className="grid grid-cols-3 gap-2">
          <Field label={`Min (${s.unit})`} htmlFor="opt-min">
            <NumberField id="opt-min" value={s.minU} min={0} onChange={(minU) => set({ minU })} />
          </Field>
          <Field label={`Max (${s.unit})`} htmlFor="opt-max">
            <NumberField id="opt-max" value={s.maxU} min={0} onChange={(maxU) => set({ maxU })} />
          </Field>
          <Field label={`Step (${s.unit})`} htmlFor="opt-step">
            <NumberField id="opt-step" value={s.stepU} min={0} onChange={(stepU) => set({ stepU })} />
          </Field>
        </div>
        {sweepError ? (
          <p className="mt-2 text-xs text-danger" role="alert">
            {sweepError}
          </p>
        ) : runCount >= 1 ? (
          <p className="mt-2 text-xs text-text-secondary" aria-live="polite">
            <span className="font-semibold tabular-nums text-text">{runCount}</span> solver run
            {runCount === 1 ? '' : 's'}, one per diameter, sequential in the background.
          </p>
        ) : (
          <p className="mt-2 text-xs text-text-secondary">
            Pre-filled around the measured diameter after the trace.
          </p>
        )}
      </RailSection>

      <RailSection title="Loss objective" icon={Target}>
        <div className="flex flex-col gap-3">
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
              s.inletPatch && s.inletPatch === s.outletPatch ? 'Inlet and outlet must differ.' : undefined
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
            <NumberField id="opt-density" value={s.density} min={1} onChange={(density) => set({ density })} />
          </Field>
          <Field label="Study name" htmlFor="opt-name" hint="Optional. A default name is used otherwise.">
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
      </RailSection>

      <div className="mt-auto flex flex-col gap-2 px-4 py-4">
        {(create.isError || run.isError) && (
          <p className="text-xs text-danger" role="alert">
            {(create.error ?? run.error) instanceof Error
              ? (create.error ?? run.error)?.message
              : 'Could not create the study.'}
          </p>
        )}
        {!traced ? (
          <p className="text-xs text-text-secondary">
            Click a face on the channel to fit its axis, then place the two rings.
          </p>
        ) : !zoneValid ? (
          <p className="text-xs text-text-secondary">
            Move the two rings apart to set the zone that grows.
          </p>
        ) : null}
        <PrimaryButton onClick={() => onLaunch(true)} disabled={!ready || busy}>
          {busy ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={15} strokeWidth={2} aria-hidden="true" />
          )}
          Launch sweep
        </PrimaryButton>
        <SecondaryButton onClick={() => onLaunch(false)} disabled={!ready || busy}>
          Save as draft
        </SecondaryButton>
      </div>
    </>
  );

  return <WorkspaceFrame stage={stage} rail={rail} />;
}

// ---- study modes (draft / running / finished) --------------------------------

/** Compact recap of a study's configuration, shown in the rail for every mode. */
function StudySummary({ study }: { study: Study }) {
  const meta = STUDY_STATUS_META[study.status];
  const u = study.sweep.unit;
  return (
    <RailSection
      title={study.name}
      icon={Target}
      aside={
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
          {meta.label}
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        <SummaryRow label="Wall patch" value={<span translate="no">{study.morph.wallPatch}</span>} />
        <SummaryRow label="Baseline Ø" value={fmtDiameter(study.morph.baselineDiameterM, u)} />
        <SummaryRow
          label="Range"
          value={`${Number((study.sweep.minM / UNIT_M[u]).toPrecision(4))} to ${Number(
            (study.sweep.maxM / UNIT_M[u]).toPrecision(4),
          )} ${u}`}
        />
        <SummaryRow label="Diameters" value={study.samples.length} />
        <SummaryRow
          label="Objective"
          value={study.objective.primary === 'headLoss' ? 'Head loss' : 'Pressure drop'}
        />
        <SummaryRow
          label="Inlet / outlet"
          value={
            <span translate="no">
              {study.objective.inletPatch} / {study.objective.outletPatch}
            </span>
          }
        />
      </div>
    </RailSection>
  );
}

/** Stage while a study is selected but not finished: the mesh + its centerline. */
function StudyStage({
  study,
  geometry,
  banner,
}: {
  study: Study;
  geometry: ArrayBuffer | null;
  banner?: ReactNode;
}) {
  return (
    <>
      {banner}
      <div className="min-h-0 flex-1 p-3">
        {geometry ? (
          <MorphViewer
            geometry={geometry}
            centerline={study.morph.centerline}
            station1={study.morph.stationA}
            station2={study.morph.stationB}
            ringRadiusM={study.morph.baselineDiameterM / 2}
            pickMode={null}
            onPick={() => {}}
            onPickStation={() => {}}
            morphPreview={null}
          />
        ) : (
          <div className="h-full min-h-64 animate-pulse rounded-md border border-border bg-bg" />
        )}
      </div>
    </>
  );
}

function RunningView({
  projectId,
  study,
  geometry,
  switcher,
}: {
  projectId: string;
  study: Study;
  geometry: ArrayBuffer | null;
  switcher: ReactNode;
}) {
  const stop = useStopStudy(projectId);
  const log = useRunLogQuery(projectId, study.currentRunId ?? null);
  const done = study.samples.filter((x) => x.status !== 'pending' && x.status !== 'running').length;
  const pct = study.samples.length > 0 ? Math.round((done / study.samples.length) * 100) : 0;
  const current = study.samples.find((x) => x.status === 'running');

  const stage = (
    <StudyStage
      study={study}
      geometry={geometry}
      banner={
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5" aria-live="polite">
          <Loader2 size={15} className="animate-spin text-primary" aria-hidden="true" />
          <span className="text-sm font-medium text-text">
            Sweeping{current ? `: solving ${fmtDiameter(current.diameterM, study.sweep.unit)}` : '…'}
          </span>
          <span className="ml-auto text-sm font-semibold tabular-nums text-primary">{pct}%</span>
        </div>
      }
    />
  );

  const rail = (
    <>
      {switcher}
      <StudySummary study={study} />
      <RailSection
        title="Progress"
        icon={Gauge}
        aside={
          <DangerButton className="px-3 py-1.5" onClick={() => stop.mutate(study.id)} disabled={stop.isPending}>
            <Square size={13} strokeWidth={2} aria-hidden="true" />
            Stop
          </DangerButton>
        }
      >
        <p className="mb-2 text-sm text-text-secondary" aria-live="polite">
          <span className="font-semibold tabular-nums text-text">{done}</span> of{' '}
          <span className="tabular-nums">{study.samples.length}</span> diameters settled
        </p>
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
        <ul className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto overscroll-contain">
          {study.samples.map((sample, i) => (
            <SampleChip key={i} sample={sample} unit={study.sweep.unit} />
          ))}
        </ul>
      </RailSection>
      <RailSection title="Live residuals" icon={Play}>
        {study.currentRunId ? (
          <ResidualChart samples={log.data?.series ?? []} />
        ) : (
          <p className="py-4 text-center text-sm text-text-secondary">Preparing the next diameter…</p>
        )}
      </RailSection>
    </>
  );

  return <WorkspaceFrame stage={stage} rail={rail} />;
}

function DraftView({
  projectId,
  study,
  geometry,
  switcher,
  onDeleted,
}: {
  projectId: string;
  study: Study;
  geometry: ArrayBuffer | null;
  switcher: ReactNode;
  onDeleted: () => void;
}) {
  const run = useRunStudy(projectId);
  const del = useDeleteStudy(projectId);

  const rail = (
    <>
      {switcher}
      <StudySummary study={study} />
      <div className="mt-auto flex flex-col gap-2 px-4 py-4">
        {run.isError && (
          <p className="text-xs text-danger" role="alert">
            {run.error instanceof Error ? run.error.message : 'Could not launch the sweep.'}
          </p>
        )}
        <PrimaryButton onClick={() => run.mutate(study.id)} disabled={run.isPending}>
          {run.isPending ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={15} strokeWidth={2} aria-hidden="true" />
          )}
          Launch sweep
        </PrimaryButton>
        <DeleteStudyButton onConfirm={() => del.mutate(study.id, { onSuccess: onDeleted })} pending={del.isPending} />
      </div>
    </>
  );

  return <WorkspaceFrame stage={<StudyStage study={study} geometry={geometry} />} rail={rail} />;
}

function FinishedView({
  projectId,
  study,
  switcher,
  onDeleted,
}: {
  projectId: string;
  study: Study;
  switcher: ReactNode;
  onDeleted: () => void;
}) {
  const run = useRunStudy(projectId);
  const del = useDeleteStudy(projectId);
  const doneSamples = study.samples.filter((x) => x.status === 'done');
  const bestSample = study.samples.find(
    (x) => study.bestDiameterM !== undefined && Math.abs(x.diameterM - study.bestDiameterM) < 1e-12,
  );
  const bestLoss = bestSample?.metrics
    ? study.objective.primary === 'headLoss'
      ? `${Number(bestSample.metrics.headLossM.toPrecision(4))} m`
      : `${Number(bestSample.metrics.pressureDropPa.toPrecision(4))} Pa`
    : '-';

  const stage = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
      {study.status === 'failed' && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-border bg-danger-tint px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{study.reason ?? 'The sweep did not produce a result.'}</span>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-secondary">Optimal diameter</span>
          <span className="text-lg font-semibold tabular-nums text-accent-hover">
            {study.bestDiameterM !== undefined ? fmtDiameter(study.bestDiameterM, study.sweep.unit) : '-'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-secondary">
            {study.objective.primary === 'headLoss' ? 'Least head loss' : 'Least Δp'}
          </span>
          <span className="text-lg font-semibold tabular-nums text-text">{bestLoss}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-secondary">Solved</span>
          <span className="text-lg font-semibold tabular-nums text-text">
            {doneSamples.length} / {study.samples.length}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-text-secondary">Skipped / failed</span>
          <span className="text-lg font-semibold tabular-nums text-text">
            {study.samples.filter((x) => x.status === 'meshFailed' || x.status === 'failed').length}
          </span>
        </div>
      </div>
      <LossChart
        samples={study.samples}
        primary={study.objective.primary}
        unit={study.sweep.unit}
        bestDiameterM={study.bestDiameterM}
      />
    </div>
  );

  const rail = (
    <>
      {switcher}
      <StudySummary study={study} />
      <div className="mt-auto flex flex-col gap-2 px-4 py-4">
        {run.isError && (
          <p className="text-xs text-danger" role="alert">
            {run.error instanceof Error ? run.error.message : 'Could not relaunch the sweep.'}
          </p>
        )}
        <SecondaryButton onClick={() => downloadCsv(study)}>
          <Download size={15} strokeWidth={1.75} aria-hidden="true" />
          Export CSV
        </SecondaryButton>
        <PrimaryButton onClick={() => run.mutate(study.id)} disabled={run.isPending}>
          {run.isPending ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={15} strokeWidth={2} aria-hidden="true" />
          )}
          Run again
        </PrimaryButton>
        <DeleteStudyButton onConfirm={() => del.mutate(study.id, { onSuccess: onDeleted })} pending={del.isPending} />
      </div>
    </>
  );

  return <WorkspaceFrame stage={stage} rail={rail} />;
}

// ---- workspace root ----------------------------------------------------------

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
  const geometryQuery = useMeshGeometryQuery(projectId, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedQuery = useStudyQuery(projectId, selectedId);
  const patches = manifest.data?.patches ?? [];
  const studies = studiesQuery.data ?? [];
  const geometry = geometryQuery.data ?? null;

  if (manifest.isPending || studiesQuery.isPending) {
    return (
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]">
        <div className="min-h-[26rem] animate-pulse rounded-lg border border-border bg-surface" />
        <div className="animate-pulse rounded-lg border border-border bg-surface" />
      </div>
    );
  }

  if (patches.length === 0) {
    return <EmptyMesh />;
  }

  const switcher = (
    <StudySwitcher
      studies={studies}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onNew={() => setSelectedId(null)}
    />
  );

  const selected = selectedId ? selectedQuery.data : undefined;

  // A selected study still loading: keep the frame instead of flashing the setup.
  if (selectedId && !selected) {
    return (
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]">
        <div className="min-h-[26rem] animate-pulse rounded-lg border border-border bg-surface" />
        <div className="animate-pulse rounded-lg border border-border bg-surface" />
      </div>
    );
  }

  if (!selectedId || !selected) {
    return (
      <SetupFlow
        projectId={projectId}
        patches={patches}
        geometry={geometry}
        geometryError={geometryQuery.isError}
        switcher={switcher}
        onCreated={setSelectedId}
      />
    );
  }
  if (isStudyActive(selected.status)) {
    return (
      <RunningView projectId={projectId} study={selected} geometry={geometry} switcher={switcher} />
    );
  }
  if (selected.status === 'draft') {
    return (
      <DraftView
        projectId={projectId}
        study={selected}
        geometry={geometry}
        switcher={switcher}
        onDeleted={() => setSelectedId(null)}
      />
    );
  }
  return (
    <FinishedView
      projectId={projectId}
      study={selected}
      switcher={switcher}
      onDeleted={() => setSelectedId(null)}
    />
  );
}
