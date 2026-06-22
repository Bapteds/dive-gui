import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Button - the app's single button primitive.
 *
 * Variants follow DESIGN.md section 6:
 *  - primary:     orange CTA fill behind white text (one per zone).
 *  - secondary:   blue outline, primary-tint hover.
 *  - ghost:       transparent, page-bg hover (low-emphasis / toolbar).
 *  - destructive: danger fill, used inside confirm dialogs only.
 * Every variant carries default/hover/focus-visible/active/disabled states, a
 * 1px tactile push on :active, and a non-shifting loading state (spinner swaps
 * in while the label stays put).
 */
const buttonVariants = cva(
  // Base: layout, type, focus ring, motion, tactile push, disabled.
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm',
    'text-sm font-semibold select-none',
    'transition-[background-color,border-color,color,transform] duration-fast ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
    'active:translate-y-px',
    'disabled:pointer-events-none disabled:active:translate-y-0',
    // Legible, token-based disabled treatment shared by every variant (white on
    // neutral was unreadable at 1.88:1; border-on-text-secondary is ~4.8:1).
    'disabled:bg-border disabled:text-text-secondary disabled:cursor-not-allowed',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // Primary CTA: white bold on the accessible darker-orange fill (~4.9:1,
        // AA at normal text size). The shared disabled rule overrides this fill.
        primary: ['bg-cta text-white font-bold', 'hover:bg-cta-hover'],
        secondary: ['border border-primary bg-transparent text-primary', 'hover:bg-primary-tint'],
        ghost: ['bg-transparent text-text-secondary', 'hover:bg-bg hover:text-text'],
        destructive: ['bg-danger text-white', 'hover:bg-danger-hover'],
      },
      size: {
        sm: 'h-8 px-3 text-sm [&_svg]:size-4',
        md: 'h-10 px-4 text-sm [&_svg]:size-4',
        icon: 'size-10 [&_svg]:size-[1.125rem]',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as a Radix Slot, merging props onto a single child element. */
  asChild?: boolean;
  /** Show a spinner and disable interaction without changing the layout. */
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    // Slot cannot host the extra spinner element, so loading falls back to a
    // native button (Slot is for plain pass-through composition like links).
    const Comp = asChild && !loading ? Slot : 'button';
    const isDisabled = disabled || loading;

    if (Comp === Slot) {
      return (
        <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props}>
          {children}
        </Comp>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }), 'relative')}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
            <Loader2 className="size-4 animate-spin" />
          </span>
        )}
        {/* Label keeps its box (only visibility toggles) so width never shifts. */}
        <span className={cn('inline-flex items-center justify-center gap-2', loading && 'invisible')}>
          {children}
        </span>
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
