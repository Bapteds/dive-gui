import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input, type InputProps } from './input';

/**
 * PasswordInput - password field with a show/hide toggle.
 *
 * Wraps Input and adds a trailing icon button that toggles the input type.
 * The toggle exposes `aria-pressed` and an `aria-label` so screen readers can
 * announce its state (DESIGN.md section 6). The button is not a tab stop trap:
 * it sits after the input in DOM order and is keyboard operable.
 */
export type PasswordInputProps = Omit<InputProps, 'type'>;

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className={cn(
            'absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-sm',
            'text-text-secondary transition-colors duration-fast ease-out',
            'hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
          )}
        >
          {visible ? (
            <EyeOff className="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Eye className="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
