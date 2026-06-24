import { useEffect, useMemo, useRef, useState } from 'react';
import { RESIDUAL_FIELDS } from '@dive/shared';
import type { ResidualSample } from '@/lib/api/types';

/**
 * ResidualChart - a hand-rolled SVG line chart of solver residuals on a log Y
 * axis (residuals span decades; lower is better). One line per field. Kept
 * dependency-free and lazy with the tab, in line with the app's bundle
 * discipline (no chart library).
 *
 * The SVG is rendered at the container's measured pixel width and a FIXED height
 * (so 1 viewBox unit = 1px: text stays its real size and the chart never grows
 * to a huge aspect-ratio box on a wide screen). Each series carries a marker at
 * its latest point so a run with only a point or two is still visible. Colors
 * come from the brand-derived token scale; series are distinguished by color AND
 * a direct end-of-line label, and a collapsible data table is the screen-reader
 * source of truth.
 */

const HEIGHT = 260;
const PAD = { top: 16, right: 64, bottom: 30, left: 48 };

/** Series colors from the brand-derived token scale only (blue / orange / grey). */
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

interface Point {
  x: number;
  y: number;
}
interface Series {
  field: string;
  color: string;
  points: Point[];
}
interface ChartModel {
  series: Series[];
  gridlines: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  baselineY: number;
}

/** Order fields by the known RESIDUAL_FIELDS, then any extras alphabetically. */
function orderFields(present: Set<string>): string[] {
  const knownSet = new Set<string>(RESIDUAL_FIELDS);
  const known = RESIDUAL_FIELDS.filter((field) => present.has(field));
  const extra = [...present].filter((field) => !knownSet.has(field)).sort();
  return [...known, ...extra];
}

/** Build render-ready chart geometry (in pixel coordinates) at a given width. */
function buildModel(samples: ResidualSample[], width: number): ChartModel | null {
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  if (plotW <= 0 || plotH <= 0) return null;

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

  const xScale = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin)) * plotW;
  const yScale = (v: number) =>
    PAD.top + ((decadeMax - Math.log10(v)) / (decadeMax - decadeMin)) * plotH;

  const series: Series[] = orderFields(present).map((field, i) => ({
    field,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    points: samples
      .filter((s) => typeof s.values[field] === 'number' && (s.values[field] as number) > 0)
      .map((s) => ({ x: xScale(s.time), y: yScale(s.values[field] as number) })),
  }));

  const gridlines: { y: number; label: string }[] = [];
  for (let d = decadeMin; d <= decadeMax; d += 1) {
    gridlines.push({ y: yScale(10 ** d), label: `1e${d}` });
  }

  const tickCount = Math.min(5, Math.max(2, Math.round(xMax - xMin) + 1));
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const t = Math.round(xMin + ((xMax - xMin) * i) / (tickCount - 1));
    return { x: xScale(t), label: String(t) };
  });

  return { series, gridlines, xTicks, baselineY: PAD.top + plotH };
}

/** A 0-point placeholder shown before any residuals arrive. */
function ChartEmpty() {
  return (
    <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
      <span className="size-2.5 rotate-45 rounded-[2px] bg-neutral" aria-hidden="true" />
      <p className="text-sm font-medium text-text">No residuals yet</p>
      <p className="max-w-xs text-xs text-text-secondary">
        The convergence history appears here once the solver starts iterating.
      </p>
    </div>
  );
}

export function ResidualChart({ samples }: { samples: ResidualSample[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(680);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => buildModel(samples, width), [samples, width]);

  // Field order + colors for the legend / table, even when the geometry is null.
  const fields = useMemo(() => {
    const present = new Set<string>();
    for (const sample of samples) {
      for (const [field, value] of Object.entries(sample.values)) {
        if (typeof value === 'number' && value > 0) present.add(field);
      }
    }
    return orderFields(present).map((field, i) => ({
      field,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));
  }, [samples]);

  const summary = `Residual convergence by iteration, log scale, lower is better. ${
    fields.length
  } field${fields.length === 1 ? '' : 's'} over ${samples.length} iteration${
    samples.length === 1 ? '' : 's'
  }.`;

  const recent = samples.slice(-100);

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {model ? (
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="max-w-full"
          role="img"
          aria-label={summary}
        >
          {/* Decade gridlines + Y labels (subtle, never competing with the data). */}
          {model.gridlines.map((line) => (
            <g key={line.label}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={line.y}
                y2={line.y}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={line.y + 3}
                textAnchor="end"
                className="fill-text-secondary text-[10px] tabular-nums"
              >
                {line.label}
              </text>
            </g>
          ))}

          {/* X axis baseline + iteration ticks. */}
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={model.baselineY}
            y2={model.baselineY}
            stroke="var(--color-border-strong)"
            strokeWidth={1}
          />
          {model.xTicks.map((tick) => (
            <text
              key={tick.label}
              x={tick.x}
              y={model.baselineY + 16}
              textAnchor="middle"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {tick.label}
            </text>
          ))}
          <text
            x={PAD.left + (width - PAD.left - PAD.right) / 2}
            y={HEIGHT - 2}
            textAnchor="middle"
            className="fill-text-secondary text-[10px]"
          >
            iteration
          </text>

          {/* One polyline per field, a marker at its latest point, and a label. */}
          {model.series.map((s) => {
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
                {last && <circle cx={last.x} cy={last.y} r={2.5} fill={s.color} />}
                {last && (
                  <text
                    x={Math.min(last.x + 7, width - 2)}
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
      ) : (
        <ChartEmpty />
      )}

      {/* Legend (color swatch + name) - the names are the real distinguisher. */}
      {fields.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {fields.map((s) => (
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
      )}

      {/* Screen-reader / copy source of truth: the residual values as a table. */}
      {fields.length > 0 && (
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
                  {fields.map((s) => (
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
                    {fields.map((s) => (
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
      )}
    </div>
  );
}
