import { SOLVER_SPECS, type ConfigurableSolverId } from '@/lib/api/types';
import { RadioCardGroup } from './RadioCardGroup';

/**
 * SolverPicker - choose the solver (and thus the case archetype) as radio cards.
 * Each card names the archetype ("Steady-state, incompressible"), the exact solver
 * binary, and a one-line "when to use" summary. A thin wrapper over RadioCardGroup.
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
    <RadioCardGroup
      items={SOLVER_SPECS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        mono: spec.id,
        summary: spec.summary,
      }))}
      value={value}
      onChange={(id) => onChange(id as ConfigurableSolverId)}
      disabled={disabled}
      name={name}
      legend={legend}
    />
  );
}
