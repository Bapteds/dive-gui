import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { useFieldControl } from './field';

/**
 * Input - text input primitive.
 *
 * 40px tall, sm radius, hairline border that darkens on hover. Focus shows the
 * blue ring (2px + 2px offset) and a primary border. When wrapped in a Field it
 * inherits `id`, `aria-invalid`, and `aria-describedby` automatically; an
 * invalid field turns the border danger-colored. Caller props override the
 * inherited wiring. Never uses placeholder-as-label.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type = 'text', ...props }, ref) => {
  const field = useFieldControl();
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-sm border border-border bg-surface px-3 py-2',
        'text-sm text-text',
        'placeholder:text-text-secondary',
        'transition-[border-color,box-shadow] duration-fast ease-out',
        'hover:border-border-strong',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:bg-bg disabled:text-text-secondary',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger',
        className,
      )}
      {...field}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
