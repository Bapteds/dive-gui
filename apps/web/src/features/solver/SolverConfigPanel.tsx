import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  Loader2,
  Play,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { getCaseFileContent } from '@/lib/api/projects';
import {
  SOLVER_CATALOG,
  SOLVER_LIBRARY,
  TURBULENCE_APPROACHES,
  TURBULENCE_MODELS,
  isConfigurableSolver,
  type ConfigurableSolverId,
  type SolverId,
  type SolverParamDef,
} from '@/lib/api/types';
import {
  caseFileContentQueryKey,
  useCaseFileContentQuery,
  useCaseFilesQuery,
  useSaveCaseFile,
} from '@/features/projects/useCaseFiles';
import {
  getFoamValue,
  insertFoamField,
  parseFoamModel,
  setFoamValue,
} from '@/features/projects/foamModel';
import { CaseFileEditor } from '@/features/projects/CaseFileEditor';
import { SolverBrowserDialog } from './SolverBrowserDialog';
import { useScaffoldSolver } from './useRuns';

/**
 * The solver files worth surfacing FIRST in Advanced mode (a solver with no catalog
 * template falls back to these). This is only a preferred ORDERING — the dropdown
 * lists the case's REAL files (see AdvancedConfig), so a name here that isn't on disk
 * is simply never shown, instead of being offered and 404-ing on open.
 */
const DEFAULT_SOLVER_FILES = [
  'system/controlDict',
  'system/fvSchemes',
  'system/fvSolution',
  'constant/turbulenceProperties',
  'constant/transportProperties',
  '0/U',
  '0/p',
];

/**
 * Keep only editable config files: system/, 0/, constant/, minus the binary mesh
 * (mirrors the wizard's SolverFilesStep). Used to list the case's REAL files so the
 * Advanced editor never advertises a path that does not exist on disk.
 */
function isConfigFile(path: string): boolean {
  const top = path.split('/')[0];
  if (top !== 'system' && top !== '0' && top !== 'constant') return false;
  if (path === 'constant/polyMesh' || path.startsWith('constant/polyMesh/')) return false;
  return true;
}

/**
 * SolverConfigPanel - configure the solver with the same Easy / Advanced split as
 * the per-file editor, but solver-centric and cross-file.
 *
 *  - Easy: pick the solver (archetype) and set only the handful of parameters that
 *    actually matter for it (turbulence model, viscosity, end time, convergence /
 *    time step, ...). Each control reads and writes its own case file by splicing
 *    the single value back in (foamModel), so comments and everything else are
 *    preserved - exactly how the file form works, just gathered in one place.
 *  - Advanced: type any solver binary into `application`, and edit the raw solver
 *    dictionaries directly. No curation, full control.
 *
 * The single orange CTA in this zone stays the Run button; every configuration
 * control is neutral or brand-blue. Editing is locked while a run is active.
 */
/** Clamp a core-count input to the integer range [1, max]. */
function clampCores(value: string, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/** Per-project storage key for the chosen core count. */
const coresStorageKey = (projectId: string) => `dive.solver.cores.${projectId}`;

/**
 * Read the persisted core count for a project (clamped to [1, max]), so the choice
 * survives leaving/returning to the tab or a reload — otherwise it silently resets to
 * 1 and the next "Run again" goes serial without the user noticing. Defaults to 1.
 */
function readStoredCores(projectId: string, max: number): number {
  try {
    const raw = window.localStorage.getItem(coresStorageKey(projectId));
    return raw == null ? 1 : clampCores(raw, max);
  } catch {
    return 1;
  }
}

/** Persist the chosen core count for a project (best-effort; storage may be unavailable). */
function writeStoredCores(projectId: string, value: number): void {
  try {
    window.localStorage.setItem(coresStorageKey(projectId), String(value));
  } catch {
    /* storage blocked (private mode) — the in-memory value still applies this session */
  }
}

interface SolverConfigPanelProps {
  projectId: string;
  /** The solver read from controlDict (any library binary), or null. */
  solver: string | null;
  /** Whether the solver has a guided (easy) form; else it is manual setup. */
  scaffoldable: boolean;
  active: boolean;
  /** Server core budget: the max cores the run selector allows. */
  maxCores: number;
  runLabel: string;
  runPending: boolean;
  onRun: (cores: number) => void;
  /** Re-open the setup wizard (solver -> turbulence -> files). */
  onReconfigure: () => void;
}

export function SolverConfigPanel({
  projectId,
  solver,
  scaffoldable,
  active,
  maxCores,
  runLabel,
  runPending,
  onRun,
  onReconfigure,
}: SolverConfigPanelProps) {
  const [mode, setMode] = useState<'easy' | 'advanced'>(scaffoldable ? 'easy' : 'advanced');
  const [cores, setCores] = useState(() => readStoredCores(projectId, maxCores));
  const [configOpen, setConfigOpen] = useState(false);

  // Persist the choice and keep it within the current server budget (it may shrink
  // while the panel is mounted, e.g. another project starts a run).
  const updateCores = (value: string) => {
    const next = clampCores(value, maxCores);
    setCores(next);
    writeStoredCores(projectId, next);
  };
  useEffect(() => {
    setCores((current) => Math.min(current, maxCores));
  }, [maxCores]);
  const configurable = solver && isConfigurableSolver(solver) ? solver : null;
  const solverLabel = SOLVER_LIBRARY.find((entry) => entry.id === solver)?.label ?? solver ?? 'None';

  return (
    <div className="rounded-md border border-border bg-surface shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text">Solver configuration</h2>
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          <Button variant="secondary" onClick={onReconfigure} disabled={active}>
            <Wrench strokeWidth={1.75} aria-hidden="true" />
            Reconfigure
          </Button>
          {!active && (
            <Button variant="primary" loading={runPending} onClick={() => onRun(cores)}>
              <Play strokeWidth={1.75} aria-hidden="true" />
              {runLabel}
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {active && (
          <p className="text-xs text-text-secondary" role="status">
            Configuration is locked while a run is active.
          </p>
        )}
        {!active && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-secondary">Cores</span>
              <input
                type="number"
                min={1}
                max={maxCores}
                value={cores}
                onChange={(event) => updateCores(event.target.value)}
                aria-label="Number of cores for the run"
                className="w-24 rounded-sm border border-border bg-surface px-2 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </label>
            <p className="max-w-[30rem] text-xs text-text-secondary">
              {maxCores} available on the server. 1 runs serially; more runs the solver in
              parallel (decomposePar + mpirun). A run is refused if not enough cores are free.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg/40 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-text-secondary">Solver</span>
            <span className="text-sm font-medium text-text">{solverLabel}</span>
          </div>
          <Button variant="secondary" onClick={() => setConfigOpen(true)} disabled={active}>
            <SlidersHorizontal strokeWidth={1.75} aria-hidden="true" />
            Configure
          </Button>
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent
          className="flex h-[85vh] w-[90vw] max-w-[60rem] flex-col gap-0 overflow-hidden p-0"
          onInteractOutside={(event) => {
            // The solver browser and file editor inside portal outside this content;
            // don't close the config overlay when interacting with them.
            const target = event.target as Element | null;
            if (
              target?.closest(
                '[data-radix-popper-content-wrapper],[role="menu"],[role="dialog"],[role="alertdialog"]',
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <DialogHeader className="shrink-0 border-b border-border p-4 pr-12">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <DialogTitle>Configure the solver</DialogTitle>
                <DialogDescription>
                  Set the solver and its parameters (Easy), or edit the raw dictionaries
                  (Advanced). Changes save automatically.
                </DialogDescription>
              </div>
              <ModeToggle mode={mode} onChange={setMode} />
            </div>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
            <ChangeSolver projectId={projectId} current={solver} disabled={active} />
            {mode === 'easy' ? (
              configurable ? (
                <div className="flex flex-col gap-3">
                  {SOLVER_CATALOG[configurable]?.tier === 'base' && <BaseSetupHint />}
                  <SolverEasyForm projectId={projectId} solver={configurable} disabled={active} />
                </div>
              ) : (
                <ManualEasyNote solver={solver} />
              )
            ) : (
              <AdvancedConfig projectId={projectId} solver={configurable} disabled={active} />
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border p-4">
            <Button variant="primary" onClick={() => setConfigOpen(false)}>
              <Check strokeWidth={1.9} aria-hidden="true" />
              Done
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Honest hint for base-tier solvers: the scaffold is a flow base you extend. */
function BaseSetupHint() {
  return (
    <div className="rounded-md border border-border bg-bg/40 p-3 text-xs text-text-secondary">
      Base setup. The parameters below are the universal knobs; this solver&apos;s physics-specific
      fields (phases, chemistry, sources, ...) are added in the Advanced tab or the file editor.
    </div>
  );
}

/** Easy-mode note for a solver with no guided form: point to Advanced / the editor. */
function ManualEasyNote({ solver }: { solver: string | null }) {
  const info = SOLVER_LIBRARY.find((entry) => entry.id === solver);
  return (
    <div className="rounded-md border border-border bg-bg/40 p-4">
      <p className="text-sm font-medium text-text">Manual setup</p>
      <p className="mt-1 text-sm text-text-secondary">
        {info?.label ?? solver ?? 'This solver'} has no guided form yet. Set its `application`
        and edit the solver files in Advanced mode (or the Detail file editor). It runs once the
        case files are in place.
      </p>
    </div>
  );
}

/** Segmented Easy / Advanced switch (mirrors the file editor's ModeToggle). */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'easy' | 'advanced';
  onChange: (mode: 'easy' | 'advanced') => void;
}) {
  return (
    <div
      role="group"
      aria-label="Configuration mode"
      className="inline-flex items-center rounded-md border border-border bg-bg p-0.5"
    >
      <ModeButton
        active={mode === 'easy'}
        onClick={() => onChange('easy')}
        icon={<Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
        label="Easy"
      />
      <ModeButton
        active={mode === 'advanced'}
        onClick={() => onChange('advanced')}
        icon={<Code2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
        label="Advanced"
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        active ? 'bg-surface text-primary shadow-sm' : 'text-text-secondary hover:text-text',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Show the current solver and let the user switch to any library solver via the
 * browser overlay. Switching re-scaffolds the case, so it is an explicit two-step
 * action: pick in the overlay, then Apply (with a plain note), never silent.
 */
function ChangeSolver({
  projectId,
  current,
  disabled,
}: {
  projectId: string;
  current: string | null;
  disabled: boolean;
}) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [choice, setChoice] = useState<SolverId | null>(null);
  const scaffold = useScaffoldSolver(projectId);
  const info = SOLVER_LIBRARY.find((entry) => entry.id === current);
  const pendingChoice = choice && choice !== current ? choice : null;

  const apply = async () => {
    if (!pendingChoice) return;
    try {
      await scaffold.mutateAsync({ solver: pendingChoice });
      toast.success(`Switched to ${pendingChoice}. The case was updated.`);
      setChoice(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not switch the solver.');
    }
  };

  return (
    <section className="rounded-md border border-border bg-bg/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-text-secondary">Solver</span>
          <span className="text-sm font-medium text-text">
            {info?.label ?? current ?? 'None selected'}{' '}
            <span className="font-mono text-xs text-text-secondary" translate="no">
              ({current ?? '-'})
            </span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-primary"
          disabled={disabled || scaffold.isPending}
          onClick={() => setBrowserOpen(true)}
        >
          Change solver
        </Button>
      </div>

      {pendingChoice && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={scaffold.isPending}
            onClick={() => void apply()}
          >
            Apply {pendingChoice}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={scaffold.isPending}
            onClick={() => setChoice(null)}
          >
            Cancel
          </Button>
          <p className="text-xs text-text-secondary">
            Switching regenerates the solver setup. Your boundary conditions and property values
            are kept.
          </p>
        </div>
      )}

      <SolverBrowserDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        value={(pendingChoice ?? current ?? 'simpleFoam') as SolverId}
        onSelect={(id) => setChoice(id)}
      />
    </section>
  );
}

/**
 * The curated parameter form. Reads every distinct file the solver's easyParams
 * point at (one batched query set), then renders one control per parameter that
 * writes just that value back into its file. Multiple parameters can target the
 * same file (e.g. endTime + writeInterval in controlDict); each edit splices only
 * its own value, so they never clobber each other.
 */
function SolverEasyForm({
  projectId,
  solver,
  disabled,
}: {
  projectId: string;
  solver: ConfigurableSolverId;
  disabled: boolean;
}) {
  const allParams = SOLVER_CATALOG[solver].easyParams;
  const files = useMemo(() => Array.from(new Set(allParams.map((param) => param.file))), [allParams]);

  const results = useQueries({
    queries: files.map((file) => ({
      queryKey: caseFileContentQueryKey(projectId, file),
      queryFn: () => getCaseFileContent(projectId, file),
      staleTime: 5_000,
      // A merely-absent optional file (404) should fail fast and be skipped, not retried.
      retry: false,
    })),
  });
  const save = useSaveCaseFile(projectId);

  const contentByFile: Record<string, string | null> = {};
  files.forEach((file, index) => {
    contentByFile[file] = results[index]?.data?.content ?? null;
  });

  // Only configure params whose file actually loaded (exists on disk). One missing file
  // no longer errors the whole form — its param is skipped and the rest still render.
  const params = allParams.filter((param) => contentByFile[param.file] != null);

  const loading = results.some((result) => result.isPending);
  // Show the error state only when EVERY file failed to load (a real load problem), not
  // when a single optional file is simply absent.
  const errored = results.length > 0 && results.every((result) => result.isError);

  const commit = (param: SolverParamDef, value: string) => {
    const content = contentByFile[param.file];
    if (content == null) return;
    const key = param.path[param.path.length - 1];
    const next =
      setFoamValue(content, param.path, value) ??
      insertFoamField(content, param.path.slice(0, -1), key, value);
    if (next && next !== content) {
      save.mutate(
        { path: param.file, content: next },
        {
          onError: (err) =>
            toast.error(err instanceof ApiError ? err.message : 'Could not save the change.'),
        },
      );
    }
  };

  if (errored) {
    return (
      <div role="alert" className="rounded-md border border-danger/30 bg-danger-tint p-4">
        <p className="text-sm font-medium text-danger">We could not load the solver settings.</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => results.forEach((result) => void result.refetch())}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-live="polite">
        <span className="sr-only">Loading the solver settings</span>
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-9 animate-pulse rounded-md bg-bg" />
        ))}
      </div>
    );
  }

  if (params.length === 0) {
    return (
      <p className="rounded-md border border-border bg-bg/40 p-3 text-sm text-text-secondary">
        This solver&apos;s setup files are not generated yet. Use Reconfigure to create them, then
        the guided settings will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {params.map((param) => {
        // The turbulence model is applied through the scaffold (it must rewrite the
        // whole RAS/LES/laminar block AND ensure the model's 0/ fields), not spliced
        // as a bare RASModel value - so it gets a dedicated control.
        if (param.key === 'rasModel') {
          return (
            <TurbulenceField
              key={param.key}
              projectId={projectId}
              solver={solver}
              content={contentByFile[param.file]}
              disabled={disabled}
            />
          );
        }
        const content = contentByFile[param.file];
        const value = content != null ? getFoamValue(parseFoamModel(content), param.path) ?? '' : '';
        return (
          <ParamRow
            key={param.key}
            param={param}
            value={value}
            disabled={disabled}
            onCommit={(next) => commit(param, next)}
          />
        );
      })}
    </div>
  );
}

/** Read the active turbulence model from turbulenceProperties (RAS / LES / laminar). */
function currentTurbulenceModel(content: string): string {
  const doc = parseFoamModel(content);
  const simulationType = getFoamValue(doc, ['simulationType']);
  if (simulationType === 'laminar') return 'laminar';
  if (simulationType === 'LES') return getFoamValue(doc, ['LES', 'LESModel']) ?? '';
  return getFoamValue(doc, ['RAS', 'RASModel']) ?? '';
}

/**
 * The turbulence-model control. Unlike the other easy params (single-value splices),
 * changing the turbulence model must rewrite the whole simulationType block (RAS vs
 * LES vs laminar) AND ensure the model's 0/ fields exist - so it applies through the
 * scaffold (same path the setup wizard uses), and offers every model, not just RAS.
 */
function TurbulenceField({
  projectId,
  solver,
  content,
  disabled,
}: {
  projectId: string;
  solver: ConfigurableSolverId;
  content: string | null;
  disabled: boolean;
}) {
  const scaffold = useScaffoldSolver(projectId);
  const current = content ? currentTurbulenceModel(content) : '';
  const regime = SOLVER_CATALOG[solver]?.regime ?? 'steady';
  const selected = TURBULENCE_MODELS.find((model) => model.id === current);
  const lesOnSteady = selected?.simulationType === 'LES' && regime === 'steady';
  const id = 'solver-turbulence';

  const apply = async (model: string) => {
    if (!model || model === current) return;
    try {
      await scaffold.mutateAsync({ solver, turbulence: model });
      toast.success(`Turbulence model set to ${model}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not apply the turbulence model.');
    }
  };

  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
      <div className="flex flex-col pt-1.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          Turbulence model
        </label>
        <span className="font-mono text-xs text-text-secondary" translate="no">
          simulationType
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="relative">
          <select
            id={id}
            value={current}
            disabled={disabled || scaffold.isPending}
            onChange={(event) => void apply(event.target.value)}
            className={cn(
              'h-9 w-full appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-text',
              'transition-colors duration-fast ease-out hover:border-border-strong',
              'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {!current && (
              <option value="" disabled>
                Select a model
              </option>
            )}
            {TURBULENCE_APPROACHES.map((approach) => (
              <optgroup key={approach.id} label={approach.label}>
                {TURBULENCE_MODELS.filter((model) => model.simulationType === approach.id).map(
                  (model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ),
                )}
              </optgroup>
            ))}
          </select>
          {scaffold.isPending ? (
            <Loader2
              className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-text-secondary"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          )}
        </div>
        <p className="text-xs text-text-secondary">
          Rewrites turbulenceProperties and adds the matching 0/ fields for this model.
        </p>
        {lesOnSteady && (
          <p className="rounded-md bg-accent-tint px-2.5 py-1.5 text-xs text-text">
            LES/DES needs a transient solver. Change the solver above (e.g. pimpleFoam) to run this.
          </p>
        )}
      </div>
    </div>
  );
}

/** One labelled control for a curated solver parameter. */
function ParamRow({
  param,
  value,
  disabled,
  onCommit,
}: {
  param: SolverParamDef;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const id = `solver-${param.key}`;
  const keyword = param.path[param.path.length - 1];
  const isEnum = (param.kind === 'enum' || param.kind === 'bool') && !!param.options;

  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
      <div className="flex flex-col pt-1.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {param.label}
        </label>
        <span className="font-mono text-xs text-text-secondary" translate="no">
          {keyword}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {isEnum ? (
          <EnumControl
            id={id}
            value={value}
            options={param.options as string[]}
            disabled={disabled}
            onChange={onCommit}
          />
        ) : (
          <TextControl
            id={id}
            value={value}
            placeholder={param.example}
            disabled={disabled}
            onCommit={onCommit}
          />
        )}
        {param.help && <p className="text-xs text-text-secondary">{param.help}</p>}
      </div>
    </div>
  );
}

/** A styled native <select>; the current value is always selectable. */
function EnumControl({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const withCurrent = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-text',
          'transition-colors duration-fast ease-out hover:border-border-strong',
          'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {withCurrent.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </div>
  );
}

/** A text input that commits on blur / Enter (not per keystroke). */
function TextControl({
  id,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      id={id}
      key={value}
      type="text"
      defaultValue={value}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      translate="no"
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm text-text',
        'transition-colors duration-fast ease-out hover:border-border-strong',
        'placeholder:text-text-secondary/60',
        'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    />
  );
}

/**
 * Advanced mode: a free `application` field (target ANY solver binary, not just
 * the curated two) plus a raw editor over the solver's files. This is the same
 * "enter whatever you want" freedom the file editor's Advanced mode gives, scoped
 * to the files that make up the solver setup.
 */
function AdvancedConfig({
  projectId,
  solver,
  disabled,
}: {
  projectId: string;
  solver: ConfigurableSolverId | null;
  disabled: boolean;
}) {
  // List the case's REAL config files, so the dropdown never offers a path that does
  // not exist on disk (which would 404 on open). Order the solver's own files first
  // (when present), then the rest of the tree.
  const filesQuery = useCaseFilesQuery(projectId);
  const preferred = solver ? SOLVER_CATALOG[solver].requiredFiles : DEFAULT_SOLVER_FILES;
  const files = useMemo(() => {
    const real = (filesQuery.data ?? [])
      .filter((entry) => entry.type === 'file' && isConfigFile(entry.path))
      .map((entry) => entry.path);
    const realSet = new Set(real);
    const first = preferred.filter((path) => realSet.has(path));
    const firstSet = new Set(first);
    const rest = real.filter((path) => !firstSet.has(path)).sort();
    return [...first, ...rest];
  }, [filesQuery.data, preferred]);

  const [selected, setSelected] = useState<string>('');
  useEffect(() => {
    if (files.length > 0 && !files.includes(selected)) setSelected(files[0]);
  }, [files, selected]);

  return (
    <div className="flex flex-col gap-4">
      <ApplicationField projectId={projectId} disabled={disabled} />

      <div className="flex flex-col gap-2">
        <label htmlFor="solver-raw-file" className="text-xs font-medium text-text-secondary">
          Edit a solver file
        </label>
        {filesQuery.isPending ? (
          <div className="h-9 w-full animate-pulse rounded-md bg-bg sm:max-w-xs" role="status" aria-label="Loading the case files" />
        ) : filesQuery.isError ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-tint p-3">
            <p className="text-sm text-danger">We could not load this case&apos;s files.</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => void filesQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : files.length === 0 ? (
          <p className="rounded-md border border-border bg-bg/40 p-3 text-sm text-text-secondary">
            No editable config files yet. Generate the solver setup first (Reconfigure), then edit
            them here.
          </p>
        ) : (
          <>
            <div className="relative sm:max-w-xs">
              <select
                id="solver-raw-file"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className={cn(
                  'h-9 w-full appearance-none rounded-md border border-border bg-surface pl-3 pr-9 font-mono text-sm text-text',
                  'transition-colors duration-fast ease-out hover:border-border-strong',
                  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
                )}
              >
                {files.map((file) => (
                  <option key={file} value={file}>
                    {file}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </div>
            {selected && <RawFileEditor projectId={projectId} path={selected} disabled={disabled} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Free-form `application` (solver binary) field, written into system/controlDict. */
function ApplicationField({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const path = 'system/controlDict';
  const query = useCaseFileContentQuery(projectId, path);
  const save = useSaveCaseFile(projectId);
  const application =
    query.data != null ? getFoamValue(parseFoamModel(query.data.content), ['application']) ?? '' : '';

  const commit = (value: string) => {
    const content = query.data?.content;
    if (content == null || !value) return;
    const next =
      setFoamValue(content, ['application'], value) ??
      insertFoamField(content, [], 'application', value);
    if (next && next !== content) {
      save.mutate(
        { path, content: next },
        {
          onError: (err) =>
            toast.error(err instanceof ApiError ? err.message : 'Could not save the change.'),
        },
      );
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="solver-application" className="text-sm font-medium text-text">
        Application (solver binary)
      </label>
      <TextControl
        id="solver-application"
        value={application}
        placeholder="e.g. rhoSimpleFoam"
        disabled={disabled || query.isPending}
        onCommit={commit}
      />
      <p className="text-xs text-text-secondary">
        The solver executable run for this case. Any installed OpenFOAM solver name is accepted.
      </p>
    </div>
  );
}

/** Raw CodeMirror editor for one solver file, with debounced autosave. */
function RawFileEditor({
  projectId,
  path,
  disabled,
}: {
  projectId: string;
  path: string;
  disabled: boolean;
}) {
  const query = useCaseFileContentQuery(projectId, path);
  const { mutate: saveFile, isPending: saving, isError: saveFailed } = useSaveCaseFile(projectId);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (query.data) setDraft(query.data.content);
  }, [query.data]);

  const dirty = !!query.data && draft !== query.data.content;

  useEffect(() => {
    if (disabled || !query.data || draft === query.data.content) return;
    const handle = setTimeout(() => saveFile({ path, content: draft }), 600);
    return () => clearTimeout(handle);
  }, [draft, query.data, path, disabled, saveFile]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-72 overflow-hidden rounded-md border border-border">
        {query.isPending ? (
          <div className="h-full animate-pulse bg-bg" role="status" aria-label="Loading the file" />
        ) : query.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-text-secondary">We could not load this file.</p>
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <CaseFileEditor value={draft} onChange={setDraft} readOnly={disabled} />
        )}
      </div>
      {!disabled && !query.isError && (
        <RawSaveStatus saving={saving} failed={saveFailed} dirty={dirty} />
      )}
    </div>
  );
}

/** Small autosave status line for the raw editor. */
function RawSaveStatus({
  saving,
  failed,
  dirty,
}: {
  saving: boolean;
  failed: boolean;
  dirty: boolean;
}) {
  if (failed) {
    return (
      <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-danger">
        <AlertCircle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        Save failed
      </p>
    );
  }
  if (saving) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 text-xs text-text-secondary"
      >
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
        Saving…
      </p>
    );
  }
  if (dirty) {
    return (
      <p role="status" aria-live="polite" className="text-xs text-text-secondary">
        Editing…
      </p>
    );
  }
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-text-secondary"
    >
      <Check className="size-3.5 text-success" strokeWidth={2} aria-hidden="true" />
      All changes saved
    </p>
  );
}
