import { cn } from '@/lib/utils';

/**
 * PageHeader - the title row at the top of a content area.
 *
 * Title (24px / 600) with an optional subtitle line and an optional
 * right-aligned action (e.g. the admin "Add user" CTA). Stacks the action
 * below the title on narrow screens. No eyebrow label above the title.
 */
export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Right-aligned action slot (typically a single primary button). */
  action?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, action, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">{title}</h1>
        {subtitle && <p className="text-sm text-text-secondary">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
