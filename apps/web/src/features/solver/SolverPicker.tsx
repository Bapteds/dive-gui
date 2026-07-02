import { cn } from '@/lib/utils';
import { SOLVER_SPECS, type ConfigurableSolverId } from '@/lib/api/types';

/**
 * SolverPicker - choose the solver (and thus the case archetype) as a small set
 * of radio cards. Each card names the archetype ("Steady-state, incompressible")
 * plus the exact solver binary and a one-line "when to use" summary, so the choice
 * is legible to someone who does not know the OpenFOAM binary names by heart.
 *
 * Accessible by construction: real (visually hidden) radio inputs inside a
 * fieldset/legend, so keyboard arrow-key navigation and screen-reader grouping
 * come for free. The selected state is shown with the brand blue (tint + ring +
 * a filled radio dot), never orange - orange stays reserved for the single Run
 * CTA in this zone.
 */
interface SolverPickerProps {
  value: ConfigurableSolverId;
  onChange: (solver: ConfigurableSolverId) => void;
  disabled?: boolean;
  /** Radio group name; make it unique when several pickers share a page. */
  name?: string;
  /** Visible group label (the fieldset legend). */
  legend?: string;
}

export function SolverPicker({
  value,
  onChange,
  disabled = false,
  name = 'solver',
  legend = 'Solver',
}: SolverPickerProps) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-xs font-medium text-text-secondary">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {SOLVER_SPECS.map((spec) => {
          const selected = spec.id === value;
          return (
            <label
              key={spec.id}
              className={cn(
                'relative flex cursor-pointer flex-col gap-1 rounded-md border p-3 transition-colors duration-fast ease-out',
                'focus-within:outline-none focus-within:ring-2 focus-within:ring-focus-ring focus-within:ring-offset-1',
                selected
                  ? 'border-primary bg-primary-tint'
                  : 'border-border bg-surface hover:border-border-strong',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={name}
                value={spec.id}
                checked={selected}
                onChange={() => onChange(spec.id)}
                className="sr-only"
              />
              <div className="flex items-start justify-between gap-2">
                <span className={cn('text-sm font-medium', selected ? 'text-primary' : 'text-text')}>
                  {spec.label}
                </span>
                <RadioDot selected={selected} />
              </div>
              <span className="font-mono text-xs text-text-secondary" translate="no">
                {spec.id}
              </span>
              <span className="text-xs text-text-secondary">{spec.summary}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The radio affordance: an outlined circle that fills with brand blue when selected. */
function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-fast ease-out',
        selected ? 'border-primary' : 'border-border-strong',
      )}
    >
      {selected && <span className="size-2 rounded-full bg-primary" />}
    </span>
  );
}
