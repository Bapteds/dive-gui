import { cn } from '@/lib/utils';

/**
 * BrandLockup - the official DIVE Turbinen logo (emblem + wordmark).
 *
 * Renders the real brand asset (apps/web/public/logo.svg): the rhombus emblem
 * plus the "DIVE" (orange) / "Turbinen" (blue) wordmark, in the locked brand
 * palette. Used in the header, the login card, the mobile nav, and the
 * full-page loader. Sized by height with the width following the fixed aspect
 * ratio; explicit width/height reserve space so the logo never shifts layout.
 *
 * `alt` defaults to the brand name; pass `alt=""` where a surrounding element
 * already names the control (e.g. the header's home link with its aria-label).
 */
export interface BrandLockupProps {
  /** Visual size of the lockup. */
  size?: 'sm' | 'md' | 'lg';
  /** Accessible name; pass "" to mark it decorative when already labelled. */
  alt?: string;
  className?: string;
}

// logo.svg intrinsic ratio is 793.51 / 211.364 ≈ 3.754 (width / height); widths
// below keep that ratio so the asset is never stretched.
const SIZES = {
  sm: { height: 24, width: 90 },
  md: { height: 28, width: 105 },
  lg: { height: 40, width: 150 },
} as const;

export function BrandLockup({ size = 'md', alt = 'DIVE Turbinen', className }: BrandLockupProps) {
  const s = SIZES[size];
  return (
    <img
      src="/logo.svg"
      alt={alt}
      width={s.width}
      height={s.height}
      draggable={false}
      className={cn('block select-none', className)}
    />
  );
}
