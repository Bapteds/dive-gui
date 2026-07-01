import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SegmentedRadioGroup - a compact segmented control backed by NATIVE radio
 * inputs, so it inherits radio-group semantics for free: arrow keys move and
 * select, Space activates, and screen readers announce it as a radio group.
 * Each option is a <label> wrapping its visually-hidden <input>, so the label
 * and control share ONE hit target with no dead zones. The selected segment
 * lifts to the surface colour with the primary label; the rest stay muted.
 *
 * Token-driven, light-theme only. Used for the assembly base source and the
 * per-interface coupling, so the two choices read with the same visual grammar.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading icon (decorative; the text label carries the meaning). */
  icon?: LucideIcon;
}

export interface SegmentedRadioGroupProps<T extends string> {
  /** Radio group name; unique per instance so separate groups never interfere. */
  name: string;
  /** Currently selected value. */
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible group label (announced by screen readers). */
  ariaLabel: string;
  disabled?: boolean;
  /** Fill the container width with equal-width segments (default: content-sized). */
  stretch?: boolean;
  className?: string;
}

export function SegmentedRadioGroup<T extends string>({
  name,
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  stretch = false,
  className,
}: SegmentedRadioGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'items-stretch gap-0.5 rounded-md border border-border bg-bg p-0.5',
        stretch ? 'flex w-full' : 'inline-flex w-fit max-w-full',
        disabled && 'opacity-60',
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const Icon = option.icon;
        return (
          <label
            key={option.value}
            className={cn(
              'relative flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors',
              stretch && 'flex-1 basis-0',
              checked ? 'bg-surface text-primary shadow-sm' : 'text-text-secondary hover:text-text',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            {Icon && <Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
            <span className="truncate">{option.label}</span>
            {/* Focus ring driven by the peer input's focus-visible state. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-sm ring-focus-ring peer-focus-visible:ring-2"
            />
          </label>
        );
      })}
    </div>
  );
}

export default SegmentedRadioGroup;
