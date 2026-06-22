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
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-md border border-border bg-surface px-6 py-16 text-center',
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
        <Diamond size={18} className="text-primary" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-lg font-semibold text-text">{title}</p>
        <p className="text-sm text-text-secondary">{description}</p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
