import { cn } from '@/lib/utils';

/**
 * RadioCardGroup - an accessible set of radio "cards" used by the solver setup
 * wizard (choose a solver, choose a turbulence model). Each card shows a human
 * label, the exact OpenFOAM token (mono), and a one-line summary.
 *
 * Accessible by construction: real (visually hidden) radio inputs inside a
 * fieldset/legend, so keyboard arrow-key navigation and screen-reader grouping
 * come for free. The selected state is shown with the brand blue (tint + ring +
 * a filled radio dot), never orange - orange is reserved for the single CTA.
 */
export interface RadioCardItem {
  /** The value written on select (an OpenFOAM token). */
  id: string;
  /** Human label shown on the card. */
  label: string;
  /** The exact token, shown in mono under the label. */
  mono: string;
  /** One-line "when to use this" summary. */
  summary: string;
}

interface RadioCardGroupProps {
  items: RadioCardItem[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Radio group name; make it unique when several groups share a page. */
  name: string;
  /** Visible group label (the fieldset legend). */
  legend: string;
}

export function RadioCardGroup({
  items,
  value,
  onChange,
  disabled = false,
  name,
  legend,
}: RadioCardGroupProps) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-xs font-medium text-text-secondary">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <label
              key={item.id}
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
                value={item.id}
                checked={selected}
                onChange={() => onChange(item.id)}
                className="sr-only"
              />
              <div className="flex items-start justify-between gap-2">
                <span className={cn('text-sm font-medium', selected ? 'text-primary' : 'text-text')}>
                  {item.label}
                </span>
                <RadioDot selected={selected} />
              </div>
              <span className="font-mono text-xs text-text-secondary" translate="no">
                {item.mono}
              </span>
              <span className="text-xs text-text-secondary">{item.summary}</span>
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
