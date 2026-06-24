import { useMemo } from 'react';
import { RESIDUAL_FIELDS } from '@dive/shared';
import type { ResidualSample } from '@/lib/api/types';

/**
 * ResidualChart - a hand-rolled SVG line chart of solver residuals on a log Y
 * axis (residuals span decades; lower is better). One line per field. Kept
 * dependency-free and lazy with the tab, in line with the app's bundle
 * discipline (no chart library). Colors come only from the brand-derived token
 * scale; series are distinguished by color AND a direct end-of-line label (never
 * color alone), and a collapsible data table is the screen-reader source of truth.
 */

/** viewBox units; the SVG scales responsively to its container width. */
const VIEW_W = 680;
const VIEW_H = 300;
const PAD = { top: 14, right: 64, bottom: 30, left: 48 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

/**
 * Series colors from the brand-derived token scale only (blue / orange / grey
 * family). Assigned in field order; the end-label + legend carry the meaning.
 */
const SERIES_COLORS = [
  'var(--color-primary)',
  'var(--color-accent)',
  'var(--color-primary-light)',
  'var(--color-cta)',
  'var(--color-text-secondary)',
  'var(--color-accent-hover)',
  'var(--color-primary-hover)',
  'var(--color-neutral)',
];

interface SeriesPoint {
  x: number;
  y: number;
}
interface Series {
  field: string;
  color: string;
  points: SeriesPoint[];
}

interface ChartModel {
  series: Series[];
  decades: number[];
  xTicks: number[];
  xMin: number;
  xMax: number;
  decadeMin: number;
  decadeMax: number;
}

/** Order fields by the known RESIDUAL_FIELDS, then any extras alphabetically. */
function orderFields(present: Set<string>): string[] {
  const knownSet = new Set<string>(RESIDUAL_FIELDS);
  const known = RESIDUAL_FIELDS.filter((field) => present.has(field));
  const extra = [...present].filter((field) => !knownSet.has(field)).sort();
  return [...known, ...extra];
}

/** Build the chart geometry from the residual samples. */
function buildModel(samples: ResidualSample[]): ChartModel | null {
  const present = new Set<string>();
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;

  for (const sample of samples) {
    xMin = Math.min(xMin, sample.time);
    xMax = Math.max(xMax, sample.time);
    for (const [field, value] of Object.entries(sample.values)) {
      if (typeof value !== 'number' || !(value > 0)) continue;
      present.add(field);
      yMin = Math.min(yMin, value);
      yMax = Math.max(yMax, value);
    }
  }
  if (present.size === 0 || !Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (xMax === xMin) xMax = xMin + 1;

  const decadeMin = Math.floor(Math.log10(yMin));
  const decadeMax = Math.max(decadeMin + 1, Math.ceil(Math.log10(yMax)));

  const xScale = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin)) * PLOT_W;
  const yScale = (v: number) =>
    PAD.top + ((decadeMax - Math.log10(v)) / (decadeMax - decadeMin)) * PLOT_H;

  const fields = orderFields(present);
  const series: Series[] = fields.map((field, i) => ({
    field,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    points: samples
      .filter((s) => typeof s.values[field] === 'number' && (s.values[field] as number) > 0)
      .map((s) => ({ x: xScale(s.time), y: yScale(s.values[field] as number) })),
  }));

  const decades: number[] = [];
  for (let d = decadeMin; d <= decadeMax; d += 1) decades.push(d);

  const tickCount = Math.min(5, Math.max(2, Math.round(xMax - xMin) + 1));
  const xTicks = Array.from({ length: tickCount }, (_, i) =>
    Math.round(xMin + ((xMax - xMin) * i) / (tickCount - 1)),
  );

  return { series, decades, xTicks, xMin, xMax, decadeMin, decadeMax };
}

/** A 0-point placeholder shown before any residuals arrive. */
function ChartEmpty() {
  return (
    <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
      <span
        className="size-2.5 rotate-45 rounded-[2px] bg-neutral"
        aria-hidden="true"
      />
      <p className="text-sm font-medium text-text">No residuals yet</p>
      <p className="max-w-xs text-xs text-text-secondary">
        The convergence history appears here once the solver starts iterating.
      </p>
    </div>
  );
}

export function ResidualChart({ samples }: { samples: ResidualSample[] }) {
  const model = useMemo(() => buildModel(samples), [samples]);

  if (!model) return <ChartEmpty />;

  const { series, decades, xTicks, xMin, xMax, decadeMin, decadeMax } = model;
  const yFor = (d: number) =>
    PAD.top + ((decadeMax - d) / (decadeMax - decadeMin)) * PLOT_H;
  const xFor = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin)) * PLOT_W;

  const summary = `Residual convergence by iteration, log scale, lower is better. ${
    series.length
  } field${series.length === 1 ? '' : 's'} over ${samples.length} iteration${
    samples.length === 1 ? '' : 's'
  }.`;

  // Most recent rows for the screen-reader data table (the chart's text source).
  const recent = samples.slice(-100);

  return (
    <div className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full"
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Decade gridlines + Y labels (subtle, never competing with the data). */}
        {decades.map((d) => (
          <g key={`y-${d}`}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={yFor(d)}
              y2={yFor(d)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yFor(d) + 3}
              textAnchor="end"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {`1e${d}`}
            </text>
          </g>
        ))}

        {/* X axis baseline + iteration ticks. */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          stroke="var(--color-border-strong)"
          strokeWidth={1}
        />
        {xTicks.map((t) => (
          <text
            key={`x-${t}`}
            x={xFor(t)}
            y={PAD.top + PLOT_H + 16}
            textAnchor="middle"
            className="fill-text-secondary text-[10px] tabular-nums"
          >
            {t}
          </text>
        ))}
        <text
          x={PAD.left + PLOT_W / 2}
          y={VIEW_H - 2}
          textAnchor="middle"
          className="fill-text-secondary text-[10px]"
        >
          iteration
        </text>

        {/* One polyline per field, plus a direct end-of-line label. */}
        {series.map((s) => {
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.field}>
              <polyline
                points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last && (
                <text
                  x={Math.min(last.x + 6, VIEW_W - 2)}
                  y={last.y + 3}
                  className="text-[10px] font-semibold"
                  style={{ fill: s.color }}
                >
                  {s.field}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend (color swatch + name) - the names are the real distinguisher. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <li key={s.field} className="flex items-center gap-1.5 text-xs text-text-secondary">
            <span
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            <span className="font-medium text-text" translate="no">
              {s.field}
            </span>
          </li>
        ))}
      </ul>

      {/* Screen-reader / copy source of truth: the residual values as a table. */}
      <details className="text-xs">
        <summary className="cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
          Show residual values
        </summary>
        <div className="mt-2 max-h-48 overflow-auto overscroll-contain rounded-md border border-border">
          <table className="w-full text-left tabular-nums">
            <caption className="sr-only">{summary} Most recent 100 iterations.</caption>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-border">
                <th scope="col" className="px-2 py-1 font-medium text-text-secondary">
                  Iter
                </th>
                {series.map((s) => (
                  <th
                    key={s.field}
                    scope="col"
                    className="px-2 py-1 font-medium text-text-secondary"
                    translate="no"
                  >
                    {s.field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.map((sample) => (
                <tr key={sample.time} className="border-b border-border last:border-0">
                  <th scope="row" className="px-2 py-1 font-normal text-text">
                    {sample.time}
                  </th>
                  {series.map((s) => (
                    <td key={s.field} className="px-2 py-1 text-text-secondary">
                      {typeof sample.values[s.field] === 'number'
                        ? (sample.values[s.field] as number).toExponential(2)
                        : '-'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
