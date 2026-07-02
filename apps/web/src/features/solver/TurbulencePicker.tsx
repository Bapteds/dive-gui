import { TURBULENCE_MODELS } from '@/lib/api/types';
import { RadioCardGroup } from './RadioCardGroup';

/**
 * TurbulencePicker - choose the turbulence model as radio cards (step 2 of the
 * solver setup wizard). Each card names the model, its OpenFOAM token, and a
 * one-line summary; `laminar` disables turbulence. A thin wrapper over RadioCardGroup.
 */
interface TurbulencePickerProps {
  /** The selected model id (an RAS.RASModel token, or 'laminar'). */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  name?: string;
  legend?: string;
}

export function TurbulencePicker({
  value,
  onChange,
  disabled = false,
  name = 'turbulence',
  legend = 'Turbulence model',
}: TurbulencePickerProps) {
  return (
    <RadioCardGroup
      items={TURBULENCE_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        mono: model.id,
        summary: model.summary,
      }))}
      value={value}
      onChange={onChange}
      disabled={disabled}
      name={name}
      legend={legend}
    />
  );
}
