import { cn } from '@/lib/utils';

/**
 * Diamond - the DIVE rhombus mark (a 45deg-rotated square).
 *
 * The recurring "joint" of the engineered-hairline language: brand lockup,
 * sidebar active marker, empty-state bullet, favicon. Monochrome by design,
 * sized in pixels, colored via `currentColor` (inherits text color) unless a
 * color is passed. Never large, never orange-filled (DESIGN.md section 1).
 */
export interface DiamondProps {
  /** Edge length of the (unrotated) square in pixels. */
  size?: number;
  /** Explicit fill; defaults to `currentColor` so it follows text color. */
  color?: string;
  /** Render as an outline (stroke) instead of a solid fill. */
  outline?: boolean;
  className?: string;
}

export function Diamond({ size = 12, color = 'currentColor', outline = false, className }: DiamondProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <rect
        x="0.6"
        y="0.6"
        width="8.8"
        height="8.8"
        rx="1"
        transform="rotate(45 5 5)"
        fill={outline ? 'none' : color}
        stroke={outline ? color : 'none'}
        strokeWidth={outline ? 1.2 : 0}
      />
    </svg>
  );
}
