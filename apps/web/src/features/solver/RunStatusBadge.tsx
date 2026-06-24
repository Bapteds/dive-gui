import type { RunStatus } from '@/lib/api/types';
import { runStatusMeta } from './runStatusMeta';

/** A status pill: tinted surface + icon + word (color is never the only signal). */
export function RunStatusBadge({
  status,
  className = '',
}: {
  status: RunStatus;
  className?: string;
}) {
  const meta = runStatusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold ${meta.badgeClass} ${className}`}
    >
      <Icon
        className={`size-3.5 ${meta.spin ? 'animate-spin' : ''}`}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}
