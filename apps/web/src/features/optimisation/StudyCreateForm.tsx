import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  CHAMBER_OUTPUT_KEYS,
  STUDY_DEFAULTS,
  STUDY_MAX_EVALUATIONS,
  chamberSpiralModelInput,
  computeChamberOutputs,
  computeParamSpace,
  studyPickableKeys,
  studyRelationWarnings,
  type ChamberInput,
  type ChamberOutputKey,
  type ChamberSaveSummary,
  type CreateStudyRequest,
  type PublicStudy,
  type StudyMode,
  type StudySampler,
  type StudySetup,
  type StudyVortexMetric,
} from '@dive/shared';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { useCreateStudy, useUpdateStudy } from './useStudies';

/**
 * StudyCreateForm - the inline "New study" / "Edit study" form of the
 * Optimisation tab (WS-H spec §4-§5, §0). The search space is previewed live
 * with the same shared function the API uses (computeParamSpace: band around the
 * base FINAL ∩ table Min / Max, 50 mm grid snapped inward), so what the user
 * sees is what the study will explore. One orange CTA (Create study / Save
 * changes); advanced optimiser settings sit behind a disclosure.
 *
 * Visual contract: brain/design/design-system.md sections 2, 4 and 6 (hairline
 * panel, labels above fields, tokens only, errors with role="alert").
 */

interface StudyCreateFormProps {
  projectId: string;
  setup: StudySetup;
  saves: ChamberSaveSummary[];
  /** Edit this draft instead of creating a study. */
  study?: PublicStudy;
  onDone: (study: PublicStudy) => void;
  onCancel: () => void;
}

type BaseKind = 'save' | 'meshOrigin';

const MODE_OPTIONS: { value: StudyMode; label: string }[] = [
  { value: 'weighted', label: 'Weighted sum' },
  { value: 'pareto', label: 'Pareto front' },
];
const VORTEX_OPTIONS: { value: StudyVortexMetric; label: string }[] = [
  { value: 'maskedQVolume', label: 'Masked Q volume' },
  { value: 'omegaRms', label: 'RMS vorticity' },
];
const SAMPLER_LABELS: Record<StudySampler, string> = {
  tpe: 'TPE (Bayesian, default)',
  nsga2: 'NSGA-II (genetic, for Pareto)',
  random: 'Random (reference)',
};

/** A finite number from a text field, or null. */
function num(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const fmtMm = (v: number) => Math.round(v).toString();

export function StudyCreateForm({
  projectId,
  setup,
  saves,
  study,
  onDone,
  onCancel,
}: StudyCreateFormProps) {
  const uid = useId();
  const editing = !!study;
  const create = useCreateStudy(projectId);
  const update = useUpdateStudy(projectId);
  const pending = create.isPending || update.isPending;

  const [name, setName] = useState(study?.name ?? '');
  const [baseKind, setBaseKind] = useState<BaseKind>(
    setup.originInput && !study ? 'meshOrigin' : saves.length ? 'save' : 'meshOrigin',
  );
  const [saveId, setSaveId] = useState(saves[0]?.id ?? '');
  const [keys, setKeys] = useState<ChamberOutputKey[]>(study?.paramSpace.map((r) => r.key) ?? []);
  const [bandPct, setBandPct] = useState(String(study?.bandPct ?? STUDY_DEFAULTS.bandPct));
  const [overrides, setOverrides] = useState<Partial<Record<ChamberOutputKey, string>>>(() =>
    Object.fromEntries(
      (study?.paramSpace ?? [])
        .filter((r) => r.bandPct !== study?.bandPct)
        .map((r) => [r.key, String(r.bandPct)]),
    ),
  );
  const [mode, setMode] = useState<StudyMode>(study?.mode ?? STUDY_DEFAULTS.mode);
  const [weightHead, setWeightHead] = useState(
    String(study?.weights.headLoss ?? STUDY_DEFAULTS.weights.headLoss),
  );
  const [weightVortex, setWeightVortex] = useState(
    String(study?.weights.vortex ?? STUDY_DEFAULTS.weights.vortex),
  );
  const [vortexMetric, setVortexMetric] = useState<StudyVortexMetric>(
    study?.vortexMetric ?? STUDY_DEFAULTS.vortexMetric,
  );
  const [sessionId, setSessionId] = useState(
    study?.meshingSourceId ?? setup.defaultSessionId ?? setup.sessions[0]?.id ?? '',
  );
  const [cores, setCores] = useState(String(study?.cores ?? setup.defaultCores));
  const [maxEvaluations, setMaxEvaluations] = useState(
    String(study?.maxEvaluations ?? STUDY_DEFAULTS.maxEvaluations),
  );
  const [maxHours, setMaxHours] = useState(
    study?.maxDurationHours != null ? String(study.maxDurationHours) : '',
  );
  const [sampler, setSampler] = useState<StudySampler>(study?.sampler ?? STUDY_DEFAULTS.sampler);
  const [samplerTouched, setSamplerTouched] = useState(editing);
  const [seed, setSeed] = useState(study?.seed != null ? String(study.seed) : '');
  const [keepBest, setKeepBest] = useState(String(study?.keepBest ?? STUDY_DEFAULTS.keepBest));
  const [keepLast, setKeepLast] = useState(String(study?.keepLast ?? STUDY_DEFAULTS.keepLast));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const baseInput: ChamberInput | null = study
    ? study.baseInput
    : baseKind === 'save'
      ? (saves.find((s) => s.id === saveId)?.snapshot ?? null)
      : setup.originInput;

  const band = num(bandPct);
  const bandOk = band !== null && band > 0 && band <= 100;
  const outputs = useMemo(
    () => (baseInput ? computeChamberOutputs(chamberSpiralModelInput(baseInput)) : []),
    [baseInput],
  );
  const pickable = useMemo(() => (baseInput ? studyPickableKeys(baseInput) : []), [baseInput]);
  const overrideValues = useMemo(() => {
    const out: Partial<Record<ChamberOutputKey, number>> = {};
    for (const [key, text] of Object.entries(overrides) as [ChamberOutputKey, string][]) {
      const value = num(text);
      if (value !== null && value > 0 && value <= 100) out[key] = value;
    }
    return out;
  }, [overrides]);
  const rangeOf = (key: ChamberOutputKey) =>
    baseInput && bandOk
      ? computeParamSpace(baseInput, [key], band as number, overrideValues)
      : null;
  const relationWarnings = baseInput ? studyRelationWarnings(baseInput, keys) : [];

  const toggleKey = (key: ChamberOutputKey, on: boolean) =>
    setKeys((prev) =>
      on
        ? CHAMBER_OUTPUT_KEYS.filter((k) => k === key || prev.includes(k))
        : prev.filter((k) => k !== key),
    );

  const onModeChange = (next: StudyMode) => {
    setMode(next);
    if (!samplerTouched) setSampler(next === 'pareto' ? 'nsga2' : 'tpe');
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Enter a name for the study.';
    if (!baseInput) {
      e.base =
        baseKind === 'save'
          ? 'Pick a chamber save.'
          : "This project's mesh does not come from a chamber build. Pick a chamber save.";
    }
    if (!bandOk) e.band = 'Enter a band between 0 and 100 %.';
    if (keys.length === 0) e.keys = 'Tick at least one parameter to optimise.';
    else if (baseInput && bandOk) {
      const space = computeParamSpace(baseInput, keys, band as number, overrideValues);
      if (space.errors.length) e.keys = space.errors.join(' ');
    }
    if (mode === 'weighted') {
      const h = num(weightHead);
      const v = num(weightVortex);
      if (h === null || v === null || h < 0 || v < 0 || h + v <= 0) {
        e.weights = 'At least one weight must be above 0.';
      }
    }
    if (!sessionId) e.session = 'Pick the reference meshing session.';
    const max = num(maxEvaluations);
    if (max === null || !Number.isInteger(max) || max < 1 || max > STUDY_MAX_EVALUATIONS) {
      e.maxEvaluations = `Enter a whole number from 1 to ${STUDY_MAX_EVALUATIONS}.`;
    }
    const hours = num(maxHours);
    if (maxHours.trim() !== '' && (hours === null || hours <= 0)) {
      e.maxHours = 'Enter a positive number of hours, or leave it empty.';
    }
    const c = num(cores);
    if (c === null || !Number.isInteger(c) || c < 1) e.cores = 'Enter a whole number of cores.';
    for (const [field, text] of [
      ['keepBest', keepBest],
      ['keepLast', keepLast],
    ] as const) {
      const value = num(text);
      if (value === null || !Number.isInteger(value) || value < 0) e[field] = 'Enter 0 or more.';
    }
    if (
      seed.trim() !== '' &&
      (num(seed) === null || !Number.isInteger(num(seed)) || (num(seed) as number) < 0)
    ) {
      e.seed = 'Enter a whole number, or leave it empty.';
    }
    return e;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Focus the first invalid control once the errors are rendered.
      requestAnimationFrame(() => {
        const first = formRef.current?.querySelector<HTMLElement>(
          '[aria-invalid="true"], [data-error-anchor="true"]',
        );
        first?.focus();
      });
      return;
    }
    const body: CreateStudyRequest = {
      name: name.trim(),
      base: baseKind === 'save' ? { kind: 'save', saveId } : { kind: 'meshOrigin' },
      keys,
      bandPct: band as number,
      ...(Object.keys(overrideValues).length ? { bandOverrides: overrideValues } : {}),
      weights: { headLoss: num(weightHead) ?? 0, vortex: num(weightVortex) ?? 0 },
      mode,
      sampler,
      seed: seed.trim() === '' ? null : Number(seed),
      vortexMetric,
      maxEvaluations: Number(maxEvaluations),
      maxDurationHours: maxHours.trim() === '' ? null : Number(maxHours),
      keepBest: Number(keepBest),
      keepLast: Number(keepLast),
      meshingSourceId: sessionId,
      cores: Number(cores),
    };
    const handlers = {
      onSuccess: (saved: PublicStudy) => {
        toast.success(editing ? 'Study saved.' : 'Study created. Start it when ready.');
        onDone(saved);
      },
      onError: (err: Error) => toast.error(err.message || 'The study could not be saved.'),
    };
    if (study) {
      // The base design of a draft stays as created.
      const { base: _base, ...rest } = body;
      void _base;
      update.mutate({ studyId: study.id, body: rest }, handlers);
    } else {
      create.mutate(body, handlers);
    }
  };

  const fieldset = 'flex flex-col gap-4 border-t border-border pt-5 first:border-t-0 first:pt-0';
  const legend = 'mb-1 text-sm font-semibold text-text';

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="rounded-md border border-border bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h3 id={`${uid}-title`} className="text-base font-semibold text-text">
          {editing ? 'Edit study' : 'New study'}
        </h3>
        <p className="mt-1 max-w-[70ch] text-sm text-text-secondary">
          Each evaluation builds a design, meshes it with the reference session, replaces this
          project&apos;s case mesh and solves until the convergence criteria of the Solver tab.
        </p>
      </div>

      <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-5 px-5 py-5">
        {(setup.runningStudy || !setup.criteriaApplicable) && (
          <ul className="flex flex-col gap-2 text-sm">
            {!setup.criteriaApplicable && (
              <Note>
                The case needs a steady incompressible solver (simpleFoam) before the study can
                start. Set it up in the Solver tab.
              </Note>
            )}
            {setup.runningStudy && (
              <Note>
                The study “{setup.runningStudy.name}” is running. One study runs at a time: this one
                can be created now and started later.
              </Note>
            )}
          </ul>
        )}

        <fieldset className={fieldset}>
          <legend className={legend}>Study</legend>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Study name" required error={errors.name}>
              <Input
                name="studyName"
                autoComplete="off"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className={fieldset}>
          <legend className={legend}>Base design</legend>
          {editing ? (
            <p className="text-sm text-text-secondary">
              {study?.baseLabel}. The base design of a study stays as created; create a new study
              for another base.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-text" id={`${uid}-base`}>
                  Start from
                </span>
                <SegmentedRadioGroup<BaseKind>
                  name={`${uid}-base-kind`}
                  ariaLabel="Start from"
                  value={baseKind}
                  onChange={setBaseKind}
                  options={[
                    { value: 'save', label: 'Chamber save' },
                    { value: 'meshOrigin', label: 'Chamber of this mesh' },
                  ]}
                />
              </div>
              {baseKind === 'save' ? (
                <Field
                  label="Chamber save"
                  error={errors.base}
                  helperText={
                    saves.length
                      ? undefined
                      : 'No chamber save yet: save a design in Chamber Creation.'
                  }
                >
                  <NativeSelect
                    name="chamberSave"
                    value={saveId}
                    onChange={(e) => setSaveId(e.target.value)}
                    disabled={saves.length === 0}
                  >
                    {saves.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : (
                <p
                  className={cn(
                    'self-end text-sm',
                    setup.originInput ? 'text-text-secondary' : 'text-danger',
                  )}
                  role={setup.originInput ? undefined : 'alert'}
                >
                  {setup.originInput && setup.origin
                    ? `The chamber built for the meshing session “${setup.origin.sessionName}”.`
                    : "This project's mesh does not come from a chamber build. Pick a chamber save."}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className={fieldset}>
          <legend className={legend}>Parameters to optimise</legend>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[12rem_1fr]">
            <Field
              label="Band (±%)"
              error={errors.band}
              helperText="Around each base value, within the table Min / Max."
            >
              <Input
                name="bandPct"
                inputMode="decimal"
                value={bandPct}
                onChange={(e) => setBandPct(e.target.value)}
              />
            </Field>
            <p className="self-center text-sm text-text-secondary">
              Values move on the 50 mm manufacturing grid and are sent as Exact. Runner Ø, Head and
              Q_max stay fixed.
            </p>
          </div>
          {baseInput ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[560px] text-sm" aria-label="Parameters to optimise">
                <thead className="bg-bg">
                  <tr>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium text-text-secondary"
                    >
                      Parameter
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-right text-xs font-medium text-text-secondary"
                    >
                      Base (mm)
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium text-text-secondary"
                    >
                      Band (±%)
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium text-text-secondary"
                    >
                      Range explored
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pickable.map((key) => {
                    const output = outputs.find((o) => o.key === key);
                    const checked = keys.includes(key);
                    const space = checked ? rangeOf(key) : null;
                    const range = space?.ranges[0];
                    const label = output?.label ?? key;
                    return (
                      <tr key={key} className={cn(checked && 'bg-primary-tint')}>
                        <td className="px-3 py-2">
                          <label className="flex cursor-pointer items-center gap-2 text-text">
                            <input
                              type="checkbox"
                              name={`key-${key}`}
                              checked={checked}
                              onChange={(e) => toggleKey(key, e.target.checked)}
                              className="size-4 shrink-0 rounded-xs border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
                            />
                            {label}
                          </label>
                        </td>
                        <td
                          className="px-3 py-2 text-right tabular-nums text-text"
                          data-testid={`base-${key}`}
                        >
                          {output && Number.isFinite(output.final) ? fmtMm(output.final) : '-'}
                        </td>
                        <td className="px-3 py-1.5">
                          {checked ? (
                            <Input
                              name={`band-${key}`}
                              inputMode="decimal"
                              aria-label={`Band for ${label} (±%)`}
                              placeholder={bandPct}
                              value={overrides[key] ?? ''}
                              onChange={(e) =>
                                setOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              className="h-8 w-20"
                            />
                          ) : (
                            <span className="text-text-secondary">-</span>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums" data-testid={`range-${key}`}>
                          {!checked ? (
                            <span className="text-text-secondary">-</span>
                          ) : range ? (
                            <span className="text-text">
                              {fmtMm(range.min)} to {fmtMm(range.max)} mm
                              {range.source === 'table' && (
                                <span className="text-text-secondary"> (table limit)</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-danger">
                              {space?.errors[0] ?? 'Enter a valid band.'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              Pick a base design to list its parameters.
            </p>
          )}
          {errors.keys && (
            <p
              role="alert"
              tabIndex={-1}
              data-error-anchor="true"
              className="text-xs font-medium text-danger focus-visible:outline-none"
            >
              {errors.keys}
            </p>
          )}
          {relationWarnings.length > 0 && (
            <ul className="flex flex-col gap-2 text-sm">
              {relationWarnings.map((w) => (
                <Note key={w}>{w}</Note>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className={fieldset}>
          <legend className={legend}>Objective</legend>
          <div className="flex flex-wrap items-start gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-text">Aggregation</span>
              <SegmentedRadioGroup<StudyMode>
                name={`${uid}-mode`}
                ariaLabel="Aggregation"
                value={mode}
                onChange={onModeChange}
                options={MODE_OPTIONS}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-text">Vortex metric</span>
              <SegmentedRadioGroup<StudyVortexMetric>
                name={`${uid}-vortex`}
                ariaLabel="Vortex metric"
                value={vortexMetric}
                onChange={setVortexMetric}
                options={VORTEX_OPTIONS}
              />
            </div>
          </div>
          {mode === 'weighted' ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:max-w-md">
                <Field label="Head loss weight">
                  <Input
                    name="weightHeadLoss"
                    inputMode="decimal"
                    value={weightHead}
                    onChange={(e) => setWeightHead(e.target.value)}
                  />
                </Field>
                <Field label="Vortex weight">
                  <Input
                    name="weightVortex"
                    inputMode="decimal"
                    value={weightVortex}
                    onChange={(e) => setWeightVortex(e.target.value)}
                  />
                </Field>
              </div>
              {errors.weights ? (
                <p
                  role="alert"
                  tabIndex={-1}
                  data-error-anchor="true"
                  className="text-xs font-medium text-danger focus-visible:outline-none"
                >
                  {errors.weights}
                </p>
              ) : (
                <p className="text-xs text-text-secondary">
                  J = w_h · head loss / baseline + w_v · vortex / baseline. The baseline is the
                  unmodified base design, always evaluated first.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              Both objectives are minimised; the tab shows the non-dominated designs.
            </p>
          )}
        </fieldset>

        <fieldset className={fieldset}>
          <legend className={legend}>Pipeline and budget</legend>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field
              label="Reference meshing session"
              error={errors.session}
              helperText={
                setup.sessions.length
                  ? 'Its settings mesh every design.'
                  : 'No meshed session yet: mesh the chamber once in Meshing.'
              }
            >
              <NativeSelect
                name="meshingSource"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                disabled={setup.sessions.length === 0}
              >
                {setup.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.id === setup.origin?.sessionId ? ' (mesh origin)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Solver cores" error={errors.cores}>
              <Input
                name="cores"
                inputMode="numeric"
                value={cores}
                onChange={(e) => setCores(e.target.value)}
              />
            </Field>
            <Field
              label="Max evaluations"
              error={errors.maxEvaluations}
              helperText="Baseline included."
            >
              <Input
                name="maxEvaluations"
                inputMode="numeric"
                value={maxEvaluations}
                onChange={(e) => setMaxEvaluations(e.target.value)}
              />
            </Field>
            <Field label="Max duration (h)" error={errors.maxHours} helperText="Optional.">
              <Input
                name="maxDurationHours"
                inputMode="decimal"
                value={maxHours}
                onChange={(e) => setMaxHours(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <details className="group border-t border-border pt-5">
          <summary className="w-fit cursor-pointer rounded-sm text-sm font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
            Advanced
          </summary>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Sampler">
              <NativeSelect
                name="sampler"
                value={sampler}
                onChange={(e) => {
                  setSampler(e.target.value as StudySampler);
                  setSamplerTouched(true);
                }}
              >
                {(Object.keys(SAMPLER_LABELS) as StudySampler[]).map((s) => (
                  <option key={s} value={s}>
                    {SAMPLER_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Seed" error={errors.seed} helperText="Empty = random.">
              <Input
                name="seed"
                inputMode="numeric"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
              />
            </Field>
            <Field label="Keep best sessions" error={errors.keepBest}>
              <Input
                name="keepBest"
                inputMode="numeric"
                value={keepBest}
                onChange={(e) => setKeepBest(e.target.value)}
              />
            </Field>
            <Field
              label="Keep last sessions"
              error={errors.keepLast}
              helperText="Other meshing sessions are deleted once archived."
            >
              <Input
                name="keepLast"
                inputMode="numeric"
                value={keepLast}
                onChange={(e) => setKeepLast(e.target.value)}
              />
            </Field>
          </div>
        </details>

        <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-5">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {editing ? 'Save changes' : 'Create study'}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** A warning line (icon + text, never colour alone). */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 rounded-sm bg-accent-tint px-3 py-2 text-text">
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-accent-strong"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}
