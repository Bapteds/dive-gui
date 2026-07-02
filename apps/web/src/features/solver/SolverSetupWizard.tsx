import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Cpu, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { SOLVER_CATALOG, TURBULENCE_MODELS, type ConfigurableSolverId } from '@/lib/api/types';
import { useSyncBoundaries } from '@/features/projects/useCaseFiles';
import { SolverPicker } from './SolverPicker';
import { TurbulencePicker } from './TurbulencePicker';
import { useScaffoldSolver } from './useRuns';

/**
 * SolverSetupWizard - a two-step setup for a case that is not yet runnable:
 *   Step 1  choose the solver (archetype).
 *   Step 2  choose the turbulence model, then generate.
 * Generating scaffolds the case for that solver and applies the turbulence model;
 * the case then becomes runnable and the configure + run panel takes over.
 *
 * Paged (one step at a time) to match the "step 1 / step 2" mental model, with a
 * compact numbered indicator. Exactly ONE orange CTA (Generate), only on the last
 * step; Back is a ghost, Next is a neutral secondary.
 */
export function SolverSetupWizard({ projectId }: { projectId: string; missingFiles?: string[] }) {
  const scaffold = useScaffoldSolver(projectId);
  const syncBoundaries = useSyncBoundaries(projectId);

  const [step, setStep] = useState<1 | 2>(1);
  const [solver, setSolver] = useState<ConfigurableSolverId>('simpleFoam');
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
  const solverLabel = SOLVER_CATALOG[solver].label;
  const turbulenceLabel = TURBULENCE_MODELS.find((m) => m.id === turbulence)?.label ?? turbulence;

  const handleGenerate = async () => {
    try {
      await scaffold.mutateAsync({ solver, turbulence });
      if (applyBoundaries) {
        await syncBoundaries.mutateAsync();
      }
      toast.success('Solver setup generated. The case is ready to run.');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5 rounded-md border border-border bg-surface p-6 shadow-sm">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="size-5 text-primary" strokeWidth={1.75} aria-hidden="true" />
          <h2 className="text-base font-semibold text-text">Set up the solver</h2>
        </div>
        <StepIndicator step={step} />
      </header>

      <div ref={stepRef} tabIndex={-1} className="focus:outline-none">
        {step === 1 ? (
          <section className="flex flex-col gap-3" aria-labelledby="setup-step-1">
            <p id="setup-step-1" className="text-sm text-text-secondary">
              Choose the solver that matches your case. It fixes the physics (steady or transient,
              incompressible or compressible); you can fine-tune every value after generating.
            </p>
            <SolverPicker value={solver} onChange={setSolver} disabled={pending} />
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

            <p className="text-xs text-text-secondary">
              After generating you can fine-tune the values and run the solver.
            </p>
          </section>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
        {step === 2 ? (
          <Button variant="ghost" onClick={() => setStep(1)} disabled={pending}>
            <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
            Back
          </Button>
        ) : (
          <span />
        )}

        {step === 1 ? (
          <Button variant="secondary" onClick={() => setStep(2)}>
            Next
            <ArrowRight strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="primary" loading={pending} onClick={() => void handleGenerate()}>
            <Wrench strokeWidth={1.75} aria-hidden="true" />
            Generate solver setup
          </Button>
        )}
      </footer>
    </div>
  );
}

/** A compact numbered step indicator: done (check), current (filled), upcoming (outline). */
function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2" aria-label={`Setup step ${step} of 2`}>
      <StepDot n={1} label="Solver" state={step === 1 ? 'current' : 'done'} />
      <span className="h-px w-6 bg-border" aria-hidden="true" />
      <StepDot n={2} label="Turbulence" state={step === 2 ? 'current' : 'upcoming'} />
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
