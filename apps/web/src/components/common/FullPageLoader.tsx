import { Loader2 } from 'lucide-react';
import { BrandLockup } from '@/components/brand/BrandLockup';

/**
 * FullPageLoader - full-viewport loading state.
 *
 * Shown while the session is bootstrapping (the auth status is 'loading'). Pairs
 * the brand lockup with a small spinner and an `aria-live` status so assistive
 * tech announces the wait. Spinner stops under reduced-motion (global rule).
 */
export function FullPageLoader() {
  return (
    <div
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-bg"
      role="status"
      aria-live="polite"
    >
      <BrandLockup size="lg" />
      <span className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
        Loading your workspace
      </span>
    </div>
  );
}
