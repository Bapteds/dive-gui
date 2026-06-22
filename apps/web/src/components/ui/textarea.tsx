import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { useFieldControl } from './field';

/**
 * Textarea - multi-line text input primitive.
 *
 * Mirrors Input's hairline border, hover, focus ring and invalid states, with a
 * comfortable min-height and vertical resize. When wrapped in a Field it inherits
 * `id`, `aria-invalid`, and `aria-describedby` automatically.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  const field = useFieldControl();
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-20 w-full rounded-sm border border-border bg-surface px-3 py-2',
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
Textarea.displayName = 'Textarea';

export { Textarea };
