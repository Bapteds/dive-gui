import { cn } from '@/lib/utils';

/**
 * Skeleton - loading placeholder block.
 *
 * A static border-colored block with a slow shimmer sweep on top. Under
 * `prefers-reduced-motion: reduce` the sweep is hidden and the block stays
 * static (DESIGN.md section 6). Skeletons should mirror the final layout shape
 * rather than using a centered spinner.
 */
export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-sm bg-border/70', className)}
      aria-hidden="true"
      {...props}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-bg/80 to-transparent motion-reduce:hidden" />
    </div>
  );
}

export { Skeleton };
