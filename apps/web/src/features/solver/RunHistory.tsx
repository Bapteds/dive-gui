import type { RunSummary } from '@/lib/api/types';
import { RunStatusBadge } from './RunStatusBadge';

/**
 * RunHistory - a project's past and current runs, newest first. Each row shows
 * the status (color + icon + word), the solver and when it started, plus the
 * duration / exit code once terminal.
 */

const whenFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : whenFormatter.format(date);
}

/** Human duration between two ISO timestamps (e.g. "1m 42s"), or null. */
function formatDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function RunHistory({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-text-secondary">No runs yet.</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {runs.map((run) => {
        const duration = formatDuration(run.startedAt, run.finishedAt);
        return (
          <li key={run.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-col gap-1.5">
              <RunStatusBadge status={run.status} className="w-fit" />
              <span className="truncate text-xs text-text-secondary">
                <span className="font-medium text-text" translate="no">
                  {run.solver}
                </span>{' '}
                · {formatWhen(run.createdAt)}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5 text-xs text-text-secondary tabular-nums">
              {duration && <span>{duration}</span>}
              {run.exitCode !== null && <span>exit {run.exitCode}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
