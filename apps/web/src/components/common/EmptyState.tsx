import { cn } from '@/lib/utils';
import { Diamond } from '@/components/brand/Diamond';

/**
 * EmptyState - centered "teach the next step" placeholder (DESIGN.md section 6).
 *
 * A small monochrome diamond mark inside a tinted disc, a title line, one muted
 * guidance line, and an optional action. Used for blank content areas (Home,
 * the admin table before any extra accounts exist). Never just "Nothing here."
 */
export interface EmptyStateProps {
  title: string;
  /** One short line of guidance toward the next step. */
  description: string;
  /** Optional single action (e.g. a primary button). */
  action?: React.ReactNode;
  /**
   * `card` (default) renders its own bordered surface for blank content areas.
   * `inline` drops the card chrome for use INSIDE an existing panel/card, so
   * empty panels never nest a card within a card.
   */
  variant?: 'card' | 'inline';
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  variant = 'card',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        variant === 'card'
          ? 'rounded-md border border-border bg-surface px-6 py-16'
          : 'min-h-0 flex-1 px-4 py-8',
        className,
      )}
    >
      <span
        className={cn(
          'grid place-items-center rounded-md bg-primary-tint',
          variant === 'card' ? 'size-12' : 'size-10',
        )}
      >
        <Diamond size={variant === 'card' ? 18 : 14} className="text-primary" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn('font-semibold text-text', variant === 'card' ? 'text-lg' : 'text-sm')}>
          {title}
        </p>
        <p className={cn('text-text-secondary', variant === 'card' ? 'text-sm' : 'text-xs')}>
          {description}
        </p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
