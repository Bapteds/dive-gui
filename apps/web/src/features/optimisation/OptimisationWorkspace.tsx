import {
  useEffect,
  useMemo,
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
import { LossChart } from './LossChart';
import {
  FALLOFF_END_FACTOR,
  FALLOFF_START_FACTOR,
  MorphViewer,
  ZONE_BLEND,
  meanRadius,
  type RingPlacement,
} from './MorphViewer';
import {
  NO_TILT,
  TILT_LIMIT,
  axisLength,
  buildAxis,
  dist3,
  type Tilt,
  type Vec3,
} from './ringAxis';
import {
  isStudyActive,
  useCreateStudy,
  useDeleteStudy,
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

/**
 * Point at an arc-length fraction of a raw polyline. Used to rebuild a saved study's
 * two rings from its stored morph (stations 0/1 on the 2-point axis a new study
 * writes, and any station on the longer axis older studies carry).
 */
function pointAtFraction(points: Vec3[], f: number): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  if (points.length === 1) return points[0];
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1] + dist3(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return points[0];
  const s = Math.max(0, Math.min(1, f)) * total;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i += 1;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / seg;
  const a = points[i];
  const b = points[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

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
  which: 'A' | 'B';
  active: boolean;
  placed: boolean;
  onToggle: () => void;
}) {
  const dot = which === 'A' ? 'bg-primary' : 'bg-primary-light';
  const label = active
    ? `Click the shape to place ring ${which}`
    : placed
      ? `Replace ring ${which}`
      : `Place ring ${which}`;
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

/** The X/Y tilt of one ring's cut plane, in degrees. */
function TiltRow({
  label,
  color,
  tilt,
  onChange,
}: {
  label: string;
  color: string;
  tilt: Tilt;
  onChange: (t: Tilt) => void;
}) {
  const slug = label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium text-text">
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
        {label}
      </span>
      {(['x', 'y'] as const).map((axis) => (
        <div key={axis} className="flex items-center gap-2">
          <label
            htmlFor={`tilt-${slug}-${axis}`}
            className="w-3 shrink-0 text-xs uppercase text-text-secondary"
          >
            {axis}
          </label>
          <input
            id={`tilt-${slug}-${axis}`}
            type="range"
            min={-TILT_LIMIT}
            max={TILT_LIMIT}
            step={1}
            value={tilt[axis]}
            onChange={(e) => onChange({ ...tilt, [axis]: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: color }}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-text-secondary">
            {tilt[axis]}°
          </span>
        </div>
      ))}
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
  // NO fitted axis, no rail. The engineer drops TWO rings ANYWHERE on the shape: each
  // click is probed across the channel (wall -> opposite wall) to measure that section's
  // centre + radius right where they clicked. The two measured centres ARE the axis, and
  // the wall between them is the zone whose diameter the sweep changes.
  const [ringA, setRingA] = useState<RingPlacement | null>(null);
  const [ringB, setRingB] = useState<RingPlacement | null>(null);
  // Each ring's cut-plane tilt. Tilting a ring bends the axis to leave/arrive along that
  // plane's normal, so the zone boundary really does follow the ring (see ringAxis.ts).
  const [tiltA, setTiltA] = useState<Tilt>(NO_TILT);
  const [tiltB, setTiltB] = useState<Tilt>(NO_TILT);
  const [pickMode, setPickMode] = useState<'A' | 'B' | null>('A');
  const [previewU, setPreviewU] = useState<number | null>(null);
  // Sweep + objective.
  const [s, setS] = useState<SetupSweep>(defaultSweep);
  const set = (patch: Partial<SetupSweep>) => setS((prev) => ({ ...prev, ...patch }));

  const create = useCreateStudy(projectId);
  const run = useRunStudy(projectId);

  const onPlaceRing = (which: 'A' | 'B', placement: RingPlacement) => {
    if (which === 'A') {
      setRingA(placement);
      setPickMode(ringB === null ? 'B' : null); // guide straight to the second ring
    } else {
      setRingB(placement);
      setPickMode(null);
    }
  };

  // Everything below derives from the two placements + their tilts. No server fit.
  const bothPlaced = ringA !== null && ringB !== null;
  const wallPatch = ringA?.patch ?? ringB?.patch ?? '';
  const meanR = ringA && ringB ? meanRadius(ringA, ringB) : null;
  const baselineM = meanR !== null ? 2 * meanR : null; // the MEASURED diameter
  const chordM = ringA && ringB ? dist3(ringA.center, ringB.center) : null;
  // The two rings must be far enough apart to bound a real band of wall.
  const zoneValid = meanR !== null && chordM !== null && meanR > 0 && chordM > meanR * 0.05;

  const falloffStartM =
    meanR !== null ? Number((meanR * FALLOFF_START_FACTOR).toPrecision(6)) : undefined;
  const falloffEndM =
    meanR !== null ? Number((meanR * FALLOFF_END_FACTOR).toPrecision(6)) : undefined;

  // Pre-fill the sweep around the measured diameter the first time both rings land (a
  // user-tuned range survives a later ring move).
  useEffect(() => {
    if (baselineM === null || !(baselineM > 0)) return;
    const dUnit = baselineM / UNIT_M[s.unit];
    setPreviewU((prev) => (prev === null ? Number(dUnit.toPrecision(4)) : prev));
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
  }, [baselineM]); // eslint-disable-line react-hooks/exhaustive-deps -- prefill once per measure

  const fmtLen = (m: number) => `${Number((m / UNIT_M[s.unit]).toPrecision(3))} ${s.unit}`;

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

  const ready =
    zoneValid &&
    !!wallPatch &&
    runCount >= 1 &&
    runCount <= MAX_SWEEP &&
    !!s.inletPatch &&
    !!s.outletPatch &&
    s.inletPatch !== s.outletPatch &&
    s.density > 0;

  const buildConfig = () => ({
    name: s.name.trim() || undefined,
    morph: {
      wallPatch,
      // The axis comes from the two measured section centres (straight, or bent by the
      // ring tilts). Stations 0->1 span the whole gap between the rings; blendWeight
      // tapers to zero AT each ring, so the grown band rejoins the untouched wall
      // smoothly and nothing beyond a ring ever moves. The radial falloff keeps distant
      // parts of a complex mesh out of it. Same object the viewer previews with.
      centerline: { points: (centerlineObj as { points: Vec3[] }).points },
      stationA: 0,
      stationB: 1,
      blend: ZONE_BLEND,
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

  // Stable across unrelated re-renders so the viewer only redraws / re-morphs when a
  // ring placement, a tilt, or the preview diameter actually changes. This ONE axis is
  // what the viewer previews AND what buildConfig ships, so they cannot disagree.
  const centerlineObj = useMemo(
    () => (ringA && ringB ? { points: buildAxis(ringA.center, ringB.center, tiltA, tiltB) } : null),
    [ringA, ringB, tiltA, tiltB],
  );
  const zoneLenM = centerlineObj ? axisLength(centerlineObj.points) : null;
  const morphPreview = useMemo(
    () =>
      zoneValid && previewU !== null
        ? {
            baselineDiameterM: baselineM as number,
            diameterM: previewU * UNIT_M[s.unit],
            stationA: 0,
            stationB: 1,
            blend: ZONE_BLEND,
            falloffStartM,
            falloffEndM,
          }
        : null,
    [zoneValid, previewU, baselineM, s.unit, falloffStartM, falloffEndM],
  );

  const stage = (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <PickToggle
          which="A"
          active={pickMode === 'A'}
          placed={ringA !== null}
          onToggle={() => setPickMode((m) => (m === 'A' ? null : 'A'))}
        />
        <PickToggle
          which="B"
          active={pickMode === 'B'}
          placed={ringB !== null}
          onToggle={() => setPickMode((m) => (m === 'B' ? null : 'B'))}
        />
        {bothPlaced && (
          <SecondaryButton
            className="px-2.5 py-1.5 text-xs"
            onClick={() => {
              setRingA(null);
              setRingB(null);
              setTiltA(NO_TILT);
              setTiltB(NO_TILT);
              setPickMode('A');
            }}
          >
            Clear rings
          </SecondaryButton>
        )}
        <span className="ml-auto text-xs text-text-secondary">
          Click the shape to drop a ring; drag a ring to move it anywhere.
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        {geometry ? (
          <MorphViewer
            geometry={geometry}
            centerline={centerlineObj}
            ringA={ringA}
            ringB={ringB}
            tiltA={tiltA}
            tiltB={tiltB}
            pickMode={pickMode}
            onPlaceRing={onPlaceRing}
            morphPreview={morphPreview}
          />
        ) : geometryError ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-bg p-8 text-center">
            <AlertTriangle size={20} strokeWidth={1.5} className="text-neutral" aria-hidden="true" />
            <p className="text-sm font-medium text-text">3D preview unavailable</p>
            <p className="max-w-sm text-xs text-text-secondary">
              The mesh render could not be built on this host, so the rings cannot be placed. A
              diameter study needs the 3D view; try reloading, or rebuild the mesh geometry.
            </p>
          </div>
        ) : (
          <div className="h-full min-h-64 animate-pulse rounded-md border border-border bg-bg" />
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-text">Morph zone</span>
            {zoneValid && (
              <span className="text-xs tabular-nums text-text-secondary">
                {fmtLen(zoneLenM as number)} of wall, measured Ø{' '}
                {fmtDiameter(baselineM as number, s.unit)}
              </span>
            )}
          </div>
          {bothPlaced && !zoneValid ? (
            <p className="text-xs text-danger" role="alert">
              The two rings are almost on top of each other; move one further along the shape.
            </p>
          ) : (
            <p className="text-xs text-text-secondary" aria-live="polite">
              {!ringA
                ? 'Click the shape wherever you want ring A.'
                : !ringB
                  ? 'Now click wherever you want ring B: the wall between the two rings is what changes diameter.'
                  : 'Drag either ring to move it anywhere on the shape.'}
            </p>
          )}
        </div>
        {zoneValid && previewU !== null && s.maxU > s.minU && (
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
    </>
  );

  const rail = (
    <>
      {switcher}
      <RailSection title="The two rings" icon={Ruler}>
        <div className="flex flex-col gap-2">
          <SummaryRow
            label="Wall patch"
            value={
              wallPatch ? (
                <span translate="no">{wallPatch}</span>
              ) : (
                <span className="font-normal text-text-secondary">from your click</span>
              )
            }
          />
          <SummaryRow
            label="Ring A"
            value={
              ringA ? (
                `Ø ${fmtDiameter(2 * ringA.radius, s.unit)}`
              ) : (
                <span className="font-normal text-text-secondary">not placed</span>
              )
            }
          />
          <SummaryRow
            label="Ring B"
            value={
              ringB ? (
                `Ø ${fmtDiameter(2 * ringB.radius, s.unit)}`
              ) : (
                <span className="font-normal text-text-secondary">not placed</span>
              )
            }
          />
          {zoneValid && (
            <>
              <SummaryRow label="Zone length" value={fmtLen(zoneLenM as number)} />
              <SummaryRow label="Baseline Ø" value={fmtDiameter(baselineM as number, s.unit)} />
            </>
          )}
          <p className="text-xs text-text-secondary">
            Click the shape wherever you want each ring: the channel is measured across at that
            exact spot, so there is no axis to follow and nothing snaps. The highlighted wall
            between the two rings is what the sweep grows. Drag a ring to move it anywhere.
          </p>
        </div>

        {bothPlaced && (
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-text">Tilt the cut planes</span>
              {(tiltA.x || tiltA.y || tiltB.x || tiltB.y) !== 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setTiltA(NO_TILT);
                    setTiltB(NO_TILT);
                  }}
                  className="rounded-sm text-xs text-text-secondary underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  reset
                </button>
              )}
            </div>
            <TiltRow label="Ring A" color="var(--color-primary)" tilt={tiltA} onChange={setTiltA} />
            <TiltRow
              label="Ring B"
              color="var(--color-primary-light)"
              tilt={tiltB}
              onChange={setTiltB}
            />
            <p className="text-xs text-text-secondary">
              Tip a ring so its cut sits square across the channel. The axis leaves each ring
              along its own plane, so on a bend the zone follows the curve instead of cutting the
              corner.
            </p>
          </div>
        )}
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
        {!zoneValid && (
          <p className="text-xs text-text-secondary">
            Click the shape to place ring A and ring B; the wall between them is what grows.
          </p>
        )}
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
  const m = study.morph;
  // Rebuild the saved rings for a read-only view. Keyed on the study (its morph is
  // immutable once created) so a 2s status poll never re-runs the viewer's heavy work.
  const view = useMemo(() => {
    const pts = m.centerline.points as Vec3[];
    const radius = m.baselineDiameterM / 2;
    return {
      centerline: m.centerline,
      ringA: { center: pointAtFraction(pts, m.stationA), radius, patch: m.wallPatch },
      ringB: { center: pointAtFraction(pts, m.stationB), radius, patch: m.wallPatch },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- morph is fixed per study
  }, [study.id, m.stationA, m.stationB, m.baselineDiameterM, m.wallPatch]);
  return (
    <>
      {banner}
      <div className="min-h-0 flex-1 p-3">
        {geometry ? (
          <MorphViewer
            geometry={geometry}
            centerline={view.centerline}
            ringA={view.ringA}
            ringB={view.ringB}
            // Read-only: the saved axis already carries any tilt, and its end tangents
            // orient the rings, so no tilt needs replaying here.
            tiltA={NO_TILT}
            tiltB={NO_TILT}
            pickMode={null}
            onPlaceRing={() => {}}
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
