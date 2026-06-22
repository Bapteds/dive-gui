import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge - compact status / role label.
 *
 * 12px / 500 weight, sm radius, 4x8 padding (DESIGN.md section 6). Variants:
 *  - neutral:   page-bg fill, secondary text, hairline border (default / USER role).
 *  - primary:   primary-tint fill + primary text (SUPER_ADMIN role).
 *  - success:   muted success surface + text (status, paired with an icon).
 *  - danger:    muted danger surface + text (status, paired with an icon).
 * Status variants always accompany an icon or text, never color alone.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium leading-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border border-border bg-bg text-text-secondary',
        primary: 'bg-primary-tint text-primary',
        success: 'bg-success-tint text-success',
        danger: 'bg-danger-tint text-danger',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
