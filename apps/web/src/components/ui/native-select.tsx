import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldControl } from './field';

/**
 * NativeSelect - the app's single styled native `<select>`.
 *
 * Several feature screens need a plain native select (dozens of options, dense
 * config forms, form-library registration); this primitive gives them the exact
 * Input shape - 40px tall, sm radius, hairline border that darkens on hover,
 * blue focus ring - so native selects stop drifting per feature. The browser
 * chevron is replaced by a lucide ChevronDown to match the Radix Select trigger.
 * When wrapped in a Field it inherits id / aria-invalid / aria-describedby.
 */
export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, children, ...props }, ref) => {
    const field = useFieldControl();
    return (
      <span className={cn('relative inline-flex w-full', className)}>
        <select
          ref={ref}
          className={cn(
            'h-10 w-full appearance-none rounded-sm border border-border bg-surface pl-3 pr-9',
            'text-sm text-text',
            'transition-[border-color,box-shadow] duration-fast ease-out',
            'hover:border-border-strong',
            'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:bg-bg disabled:text-text-secondary',
            'aria-[invalid=true]:border-danger',
          )}
          {...field}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </span>
    );
  },
);
NativeSelect.displayName = 'NativeSelect';

export { NativeSelect };
