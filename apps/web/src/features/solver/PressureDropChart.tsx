import { useMemo, useRef, useState } from 'react';
import {
  GRAVITY,
  type ConvergenceSettings,
  type CriterionProgress,
  type PressureDropSample,
} from '@dive/shared';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { formatValue, iterationTicks, niceTicks, useMeasuredWidth } from './chartUtils';

/**
 * PressureDropChart - the flux-weighted total-pressure drop Δp₀ per iteration
 * (WS-G), the quantity both pressure-drop criteria judge. A hand-made SVG in the
 * ResidualChart style: Δp₀ (solid brand blue), its trailing mean over the
 * criterion window (dashed grey) and, for the simple criterion, the ±devTol band
 * around the mean (blue tint). Series differ by colour AND line style; a legend
 * names them and a collapsible table is the screen-reader source of truth. The
 * header gives the latest Δp₀ in Pa and as a head H = Δp₀ / (ρ g) in m, plus the
 * criterion progress parsed from the solver log.
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 16, bottom: 30, left: 64 };
const ZOOM_ITERATIONS = 500;

type Zoom = 'all' | 'last';

interface Props {
  samples: PressureDropSample[];
  criterion: CriterionProgress | null;
  convergence: ConvergenceSettings;
}

/** Trailing mean over the previous `window` samples (by index), aligned to each sample. */
function trailingMean(samples: PressureDropSample[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i].dp0;
    if (i >= window) sum -= samples[i - window].dp0;
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/** The progress line of the criterion, or null. */
function criterionText(
  criterion: CriterionProgress | null,
  convergence: ConvergenceSettings,
): string | null {
  if (!criterion) return null;
  if (criterion.method === 'simplePDrop') {
    if (criterion.filling) {
      return `Filling the averaging window: ${criterion.filling.filled} / ${criterion.filling.size} iterations`;
    }
    const band = Number((convergence.simplePDrop.devTol * 100).toPrecision(6));
    return `${criterion.consecutive} / ${criterion.required ?? convergence.simplePDrop.nPass} consecutive iterations within ±${band} %`;
  }
  return `Check ${criterion.passes} / ${criterion.required}: drift ${formatValue(criterion.drift)} Pa, trend ${formatValue(
    criterion.trend,
  )} Pa, max residual ${criterion.maxRes.toExponential(1)}`;
}

export function PressureDropChart({ samples, criterion, convergence }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const width = useMeasuredWidth(containerRef);
  const [zoom, setZoom] = useState<Zoom>('all');

  const meanWindow = convergence.method === 'robust' ? convergence.robust.W : convergence.simplePDrop.window;
  const showBand = convergence.method === 'simplePDrop';
  const devTol = convergence.simplePDrop.devTol;

  const rows = useMemo(() => {
    const means = trailingMean(samples, meanWindow);
    const all = samples.map((s, i) => ({ ...s, mean: means[i] }));
    if (zoom === 'last' && all.length > 0) {
      const lastTime = all[all.length - 1].time;
      return all.filter((r) => r.time > lastTime - ZOOM_ITERATIONS);
    }
    return all;
  }, [samples, meanWindow, zoom]);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const head = latest ? latest.dp0 / (convergence.rho * GRAVITY) : null;
  const progress = criterionText(criterion, convergence);

  const model = useMemo(() => {
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    if (rows.length === 0 || plotW <= 0) return null;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const r of rows) {
      yMin = Math.min(yMin, r.dp0);
      yMax = Math.max(yMax, r.dp0);
      if (r.mean !== null) {
        const lo = showBand ? r.mean * (1 - devTol) : r.mean;
        const hi = showBand ? r.mean * (1 + devTol) : r.mean;
        yMin = Math.min(yMin, lo, hi);
        yMax = Math.max(yMax, lo, hi);
      }
    }
    const yTicks = niceTicks(yMin, yMax, 5);
    const y0 = yTicks[0];
    const y1 = yTicks[yTicks.length - 1];
    const xMin = rows[0].time;
    const xMax = rows.length > 1 ? rows[rows.length - 1].time : xMin + 1;
    const xs = (t: number) => PAD.left + ((t - xMin) / (xMax - xMin)) * plotW;
    const ys = (v: number) => PAD.top + ((y1 - v) / (y1 - y0)) * plotH;

    const line = rows.map((r) => `${xs(r.time)},${ys(r.dp0)}`).join(' ');
    const withMean = rows.filter((r) => r.mean !== null) as Array<(typeof rows)[number] & { mean: number }>;
    const meanLine = withMean.map((r) => `${xs(r.time)},${ys(r.mean)}`).join(' ');
    const band =
      showBand && withMean.length > 1
        ? [
            ...withMean.map((r) => `${xs(r.time)},${ys(r.mean * (1 + devTol))}`),
            ...[...withMean].reverse().map((r) => `${xs(r.time)},${ys(r.mean * (1 - devTol))}`),
          ].join(' ')
        : null;
    const last = rows[rows.length - 1];
    return {
      line,
      meanLine,
      band,
      lastPoint: { x: xs(last.time), y: ys(last.dp0) },
      yTicks: yTicks.map((v) => ({ y: ys(v), label: formatValue(v) })),
      xTicks: iterationTicks(xMin, xMax).map((t) => ({ x: xs(t), label: String(t) })),
      baselineY: PAD.top + plotH,
    };
  }, [rows, width, showBand, devTol]);

  const first = rows[0]?.time;
  const lastIt = rows[rows.length - 1]?.time;
  const summary =
    rows.length > 0
      ? `Pressure drop by iteration, iterations ${first} to ${lastIt}. Latest ${formatValue(
          latest?.dp0 ?? 0,
        )} Pa.`
      : 'Pressure drop by iteration, no data yet.';

  return (
    <section ref={containerRef} className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold text-text">Pressure drop</h3>
          {latest && (
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums">
              <span className="text-text-secondary">Latest Δp₀</span>
              <span className="font-semibold text-text">{`${formatValue(latest.dp0)} Pa`}</span>
              <span className="text-text-secondary">Head</span>
              <span className="font-semibold text-text">{`${formatValue(head ?? 0)} m`}</span>
            </p>
          )}
          {progress && <p className="text-xs text-text-secondary tabular-nums">{progress}</p>}
        </div>
        {samples.length > 0 && (
          <SegmentedRadioGroup<Zoom>
            name="pressure-drop-zoom"
            ariaLabel="Pressure drop range"
            value={zoom}
            onChange={setZoom}
            options={[
              { value: 'all', label: 'All iterations' },
              { value: 'last', label: `Last ${ZOOM_ITERATIONS} iterations` },
            ]}
          />
        )}
      </div>

      {model ? (
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="max-w-full"
          role="img"
          aria-label={summary}
        >
          {model.yTicks.map((tick) => (
            <g key={tick.label}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={tick.y + 3}
                textAnchor="end"
                className="fill-text-secondary text-[10px] tabular-nums"
              >
                {tick.label}
              </text>
            </g>
          ))}
          <text x={4} y={PAD.top - 2} className="fill-text-secondary text-[10px]">
            Pa
          </text>
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

          {model.band && (
            <polygon points={model.band} fill="var(--color-primary-tint)" stroke="none" />
          )}
          {model.meanLine && (
            <polyline
              points={model.meanLine}
              fill="none"
              stroke="var(--color-text-secondary)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
          )}
          <polyline
            points={model.line}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={model.lastPoint.x} cy={model.lastPoint.y} r={2.5} fill="var(--color-primary)" />
        </svg>
      ) : (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
          <span className="size-2.5 rotate-45 rounded-xs bg-neutral" aria-hidden="true" />
          <p className="text-sm font-medium text-text">No pressure drop yet</p>
          <p className="max-w-xs text-xs text-text-secondary">
            Δp₀ between the inlet and outlet patches appears here once the solver iterates with a
            pressure-drop criterion or vortex metrics.
          </p>
        </div>
      )}

      {samples.length > 0 && (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-secondary">
            <li className="flex items-center gap-1.5">
              <svg width="16" height="4" aria-hidden="true">
                <line x1="0" x2="16" y1="2" y2="2" stroke="var(--color-primary)" strokeWidth={2} />
              </svg>
              <span className="font-medium text-text">Δp₀</span>
            </li>
            <li className="flex items-center gap-1.5">
              <svg width="16" height="4" aria-hidden="true">
                <line
                  x1="0"
                  x2="16"
                  y1="2"
                  y2="2"
                  stroke="var(--color-text-secondary)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              </svg>
              <span className="font-medium text-text">{`Trailing mean (${meanWindow} iterations)`}</span>
            </li>
            {showBand && (
              <li className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-4 rounded-xs bg-primary-tint" aria-hidden="true" />
                <span className="font-medium text-text">{`±${Number((devTol * 100).toPrecision(6))} % band`}</span>
              </li>
            )}
          </ul>

          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
              Show pressure drop values
            </summary>
            <div className="mt-2 max-h-48 overflow-auto overscroll-contain rounded-md border border-border">
              <table className="w-full text-left tabular-nums">
                <caption className="sr-only">{summary} Most recent 100 iterations.</caption>
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2 py-1 font-medium text-text-secondary">
                      Iter
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium text-text-secondary">
                      Δp₀ (Pa)
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium text-text-secondary">
                      Trailing mean (Pa)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(-100).map((r) => (
                    <tr key={r.time} className="border-b border-border last:border-0">
                      <th scope="row" className="px-2 py-1 font-normal text-text">
                        {r.time}
                      </th>
                      <td className="px-2 py-1 text-text-secondary">{formatValue(r.dp0)}</td>
                      <td className="px-2 py-1 text-text-secondary">
                        {r.mean === null ? '-' : formatValue(r.mean)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
