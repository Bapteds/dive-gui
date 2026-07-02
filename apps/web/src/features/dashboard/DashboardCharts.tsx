import { cn } from '@/lib/utils';

/**
 * Hand-rolled SVG charts for the Home dashboard (no chart lib, same discipline as
 * the solver ResidualChart). Colours are passed in as brand-token CSS vars
 * (see dashboardColors.ts), so nothing here hard-codes a hue.
 */

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/** A trend sparkline (filled area + line) of recent 0-100 values, in `color`. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <div className="h-[34px] w-full" aria-hidden="true" />;
  }
  const width = 200;
  const height = 40;
  const step = width / (values.length - 1);
  const points = values
    .map((value, i) => `${(i * step).toFixed(1)},${(height - (clamp(value) / 100) * height).toFixed(1)}`)
    .join(' ');
  const area = `0,${height} ${points} ${width},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="34"
      preserveAspectRatio="none"
      className="block"
      aria-hidden="true"
    >
      <polygon points={area} style={{ fill: color, fillOpacity: 0.1 }} />
      <polyline
        points={points}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A thin multi-segment distribution bar. Empty renders a neutral track. */
export function DistributionBar({
  segments,
  className,
  label,
}: {
  segments: { value: number; color: string }[];
  className?: string;
  label?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const visible = segments.filter((segment) => segment.value > 0);
  return (
    <div
      className={cn('flex h-2.5 gap-[3px] overflow-hidden rounded-full', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {total === 0 ? (
        <span className="flex-1" style={{ background: 'var(--color-border)' }} />
      ) : (
        visible.map((segment, index) => (
          <span key={index} style={{ flex: segment.value, background: segment.color }} />
        ))
      )}
    </div>
  );
}

/** A donut ring of coloured segments with a total in the centre. */
export function Donut({
  segments,
  size = 132,
  unit = 'total runs',
}: {
  segments: { value: number; color: string }[];
  size?: number;
  unit?: string;
}) {
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  let offset = 0;

  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${total} ${unit}`}
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
          visible.map((segment, index) => {
            const length = (segment.value / total) * circ;
            const element = (
              <circle
                key={index}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                style={{ stroke: segment.color }}
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
        <span className="font-mono text-3xl font-semibold text-text tabular-nums">{total}</span>
        <span className="text-xs text-text-secondary">{unit}</span>
      </div>
    </div>
  );
}
