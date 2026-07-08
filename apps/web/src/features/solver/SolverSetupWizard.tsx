import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Cpu, Search, Sparkles, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import {
  SOLVER_CATALOG,
  SOLVER_LIBRARY,
  TURBULENCE_MODELS,
  type SolverId,
} from '@/lib/api/types';
import { useSyncBoundaries } from '@/features/projects/useCaseFiles';
import { SolverBrowserDialog } from './SolverBrowserDialog';
import { SolverFilesStep } from './SolverFilesStep';
import { TurbulenceCalculator } from './TurbulenceCalculator';
import { TurbulencePicker } from './TurbulencePicker';
import { useScaffoldSolver } from './useRuns';

/**
 * SolverSetupWizard - a three-step setup for a case's solver:
 *   Step 1  choose the solver (archetype).
 *   Step 2  choose the turbulence model.
 *   Step 3  generate the case, then edit its files (system / 0 / constant) in a
 *           full-screen editor overlay (Easy or Advanced) + "Add from template file".
 * Moving to step 3 scaffolds the case for that solver + turbulence; the case then
 * becomes runnable and "Done" hands over to the configure + run panel. `onDone`
 * closes the wizard (also used by the Reconfigure entry point).
 *
 * Paged with a compact numbered indicator. Exactly ONE orange CTA per zone.
 */
export function SolverSetupWizard({
  projectId,
  initialSolver,
  onDone,
}: {
  projectId: string;
  /** The case's current controlDict solver, so the wizard opens on it (not simpleFoam). */
  initialSolver?: string | null;
  /** Close the wizard (finished, or cancelled). */
  onDone: () => void;
  missingFiles?: string[];
}) {
  const scaffold = useScaffoldSolver(projectId);
  const syncBoundaries = useSyncBoundaries(projectId);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [solver, setSolver] = useState<SolverId>(() =>
    initialSolver && SOLVER_LIBRARY.some((s) => s.id === initialSolver)
      ? (initialSolver as SolverId)
      : 'simpleFoam',
  );
  const [browserOpen, setBrowserOpen] = useState(false);
  const [turbulence, setTurbulence] = useState<string>('kOmegaSST');
  // Default on: a freshly scaffolded case usually needs its 0/ boundaryFields
  // aligned to the mesh patches (names + types) to actually run.
  const [applyBoundaries, setApplyBoundaries] = useState(true);

  // Move focus to the step content when the step changes (not on first mount), so
  // keyboard and screen-reader users follow the wizard.
  const stepRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepRef.current?.focus();
  }, [step]);

  const pending = scaffold.isPending || syncBoundaries.isPending;
  const solverInfo = SOLVER_LIBRARY.find((s) => s.id === solver);
  const solverLabel = solverInfo?.label ?? solver;
  const tier = SOLVER_CATALOG[solver]?.tier ?? 'base';
  const regime = SOLVER_CATALOG[solver]?.regime ?? 'steady';
  const turbulenceLabel = TURBULENCE_MODELS.find((m) => m.id === turbulence)?.label ?? turbulence;
  const lesOnSteady =
    regime === 'steady' &&
    TURBULENCE_MODELS.find((m) => m.id === turbulence)?.simulationType === 'LES';

  // Step 2 -> 3: scaffold the case for the chosen solver + turbulence (and align the
  // boundary fields), then open the file editor. The overlay opening is the feedback.
  const handleGoToFiles = async () => {
    try {
      await scaffold.mutateAsync({ solver, turbulence });
      if (applyBoundaries) {
        await syncBoundaries.mutateAsync();
      }
      setStep(3);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <>
      {step !== 3 && (
      <div className="flex w-full flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm lg:min-h-0 lg:flex-1">
      <header className="flex shrink-0 flex-col gap-3 p-6 pb-4">
        <div className="flex items-center gap-2">
          <Cpu className="size-5 text-primary" strokeWidth={1.75} aria-hidden="true" />
          <h2 className="text-base font-semibold text-text">Set up the solver</h2>
        </div>
        <StepIndicator step={step} />
      </header>

      <div
        ref={stepRef}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-1 focus:outline-none"
      >
        {step === 1 ? (
          <section className="flex flex-col gap-3" aria-labelledby="setup-step-1">
            <p id="setup-step-1" className="text-sm text-text-secondary">
              Choose the solver that matches your case, from the full library. It fixes the physics;
              you can fine-tune every value after generating.
            </p>
            <div className="flex flex-col gap-1 rounded-md border border-primary bg-primary-tint p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-primary">{solverLabel}</span>
                {tier === 'full' ? (
                  <Badge variant="primary" className="shrink-0 border border-primary/20">
                    <Sparkles className="size-3" strokeWidth={1.75} aria-hidden="true" />
                    Guided setup
                  </Badge>
                ) : (
                  <Badge variant="neutral" className="shrink-0">
                    Base setup
                  </Badge>
                )}
              </div>
              <span className="font-mono text-xs text-text-secondary" translate="no">
                {solver}
              </span>
              {solverInfo?.summary && (
                <span className="text-xs text-text-secondary">{solverInfo.summary}</span>
              )}
            </div>
            <div>
              <Button variant="secondary" onClick={() => setBrowserOpen(true)} disabled={pending}>
                <Search strokeWidth={1.75} aria-hidden="true" />
                Browse all solvers
              </Button>
            </div>
            <SolverBrowserDialog
              open={browserOpen}
              onOpenChange={setBrowserOpen}
              value={solver}
              onSelect={setSolver}
            />
          </section>
        ) : (
          <section className="flex flex-col gap-3" aria-labelledby="setup-step-2">
            <p id="setup-step-2" className="text-sm text-text-secondary">
              Choose the turbulence model for the RANS equations, or run laminar (no model).
            </p>
            <TurbulencePicker value={turbulence} onChange={setTurbulence} disabled={pending} />

            <dl className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-bg/40 px-3 py-2 text-sm">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-xs font-medium text-text-secondary">Solver</dt>
                <dd className="font-medium text-text">{solverLabel}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-xs font-medium text-text-secondary">Turbulence</dt>
                <dd className="font-medium text-text">{turbulenceLabel}</dd>
              </div>
            </dl>

            {lesOnSteady && (
              <p className="rounded-md bg-accent-tint px-3 py-2 text-xs text-text">
                {turbulenceLabel} is an LES/DES model, which needs a transient solver. Go back and
                pick a transient solver (e.g. pimpleFoam) to run it.
              </p>
            )}

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={applyBoundaries}
                disabled={pending}
                onChange={(event) => setApplyBoundaries(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              />
              <span className="text-sm text-text">
                Apply the boundary type and name to the 0/ fields
                <span className="block text-xs text-text-secondary">
                  Rewrites each field&apos;s boundaryField to match the mesh patches (needed after a
                  polyMesh import with a template or default files).
                </span>
              </span>
            </label>

            <TurbulenceCalculator turbulence={turbulence} disabled={pending} />

            <p className="text-xs text-text-secondary">
              After generating you can fine-tune the values and run the solver.
            </p>
          </section>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border p-6 pt-4">
        {step === 1 ? (
          <Button variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setStep(1)} disabled={pending}>
            <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
            Back
          </Button>
        )}

        {step === 1 ? (
          <Button variant="secondary" onClick={() => setStep(2)}>
            Next
            <ArrowRight strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="primary" loading={pending} onClick={() => void handleGoToFiles()}>
            <Wrench strokeWidth={1.75} aria-hidden="true" />
            Generate and continue
          </Button>
        )}
      </footer>
      </div>
      )}
      <SolverFilesStep
        projectId={projectId}
        open={step === 3}
        onBack={() => setStep(2)}
        onDone={onDone}
      />
    </>
  );
}

/** A compact numbered step indicator: done (check), current (filled), upcoming (outline). */
function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={`Setup step ${step} of 3`}>
      <StepDot n={1} label="Solver" state={step === 1 ? 'current' : 'done'} />
      <span className="h-px w-6 bg-border" aria-hidden="true" />
      <StepDot
        n={2}
        label="Turbulence"
        state={step === 2 ? 'current' : step > 2 ? 'done' : 'upcoming'}
      />
      <span className="h-px w-6 bg-border" aria-hidden="true" />
      <StepDot n={3} label="Files" state={step === 3 ? 'current' : 'upcoming'} />
    </ol>
  );
}

function StepDot({
  n,
  label,
  state,
}: {
  n: number;
  label: string;
  state: 'done' | 'current' | 'upcoming';
}) {
  return (
    <li
      className="flex items-center gap-1.5"
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <span
        className={cn(
          'grid size-5 place-items-center rounded-full text-xs font-semibold tabular-nums',
          state === 'upcoming'
            ? 'border border-border-strong text-text-secondary'
            : 'bg-primary text-white',
        )}
      >
        {state === 'done' ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : n}
      </span>
      <span
        className={cn(
          'text-sm',
          state === 'current' ? 'font-semibold text-text' : 'text-text-secondary',
        )}
      >
        {label}
      </span>
      {state === 'done' && <span className="sr-only">(completed)</span>}
    </li>
  );
}
