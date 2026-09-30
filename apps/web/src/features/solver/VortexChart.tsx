import { useMemo, useRef } from 'react';
import { Calculator } from 'lucide-react';
import type { VortexMetricsSample } from '@dive/shared';
import { Button } from '@/components/ui/button';
import { formatValue, iterationTicks, niceTicks, useMeasuredWidth } from './chartUtils';

/**
 * VortexChart - the vortex metrics of a run (WS-G): the masked Q volume (m³,
 * left axis, solid brand blue) and the RMS vorticity in the Q core (1/s, right
 * axis, dashed brand orange as a non-text stroke). Two Y axes, each labelled with
 * its unit; series differ by colour, line style and axis side, and a legend plus
 * a collapsible table carry the exact values. On a terminal run a secondary
 * "Compute at latest time" button runs the post-process on the server.
 */

const HEIGHT = 220;
const PAD = { top: 16, right: 64, bottom: 30, left: 64 };

interface Props {
  samples: VortexMetricsSample[];
  /** Show the on-demand computation (terminal run, no active solver). */
  canCompute: boolean;
  computing: boolean;
  onCompute: () => void;
}

export function VortexChart({ samples, canCompute, computing, onCompute }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const width = useMeasuredWidth(containerRef);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const model = useMemo(() => {
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    if (samples.length === 0 || plotW <= 0) return null;
    const vol = samples.map((s) => s.maskedQVolume);
    const rms = samples.map((s) => s.omegaRms);
    const vTicks = niceTicks(Math.min(0, ...vol), Math.max(...vol), 5);
    const rTicks = niceTicks(Math.min(0, ...rms), Math.max(...rms), 5);
    const xMin = samples[0].time;
    const xMax = samples.length > 1 ? samples[samples.length - 1].time : xMin + 1;
    const xs = (t: number) =>
      samples.length > 1 ? PAD.left + ((t - xMin) / (xMax - xMin)) * plotW : PAD.left + plotW / 2;
    const scale = (ticks: number[]) => (v: number) =>
      PAD.top + ((ticks[ticks.length - 1] - v) / (ticks[ticks.length - 1] - ticks[0])) * plotH;
    const yv = scale(vTicks);
    const yr = scale(rTicks);
    return {
      volPoints: samples.map((s) => ({ x: xs(s.time), y: yv(s.maskedQVolume) })),
      rmsPoints: samples.map((s) => ({ x: xs(s.time), y: yr(s.omegaRms) })),
      vTicks: vTicks.map((v) => ({ y: yv(v), label: formatValue(v) })),
      rTicks: rTicks.map((v) => ({ y: yr(v), label: formatValue(v) })),
      xTicks: (samples.length > 1 ? iterationTicks(xMin, xMax) : [xMin]).map((t) => ({
        x: xs(t),
        label: String(t),
      })),
      baselineY: PAD.top + plotH,
    };
  }, [samples, width]);

  const summary = latest
    ? `Vortex metrics by iteration, ${samples.length} evaluation${samples.length === 1 ? '' : 's'}. Latest masked Q volume ${formatValue(
        latest.maskedQVolume,
      )} cubic metres, RMS vorticity ${formatValue(latest.omegaRms)} per second.`
    : 'Vortex metrics by iteration, no data yet.';

  return (
    <section ref={containerRef} className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold text-text">Vortex metrics</h3>
          {latest && (
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums">
              <span className="text-text-secondary">Masked Q volume</span>
              <span className="font-semibold text-text">{`${formatValue(latest.maskedQVolume)} m³`}</span>
              <span className="text-text-secondary">RMS vorticity</span>
              <span className="font-semibold text-text">{`${formatValue(latest.omegaRms)} 1/s`}</span>
              <span className="text-xs text-text-secondary">{`at iteration ${latest.time}`}</span>
            </p>
          )}
        </div>
        {canCompute && (
          <Button variant="secondary" size="sm" loading={computing} onClick={onCompute}>
            <Calculator strokeWidth={1.75} aria-hidden="true" />
            Compute at latest time
          </Button>
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
          {model.vTicks.map((tick) => (
            <g key={`v${tick.label}`}>
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
          {model.rTicks.map((tick) => (
            <text
              key={`r${tick.label}`}
              x={width - PAD.right + 8}
              y={tick.y + 3}
              textAnchor="start"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {tick.label}
            </text>
          ))}
          <text x={4} y={PAD.top - 4} className="fill-text-secondary text-[10px]">
            m³
          </text>
          <text x={width - 4} y={PAD.top - 4} textAnchor="end" className="fill-text-secondary text-[10px]">
            1/s
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

          <polyline
            points={model.volPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={1.75}
            strokeLinejoin="round"
          />
          {model.volPoints.map((p, i) => (
            <circle key={`vp${i}`} cx={p.x} cy={p.y} r={2.5} fill="var(--color-primary)" />
          ))}
          <polyline
            points={model.rmsPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.75}
            strokeDasharray="5 4"
            strokeLinejoin="round"
          />
          {model.rmsPoints.map((p, i) => (
            <rect
              key={`rp${i}`}
              x={p.x - 2.5}
              y={p.y - 2.5}
              width={5}
              height={5}
              fill="var(--color-accent)"
            />
          ))}
        </svg>
      ) : (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
          <span className="size-2.5 rotate-45 rounded-xs bg-neutral" aria-hidden="true" />
          <p className="text-sm font-medium text-text">No vortex metrics yet</p>
          <p className="max-w-xs text-xs text-text-secondary">
            They are computed every few iterations during a run with vortex metrics on, or at the
            latest time on demand.
          </p>
        </div>
      )}

      {samples.length > 0 && (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-secondary">
            <li className="flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden="true">
                <line x1="0" x2="16" y1="3" y2="3" stroke="var(--color-primary)" strokeWidth={2} />
              </svg>
              <span className="font-medium text-text">Masked Q volume (m³, left)</span>
            </li>
            <li className="flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden="true">
                <line
                  x1="0"
                  x2="16"
                  y1="3"
                  y2="3"
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              </svg>
              <span className="font-medium text-text">RMS vorticity in the Q core (1/s, right)</span>
            </li>
          </ul>

          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
              Show vortex metric values
            </summary>
            <div className="mt-2 max-h-48 overflow-auto overscroll-contain rounded-md border border-border">
              <table className="w-full text-left tabular-nums">
                <caption className="sr-only">{summary}</caption>
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border">
                    {['Iter', 'Masked Q volume (m³)', 'Q volume (m³)', 'RMS vorticity (1/s)', 'Core volume (m³)', 'Core cells'].map(
                      (label) => (
                        <th key={label} scope="col" className="px-2 py-1 font-medium text-text-secondary">
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {samples.slice(-100).map((s) => (
                    <tr key={s.time} className="border-b border-border last:border-0">
                      <th scope="row" className="px-2 py-1 font-normal text-text">
                        {s.time}
                      </th>
                      <td className="px-2 py-1 text-text-secondary">{formatValue(s.maskedQVolume)}</td>
                      <td className="px-2 py-1 text-text-secondary">{formatValue(s.qVolume)}</td>
                      <td className="px-2 py-1 text-text-secondary">{formatValue(s.omegaRms)}</td>
                      <td className="px-2 py-1 text-text-secondary">{formatValue(s.coreVolume)}</td>
                      <td className="px-2 py-1 text-text-secondary">{s.coreCells}</td>
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
