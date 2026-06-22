import { cn } from '@/lib/utils';
import { Diamond } from './Diamond';

/**
 * BrandLockup - the diamond mark + "DIVE Turbinen" wordmark.
 *
 * Used in the header and on the login screen. The wordmark is in the primary
 * blue; the bold-italic treatment is reserved for branding (not body text).
 * "DIVE" carries the emphasis, "Turbinen" sits in a lighter weight beside it.
 */
export interface BrandLockupProps {
  /** Visual size of the lockup. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: { diamond: 14, text: 'text-base', gap: 'gap-2' },
  md: { diamond: 16, text: 'text-lg', gap: 'gap-2.5' },
  lg: { diamond: 22, text: 'text-2xl', gap: 'gap-3' },
} as const;

export function BrandLockup({ size = 'md', className }: BrandLockupProps) {
  const s = SIZES[size];
  return (
    <span className={cn('inline-flex items-center text-primary', s.gap, className)}>
      <Diamond size={s.diamond} />
      <span className={cn('font-semibold leading-none tracking-[-0.01em]', s.text)}>
        <span className="font-bold italic">DIVE</span> Turbinen
      </span>
    </span>
  );
}
