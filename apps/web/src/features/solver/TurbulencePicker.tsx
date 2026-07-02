import { TURBULENCE_APPROACHES, TURBULENCE_MODELS } from '@/lib/api/types';
import { RadioCardGroup } from './RadioCardGroup';

/**
 * TurbulencePicker - choose the turbulence model, grouped by approach (Laminar/DNS,
 * RANS, LES/DES). Each approach is one fieldset of radio cards; they all share the
 * same radio group name, so exactly one model is selected across every group.
 */
interface TurbulencePickerProps {
  /** The selected model id (an RAS/LES model token, or 'laminar'). */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  name?: string;
}

export function TurbulencePicker({
  value,
  onChange,
  disabled = false,
  name = 'turbulence',
}: TurbulencePickerProps) {
  return (
    <div className="flex flex-col gap-4">
      {TURBULENCE_APPROACHES.map((approach) => {
        const items = TURBULENCE_MODELS.filter(
          (model) => model.simulationType === approach.id,
        ).map((model) => ({
          id: model.id,
          label: model.label,
          mono: model.id,
          summary: model.summary,
        }));
        if (items.length === 0) return null;
        return (
          <RadioCardGroup
            key={approach.id}
            items={items}
            value={value}
            onChange={onChange}
            disabled={disabled}
            name={name}
            legend={approach.label}
          />
        );
      })}
    </div>
  );
}
