import { cn } from '@/lib/utils';
import type { RunStatus } from '@/lib/api/types';

/**
 * Hand-rolled SVG charts for the Home dashboard (no chart lib, same discipline as
 * the solver ResidualChart). All colours are brand tokens via inline CSS vars, so
 * they stay in the palette: blue (primary), orange (accent), green (success), red
 * (danger), grey (neutral), light blue (primary-light).
 */

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/** Usage colour by health: blue (calm) -> orange (busy) -> red (saturated). */
function usageColor(pct: number): string {
  if (pct >= 90) return 'var(--color-danger)';
  if (pct >= 75) return 'var(--color-accent)';
  return 'var(--color-primary)';
}

/** Per-status colour for the run-outcome donut and legend. */
const STATUS_COLOR: Record<RunStatus, string> = {
  queued: 'var(--color-neutral)',
  running: 'var(--color-primary-light)',
  converged: 'var(--color-success)',
  completed: 'var(--color-primary)',
  diverged: 'var(--color-accent)',
  failed: 'var(--color-danger)',
  stopped: 'var(--color-neutral)',
};

/** A circular usage gauge (0-100%) with the value in the centre. */
export function RadialGauge({ value, caption }: { value: number; caption?: string }) {
  const size = 128;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const pct = clamp(value);
  const dash = (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="relative grid place-items-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${Math.round(pct)} percent`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            style={{ stroke: 'var(--color-border)' }}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            style={{ stroke: usageColor(pct) }}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ - dash}`}
            className="transition-all duration-base ease-out"
          />
        </svg>
        <span className="absolute flex items-baseline text-3xl font-semibold text-text tabular-nums">
          {Math.round(pct)}
          <span className="ml-0.5 text-base font-medium text-text-secondary">%</span>
        </span>
      </div>
      {caption && <span className="text-xs text-text-secondary tabular-nums">{caption}</span>}
    </div>
  );
}

/** A thin filled sparkline of recent values (0-100). Decorative (the gauge has the number). */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-10 w-full" aria-hidden="true" />;
  }
  const width = 100;
  const height = 28;
  const step = width / (values.length - 1);
  const points = values
    .map((value, i) => `${(i * step).toFixed(2)},${(height - (clamp(value) / 100) * height).toFixed(2)}`)
    .join(' ');
  const area = `0,${height} ${points} ${width},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-10 w-full"
      aria-hidden="true"
    >
      <polygon points={area} style={{ fill: 'var(--color-primary-tint)' }} />
      <polyline
        points={points}
        fill="none"
        style={{ stroke: 'var(--color-primary)' }}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Run-outcome donut + legend. Empty state when there are no runs. */
export function RunOutcomesDonut({ counts }: { counts: Record<RunStatus, number> }) {
  const order: RunStatus[] = [
    'converged',
    'completed',
    'running',
    'queued',
    'diverged',
    'stopped',
    'failed',
  ];
  const segments = order
    .map((status) => ({ status, count: counts[status] ?? 0 }))
    .filter((segment) => segment.count > 0);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  const size = 128;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative grid shrink-0 place-items-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${total} solver runs`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {total === 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              style={{ stroke: 'var(--color-border)' }}
              strokeWidth={stroke}
            />
          ) : (
            segments.map((segment) => {
              const length = (segment.count / total) * circ;
              const element = (
                <circle
                  key={segment.status}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  style={{ stroke: STATUS_COLOR[segment.status] }}
                  strokeWidth={stroke}
                  strokeDasharray={`${length} ${circ - length}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return element;
            })
          )}
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className="text-2xl font-semibold text-text tabular-nums">{total}</span>
          <span className="text-xs text-text-secondary">runs</span>
        </div>
      </div>

      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {total === 0 ? (
          <li className="text-sm text-text-secondary">No runs yet.</li>
        ) : (
          segments.map((segment) => (
            <li key={segment.status} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: STATUS_COLOR[segment.status] }}
                  aria-hidden="true"
                />
                <span className="truncate capitalize text-text-secondary">{segment.status}</span>
              </span>
              <span className="tabular-nums text-text">{segment.count}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** A compact stat tile: a big number + a label, optionally an icon slot. */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col justify-center rounded-md bg-bg/60 px-3 py-2', className)}>
      <span className="text-lg font-semibold text-text tabular-nums">{value}</span>
      <span className="text-xs text-text-secondary">{label}</span>
      {hint && <span className="text-[11px] text-text-secondary/80 tabular-nums">{hint}</span>}
    </div>
  );
}
