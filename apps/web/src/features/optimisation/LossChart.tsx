import { useEffect, useMemo, useRef, useState } from 'react';
import type { LengthUnit, StudyMetric, StudySample } from '@/lib/api/types';

/**
 * LossChart - a hand-rolled SVG line chart of the swept loss objective versus pipe
 * diameter (linear axes; the sweep's whole point is reading this curve). Kept
 * dependency-free like ResidualChart, in line with the app's bundle discipline.
 *
 * The diameter that minimises the loss (the optimum) is marked in accent orange with
 * a direct label. Values come in metres and are shown in the study's unit. Colors are
 * brand tokens only; a collapsible data table is the screen-reader source of truth.
 */

const HEIGHT = 280;
const PAD = { top: 20, right: 20, bottom: 40, left: 64 };
const UNIT_M: Record<LengthUnit, number> = { mm: 0.001, cm: 0.01, m: 1 };

function metricLabel(primary: StudyMetric): string {
  return primary === 'headLoss' ? 'Head loss (m)' : 'Pressure drop (Pa)';
}

function metricValue(sample: StudySample, primary: StudyMetric): number | null {
  if (sample.status !== 'done' || !sample.metrics) return null;
  return primary === 'headLoss' ? sample.metrics.headLossM : sample.metrics.pressureDropPa;
}

/** One standard deviation of the tail-averaged objective (absent on legacy samples). */
function metricStd(sample: StudySample, primary: StudyMetric): number | undefined {
  if (sample.status !== 'done' || !sample.metrics) return undefined;
  return primary === 'headLoss' ? sample.metrics.headLossStdM : sample.metrics.pressureDropStdPa;
}

/** Compact number for axis ticks and labels (SI-ish, avoids overlong strings). */
function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return n.toExponential(1);
  return Number(n.toPrecision(4)).toString();
}

interface Row {
  diameterUnit: number;
  loss: number;
  /** One standard deviation of the tail-averaged loss (the error bar), if known. */
  std?: number;
  isBest: boolean;
}

interface Model {
  points: { x: number; y: number; yLo?: number; yHi?: number; row: Row }[];
  xTicks: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  baselineY: number;
  plotRight: number;
}

function buildModel(
  rows: Row[],
  width: number,
): Model | null {
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  if (plotW <= 0 || plotH <= 0 || rows.length < 1) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const r of rows) {
    xMin = Math.min(xMin, r.diameterUnit);
    xMax = Math.max(xMax, r.diameterUnit);
    const half = r.std ?? 0; // the error bars must fit inside the plot too
    yMin = Math.min(yMin, r.loss - half);
    yMax = Math.max(yMax, r.loss + half);
  }
  if (xMax === xMin) xMax = xMin + 1;
  // Pad the Y range a little and never let it collapse to a line.
  if (yMax === yMin) {
    yMax = yMin + Math.max(1, Math.abs(yMin) * 0.1);
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;

  const xScale = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
  const yScale = (v: number) => PAD.top + ((yMax - v) / (yMax - yMin)) * plotH;

  const points = rows.map((row) => ({
    x: xScale(row.diameterUnit),
    y: yScale(row.loss),
    yLo: row.std !== undefined && row.std > 0 ? yScale(row.loss - row.std) : undefined,
    yHi: row.std !== undefined && row.std > 0 ? yScale(row.loss + row.std) : undefined,
    row,
  }));

  const tickN = 5;
  const xTicks = Array.from({ length: tickN }, (_, i) => {
    const v = xMin + ((xMax - xMin) * i) / (tickN - 1);
    return { x: xScale(v), label: fmt(v) };
  });
  const yTicks = Array.from({ length: tickN }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / (tickN - 1);
    return { y: yScale(v), label: fmt(v) };
  });

  return { points, xTicks, yTicks, baselineY: PAD.top + plotH, plotRight: width - PAD.right };
}

function ChartEmpty() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
      <span className="size-2.5 rotate-45 rounded-[2px] bg-neutral" aria-hidden="true" />
      <p className="text-sm font-medium text-text">No results yet</p>
      <p className="max-w-xs text-xs text-text-secondary">
        The loss-versus-diameter curve appears here once a swept value has finished solving.
      </p>
    </div>
  );
}

export function LossChart({
  samples,
  primary,
  unit,
  bestDiameterM,
}: {
  samples: StudySample[];
  primary: StudyMetric;
  unit: LengthUnit;
  bestDiameterM?: number;
}) {
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

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const sample of samples) {
      const loss = metricValue(sample, primary);
      if (loss === null) continue;
      out.push({
        diameterUnit: sample.diameterM / UNIT_M[unit],
        loss,
        std: metricStd(sample, primary),
        isBest:
          bestDiameterM !== undefined && Math.abs(sample.diameterM - bestDiameterM) < 1e-12,
      });
    }
    return out.sort((a, b) => a.diameterUnit - b.diameterUnit);
  }, [samples, primary, unit, bestDiameterM]);

  const model = useMemo(() => buildModel(rows, width), [rows, width]);
  const label = metricLabel(primary);
  const best = rows.find((r) => r.isBest);
  const summary = `${label} versus diameter in ${unit}, ${rows.length} solved value${
    rows.length === 1 ? '' : 's'
  }${best ? `; the minimum is at ${fmt(best.diameterUnit)} ${unit}` : ''}.`;

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {model && rows.length >= 1 ? (
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="max-w-full"
          role="img"
          aria-label={summary}
        >
          {/* Horizontal gridlines + Y labels (subtle). */}
          {model.yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={model.plotRight}
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

          {/* X axis baseline + diameter ticks. */}
          <line
            x1={PAD.left}
            x2={model.plotRight}
            y1={model.baselineY}
            y2={model.baselineY}
            stroke="var(--color-border-strong)"
            strokeWidth={1}
          />
          {model.xTicks.map((tick, i) => (
            <text
              key={i}
              x={tick.x}
              y={model.baselineY + 16}
              textAnchor="middle"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {tick.label}
            </text>
          ))}
          <text
            x={PAD.left + (model.plotRight - PAD.left) / 2}
            y={HEIGHT - 4}
            textAnchor="middle"
            className="fill-text-secondary text-[10px]"
          >
            {`diameter (${unit})`}
          </text>

          {/* +/- one-sigma error bars of the tail-averaged objective (light blue). */}
          {model.points.map((p, i) =>
            p.yLo !== undefined && p.yHi !== undefined ? (
              <g key={`err-${i}`} stroke="var(--color-primary-light)" strokeWidth={1.25}>
                <line x1={p.x} x2={p.x} y1={p.yHi} y2={p.yLo} />
                <line x1={p.x - 3.5} x2={p.x + 3.5} y1={p.yHi} y2={p.yHi} />
                <line x1={p.x - 3.5} x2={p.x + 3.5} y1={p.yLo} y2={p.yLo} />
              </g>
            ) : null,
          )}
          {/* The loss curve (primary blue). */}
          <polyline
            points={model.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Sample points; the optimum in accent orange with a direct label. */}
          {model.points.map((p, i) =>
            p.row.isBest ? (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r={5} fill="var(--color-accent)" />
                <text
                  x={p.x}
                  y={p.y - 10}
                  textAnchor="middle"
                  className="fill-accent-hover text-[10px] font-semibold tabular-nums"
                >
                  {`${fmt(p.row.diameterUnit)} ${unit}`}
                </text>
              </g>
            ) : (
              <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--color-primary)" />
            ),
          )}
        </svg>
      ) : (
        <ChartEmpty />
      )}

      {rows.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
            Show values
          </summary>
          <div className="mt-2 max-h-56 overflow-auto overscroll-contain rounded-md border border-border">
            <table className="w-full text-left tabular-nums">
              <caption className="sr-only">{summary}</caption>
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th scope="col" className="px-3 py-1.5 font-medium text-text-secondary">
                    {`Diameter (${unit})`}
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium text-text-secondary">
                    {label}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <th scope="row" className="px-3 py-1.5 font-normal text-text">
                      {fmt(row.diameterUnit)}
                      {row.isBest && (
                        <span className="ml-1.5 font-semibold text-accent-hover">optimum</span>
                      )}
                    </th>
                    <td className="px-3 py-1.5 text-text-secondary">
                      {fmt(row.loss)}
                      {row.std !== undefined && row.std > 0 && (
                        <span className="text-text-secondary/70"> ± {fmt(row.std)}</span>
                      )}
                    </td>
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
